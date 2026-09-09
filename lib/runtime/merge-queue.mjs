import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { validateAcceptance } from "./evidence.mjs";
import { appendStateEvent, replayRunState } from "./state.mjs";
import { repositoryIdentity } from "./worktree.mjs";

export const MERGE_STRATEGY = "cherry-pick";
export const MERGE_LOCK_MS = 10 * 60 * 1000;
export const MERGE_STATES = Object.freeze({
  READY_FOR_INTEGRATION: ["INTEGRATING", "BLOCKED"],
  INTEGRATING: ["INTEGRATED", "CONFLICTED", "FAILED", "BLOCKED"],
  INTEGRATED: ["READY_FOR_PR", "TARGETED_RECHECK"],
  CONFLICTED: ["REPAIR_PLANNED", "HUMAN_DECISION"],
  FAILED: ["REPAIR_PLANNED", "HUMAN_DECISION"],
  TARGETED_RECHECK: ["READY_FOR_PR", "REPAIR_PLANNED"],
});

export function mergeQueuePath(repo) {
  const canonicalRepo = canonicalRepository(repo);
  return join(canonicalRepo, ".hush", "merge-queue", repositoryIdentity(canonicalRepo), "events.jsonl");
}

export function orderQueueItems(items) {
  return [...items].sort((left, right) => number(left.priority, 0) - number(right.priority, 0) || number(left.enqueue_sequence, Number.MAX_SAFE_INTEGER) - number(right.enqueue_sequence, Number.MAX_SAFE_INTEGER) || String(left.candidate_id).localeCompare(String(right.candidate_id)));
}

export function evidenceReuseDecision(previous, current) {
  if (!previous || !current) return { decision: "FULL_RECHECK", reuse: false, reason: "missing evidence binding" };
  const paths = [...new Set([...(previous.changed_paths ?? []), ...(current.changed_paths ?? [])])];
  if (paths.some(isSharedHub)) return { decision: "FULL_RECHECK", reuse: false, reason: "shared hub or schema changed" };
  const same = previous.patch_digest && current.patch_digest && previous.patch_digest === current.patch_digest && previous.dependency_closure_digest && previous.dependency_closure_digest === current.dependency_closure_digest && Array.isArray(previous.dependency_closure) && previous.dependency_closure.length > 0 && Array.isArray(current.dependency_closure) && current.dependency_closure.length > 0 && previous.behavior_class === current.behavior_class && sameArray(previous.changed_paths, current.changed_paths);
  return same ? { decision: "REUSE_PRE_INTEGRATION", reuse: true, reason: "patch, closure, behavior, and changed paths unchanged" } : { decision: "TARGETED_RECHECK", reuse: false, reason: "observable patch or dependency closure changed" };
}

