import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { replayRunState } from "../lib/runtime/state.mjs";

const runner = join(process.cwd(), "bin", "hush-agents.mjs");

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function sha(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function packetDigest(packet) {
  const copy = { ...packet };
  delete copy.digest;
  return sha(canonical(copy));
}

function reportDigest(report) {
  const copy = { ...report };
  delete copy.report_digest;
  return sha(canonical(copy));
}

function adapterFixture() {
  return `
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const input = JSON.parse(readFileSync(0, "utf8"));
const digest = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const canonical = (value) => value === null || typeof value !== "object"
  ? JSON.stringify(value)
  : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
  : "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
const seal = (value) => { const packet = { ...value }; delete packet.digest; return { ...packet, digest: digest(canonical(packet)) }; };
const report = (value) => { const next = { ...value }; delete next.report_digest; return { ...next, report_digest: digest(canonical(next)) }; };
const sourceDigest = input.requirements?.[0]?.source?.digest;
let output;

if (input.role === "fable") {
  const quote = input.prd_text.trim();
  const source = { path: input.prd_path, location: input.source_manifest.location, digest: input.prd_digest };
  output = { requirements: [{ requirement_id: "REQ-1", revision: 1, source, quote, expected_behavior: "produce result.txt", actor: "user", permissions: ["write result"], baseline_status: "REPORTED", enumeration_status: "EXHAUSTIVE", approval_state: "APPROVED", risk: input.prd_text.includes("HIGH_RISK") ? "HIGH" : undefined, tags: input.prd_text.includes("HIGH_RISK") ? ["FABLE-HIGH-RISK"] : undefined, unknowns: input.prd_text.includes("AMBIGUOUS") ? ["clarify expected output"] : [], source_discovery: { method: "fixture-read", ...source, status: "VERIFIED" }, quote_back: { quote, location: source.location, digest: source.digest, verified: true } }] };
} else if (input.role === "rook") {
  const environment = input.environment;
  const packet = seal({ contract_version: "hec.v1", run_id: input.run_id, plan_id: "PLAN-1", task_id: "TASK-1", packet_id: "PKT-1", packet_revision: 1, requirement_map_revision: 1, target_agent: "flint", base_sha: input.base_sha, source_refs: [{ snapshot_id: "SRC-1", manifest_digest: sourceDigest, location: "prd.md:1" }], requirements: ["REQ-1"], allowed_paths: ["result.txt"], write_paths: ["result.txt"], write_path_inventory: ["result.txt"], allowed_operations: ["create", "edit", "test"], blocked_paths: [], exclusive_hubs: [], dependencies: [], required_commands: ["node --version"], acceptance_checks: [{ check_id: "CHECK-1", executor: "puck", command: "node --version", expected_result: "pass", requirement_ids: ["REQ-1"], write_paths: ["result.txt"], evidence_artifact_id: "ART-1" }], expected_evidence: ["ART-1"], environment, vera_required: true, vera_trigger: "always", attempt: 1, strike_count: 0, expires_at: null, supersedes: [], packet_state: "ACTIVE" });
  if (input.requirements[0].risk === "HIGH") packet.mutation_policy = { required: true, tool: "strykerjs", checks: ["authorization", "publication", "consent", "audit", "security"] };
  output = { plan_id: "PLAN-1", tasks: [{ task_id: "TASK-1", requirements: ["REQ-1"], packet: seal(packet) }] };
} else if (input.role === "flint") {
  writeFileSync(input.worktree_path + "/result.txt", "implemented\\n");
  execFileSync("git", ["add", "result.txt"], { cwd: input.worktree_path });
  execFileSync("git", ["commit", "-m", "feat: implement result"], { cwd: input.worktree_path, stdio: "ignore" });
  output = { candidate_id: "CAND-TASK-1", dependency_closure: ["REQ-1"], behavior_class: "RESULT_OUTPUT" };
} else if (input.role === "puck" || input.role === "vera") {
  const snapshot = input.snapshot;
  const packet = input.packet;
  const candidate = input.candidate;
  const gate = input.role.toUpperCase();
  const value = { report_id: gate + "-REPORT", gate, phase: "PRE_INTEGRATION", packet_id: packet.packet_id, source_manifest_digest: packet.source_refs[0].manifest_digest, candidate_id: candidate.candidate_id, candidate_patch_digest: candidate.patch_digest, candidate_tree_digest: snapshot.tree_digest, candidate_diff_digest: snapshot.diff_digest, snapshot_id: snapshot.snapshot_id, gate_run_id: input.run_id + "-" + gate, verdict: "PASS", created_by: input.role, observed_write_paths: ["result.txt"], check_results: [{ check_id: "CHECK-1", status: "PASS", exit_status: 0, artifact_id: "ART-1", artifact_path: "/tmp/hush-runner-artifact", artifact_digest: digest("artifact"), write_paths: ["result.txt"] }] };
  output = { report: report(value) };
}

process.stdout.write(JSON.stringify(output));
`;
}

function setupFixture({ ambiguous = false, highRisk = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hush-runner-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
  git(repo, "config", "user.email", "hush@example.test");
  git(repo, "config", "user.name", "Hush Test");
  writeFileSync(join(repo, "prd.md"), ambiguous ? "AMBIGUOUS requirement\\n" : highRisk ? "HIGH_RISK requirement\\n" : "Implement result output.\\n");
  git(repo, "add", "prd.md");
  git(repo, "commit", "-m", "docs: add prd");

  const adapter = join(root, "adapter.mjs");
  writeFileSync(adapter, adapterFixture());
  const profile = join(root, "setup-profile.json");
  writeFileSync(profile, JSON.stringify({ setup_commands: [] }));
  const environment = {
    network: "disabled", database: "ephemeral-test-only", credentials: "fake-only", email: "sink-only", webhooks: "disabled", uploads: "disabled", test_data: "generated", cleanup: [],
    hazards: [
      ["database", "ephemeral-test-only"], ["credentials", "fake-only"], ["email", "sink-only"], ["webhooks", "disabled"], ["uploads", "disabled"], ["network", "disabled"],
    ].map(([category, policy], index) => ({ hazard_id: `HAZ-${index}`, repository: repo, category, policy, status: "MITIGATED", evidence: { method: "fixture", source: "runner-test" } })),
  };
  const command = [process.execPath, adapter];
  const config = join(root, "run-config.json");
  writeFileSync(config, JSON.stringify({
    setup_profile: profile,
    environment,
    max_workers: 1,
    capacity: { available_workers: 1, safe_limit: 1, confidence: "HIGH", observed_at: "2026-09-10T00:00:00.000Z" },
    integration_checks: ["git diff --exit-code"],
    adapters: Object.fromEntries(["fable", "rook", "flint", "puck", "vera"].map((role) => [role, { command }])),
  }, null, 2));
  return { root, repo, config };
}

function run(args, cwd) {
  return spawnSync(process.execPath, [runner, ...args], { cwd, encoding: "utf8" });
}

test("run executes the configured crew through acceptance and local integration", () => {
  const fixture = setupFixture();
  const result = run(["run", "prd.md", "--repo", fixture.repo, "--target", "main", "--config", fixture.config, "--json"], fixture.repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "ACCEPTED");
  assert.equal(summary.exit_code, 0);
  assert.deepEqual(summary.task_ids, ["TASK-1"]);
  const state = replayRunState(fixture.repo, summary.run_id);
  assert.equal(state.entities.run[summary.run_id].status, "ACCEPTED");
  assert.equal(state.entities.task["TASK-1"].status, "ACCEPTED");
  const merge = state.entities.merge_event[`MQ-main-CAND-TASK-1`];
  assert.equal(merge.status, "READY_FOR_PR");
  assert.equal(readFileSync(join(merge.integration_path, "result.txt"), "utf8"), "implemented\n");

  const resumed = run(["run", "prd.md", "--repo", fixture.repo, "--target", "main", "--config", fixture.config, "--resume", summary.run_id, "--json"], fixture.repo);
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  assert.equal(JSON.parse(resumed.stdout).run_id, summary.run_id);
});

test("run dry-run validates without creating run state", () => {
  const fixture = setupFixture();
  const result = run(["run", "prd.md", "--repo", fixture.repo, "--target", "main", "--config", fixture.config, "--dry-run", "--json"], fixture.repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, "DRY_RUN_READY");
  assert.equal(existsSync(join(fixture.repo, ".hush", "runs")), false, "dry-run must not create run state");
});

test("run rejects an ambiguous requirement as a durable block", () => {
  const fixture = setupFixture({ ambiguous: true });
  const result = run(["run", "prd.md", "--repo", fixture.repo, "--target", "main", "--config", fixture.config, "--json"], fixture.repo);
  assert.equal(result.status, 3, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "BLOCKING_UNKNOWN");
  assert.equal(replayRunState(fixture.repo, summary.run_id).entities.run[summary.run_id].status, "BLOCKING_UNKNOWN");
});

test("run blocks high-risk work when committed mutation configuration is absent", () => {
  const fixture = setupFixture({ highRisk: true });
  const result = run(["run", "prd.md", "--repo", fixture.repo, "--target", "main", "--config", fixture.config, "--json"], fixture.repo);
  assert.equal(result.status, 3, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "BLOCKED");
  assert.equal(summary.blockers.task_id, "TASK-1");
  assert.match(summary.blockers.reason, /MUTATION_CONFIG_MISSING|MUTATION_CHECK_FAILED/);
});
