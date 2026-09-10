import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { replayRunState } from "../lib/runtime/state.mjs";
import { listWorktrees } from "../lib/runtime/worktree.mjs";

const runner = join(process.cwd(), "bin", "hush-agents.mjs");

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function parallelAdapter() {
  return `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const input = JSON.parse(readFileSync(0, "utf8"));
const taskCount = Number(process.argv[3]);
const logPath = process.argv[2];
const crashPath = process.argv[4];
const digest = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const canonical = (value) => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" : "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
const seal = (value) => { const packet = { ...value }; delete packet.digest; return { ...packet, digest: digest(canonical(packet)) }; };
const report = (value) => { const next = { ...value }; delete next.report_digest; return { ...next, report_digest: digest(canonical(next)) }; };
const log = (phase) => appendFileSync(logPath, JSON.stringify({ phase, role: input.role, task_id: input.task_id, at: Date.now() }) + "\\n");
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
log("start");
if (input.role === "flint" && crashPath) {
  try { writeFileSync(crashPath, "crashed\\n", { flag: "wx" }); process.kill(process.ppid, "SIGKILL"); } catch {}
}
if (["flint", "puck", "vera"].includes(input.role)) wait(60);
const number = Number(String(input.task_id ?? "TASK-0").split("-").at(-1));
let output;
if (input.role === "fable") {
  const quote = input.prd_text.trim();
  const source = { path: input.prd_path, location: input.source_manifest.location, digest: input.prd_digest };
  output = { requirements: Array.from({ length: taskCount }, (_, index) => ({ requirement_id: "REQ-" + (index + 1), revision: 1, source, quote, expected_behavior: "write result-" + (index + 1) + ".txt", actor: "user", permissions: ["write result"], baseline_status: "REPORTED", enumeration_status: "EXHAUSTIVE", approval_state: "APPROVED", unknowns: [], source_discovery: { method: "parallel-fixture", ...source, status: "VERIFIED" }, quote_back: { quote, location: source.location, digest: source.digest, verified: true } })) };
} else if (input.role === "rook") {
  const sourceDigest = input.requirements[0].source.digest;
  output = { plan_id: "PLAN-PARALLEL", tasks: input.requirements.map((requirement, index) => {
    const number = index + 1;
    const path = "result-" + number + ".txt";
    const packet = seal({ contract_version: "hec.v1", run_id: input.run_id, plan_id: "PLAN-PARALLEL", task_id: "TASK-" + number, packet_id: "PKT-" + number, packet_revision: 1, requirement_map_revision: 1, target_agent: "flint", base_sha: input.base_sha, source_refs: [{ snapshot_id: "SRC-1", manifest_digest: sourceDigest, location: "prd.md:1" }], requirements: [requirement.requirement_id], allowed_paths: [path], write_paths: [path], write_path_inventory: [path], allowed_operations: ["create", "edit", "test"], blocked_paths: [], exclusive_hubs: [], dependencies: [], required_commands: ["node --version"], acceptance_checks: [{ check_id: "CHECK-" + number, executor: "puck", command: "node --version", expected_result: "pass", requirement_ids: [requirement.requirement_id], write_paths: [path], evidence_artifact_id: "ART-" + number }], expected_evidence: ["ART-" + number], environment: input.environment, vera_required: true, vera_trigger: "always", attempt: 1, strike_count: 0, expires_at: null, supersedes: [], packet_state: "ACTIVE" });
    return { task_id: "TASK-" + number, requirements: [requirement.requirement_id], packet };
  }) };
} else if (input.role === "flint") {
  writeFileSync(input.worktree_path + "/result-" + number + ".txt", "implemented\\n");
  execFileSync("git", ["add", "."], { cwd: input.worktree_path });
  execFileSync("git", ["commit", "-m", "feat: implement result " + number], { cwd: input.worktree_path, stdio: "ignore" });
  output = { candidate_id: "CAND-TASK-" + number, dependency_closure: ["REQ-" + number], behavior_class: "RESULT_OUTPUT" };
} else if (input.role === "puck" || input.role === "vera") {
  const packet = input.packet;
  const candidate = input.candidate;
  const snapshot = input.snapshot;
  const gate = input.role.toUpperCase();
  const path = "result-" + number + ".txt";
  output = { report: report({ report_id: gate + "-REPORT-" + number, gate, phase: "PRE_INTEGRATION", packet_id: packet.packet_id, source_manifest_digest: packet.source_refs[0].manifest_digest, candidate_id: candidate.candidate_id, candidate_patch_digest: candidate.patch_digest, candidate_tree_digest: snapshot.tree_digest, candidate_diff_digest: snapshot.diff_digest, snapshot_id: snapshot.snapshot_id, gate_run_id: input.run_id + "-" + gate + "-" + number, verdict: "PASS", created_by: input.role, observed_write_paths: [path], check_results: [{ check_id: packet.acceptance_checks[0].check_id, status: "PASS", exit_status: 0, artifact_id: packet.acceptance_checks[0].evidence_artifact_id, artifact_path: "/tmp/hush-parallel-artifact", artifact_digest: digest("artifact"), write_paths: [path] }] }) };
}
log("end");
process.stdout.write(JSON.stringify(output));
`;
}