export function enqueueCandidate({ root = ".", repo, runId, candidateId, target, priority, itemId, now }) {
  const canonicalRepo = canonicalRepository(repo);
  const state = replayRunState(root, runId);
  const candidate = state.entities.candidate?.[candidateId];
  const packet = candidate?.packet_id ? state.entities.packet?.[candidate.packet_id] : null;
  const snapshot = candidate?.snapshot_id ? state.entities.snapshot?.[candidate.snapshot_id] : null;
  const puck = reportFor(state, candidate, "puck");
  const vera = reportFor(state, candidate, "vera");
  if (!candidate || candidate.status !== "ACCEPTED") throw new Error("CANDIDATE_NOT_ACCEPTED");
  if (!packet || packet.packet_state !== "ACTIVE") throw new Error("PACKET_NOT_ACTIVE");
  if (!snapshot || !(snapshot.frozen === true || snapshot.state === "FROZEN")) throw new Error("SNAPSHOT_NOT_FROZEN");
  const acceptance = validateAcceptance({ packet: strip(packet), snapshot: strip(snapshot), candidate: strip(candidate), puck, vera, required: packet.vera_required });
  if (!acceptance.valid) throw new Error(`EVIDENCE_INCOMPLETE: ${acceptance.errors.join("; ")}`);
  validateTarget(target);
  const id = itemId ?? `MQ-${safeSegment(target)}-${safeSegment(candidateId)}`;
  const existing = latestQueueItems(canonicalRepo).find((item) => item.item_id === id);
  if (existing) {
    if (existing.candidate_id !== candidateId || existing.target !== target || existing.patch_digest !== candidate.patch_digest) throw new Error("QUEUE_ITEM_ID_CONFLICT");
    return { status: "IDEMPOTENT", item: existing };
  }
  const events = readQueueEvents(canonicalRepo);
  const item = {
    item_id: id,
    run_id: runId,
    candidate_id: candidateId,
    target,
    priority: number(priority, number(candidate.priority, 0)),
    enqueue_sequence: events.filter((event) => event.action === "enqueued").length + 1,
    status: "READY_FOR_INTEGRATION",
    packet_id: candidate.packet_id,
    snapshot_id: candidate.snapshot_id,
    patch_digest: candidate.patch_digest,
    dependency_closure: candidate.dependency_closure ?? [],
    dependency_closure_digest: candidate.dependency_closure_digest ?? null,
    behavior_class: candidate.behavior_class ?? null,
    changed_paths: candidate.changed_paths ?? [],
    repository: canonicalRepo,
    strategy: MERGE_STRATEGY,
    enqueued_at: now ?? new Date().toISOString(),
  };
  appendQueueEvent(canonicalRepo, "enqueued", item, now);
  appendMergeState(root, runId, id, "enqueued", item, "hush-queue-admission", now);
  return { status: "ENQUEUED", item };
}

export function queueStatus(repo, target) {
  const items = latestQueueItems(canonicalRepository(repo));
  return orderQueueItems(items.filter((item) => !target || item.target === target));
}

export function acquireTargetLock(repo, target, { owner = `hush-${process.pid}`, now, leaseMs = MERGE_LOCK_MS } = {}) {
  validateTarget(target);
  const canonicalRepo = canonicalRepository(repo);
  const current = readQueueEvents(canonicalRepo).filter((event) => event.action === "target-lock-acquired" && event.data.target === target).at(-1)?.data;
  const released = readQueueEvents(canonicalRepo).filter((event) => event.action === "target-lock-released" && event.data.target === target).at(-1)?.data;
  const timestamp = now ?? new Date().toISOString();
  if (current && (!released || Date.parse(released.released_at) < Date.parse(current.acquired_at)) && Date.parse(current.expires_at) > Date.parse(timestamp)) throw new Error("TARGET_LOCKED");
  if (current && (!released || Date.parse(released.released_at) < Date.parse(current.acquired_at))) appendQueueEvent(canonicalRepo, "target-lock-expired", { target, previous_lock_id: current.lock_id, expired_at: timestamp }, timestamp);
  const lockId = `LOCK-${sha256(`${target}:${owner}:${timestamp}`).slice(-16)}`;
  const lock = { lock_id: lockId, target, owner, acquired_at: timestamp, expires_at: new Date(Date.parse(timestamp) + leaseMs).toISOString() };
  appendQueueEvent(canonicalRepo, "target-lock-acquired", lock, timestamp);
  return lock;
}

export function releaseTargetLock(repo, lock, { now } = {}) {
  if (!lock?.lock_id) return { status: "NOOP" };
  const canonicalRepo = canonicalRepository(repo);
  appendQueueEvent(canonicalRepo, "target-lock-released", { ...lock, released_at: now ?? new Date().toISOString() }, now);
  return { status: "RELEASED", lock_id: lock.lock_id };
}

