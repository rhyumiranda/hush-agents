import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HARNESS_USAGE_KEY, SUPPORTED_HARNESSES, buildHarnessInvocation, parseHarnessOutput, parseHarnessUsage } from "../lib/runtime/harness-adapter.mjs";

const payload = { role: "fable", run_id: "RUN-1", repository: process.cwd(), prd_text: "test" };
const cli = join(process.cwd(), "bin", "hush-agents.mjs");

test("all supported harnesses use the same Hush request boundary", () => {
  for (const harness of SUPPORTED_HARNESSES) {
    const invocation = buildHarnessInvocation({ harness, role: "fable", payload, outputPath: "/tmp/last-message.json", executable: "/bin/test" });
    assert.equal(invocation.command, "/bin/test");
    assert.ok(invocation.args.includes(process.cwd()));
    assert.match(invocation.args.join(" ") + invocation.input, /RUN-1/);
  }
});

test("only Flint receives a writable native harness mode by default", () => {
  for (const harness of SUPPORTED_HARNESSES) {
    const readOnly = buildHarnessInvocation({ harness, role: "puck", payload, outputPath: "/tmp/last-message.json" });
    const writable = buildHarnessInvocation({ harness, role: "flint", payload, outputPath: "/tmp/last-message.json" });
    if (harness !== "opencode") {
      assert.doesNotMatch(readOnly.args.join(" "), /workspace-write|auto_edit|dontAsk/);
      assert.match(writable.args.join(" "), /workspace-write|auto_edit|dontAsk/);
    }
  }
});

test("harness prompt carries the task packet once, not twice", () => {
  const packet = { packet_id: "PKT-UNIQUE-1", write_paths: ["result.txt"] };
  const flintPayload = { task: { task_id: "TASK-1", packet }, packet, worktree_path: process.cwd() };
  for (const harness of SUPPORTED_HARNESSES) {
    const invocation = buildHarnessInvocation({ harness, role: "flint", payload: flintPayload, outputPath: "/tmp/last-message.json" });
    const prompt = invocation.args.join(" ") + invocation.input;
    assert.equal(prompt.split("PKT-UNIQUE-1").length - 1, 1, harness);
    assert.match(prompt, /"task":\{"task_id":"TASK-1"\}/, harness);
  }
});

test("an optional model reaches every harness as --model without displacing the prompt", () => {
  for (const harness of SUPPORTED_HARNESSES) {
    const plain = buildHarnessInvocation({ harness, role: "puck", payload, outputPath: "/tmp/last-message.json" });
    const fast = buildHarnessInvocation({ harness, role: "puck", payload, outputPath: "/tmp/last-message.json", model: "fast-model-1" });
    assert.equal(plain.args.includes("--model"), false, harness);
    const at = fast.args.indexOf("--model");
    assert.equal(fast.args[at + 1], "fast-model-1", harness);
    assert.equal(fast.args.at(-1), plain.args.at(-1), `${harness} keeps the prompt or stdin marker last`);
    assert.deepEqual(fast.args.filter((_, index) => index !== at && index !== at + 1), plain.args, harness);
    assert.throws(() => buildHarnessInvocation({ harness, role: "puck", payload, outputPath: "/tmp/x", model: "--sandbox" }), /model must be/);
  }
});

test("adapter output parser normalizes native text and JSON envelopes", () => {
  const result = { requirements: [{ requirement_id: "REQ-1" }] };
  assert.deepEqual(parseHarnessOutput({ harness: "codex", outputText: "```json\n" + JSON.stringify(result) + "\n```" }), result);
  assert.deepEqual(parseHarnessOutput({ harness: "claude", stdout: JSON.stringify({ result: JSON.stringify(result) }) }), result);
  assert.deepEqual(parseHarnessOutput({ harness: "gemini", stdout: JSON.stringify({ response: result }) }), result);
  assert.deepEqual(parseHarnessOutput({ harness: "opencode", stdout: JSON.stringify({ part: { text: JSON.stringify(result) } }) }), result);
});

