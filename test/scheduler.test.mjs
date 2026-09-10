import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sealPacket } from "../lib/runtime/packet.mjs";
import { dispatchOne, dispatchReadyTasks, evidenceReuseDecision, orderReadyTasks, recoverExpiredLeases, recoverInterruptedLeases, routeFailure, taskQueue, writeRunSummary } from "../lib/runtime/scheduler.mjs";
import { appendStateEvent, replayRunState } from "../lib/runtime/state.mjs";

const root = () => mkdtempSync(join(tmpdir(), "hush-scheduler-"));
const sourceText = "scheduler fixture quote\n";
const sourceDigest = `sha256:${createHash("sha256").update(sourceText).digest("hex")}`;
const hazards = [["database", "ephemeral-test-only"], ["credentials", "fake-only"], ["email", "disabled"], ["webhooks", "disabled"], ["uploads", "disabled"], ["network", "disabled"]].map(([category, policy], index) => ({ hazard_id: `HAZ-S-${index}`, repository: "scheduler-test", category, policy, status: "MITIGATED", evidence: "fixture" }));
const environment = { network: "disabled", database: "ephemeral-test-only", credentials: "fake-only", email: "disabled", webhooks: "disabled", uploads: "disabled", test_data: "fake-only", cleanup: [], hazards };
const packet = (runId, taskId, index = 1) => sealPacket({ contract_version: "hec.v1", run_id: runId, plan_id: "PLAN-1", task_id: taskId, packet_id: `PKT-${taskId}`, packet_revision: 1, requirement_map_revision: 1, target_agent: "flint", base_sha: "a".repeat(40), source_refs: [{ snapshot_id: "SRC-1", manifest_digest: "sha256:" + "b".repeat(64), location: "docs/prd-scheduler.md" }], requirements: ["SCH-001"], allowed_paths: ["lib/runtime/scheduler.mjs"], write_paths: ["lib/runtime/scheduler.mjs"], allowed_operations: ["create", "edit", "test"], blocked_paths: [], exclusive_hubs: index === 1 ? ["scheduler"] : [], dependencies: [], required_commands: ["npm test"], acceptance_checks: [{ check_id: "CHK-1", executor: "puck", command: "npm test", expected_result: "pass", requirement_ids: ["SCH-001"], write_paths: ["lib/runtime/scheduler.mjs"], evidence_artifact_id: "ART-CHK-1" }], expected_evidence: ["puck"], environment, vera_required: false, vera_trigger: null, attempt: 1, strike_count: 0, expires_at: null, supersedes: [], packet_state: "ACTIVE" });
function seed(rootPath, runId, tasks, packets = {}) {
  mkdirSync(join(rootPath, "docs"), { recursive: true });
  writeFileSync(join(rootPath, "docs/fable-gaps-scheduler.md"), sourceText);
  appendStateEvent(rootPath, runId, { entity_type: "run", entity_id: runId, action: "created", actor: "hush", cause: "fixture", data: { status: "OPEN" }, timestamp: "2026-09-10T00:00:00.000Z" });
  appendStateEvent(rootPath, runId, { entity_type: "capacity_observation", entity_id: "CAP-FIXTURE", action: "observed", actor: "hush", cause: "fixture", data: { observation_id: "CAP-FIXTURE", available_workers: 8, safe_limit: 8, confidence: "HIGH", observed_at: "2026-09-10T00:00:00.000Z" }, timestamp: "2026-09-10T00:00:00.000Z" });
  appendStateEvent(rootPath, runId, { entity_type: "requirement", entity_id: "SCH-001", action: "approved", actor: "fable", cause: "prd", data: { requirement_id: "SCH-001", revision: 1, source: { path: "docs/fable-gaps-scheduler.md", location: "docs/fable-gaps-scheduler.md:1", digest: sourceDigest }, quote: "scheduler fixture quote", expected_behavior: "scheduler fixture", actor: "fable", permissions: ["hush"], baseline_status: "REPORTED", enumeration_status: "EXHAUSTIVE", approval_state: "APPROVED", unknowns: [], source_discovery: { method: "fixture", path: "docs/fable-gaps-scheduler.md", location: "docs/fable-gaps-scheduler.md:1", digest: sourceDigest, status: "VERIFIED" }, quote_back: { quote: "scheduler fixture quote", location: "docs/fable-gaps-scheduler.md:1", digest: sourceDigest, verified: true } }, timestamp: "2026-09-10T00:00:00.000Z" });
  for (const [id, data] of Object.entries(packets)) appendStateEvent(rootPath, runId, { entity_type: "packet", entity_id: id, action: "issued", actor: "hush", cause: "fixture", data, timestamp: "2026-09-10T00:00:00.000Z" });
  for (const task of tasks) appendStateEvent(rootPath, runId, { entity_type: "task", entity_id: task.id, action: "planned", actor: "rook", cause: "fixture", data: { ...task, requirements: ["SCH-001"], status: task.status ?? "READY" }, timestamp: "2026-09-10T00:00:00.000Z" });
}

