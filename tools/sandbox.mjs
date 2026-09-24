#!/usr/bin/env node
/**
 * Build a throwaway sandbox for one live, end-to-end `hush-agents run`.
 *
 * Usage:
 *   node tools/sandbox.mjs [dir] [--harness claude|codex|gemini|opencode] [--model <name>] [--review-model <name>] [--workers <n>]
 *
 * Default dir: ../hush-sandbox, next to this repository. The command deletes and recreates the dir.
 * --model applies to Flint. --review-model applies to Fable, Rook, Puck, and Vera; it defaults to --model.
 * Leave out both flags to use the default model of the harness.
 *
 * The sandbox holds a small Node repo with a PRD and `npm test`, a run config that calls the real harness CLI through
 * `hush-agents harness-adapter`, and `run.sh`. A live run uses real model calls and costs tokens.
 * This tool is not published: package.json `files` does not list tools/.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hushRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const positional = args.find((value, index) => !value.startsWith("--") && !args[index - 1]?.startsWith("--"));
const sandbox = resolve(positional ?? join(hushRoot, "..", "hush-sandbox"));
const harness = option("--harness", "claude");
const model = option("--model");
const reviewModel = option("--review-model", model);
const workers = Number(option("--workers", "2"));
if (!["claude", "codex", "gemini", "opencode"].includes(harness)) throw new Error(`unsupported --harness ${harness}`);

rmSync(sandbox, { recursive: true, force: true });
const repo = join(sandbox, "repo");
mkdirSync(join(repo, "src"), { recursive: true });
mkdirSync(join(repo, "docs"), { recursive: true });
mkdirSync(join(repo, "test"), { recursive: true });
const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: repo, stdio: "ignore" });

// Two independent features, so the run can use both workers in parallel.
writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "hush-sandbox-app", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
writeFileSync(join(repo, "src", "shipping.js"), "/** Quote a shipping order. Not implemented yet. */\nexport function quoteShipping(order) {\n  throw new Error(\"not implemented\");\n}\n");
writeFileSync(join(repo, "src", "discount.js"), "/** Apply a discount code to a cart total in cents. Not implemented yet. */\nexport function applyDiscount(totalCents, code) {\n  throw new Error(\"not implemented\");\n}\n");
writeFileSync(join(repo, "test", "smoke.test.js"), "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\n\ntest(\"sandbox test runner works\", () => assert.equal(1 + 1, 2));\n");
writeFileSync(join(repo, "docs", "prd.md"), `# Checkout pricing

## R-01 Shipping quote
Implement \`quoteShipping({ weightKg, zone, speed })\` in \`src/shipping.js\`.
- Base price in cents is \`500 + 200 * weightKg\`.
- Zone \`remote\` multiplies the base price by 1.5. Zone \`local\` does not change it.
- Speed \`express\` adds 1200 cents after the zone rule. Speed \`standard\` adds nothing.
- Return \`{ priceCents, etaDays }\`. \`etaDays\` is 5 for \`standard\` and 2 for \`express\`.
- Round \`priceCents\` to a whole number.

## R-02 Discount codes
Implement \`applyDiscount(totalCents, code)\` in \`src/discount.js\`.
- Code \`SAVE10\` takes 10% off. Code \`FLAT500\` takes 500 cents off.
- The result is never below 0 and is a whole number of cents.
- Any other code returns \`totalCents\` unchanged.
`);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
git("config", "user.email", "hush-sandbox@example.test");
git("config", "user.name", "Hush Sandbox");
git("add", ".");
git("commit", "-q", "-m", "chore: seed sandbox app");

const profile = join(sandbox, "setup-profile.json");
writeFileSync(profile, `${JSON.stringify({ setup_commands: [] }, null, 2)}\n`);

// Same safe environment shape as the runner tests: no network, fake credentials, sinks only.
const environment = {
  network: "disabled", database: "ephemeral-test-only", credentials: "fake-only", email: "sink-only", webhooks: "disabled", uploads: "disabled", test_data: "generated", cleanup: [],
  hazards: [["database", "ephemeral-test-only"], ["credentials", "fake-only"], ["email", "sink-only"], ["webhooks", "disabled"], ["uploads", "disabled"], ["network", "disabled"]]
    .map(([category, policy], index) => ({ hazard_id: `HAZ-${index}`, repository: repo, category, policy, status: "MITIGATED", evidence: { method: "sandbox", source: "tools/sandbox.mjs" } })),
};
const cli = join(hushRoot, "bin", "hush-agents.mjs");
const adapter = (role) => ({
  command: [process.execPath, cli, "harness-adapter", "--harness", harness, "--agent", role, ...((role === "flint" ? model : reviewModel) ? ["--model", role === "flint" ? model : reviewModel] : [])],
  // Live model calls take minutes. The bridge itself stops a harness after 10 minutes.
  timeout_ms: 15 * 60 * 1000,
  // The runner passes only PATH by default. The harness CLIs need HOME to find their login and the installed profiles.
  pass_env: ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
});
const config = join(sandbox, "run-config.json");
writeFileSync(config, `${JSON.stringify({
  setup_profile: profile,
  environment,
  max_workers: workers,
  capacity: { available_workers: workers, safe_limit: workers, confidence: "HIGH", observed_at: new Date().toISOString() },
  integration_checks: ["npm test"],
  adapters: Object.fromEntries(["fable", "rook", "flint", "puck", "vera"].map((role) => [role, adapter(role)])),
}, null, 2)}\n`);

const runScript = join(sandbox, "run.sh");
writeFileSync(runScript, `#!/bin/sh
# One live end-to-end run. It makes real model calls and costs tokens.
# Pass --resume <run-id> to resume an interrupted run.
cd "$(dirname "$0")/repo" || exit 1
exec "${process.execPath}" "${cli}" run docs/prd.md --repo . --target main --config ../run-config.json --json "$@"
`);
chmodSync(runScript, 0o755);
writeFileSync(join(sandbox, "README.md"), `# hush-sandbox

A throwaway world for one live \`hush-agents run\`. Nothing outside this folder changes, except model usage on your
${harness} account.

    ./run.sh                       run the PRD in repo/docs/prd.md through all five roles
    ./run.sh --resume <run-id>     resume an interrupted run

Harness: ${harness}. Flint model: ${model ?? "harness default"}. Review model: ${reviewModel ?? "harness default"}. Workers: ${workers}.
Results: repo/.hush/runs/<run-id>/runner-summary.json. The \`usage\` block shows time and tokens for each role.

Regenerate at any time:

    node ${join(hushRoot, "tools", "sandbox.mjs")} ${sandbox} --harness ${harness}

Delete the whole folder when you are done.
`);
console.log(JSON.stringify({ sandbox, harness, model: model ?? null, review_model: reviewModel ?? null, workers, run: runScript }));
