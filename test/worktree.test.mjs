import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sealPacket } from "../lib/runtime/packet.mjs";
import { persistHazardInventory } from "../lib/runtime/environment.mjs";
import { appendStateEvent, replayRunState } from "../lib/runtime/state.mjs";
import { allocateWorktree, createWorktree, invalidateWarmBases, recoverExpiredWorktreeLeases, releaseWorktree, validateWorktree, warmWorktree } from "../lib/runtime/worktree.mjs";

function git(repo, ...args) { return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(); }
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "hush-worktree-repo-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "hush@example.test");
  git(repo, "config", "user.name", "Hush Test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD");
  const profile = join(repo, "profile.json");
  writeFileSync(profile, JSON.stringify({ setup_commands: ["git config hush.test warmed"], tool_versions: { node: "test" } }));
  const hazards = [["database", "ephemeral-test-only"], ["credentials", "fake-only"], ["email", "sink-only"], ["webhooks", "disabled"], ["uploads", "disabled"], ["network", "disabled"]].map(([category, policy], index) => ({ hazard_id: `HAZ-W-${index}`, repository: repo, category, policy, status: "MITIGATED", evidence: "fixture" }));
  persistHazardInventory(repo, repo, hazards);
  const packet = sealPacket({
    contract_version: "hec.v1", run_id: "RUN-WTB", plan_id: "PLAN-WTB", task_id: "TASK-WTB", packet_id: "PKT-WTB", packet_revision: 1, requirement_map_revision: 1,
    target_agent: "flint", base_sha: baseSha, source_refs: [{ snapshot_id: "SRC-WTB", manifest_digest: `sha256:${"a".repeat(64)}`, location: "docs/prd-warm-worktree-base.md" }], requirements: ["WTB-001"],
    allowed_paths: ["README.md"], write_paths: ["README.md"], allowed_operations: ["create", "edit", "test"], blocked_paths: [], exclusive_hubs: [], dependencies: [], required_commands: ["npm test"],
    acceptance_checks: [{ check_id: "WTB-CHECK", executor: "puck", command: "npm test", expected_result: "pass", requirement_ids: ["WTB-001"], write_paths: ["README.md"], evidence_artifact_id: "ART-WTB" }], expected_evidence: ["worktree record"],
    environment: { network: "disabled", database: "ephemeral-test-only", credentials: "fake-only", email: "sink-only", webhooks: "disabled", uploads: "disabled", test_data: "generated", cleanup: [], hazards }, vera_required: false, vera_trigger: null,
    attempt: 1, strike_count: 0, expires_at: null, supersedes: [], packet_state: "ACTIVE",
  });
  return { repo, baseSha, profile, packet };
}
function seedRun(repo, runId = "RUN-WTB") {
  appendStateEvent(repo, runId, { entity_type: "run", entity_id: runId, action: "created", actor: "hush", cause: "test", data: { status: "OPEN" } });
}

test("creates exact-base owned branch and validates clean packet binding", () => {
  const { repo, baseSha, packet } = fixture();
  seedRun(repo);
  const record = createWorktree({ repo, baseSha, runId: "RUN-WTB", taskId: "TASK-WTB" });
  assert.equal(record.branch, "hush/RUN-WTB/TASK-WTB");
  assert.equal(validateWorktree(record, packet).status, "VALID");
  assert.equal(git(record.absolute_path, "rev-parse", "HEAD"), baseSha);
  assert.throws(() => createWorktree({ repo, baseSha, runId: "RUN-WTB", taskId: "../escape" }), /safe path segment/);
});

test("warms only packet-approved setup, allocates one lease, and replays lifecycle", () => {
  const { repo, baseSha, profile, packet } = fixture();
  seedRun(repo);
  const warmed = warmWorktree({ repo, baseSha, runId: "RUN-WTB", taskId: "TASK-WTB", profile, packet, timestamp: "2026-09-10T00:00:00.000Z" });
  assert.equal(warmed.status, "WARM");
  const allocated = allocateWorktree({ root: repo, repo, runId: "RUN-WTB", taskId: "TASK-WTB", packet, now: "2026-09-10T00:01:00.000Z" });
  assert.equal(allocated.state, "ALLOCATED");
  assert.throws(() => allocateWorktree({ root: repo, repo, runId: "RUN-WTB", taskId: "TASK-WTB", packet }), /WORKTREE_UNAVAILABLE/);
  const released = releaseWorktree({ root: repo, runId: "RUN-WTB", worktreeId: allocated.worktree_id, now: "2026-09-10T00:02:00.000Z" });
  assert.equal(released.status, "WARM");
  const replay = replayRunState(repo, "RUN-WTB");
  assert.equal(replay.entities.worktree[allocated.worktree_id].state, "WARM");
  assert.ok(replay.events.every((event) => event.prior_revision === null || event.prior_revision < event.revision));
});

test("dirty release blocks and cleanup removes only released Hush worktrees", () => {
  const { repo, baseSha, profile, packet } = fixture();
  seedRun(repo);
  const first = warmWorktree({ repo, baseSha, runId: "RUN-WTB", taskId: "TASK-1", profile, packet }).worktree;
  const lease = allocateWorktree({ root: repo, repo, runId: "RUN-WTB", taskId: "TASK-1", packet });
  writeFileSync(join(lease.absolute_path, "unreviewed.txt"), "dirty\n");
  assert.equal(releaseWorktree({ root: repo, runId: "RUN-WTB", worktreeId: lease.worktree_id, cleanup: true }).status, "BLOCKED");
  const secondPacket = sealPacket({ ...packet, task_id: "TASK-2", packet_id: "PKT-WTB-2" });
  warmWorktree({ repo, baseSha, runId: "RUN-WTB", taskId: "TASK-2", profile, packet: secondPacket });
  const cleanLease = allocateWorktree({ root: repo, repo, runId: "RUN-WTB", taskId: "TASK-2", packet: secondPacket });
  assert.ok(first.absolute_path);
  assert.equal(releaseWorktree({ root: repo, runId: "RUN-WTB", worktreeId: cleanLease.worktree_id, cleanup: true }).status, "DESTROYED");
});

test("invalidates warm bases when source head changes", () => {
  const { repo, baseSha, profile, packet } = fixture();
  seedRun(repo);
  warmWorktree({ repo, baseSha, runId: "RUN-WTB", taskId: "TASK-WTB", profile, packet });
  writeFileSync(join(repo, "README.md"), "changed\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "advance source");
  const invalidated = invalidateWarmBases(repo, { root: repo });
  assert.equal(invalidated.length, 1);
  assert.equal(invalidated[0].invalidation_reason, "SOURCE_HEAD_CHANGED");
});

test("turns an expired worktree lease into a durable block", () => {
  const { repo, baseSha, profile, packet } = fixture();
  seedRun(repo);
  warmWorktree({ repo, baseSha, runId: "RUN-WTB", taskId: "TASK-WTB", profile, packet });
  const lease = allocateWorktree({ root: repo, repo, runId: "RUN-WTB", taskId: "TASK-WTB", packet, leaseMs: 10, now: "2026-09-10T00:00:00.000Z" });
  const recovered = recoverExpiredWorktreeLeases(repo, "RUN-WTB", { now: "2026-09-10T00:01:00.000Z" });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].worktree_id, lease.worktree_id);
  assert.equal(recovered[0].block_reason, "WORKTREE_LEASE_EXPIRED");
});