test("orders by priority, dependency depth, and task id", () => {
  assert.deepEqual(orderReadyTasks([{ id: "T-2", priority: 1, dependency_depth: 2 }, { id: "T-3", priority: 1, dependency_depth: 1 }, { id: "T-1", priority: 1, dependency_depth: 1 }]).map((task) => task.id), ["T-1", "T-3", "T-2"]);
});

test("blocks missing prerequisite, packet, and shared hub", () => {
  const path = root();
  const runId = "RUN-1";
  const p = packet(runId, "T-1");
  seed(path, runId, [{ id: "T-1", priority: 1, packet_id: p.packet_id, dependencies: ["T-0"] }, { id: "T-2", priority: 2, packet_id: p.packet_id, exclusive_hubs: ["scheduler"] }], { [p.packet_id]: p });
  const queue = taskQueue(replayRunState(path, runId), { runId, maxWorkers: 1, root: path });
  assert.equal(queue.candidates.length, 0);
  assert.deepEqual(queue.blocked[0].reason.code, "PREREQUISITE_NOT_VERIFIED");
  dispatchReadyTasks(path, runId, { maxWorkers: 1 });
  const after = replayRunState(path, runId);
  assert.equal(Object.values(after.entities.finding).filter((finding) => finding.task_id === "T-1").length, 1);
});

test("admits at most eight workers and serializes hubs", () => {
  const path = root(); const runId = "RUN-1"; const packets = {}; const tasks = [];
  for (let i = 1; i <= 9; i += 1) { const id = `T-${String(i).padStart(2, "0")}`; const p = packet(runId, id, i); packets[p.packet_id] = p; tasks.push({ id, priority: i, packet_id: p.packet_id, exclusive_hubs: i === 1 ? ["scheduler"] : [] }); }
  seed(path, runId, tasks, packets);
  const result = dispatchReadyTasks(path, runId, { maxWorkers: 9, now: "2026-09-10T00:00:00.000Z" });
  assert.equal(result.dispatched.length, 8);
  assert.equal(replayRunState(path, runId).entities.task["T-09"].status, "READY");
});

test("recovers expired lease and routes strikes", () => {
  const path = root(); const runId = "RUN-1"; const p = packet(runId, "T-1");
  seed(path, runId, [{ id: "T-1", packet_id: p.packet_id }], { [p.packet_id]: p });
  dispatchOne(path, runId, { now: "2026-09-10T00:00:00.000Z", leaseMs: 10 });
  const recovery = recoverExpiredLeases(path, runId, { now: "2026-09-10T00:01:00.000Z" });
  assert.equal(recovery.recovered[0].reason, "WORKER_LEASE_EXPIRED");
  routeFailure(path, runId, "T-1", { cause: "IMPLEMENTATION_DEFECT" });
  routeFailure(path, runId, "T-1", { cause: "IMPLEMENTATION_DEFECT" });
  const third = routeFailure(path, runId, "T-1", { cause: "IMPLEMENTATION_DEFECT" });
  assert.equal(third.status, "HUMAN_DECISION");
});

test("resume turns every interrupted worker lease back into retryable work", () => {
  const path = root(); const runId = "RUN-RESUME"; const p = packet(runId, "T-1");
  seed(path, runId, [{ id: "T-1", packet_id: p.packet_id }], { [p.packet_id]: p });
  dispatchOne(path, runId, { now: "2026-09-10T00:00:00.000Z", leaseMs: 60 * 60 * 1000 });
  const recovery = recoverInterruptedLeases(path, runId, { now: "2026-09-10T00:01:00.000Z" });
  assert.equal(recovery.recovered[0].reason, "RUNNER_RESUME");
  assert.equal(replayRunState(path, runId).entities.task["T-1"].status, "READY");
  assert.equal(replayRunState(path, runId).entities.task["T-1"].attempt, 2);
  assert.equal(dispatchOne(path, runId, { now: "2026-09-10T00:02:00.000Z" }).dispatched.length, 1);
});

test("packet defects do not consume implementation strikes", () => {
  const path = root(); const runId = "RUN-1"; const p = packet(runId, "T-1");
  seed(path, runId, [{ id: "T-1", packet_id: p.packet_id }], { [p.packet_id]: p });
  const result = routeFailure(path, runId, "T-1", { cause: "PACKET_DEFECT" });
  assert.equal(result.strike_count, 0);
  assert.equal(result.route, "HUSH");
});

test("evidence reuse is conservative and summary is versioned", () => {
  assert.equal(evidenceReuseDecision({ patch_digest: "p", dependency_closure_digest: "d", dependency_closure: ["T-1"], behavior_class: "scheduler" }, { patch_digest: "p", dependency_closure_digest: "d", dependency_closure: ["T-1"], behavior_class: "scheduler" }).reuse, true);
  assert.equal(evidenceReuseDecision({ patch_digest: "p", dependency_closure_digest: "d", dependency_closure: [], behavior_class: "scheduler" }, { patch_digest: "p", dependency_closure_digest: "d", dependency_closure: [], behavior_class: "scheduler" }).reuse, false);
  const path = root(); const summary = writeRunSummary(path, "RUN-1");
  assert.equal(summary.summary_version, "scheduler.v1");
});