export function processNextMerge({ root = ".", repo, target, itemId, now, integrationChecks = [], owner, finalEvidence } = {}) {
  const canonicalRepo = canonicalRepository(repo);
  const item = orderQueueItems(queueStatus(canonicalRepo, target).filter((candidate) => candidate.status === "READY_FOR_INTEGRATION" && (!itemId || candidate.item_id === itemId)))[0];
  if (!item) return { status: "IDLE", item: null };
  const lock = acquireTargetLock(canonicalRepo, item.target, { owner, now });
  const timestamp = now ?? new Date().toISOString();
  try {
    const targetSha = git(canonicalRepo, ["rev-parse", `refs/heads/${item.target}`]).stdout.trim();
    const targetStatus = workingTreeStatus(canonicalRepo);
    if (targetStatus) return blockQueueItem(root, item, "DIRTY_TARGET", "HUSH", timestamp);
    let queueItem = transitionQueueItem(canonicalRepo, root, item, "INTEGRATING", { target_sha: targetSha, lock_id: lock.lock_id, integration_started_at: timestamp }, "target-lock-acquired", timestamp);
    const integration = createIntegrationWorktree(canonicalRepo, item, targetSha, timestamp);
    const candidate = replayRunState(root, item.run_id).entities.candidate?.[item.candidate_id];
    const sourceCommits = candidate?.commit_shas ?? (candidate?.end_sha ? [candidate.end_sha] : []);
    if (sourceCommits.length === 0) return failMerge(root, canonicalRepo, item, integration, "SOURCE_COMMIT_MISSING", "FLINT", timestamp);
    const cherryPicks = [];
    for (const sourceCommit of sourceCommits) {
      const result = git(integration.path, ["cherry-pick", "--no-edit", sourceCommit]);
      cherryPicks.push({ source_commit: sourceCommit, command: result.command, exit_status: result.status, stdout_digest: sha256(result.stdout), stderr_digest: sha256(result.stderr) });
      if (result.status !== 0) {
        git(integration.path, ["cherry-pick", "--abort"]);
        return failMerge(root, canonicalRepo, item, integration, "CODE_CONFLICT", "FLINT", timestamp, { cherry_picks: cherryPicks });
      }
    }
    const resultSha = git(integration.path, ["rev-parse", "HEAD"]).stdout.trim();
    const changedPaths = git(integration.path, ["diff", "--name-only", targetSha, resultSha]).stdout.split("\n").filter(Boolean).sort();
    const currentEvidence = { patch_digest: item.patch_digest, dependency_closure_digest: item.dependency_closure_digest, dependency_closure: item.dependency_closure, behavior_class: item.behavior_class, changed_paths: changedPaths };
    const reuse = evidenceReuseDecision(item, currentEvidence);
    const checks = runChecks(integration.path, integrationChecks, timestamp);
    const integrationRecord = { integration_id: `INT-${item.item_id}`, item_id: item.item_id, integration_worktree_id: integration.integration_id, integration_path: integration.path, integration_branch: integration.branch, strategy: MERGE_STRATEGY, target: item.target, target_sha: targetSha, source_commits: sourceCommits, cherry_picks: cherryPicks, resulting_sha: resultSha, checks, evidence_decision: reuse, command_digest: sha256(JSON.stringify(cherryPicks)), created_at: timestamp };
    appendQueueEvent(canonicalRepo, "integration-recorded", integrationRecord, timestamp);
    appendMergeState(root, item.run_id, item.item_id, "integration-recorded", integrationRecord, "cherry-pick-integration", timestamp);
    if (checks.some((check) => check.exit_status !== 0)) return failMerge(root, canonicalRepo, item, integration, "INTEGRATION_CHECK_FAILED", "FLINT", timestamp, { integration_record: integrationRecord });
    const snapshot = createIntegrationSnapshot(integration.path, item, targetSha, resultSha, changedPaths, timestamp);
    appendQueueEvent(canonicalRepo, "snapshot-created", snapshot, timestamp);
    appendMergeState(root, item.run_id, item.item_id, "snapshot-created", snapshot, "integration-snapshot", timestamp);
    if (!reuse.reuse && !finalEvidence) {
      queueItem = transitionQueueItem(canonicalRepo, root, queueItem, "TARGETED_RECHECK", { integration_snapshot_id: snapshot.snapshot_id, evidence_decision: reuse }, "evidence-boundary", timestamp);
      return { status: "TARGETED_RECHECK", item: queueItem, integration, snapshot, evidence_decision: reuse };
    }
    if (finalEvidence) {
      const check = validateFinalEvidence(finalEvidence, item, snapshot);
      if (!check.valid) return failMerge(root, canonicalRepo, item, integration, "FINAL_EVIDENCE_INVALID", "HUSH", timestamp, { errors: check.errors });
    }
    queueItem = transitionQueueItem(canonicalRepo, root, queueItem, "INTEGRATED", { integration_snapshot_id: snapshot.snapshot_id, resulting_sha: resultSha, evidence_decision: reuse }, "integration-passed", timestamp);
    queueItem = transitionQueueItem(canonicalRepo, root, queueItem, "READY_FOR_PR", { integration_snapshot_id: snapshot.snapshot_id, acceptance_record_id: `ACC-${item.item_id}` }, "local-integration-complete", timestamp);
    return { status: "READY_FOR_PR", item: queueItem, integration: integrationRecord, integration_worktree: integration, integration_record: integrationRecord, snapshot, evidence_decision: reuse };
  } finally {
    releaseTargetLock(canonicalRepo, lock, { now: timestamp });
  }
}

