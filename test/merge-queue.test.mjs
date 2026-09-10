import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeReportDigest } from "../lib/runtime/evidence.mjs";
import { appendStateEvent } from "../lib/runtime/state.mjs";
import { evidenceReuseDecision, enqueueCandidate, processNextMerge, queueStatus, acquireTargetLock, releaseTargetLock } from "../lib/runtime/merge-queue.mjs";
import { sealPacket } from "../lib/runtime/packet.mjs";

function git(repo, ...args) { return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(); }
function repoFixture() {
  const repo = mkdtempSync(join(tmpdir(), "hush-merge-repo-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "hush@example.test");
  git(repo, "config", "user.name", "Hush Test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "base");
  return { repo, baseSha: git(repo, "rev-parse", "HEAD") };
}
function commitCandidate(repo, baseSha, id, path, content) {
  git(repo, "checkout", "-b", `feature-${id}`, baseSha);
  writeFileSync(join(repo, path), content);
  git(repo, "add", path);
  git(repo, "commit", "-m", `candidate ${id}`);
  const sha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "main");
  git(repo, "branch", "-D", `feature-${id}`);
  return sha;
}
function packet(baseSha, id) {
  return sealPacket({
    contract_version: "hec.v1", run_id: "RUN-MQ", plan_id: "PLAN-MQ", task_id: `TASK-${id}`, packet_id: `PKT-${id}`, packet_revision: 1, requirement_map_revision: 1,
    target_agent: "flint", base_sha: baseSha, source_refs: [{ snapshot_id: `SRC-${id}`, manifest_digest: `sha256:${"b".repeat(64)}`, location: "docs/prd-merge-queue.md" }], requirements: ["MQ-001"],
    allowed_paths: ["README.md", "feature.txt", "conflict.txt", "failure.txt"], write_paths: ["README.md"], allowed_operations: ["create", "edit", "test"], blocked_paths: [], exclusive_hubs: [], dependencies: [], required_commands: ["npm test"],
    acceptance_checks: [{ check_id: `MQ-CHECK-${id}`, executor: "puck", command: "npm test", expected_result: "pass", requirement_ids: ["MQ-001"], write_paths: ["README.md"], evidence_artifact_id: `ART-${id}` }], expected_evidence: ["puck report"],
    environment: { network: "disabled", database: "ephemeral-test-only", credentials: "fake-only", email: "sink-only", webhooks: "disabled", uploads: "disabled", test_data: "generated", cleanup: [], hazards: [["database", "ephemeral-test-only"], ["credentials", "fake-only"], ["email", "sink-only"], ["webhooks", "disabled"], ["uploads", "disabled"], ["network", "disabled"]].map(([category, policy], index) => ({ hazard_id: `HAZ-M-${index}`, repository: "merge-test", category, policy, status: "MITIGATED", evidence: "fixture" })) }, vera_required: false, vera_trigger: null,
    attempt: 1, strike_count: 0, expires_at: null, supersedes: [], packet_state: "ACTIVE",
  });
}
function addCandidate(repo, id, baseSha, commitSha, changedPath, withEvidence = true, priority = 0, behaviorClass = "merge") {
  const runId = "RUN-MQ";
  const p = packet(baseSha, id);
  const treeDigest = `sha256:${String(id).padEnd(64, "0")}`;
  const diffDigest = `sha256:${String(id).padEnd(64, "1")}`;
  const snapshot = { snapshot_id: `SNAP-${id}`, candidate_id: id, base_sha: baseSha, end_sha: commitSha, tree_digest: treeDigest, diff_digest: diffDigest, manifest_digest: `sha256:${"c".repeat(64)}`, changed_paths: [changedPath], state: "FROZEN", frozen: true };
  appendStateEvent(repo, runId, { entity_type: "packet", entity_id: p.packet_id, action: "issued", actor: "hush", cause: "test", data: p });
  appendStateEvent(repo, runId, { entity_type: "snapshot", entity_id: snapshot.snapshot_id, action: "frozen", actor: "hush", cause: "test", data: snapshot });
  const candidate = { candidate_id: id, status: "ACCEPTED", packet_id: p.packet_id, snapshot_id: snapshot.snapshot_id, patch_digest: `sha256:${id.padEnd(64, "2")}`, dependency_closure: ["TASK-MQ"], dependency_closure_digest: `sha256:${"d".repeat(64)}`, behavior_class: behaviorClass, changed_paths: [changedPath], commit_shas: [commitSha], priority };
  if (withEvidence) {
    const report = { report_id: `RPT-${id}`, gate: "PUCK", phase: "PRE_INTEGRATION", packet_id: p.packet_id, source_manifest_digest: p.source_refs[0].manifest_digest, candidate_id: id, candidate_patch_digest: candidate.patch_digest, candidate_tree_digest: treeDigest, candidate_diff_digest: diffDigest, snapshot_id: snapshot.snapshot_id, gate_run_id: `GATE-${id}`, verdict: "PASS", created_by: "puck", observed_write_paths: ["README.md"], check_results: [{ check_id: `MQ-CHECK-${id}`, status: "PASS", exit_status: 0, write_paths: ["README.md"], artifact_id: `ART-${id}`, artifact_path: `/tmp/ART-${id}`, artifact_digest: "sha256:" + "e".repeat(64), command: "npm test", cwd: repo, runtime: "node test" }] };
    appendStateEvent(repo, runId, { entity_type: "evidence", entity_id: `EVD-${id}`, action: "verified", actor: "puck", cause: "test", data: { report: { ...report, report_digest: computeReportDigest(report) } } });
    candidate.puck_evidence_id = `EVD-${id}`;
  }
  appendStateEvent(repo, runId, { entity_type: "candidate", entity_id: id, action: "accepted", actor: "hush", cause: "test", data: candidate });
  return { candidate, packet: p, snapshot };
}
function seedRun(repo) { appendStateEvent(repo, "RUN-MQ", { entity_type: "run", entity_id: "RUN-MQ", action: "created", actor: "hush", cause: "test", data: { status: "OPEN" } }); }

test("rejects missing evidence, then admits FIFO priority and duplicate idempotency", () => {
  const { repo, baseSha } = repoFixture();
  seedRun(repo);
  const missingSha = commitCandidate(repo, baseSha, "MISSING", "feature.txt", "missing\n");
  addCandidate(repo, "MISSING", baseSha, missingSha, "feature.txt", false);
  assert.throws(() => enqueueCandidate({ root: repo, repo, runId: "RUN-MQ", candidateId: "MISSING", target: "main" }), /EVIDENCE_INCOMPLETE/);
  const shaB = commitCandidate(repo, baseSha, "B", "feature-b.txt", "b\n");
  const shaA = commitCandidate(repo, baseSha, "A", "feature-a.txt", "a\n");
  addCandidate(repo, "B", baseSha, shaB, "feature-b.txt", true, 2);
  addCandidate(repo, "A", baseSha, shaA, "feature-a.txt", true, 1);
  assert.equal(enqueueCandidate({ root: repo, repo, runId: "RUN-MQ", candidateId: "B", target: "main" }).status, "ENQUEUED");
  assert.equal(enqueueCandidate({ root: repo, repo, runId: "RUN-MQ", candidateId: "A", target: "main" }).status, "ENQUEUED");
  assert.deepEqual(queueStatus(repo, "main").map((item) => item.candidate_id), ["A", "B"]);
  assert.equal(enqueueCandidate({ root: repo, repo, runId: "RUN-MQ", candidateId: "A", target: "main" }).status, "IDEMPOTENT");
});

test("serializes target locks and records cherry-pick integration without touching target", () => {
  const { repo, baseSha } = repoFixture();
  seedRun(repo);
  const sourceSha = commitCandidate(repo, baseSha, "GOOD", "feature.txt", "good\n");
  addCandidate(repo, "GOOD", baseSha, sourceSha, "feature.txt");
  enqueueCandidate({ root: repo, repo, runId: "RUN-MQ", candidateId: "GOOD", target: "main" });
  const lock = acquireTargetLock(repo, "main", { owner: "test", now: "2026-09-10T00:00:00.000Z" });
  assert.throws(() => acquireTargetLock(repo, "main", { owner: "other", now: "2026-09-10T00:01:00.000Z" }), /TARGET_LOCKED/);
  releaseTargetLock(repo, lock, { now: "2026-09-10T00:02:00.000Z" });
  const result = processNextMerge({ root: repo, repo, target: "main", integrationChecks: ["git status --porcelain"], now: "2026-09-10T00:03:00.000Z" });
  assert.equal(result.status, "READY_FOR_PR");
  assert.equal(git(repo, "rev-parse", "main"), baseSha);
  assert.equal(result.integration.strategy, "cherry-pick");
  assert.equal(result.integration.source_commits[0], sourceSha);
  assert.equal(result.evidence_decision.decision, "REUSE_PRE_INTEGRATION");
  assert.equal(queueStatus(repo, "main")[0].status, "READY_FOR_PR");
});

test("routes cherry-pick conflicts and integration-check failures", () => {
  const { repo, baseSha } = repoFixture();
  seedRun(repo);
  const conflictSha = commitCandidate(repo, baseSha, "CONFLICT", "conflict.txt", "candidate\n");
  addCandidate(repo, "CONFLICT", baseSha, conflictSha, "conflict.txt");
  enqueueCandidate({ root: repo, repo, runId: "RUN-MQ", candidateId: "CONFLICT", target: "main" });
  writeFileSync(join(repo, "conflict.txt"), "target\n");
  git(repo, "add", "conflict.txt");
  git(repo, "commit", "-m", "target change");
  const conflict = processNextMerge({ root: repo, repo, target: "main" });
  assert.equal(conflict.status, "CONFLICTED");
  assert.equal(conflict.route, "FLINT");

  const targetSha = git(repo, "rev-parse", "main");
  const failureSha = commitCandidate(repo, targetSha, "FAIL", "failure.txt", "failure\n");
  addCandidate(repo, "FAIL", targetSha, failureSha, "failure.txt");
  enqueueCandidate({ root: repo, repo, runId: "RUN-MQ", candidateId: "FAIL", target: "main", priority: 1 });
  const failure = processNextMerge({ root: repo, repo, target: "main", integrationChecks: ["false"] });
  assert.equal(failure.status, "FAILED");
  assert.equal(failure.route, "FLINT");
});

test("evidence reuse boundaries require targeted or full recheck", () => {
  const base = { patch_digest: "p", dependency_closure_digest: "d", dependency_closure: ["TASK"], behavior_class: "merge", changed_paths: ["feature.txt"] };
  assert.equal(evidenceReuseDecision(base, { ...base }).decision, "REUSE_PRE_INTEGRATION");
  assert.equal(evidenceReuseDecision(base, { ...base, patch_digest: "changed" }).decision, "TARGETED_RECHECK");
  assert.equal(evidenceReuseDecision(base, { ...base, changed_paths: ["lib/runtime/state.mjs"] }).decision, "FULL_RECHECK");
  assert.equal(evidenceReuseDecision({ ...base, dependency_closure: [] }, base).decision, "TARGETED_RECHECK");
});