test("codex JSONL stdout falls back to the last agent message when the final-message file is missing", () => {
  const result = { requirements: [{ requirement_id: "REQ-1" }] };
  const stdout = [
    { type: "item.completed", item: { type: "command_execution", status: "completed", aggregated_output: "{}" } },
    { type: "item.completed", item: { type: "agent_message", text: "draft" } },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } },
    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  ].map((line) => JSON.stringify(line)).join("\n");
  assert.deepEqual(parseHarnessOutput({ harness: "codex", stdout }), result);
});

test("harness usage is normalized to uncached input, cache reads and writes, output, and cost", () => {
  const jsonl = (...lines) => lines.map((line) => JSON.stringify(line)).join("\n");
  assert.deepEqual(parseHarnessUsage({ harness: "codex", stdout: jsonl({ type: "turn.completed", usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 } }, { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 8 } }) }), { input_tokens: 415, cache_read_tokens: 24448, cache_write_tokens: 0, output_tokens: 130, cost_usd: null });
  const gemini = JSON.stringify({ response: "{}", stats: { models: { "gemini-pro": { tokens: { prompt: 1000, cached: 400, candidates: 50, thoughts: 25 } }, "gemini-flash": { tokens: { prompt: 10, cached: 0, candidates: 5, thoughts: 0 } } } } }, null, 2);
  assert.deepEqual(parseHarnessUsage({ harness: "gemini", stdout: gemini }), { input_tokens: 610, cache_read_tokens: 400, cache_write_tokens: 0, output_tokens: 80, cost_usd: null });
  assert.deepEqual(parseHarnessUsage({ harness: "opencode", stdout: jsonl({ type: "step_finish", part: { cost: 0.25, tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 90, write: 5 } } } }, { type: "text", part: { text: "{}" } }, { type: "step_finish", part: { cost: 0.5, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } }) }), { input_tokens: 11, cache_read_tokens: 90, cache_write_tokens: 5, output_tokens: 7, cost_usd: 0.75 });
  assert.equal(parseHarnessUsage({ harness: "claude", stdout: "not json" }), null);
  assert.equal(parseHarnessUsage({ harness: "gemini", stdout: JSON.stringify({ response: "{}" }) }), null);
});

test("CLI bridge invokes every installed harness and returns the Hush JSON result", () => {
  const root = mkdtempSync(join(tmpdir(), "hush-harness-cli-"));
  const fake = join(root, "fake-harness.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const result = { requirements: [{ requirement_id: "REQ-1" }] };
const args = process.argv.slice(2);
const output = args.indexOf("--output-last-message");
if (output >= 0) {
  writeFileSync(args[output + 1], JSON.stringify(result));
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7 } }) + "\\n");
} else process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify(result), usage: { input_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 0, output_tokens: 7 }, total_cost_usd: 0.01 }));
readFileSync(0, "utf8");
`);
  chmodSync(fake, 0o755);
  const expectedUsage = { codex: { input_tokens: 40, cache_read_tokens: 60, cache_write_tokens: 0, output_tokens: 7, cost_usd: null }, claude: { input_tokens: 40, cache_read_tokens: 60, cache_write_tokens: 0, output_tokens: 7, cost_usd: 0.01 } };
  for (const harness of SUPPORTED_HARNESSES) {
    const run = spawnSync(process.execPath, [cli, "harness-adapter", "--harness", harness, "--agent", "fable", "--executable", fake], { input: JSON.stringify(payload), encoding: "utf8" });
    assert.equal(run.status, 0, `${harness}: ${run.stderr}`);
    const usage = expectedUsage[harness] ? { [HARNESS_USAGE_KEY]: expectedUsage[harness] } : {};
    assert.deepEqual(JSON.parse(run.stdout), { requirements: [{ requirement_id: "REQ-1" }], ...usage });
  }
});