export function abortMerge({ root = ".", repo, itemId, reason = "HUMAN_ABORT", now } = {}) {
  const canonicalRepo = canonicalRepository(repo);
  const item = queueStatus(canonicalRepo).find((candidate) => candidate.item_id === itemId);
  if (!item) throw new Error("QUEUE_ITEM_NOT_FOUND");
  const status = item.status === "CONFLICTED" || item.status === "FAILED" ? "HUMAN_DECISION" : "BLOCKED";
  transitionQueueItem(canonicalRepo, root, item, status, { reason }, "human-decision", now);
  return { item_id: itemId, status, reason };
}

function blockQueueItem(root, item, reason, route, timestamp) {
  const next = { ...item, status: "BLOCKED", block_reason: reason, route };
  appendMergeState(root, item.run_id, item.item_id, "blocked", next, reason, timestamp);
  appendQueueEventFromItem(item, "blocked", next, timestamp, item.repository);
  return { status: "BLOCKED", item: next, reason };
}

function failMerge(root, repo, item, integration, reason, route, timestamp, extra = {}) {
  const status = reason === "CODE_CONFLICT" ? "CONFLICTED" : "FAILED";
  const next = { ...item, status, failure_reason: reason, route, integration_path: integration.path, ...extra };
  appendMergeState(root, item.run_id, item.item_id, status.toLowerCase(), next, reason, timestamp);
  appendQueueEventFromItem(item, status.toLowerCase(), next, timestamp, repo);
  return { status, item: next, integration, route, reason };
}

function transitionQueueItem(repo, root, item, status, data, cause, timestamp) {
  if (!(MERGE_STATES[item.status]?.includes(status) ?? false)) throw new Error(`Invalid merge transition: ${item.status} -> ${status}`);
  const next = { ...item, ...data, status };
  appendQueueEventFromItem(item, actionFor(status), next, timestamp, repo);
  appendMergeState(root, item.run_id, item.item_id, actionFor(status), next, cause, timestamp);
  return next;
}

function appendQueueEventFromItem(item, action, data, timestamp, repo) {
  if (!repo) return;
  appendQueueEvent(repo, action, data, timestamp);
}

function appendMergeState(root, runId, id, action, data, cause, timestamp) {
  return appendStateEvent(root, runId, { entity_type: "merge_event", entity_id: id, action, actor: "hush", cause, timestamp, data });
}

function createIntegrationWorktree(repo, item, targetSha, timestamp) {
  const path = resolve(repo, ".hush", "integration", repositoryIdentity(repo), safeSegment(item.item_id));
  mkdirSync(resolve(repo, ".hush", "integration", repositoryIdentity(repo)), { recursive: true });
  if (existsSync(path)) throw new Error("INTEGRATION_WORKTREE_EXISTS");
  const branch = `hush/integration/${safeSegment(item.item_id)}`;
  const result = git(repo, ["worktree", "add", "-b", branch, path, targetSha]);
  if (result.status !== 0) throw new Error(`INTEGRATION_WORKTREE_FAILED: ${result.stderr.trim()}`);
  return { integration_id: `IW-${item.item_id}`, path, branch, target_sha: targetSha, created_at: timestamp };
}