function setupFixture({ crashPath = null } = {}) {
  const taskCount = 4;
  const root = mkdtempSync(join(tmpdir(), "hush-runner-parallel-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
  git(repo, "config", "user.email", "hush@example.test");
  git(repo, "config", "user.name", "Hush Parallel Test");
  writeFileSync(join(repo, "prd.md"), "Implement four independent outputs.\\n");
  git(repo, "add", "prd.md");
  git(repo, "commit", "-m", "docs: add parallel prd");

  const logPath = join(root, "adapter-events.jsonl");
  const adapter = join(root, "adapter.mjs");
  writeFileSync(adapter, parallelAdapter());
  const profile = join(root, "setup-profile.json");
  writeFileSync(profile, JSON.stringify({ setup_commands: [] }));
  const environment = {
    network: "disabled", database: "ephemeral-test-only", credentials: "fake-only", email: "sink-only", webhooks: "disabled", uploads: "disabled", test_data: "generated", cleanup: [],
    hazards: [["database", "ephemeral-test-only"], ["credentials", "fake-only"], ["email", "sink-only"], ["webhooks", "disabled"], ["uploads", "disabled"], ["network", "disabled"]].map(([category, policy], index) => ({ hazard_id: `HAZ-${index}`, repository: repo, category, policy, status: "MITIGATED", evidence: { method: "fixture", source: "parallel-test" } })),
  };
  const command = [process.execPath, adapter, logPath, String(taskCount), ...(crashPath ? [crashPath] : [])];
  const config = join(root, "run-config.json");
  writeFileSync(config, JSON.stringify({ setup_profile: profile, environment, max_workers: taskCount, capacity: { available_workers: taskCount, safe_limit: taskCount, confidence: "HIGH", observed_at: "2026-09-10T00:00:00.000Z" }, integration_checks: ["git status --porcelain"], adapters: Object.fromEntries(["fable", "rook", "flint", "puck", "vera"].map((role) => [role, { command }])) }, null, 2));
  return { root, repo, config, logPath, taskCount };
}

test("runner dispatches independent tasks concurrently and delivers every candidate", () => {
  const fixture = setupFixture();
  const result = spawnSync(process.execPath, [runner, "run", "prd.md", "--repo", fixture.repo, "--target", "main", "--config", fixture.config, "--json"], { cwd: fixture.repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  const state = replayRunState(fixture.repo, summary.run_id);
  const accepted = Object.values(state.entities.candidate).filter((candidate) => candidate.status === "ACCEPTED");
  const readyMerges = Object.values(state.entities.merge_event).filter((item) => item.status === "READY_FOR_PR");
  const deliveries = Object.values(state.entities.delivery).filter((item) => item.status === "READY_FOR_PR");
  assert.equal(accepted.length, fixture.taskCount);
  assert.equal(readyMerges.length, fixture.taskCount);
  assert.equal(deliveries.length, fixture.taskCount);

  const intervals = new Map();
  for (const line of readFileSync(fixture.logPath, "utf8").trim().split("\n")) {
    const event = JSON.parse(line);
    const key = `${event.role}:${event.task_id ?? "run"}`;
    const interval = intervals.get(key) ?? {};
    interval[event.phase] = event.at;
    intervals.set(key, interval);
  }
  const spans = [...intervals.values()].filter((interval) => interval.start && interval.end).map((interval) => [interval.start, interval.end]);
  const points = spans.flatMap(([start, end]) => [[start, 1], [end, -1]]).sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  let active = 0;
  let maxOverlap = 0;
  for (const [, delta] of points) { active += delta; maxOverlap = Math.max(maxOverlap, active); }
  assert.equal(maxOverlap, fixture.taskCount);

  const integrationRoot = join(fixture.repo, ".hush", "integration", readdirSync(join(fixture.repo, ".hush", "integration"))[0]);
  for (let index = 1; index <= fixture.taskCount; index += 1) {
    const matching = readdirSync(integrationRoot).find((name) => name.endsWith(`CAND-TASK-${index}`));
    assert.ok(matching);
    assert.equal(existsSync(join(integrationRoot, matching, `result-${index}.txt`)), true);
  }
  assert.equal(listWorktrees(fixture.repo).filter((worktree) => worktree.state === "DESTROYED").length, fixture.taskCount);
});

test("runner resumes after the parent process is killed during parallel adapter execution", () => {
  const root = mkdtempSync(join(tmpdir(), "hush-runner-crash-"));
  const crashPath = join(root, "crash-once");
  const fixture = setupFixture({ crashPath });
  const first = spawnSync(process.execPath, [runner, "run", "prd.md", "--repo", fixture.repo, "--target", "main", "--config", fixture.config, "--json"], { cwd: fixture.repo, encoding: "utf8", timeout: 20_000 });
  assert.equal(first.signal, "SIGKILL");
  const runIds = readdirSync(join(fixture.repo, ".hush", "runs"));
  assert.equal(runIds.length, 1);
  const resumed = spawnSync(process.execPath, [runner, "run", "prd.md", "--repo", fixture.repo, "--target", "main", "--config", fixture.config, "--resume", runIds[0], "--json"], { cwd: fixture.repo, encoding: "utf8", timeout: 20_000 });
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  const state = replayRunState(fixture.repo, runIds[0]);
  assert.equal(Object.values(state.entities.task).every((task) => task.status === "ACCEPTED"), true);
  assert.equal(Object.values(state.entities.task).some((task) => task.attempt > 1), true);
  assert.equal(listWorktrees(fixture.repo).some((worktree) => worktree.state === "ALLOCATED"), false);
});