function createIntegrationSnapshot(path, item, targetSha, resultSha, changedPaths, timestamp) {
  const tree = git(path, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
  const diff = git(path, ["diff", `${targetSha}..${resultSha}`]).stdout;
  return { snapshot_id: `SNAP-INT-${item.item_id}`, candidate_id: item.candidate_id, item_id: item.item_id, base_sha: targetSha, end_sha: resultSha, tree_digest: sha256(tree), diff_digest: sha256(diff), manifest_digest: sha256(JSON.stringify({ targetSha, resultSha, changedPaths })), changed_paths: changedPaths, state: "FROZEN", frozen: true, created_at: timestamp };
}

function runChecks(cwd, commands, timestamp) {
  return commands.map((command) => { const result = spawnSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HUSH_NETWORK_POLICY: "disabled" } }); return { command, cwd, exit_status: result.status ?? 1, stdout_digest: sha256(result.stdout ?? ""), stderr_digest: sha256(result.stderr ?? ""), checked_at: timestamp }; });
}

function validateFinalEvidence(reports, item, snapshot) {
  const puck = reports.puck ?? reports.PUCK;
  const vera = reports.vera ?? reports.VERA;
  const packet = reports.packet;
  return validateAcceptance({ packet, snapshot, candidate: reports.candidate, puck, vera, required: packet?.vera_required });
}

function reportFor(state, candidate, gate) {
  const id = candidate?.[`${gate}_evidence_id`] ?? candidate?.[`${gate}EvidenceId`];
  const evidence = id ? state.entities.evidence?.[id] : null;
  return evidence?.report ?? evidence ?? candidate?.[`${gate}_report`] ?? null;
}

function latestQueueItems(repo) {
  const latest = new Map();
  const stateActions = new Set(["enqueued", "ready-for-integration", "integrating", "integrated", "ready-for-pr", "targeted-recheck", "conflicted", "failed", "blocked", "human-decision", "repair-planned"]);
  for (const event of readQueueEvents(repo)) if (event.data?.item_id && stateActions.has(event.action)) latest.set(event.data.item_id, event.data);
  return [...latest.values()];
}

function readQueueEvents(repo) {
  const path = mergeQueuePath(repo);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function appendQueueEvent(repo, action, data, timestamp) {
  const path = mergeQueuePath(repo);
  mkdirSync(resolve(path, ".."), { recursive: true });
  const lockPath = `${path}.lock`;
  let fd;
  try {
    fd = openSync(lockPath, "wx");
    const events = readQueueEvents(repo);
    const event = { event_id: `MQE-${String(events.length + 1).padStart(6, "0")}`, revision: events.length + 1, prior_revision: events.length || null, action, actor: "hush", cause: action, timestamp: timestamp ?? new Date().toISOString(), data };
    writeFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
    return event;
  } finally {
    if (fd !== undefined) { closeSync(fd); try { unlinkSync(lockPath); } catch {} }
  }
}

function canonicalRepository(repo) {
  const candidate = resolve(repo);
  const result = git(candidate, ["rev-parse", "--show-toplevel"]);
  if (result.status !== 0) throw new Error("REPOSITORY_REQUIRED");
  return resolve(result.stdout.trim());
}
function git(cwd, args) { const result = spawnSync("git", args, { cwd, encoding: "utf8" }); return { ...result, status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", command: ["git", ...args].join(" ") }; }
function validateTarget(target) { if (typeof target !== "string" || !target || target.startsWith("-") || target.includes("..") || target.includes("~") || target.includes("^") || target.includes(":")) throw new Error("TARGET_INVALID"); }
function safeSegment(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error("UNSAFE_ID"); return value; }
function number(value, fallback) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
function sameArray(left = [], right = []) { return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort()); }
function isSharedHub(path) { return /(^|\/)(state\.mjs|packet\.mjs|packet\.schema\.json|package\.json|auth|schema|migration)(\/|$)/i.test(path); }
function actionFor(status) { return status.toLowerCase().replaceAll("_", "-"); }
function sha256(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function strip(record) { const copy = { ...record }; for (const key of ["id", "type", "revision", "updated_at", "last_event_id"]) delete copy[key]; return copy; }
function workingTreeStatus(repo) { return git(repo, ["status", "--porcelain"]).stdout.split("\n").filter((line) => line && !line.endsWith(" .hush/") && !line.includes(" .hush/")).join("\n"); }
