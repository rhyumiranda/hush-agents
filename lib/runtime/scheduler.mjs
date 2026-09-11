import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { validatePacket } from "./packet.mjs";
import { hasBlockingUnknowns, validateRequirementRecord } from "./requirements.mjs";
import { appendStateEvent, replayRunState } from "./state.mjs";

export const MAX_WORKERS = 8;
export const SAFE_BASELINE_WORKERS = 3;
export const DEFAULT_LEASE_MS = 15 * 60 * 1000;
export const IMPLEMENTATION_STRIKE_LIMIT = 3;
export const CAPACITY_MAX_AGE_MS = 5 * 60 * 1000;
export const TASK_TRANSITIONS = Object.freeze({
  PLANNED: ["BLOCKED", "READY"], READY: ["RUNNING"], RUNNING: ["READY", "READY_FOR_PUCK", "BLOCKED"],
  READY_FOR_PUCK: ["READY", "VERIFIED", "FAILED", "BLOCKED"], VERIFIED: ["READY_FOR_VERA", "ACCEPTED"],
  READY_FOR_VERA: ["ALIGNED", "MISALIGNED", "BLOCKED"], ALIGNED: ["ACCEPTED"],
  FAILED: ["REPAIR_PLANNED", "HUMAN_DECISION"], MISALIGNED: ["REPAIR_PLANNED", "HUMAN_DECISION"],
  REPAIR_PLANNED: ["READY"], CONFLICTED: ["REPAIR_PLANNED", "HUMAN_DECISION"],
});

const ACTIVE_TASK_STATES = new Set(["RUNNING"]);
const VERIFIED_PREREQUISITE_STATES = new Set(["VERIFIED", "ALIGNED", "ACCEPTED"]);
const IMPLEMENTATION_CAUSES = new Set(["IMPLEMENTATION_DEFECT", "FLINT_FAILURE", "TEST_FAILURE"]);
const ROUTES = Object.freeze({
  IMPLEMENTATION_DEFECT: "FLINT",
  FLINT_FAILURE: "FLINT",
  TEST_FAILURE: "FLINT",
  REQUIREMENT_OMISSION: "FABLE_OR_HUMAN",
  REQUIREMENT_CONFLICT: "FABLE_OR_HUMAN",
  REQUIREMENT_AMBIGUITY: "FABLE_OR_HUMAN",
  DEPENDENCY_CONFLICT: "ROOK",
  OWNERSHIP_CONFLICT: "ROOK",
  ENVIRONMENT_BLOCK: "HUSH_OR_ENVIRONMENT",
  PACKET_DEFECT: "HUSH",
  INTEGRITY_DEFECT: "HUSH",
});

export function loadSchedulerState(root, runId) {
  return replayRunState(root, runId);
}

export function canTransitionTask(from, to) { return TASK_TRANSITIONS[from]?.includes(to) ?? false; }
export function assertTaskTransition(from, to) { if (!canTransitionTask(from, to)) throw new Error(`Invalid task transition: ${from} -> ${to}`); return true; }

export function orderReadyTasks(tasks) {
  return [...tasks].sort((left, right) => {
    const priority = number(left.priority, Number.MAX_SAFE_INTEGER) - number(right.priority, Number.MAX_SAFE_INTEGER);
    if (priority !== 0) return priority;
    const depth = number(left.dependency_depth ?? left.depth, Number.MAX_SAFE_INTEGER) - number(right.dependency_depth ?? right.depth, Number.MAX_SAFE_INTEGER);
    if (depth !== 0) return depth;
    return String(left.id ?? left.task_id).localeCompare(String(right.id ?? right.task_id));
  });
}

export function taskQueue(state, options = {}) {
  const tasks = Object.values(state.entities.task ?? {});
  const active = tasks.filter((task) => ACTIVE_TASK_STATES.has(task.status));
  const maxWorkers = workerLimit(options.maxWorkers ?? state.entities.run?.[options.runId]?.max_workers);
  const observation = options.capacityObservation ?? options.hostCapacity ?? latestCapacityObservation(state);
  const capacity = capacityPolicy(observation, { baseline: options.baselineWorkers ?? SAFE_BASELINE_WORKERS, hardMax: MAX_WORKERS, now: options.now, maxAgeMs: options.capacityMaxAgeMs ?? CAPACITY_MAX_AGE_MS });
  const available = Math.min(capacity.safe_limit, maxWorkers, Math.max(0, maxWorkers - active.length));
  const activeHubs = new Set(active.flatMap((task) => task.exclusive_hubs ?? task.exclusiveHubs ?? []));
  const candidates = [];
  const blocked = [];

  for (const task of orderReadyTasks(tasks.filter((item) => item.status === "READY"))) {
    const reason = dispatchBlockReason(task, state, { activeHubs, available, options });
    if (reason) blocked.push({ task_id: task.id, reason });
    else candidates.push(task);
  }
  return { candidates: candidates.slice(0, available), blocked, active_count: active.length, available_slots: available, capacity };
}

export function dispatchReadyTasks(root, runId, options = {}) {
  if (options.capacityObservation || options.hostCapacity && typeof options.hostCapacity === "object") recordCapacityObservation(root, runId, options.capacityObservation ?? options.hostCapacity, { now: options.now });
  const state = loadSchedulerState(root, runId);
  const queue = taskQueue(state, { ...options, runId });
  const now = options.now ?? new Date().toISOString();
  const owner = options.owner ?? "hush";
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const dispatched = [];
  recordBlockedReasons(root, runId, queue.blocked, state.events.length, now);

  for (const task of queue.candidates) {
    assertTaskTransition(task.status, "RUNNING");
    const packet = packetForTask(state, task);
    const leaseId = `LEASE-${runId}-${task.id}-R${task.revision ?? 1}`;
    const event = appendStateEvent(root, runId, {
      entity_type: "task", entity_id: task.id, action: "claimed", actor: owner, cause: "scheduler-admission", timestamp: now,
      data: { status: "RUNNING", lease_id: leaseId, lease_owner: owner, lease_acquired_at: now, lease_heartbeat_at: now, lease_expires_at: new Date(Date.parse(now) + leaseMs).toISOString(), packet_id: packet?.id ?? task.packet_id ?? null },
    });
    appendStateEvent(root, runId, {
      entity_type: "run", entity_id: runId, action: "task-dispatched", actor: owner, cause: "scheduler-admission", timestamp: now,
      data: { last_task_id: task.id, last_task_revision: event.revision },
    });
    dispatched.push({ task_id: task.id, lease_id: leaseId, packet_id: packet?.id ?? task.packet_id ?? null });
  }
  const summary = writeRunSummary(root, runId, { queue, dispatched, state: loadSchedulerState(root, runId) });
  return { ...queue, dispatched, summary };
}

export function dispatchOne(root, runId, options = {}) {
  return dispatchReadyTasks(root, runId, { ...options, maxWorkers: 1 });
}

export function recoverExpiredLeases(root, runId, options = {}) {
  const state = loadSchedulerState(root, runId);
  const nowMs = new Date(options.now ?? new Date().toISOString()).getTime();
  const recovered = [];
  for (const task of Object.values(state.entities.task ?? {})) {
    if (task.status !== "RUNNING" || !task.lease_expires_at || Date.parse(task.lease_expires_at) > nowMs) continue;
    assertTaskTransition(task.status, "BLOCKED");
    const event = appendStateEvent(root, runId, {
      entity_type: "task", entity_id: task.id, action: "lease-expired", actor: options.owner ?? "hush", cause: "WORKER_LEASE_EXPIRED", timestamp: options.now ?? new Date().toISOString(),
      data: { status: "BLOCKED", block_reason: "WORKER_LEASE_EXPIRED", lease_expired_at: task.lease_expires_at, previous_lease_id: task.lease_id, requires_new_packet_or_retry: true },
    });
    recovered.push({ task_id: task.id, revision: event.revision, reason: "WORKER_LEASE_EXPIRED" });
  }
  const summary = writeRunSummary(root, runId, { recovered, state: loadSchedulerState(root, runId) });
  return { recovered, summary };
}

export function recoverInterruptedLeases(root, runId, options = {}) {
  const state = loadSchedulerState(root, runId);
  const timestamp = options.now ?? new Date().toISOString();
  const recovered = [];
  for (const task of Object.values(state.entities.task ?? {})) {
    if (!["RUNNING", "READY_FOR_PUCK"].includes(task.status)) continue;
    assertTaskTransition(task.status, "READY");
    const attempt = number(task.attempt, 1) + 1;
    const retryReason = task.status === "READY_FOR_PUCK" ? "VERIFICATION_INTERRUPTED" : "RUNNER_RESUME";
    const event = appendStateEvent(root, runId, {
      entity_type: "task", entity_id: task.id, action: "work-interrupted", actor: options.owner ?? "hush", cause: retryReason,
      timestamp, data: { status: "READY", attempt, retry_reason: retryReason, previous_status: task.status, previous_lease_id: task.lease_id ?? null, previous_lease_expires_at: task.lease_expires_at ?? null },
    });
    recovered.push({ task_id: task.id, attempt, revision: event.revision, reason: retryReason });
  }
  const summary = writeRunSummary(root, runId, { recovered, state: loadSchedulerState(root, runId) });
  return { recovered, summary };
}

export function heartbeat(root, runId, taskId, options = {}) {
  const state = loadSchedulerState(root, runId);
  const task = state.entities.task?.[taskId];
  if (!task || task.status !== "RUNNING") throw new Error(`Task is not running: ${taskId}`);
  const now = options.now ?? new Date().toISOString();
  const leaseMs = options.leaseMs ?? Math.max(Date.parse(task.lease_expires_at) - Date.parse(task.lease_acquired_at), DEFAULT_LEASE_MS);
  return appendStateEvent(root, runId, {
    entity_type: "task", entity_id: taskId, action: "heartbeat", actor: options.owner ?? task.lease_owner ?? "hush", cause: "worker-heartbeat", timestamp: now,
    data: { lease_heartbeat_at: now, lease_expires_at: new Date(Date.parse(now) + leaseMs).toISOString() },
  });
}

export function routeFailure(root, runId, taskId, finding = {}, options = {}) {
  const cause = finding.primary_cause ?? finding.cause ?? "IMPLEMENTATION_DEFECT";
  const route = ROUTES[cause] ?? "HUSH";
  const implementationStrike = IMPLEMENTATION_CAUSES.has(cause);
  const state = loadSchedulerState(root, runId);
  const task = state.entities.task?.[taskId];
  const priorStrikes = number(task?.strike_count, 0);
  const strikeCount = implementationStrike ? priorStrikes + 1 : priorStrikes;
  const limit = Math.min(number(state.entities.run?.[runId]?.strike_limit, IMPLEMENTATION_STRIKE_LIMIT), IMPLEMENTATION_STRIKE_LIMIT);
  const status = implementationStrike && strikeCount >= limit ? "HUMAN_DECISION" : "REPAIR_PLANNED";
  const event = appendStateEvent(root, runId, {
    entity_type: "task", entity_id: taskId, action: "failure-routed", actor: "hush", cause, timestamp: options.now ?? new Date().toISOString(),
    data: { status, primary_cause: cause, route, strike_count: strikeCount, strike_consumed: implementationStrike, finding_id: finding.finding_id ?? null, repair_reason: cause },
  });
  const findingEvent = appendStateEvent(root, runId, {
    entity_type: "finding", entity_id: finding.finding_id ?? `FIND-${taskId}-R${event.revision}`, action: "routed", actor: "hush", cause, timestamp: options.now ?? new Date().toISOString(),
    data: { task_id: taskId, primary_cause: cause, route, strike_consumed: implementationStrike, details: finding.details ?? null },
  });
  return { task_id: taskId, cause, route, strike_count: strikeCount, status, event_id: event.event_id, finding_event_id: findingEvent.event_id };
}

export function evidenceReuseDecision(previous, current) {
  if (!previous || !current) return { reuse: false, decision: "TARGETED_RECHECK", reason: "missing evidence binding" };
  const same = previous.patch_digest === current.patch_digest && previous.dependency_closure_digest === current.dependency_closure_digest && previous.behavior_class === current.behavior_class && Array.isArray(previous.dependency_closure) && previous.dependency_closure.length > 0 && Array.isArray(current.dependency_closure) && current.dependency_closure.length > 0 && previous.dependency_closure.every(Boolean) && current.dependency_closure.every(Boolean);
  return same ? { reuse: true, decision: "REUSE_PRE_INTEGRATION", reason: "patch, dependency closure, and behavior class unchanged" } : { reuse: false, decision: "TARGETED_RECHECK", reason: "patch, dependency closure, or behavior class changed or uncertain" };
}

export function writeRunSummary(root, runId, details = {}) {
  const state = details.state ?? loadSchedulerState(root, runId);
  const summary = {
    summary_version: "scheduler.v1",
    run_id: runId,
    state_revision: state.events.length,
    task_ids: Object.keys(state.entities.task ?? {}).sort(),
    tasks: Object.values(state.entities.task ?? {}).map(summaryTask).sort((a, b) => a.task_id.localeCompare(b.task_id)),
    packet_ids: Object.keys(state.entities.packet ?? {}).sort(),
    candidate_ids: Object.keys(state.entities.candidate ?? {}).sort(),
    evidence_ids: Object.keys(state.entities.evidence ?? {}).sort(),
    capacity_observation_ids: Object.keys(state.entities.capacity_observation ?? {}).sort(),
    routing_decisions: details.routing_decisions ?? state.events.filter((event) => event.action === "failure-routed").map((event) => ({ event_id: event.event_id, ...event.data })),
    blockers: details.blockers ?? state.events.filter((event) => event.data?.block_reason || event.action === "lease-expired").map((event) => ({ event_id: event.event_id, ...event.data })),
    decisions: details.dispatched ?? details.recovered ?? [],
  };
  const path = join(root, ".hush", "runs", runId, "summary.json");
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  renameSync(temp, path);
  return summary;
}

function dispatchBlockReason(task, state, context) {
  const requirements = task.requirements ?? task.requirement_ids ?? [];
  for (const requirementId of requirements) {
    const requirement = state.entities.requirement?.[requirementId];
    if (!requirement || requirement.approval_state !== "APPROVED") return { code: "REQUIREMENTS_NOT_APPROVED", requirement_id: requirementId };
    const requirementResult = validateRequirementRecord({ ...requirement, requirement_id: requirement.requirement_id ?? requirement.id ?? requirementId }, { root: context.options.root });
    if (requirementResult) return { code: "REQUIREMENT_SOURCE_INVALID", requirement_id: requirementId, issue: requirementResult };
    if (hasBlockingUnknowns(requirement)) return { code: "BLOCKING_UNKNOWN", requirement_id: requirementId };
  }
  const dependencies = task.dependencies ?? task.prerequisites ?? [];
  for (const dependency of dependencies) {
    const id = typeof dependency === "string" ? dependency : dependency.id ?? dependency.task_id;
    const status = typeof dependency === "string" ? state.entities.task?.[id]?.status : dependency.status ?? state.entities.task?.[id]?.status;
    if (!VERIFIED_PREREQUISITE_STATES.has(status)) return { code: "PREREQUISITE_NOT_VERIFIED", dependency_id: id, status: status ?? "MISSING" };
  }
  if (!packetForTask(state, task)) return { code: "PACKET_MISSING" };
  const packet = packetForTask(state, task);
  if (packet.task_id !== task.id) return { code: "PACKET_TASK_MISMATCH", packet_task_id: packet.task_id };
  const packetResult = validatePacket(packet, { now: context.options.now, environment: context.options.environment, root: context.options.root, repository: context.options.repository ?? context.options.root, activePacketIds: activePacketIds(state) });
  if (packetResult.status !== "VALID") return { code: packetResult.status, issue: packetResult.issue };
  const hubs = task.exclusive_hubs ?? task.exclusiveHubs ?? [];
  if (hubs.some((hub) => context.activeHubs.has(hub))) return { code: "EXCLUSIVE_HUB_BUSY", hub: hubs.find((hub) => context.activeHubs.has(hub)) };
  if (context.available <= 0) return { code: "WORKER_CAPACITY" };
  return null;
}

function recordBlockedReasons(root, runId, blocked, sourceRevision, timestamp) {
  const state = loadSchedulerState(root, runId);
  for (const item of blocked) {
    const reason = item.reason;
    const exists = Object.values(state.entities.finding ?? {}).some((finding) => finding.task_id === item.task_id && finding.source_state_revision === sourceRevision && JSON.stringify(finding.reason) === JSON.stringify(reason));
    if (exists) continue;
    appendStateEvent(root, runId, {
      entity_type: "finding", entity_id: `BLOCK-${item.task_id}-R${sourceRevision}`, action: "dispatch-blocked", actor: "hush", cause: reason.code, timestamp,
      data: { task_id: item.task_id, reason, source_state_revision: sourceRevision, blocking: true },
    });
  }
}

function packetForTask(state, task) { const packet = task.packet_id ? state.entities.packet?.[task.packet_id] : Object.values(state.entities.packet ?? {}).find((item) => item.task_id === task.id && item.packet_state === "ACTIVE"); return packet ? stripReplayMetadata(packet) : null; }
function activePacketIds(state) { return Object.values(state.entities.packet ?? {}).filter((packet) => packet.packet_state === "ACTIVE").map((packet) => packet.id); }
export function capacityPolicy(observation, { baseline = SAFE_BASELINE_WORKERS, hardMax = MAX_WORKERS, now = new Date().toISOString(), maxAgeMs = CAPACITY_MAX_AGE_MS } = {}) {
  const safeBaseline = Math.max(0, Math.min(hardMax, Math.floor(number(baseline, SAFE_BASELINE_WORKERS))));
  if (!observation || typeof observation !== "object" || observation.confidence !== "HIGH") return { safe_limit: 0, baseline: safeBaseline, hard_max: hardMax, confidence: "UNCERTAIN", reason: "missing or low-confidence host observation" };
  const available = Math.floor(number(observation.available_workers ?? observation.available_slots, -1));
  if (available < 0) return { safe_limit: 0, baseline: safeBaseline, hard_max: hardMax, confidence: "UNCERTAIN", reason: "host capacity unavailable" };
  const observedAt = Date.parse(observation.observed_at ?? "");
  const nowMs = Date.parse(now);
  if (!Number.isFinite(observedAt) || !Number.isFinite(nowMs) || nowMs - observedAt > maxAgeMs || observedAt > nowMs + 1000) return { safe_limit: 0, baseline: safeBaseline, hard_max: hardMax, confidence: "UNCERTAIN", reason: "capacity observation is stale or invalid" };
  const reportedSafeLimit = Math.floor(number(observation.safe_limit, safeBaseline));
  if (reportedSafeLimit < 0 || reportedSafeLimit > available) return { safe_limit: 0, baseline: safeBaseline, hard_max: hardMax, confidence: "UNCERTAIN", available_workers: available, reason: "capacity observation is contradictory" };
  return { safe_limit: Math.max(0, Math.min(hardMax, available, reportedSafeLimit)), baseline: safeBaseline, hard_max: hardMax, confidence: observation.confidence, available_workers: available, reason: "measured host capacity" };
}
export function recordCapacityObservation(root, runId, observation, { now, actor = "hush" } = {}) {
  const measured = { ...observation, observation_id: observation?.observation_id ?? `CAP-${runId}-${Date.now()}`, observed_at: observation?.observed_at ?? now ?? new Date().toISOString() };
  const policy = capacityPolicy(measured);
  const event = appendStateEvent(root, runId, { entity_type: "capacity_observation", entity_id: measured.observation_id, action: "observed", actor, cause: "host-capacity-measurement", timestamp: measured.observed_at, data: { ...measured, safe_limit: policy.safe_limit, baseline: policy.baseline, hard_max: policy.hard_max, policy_confidence: policy.confidence } });
  return { ...measured, safe_limit: policy.safe_limit, baseline: policy.baseline, hard_max: policy.hard_max, policy_confidence: policy.confidence, revision: event.revision };
}
function latestCapacityObservation(state) { return Object.values(state.entities.capacity_observation ?? {}).sort((left, right) => String(left.observed_at).localeCompare(String(right.observed_at))).at(-1); }
function workerLimit(value) { return Math.max(0, Math.min(MAX_WORKERS, number(value, MAX_WORKERS))); }
function number(value, fallback) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
function summaryTask(task) { return { task_id: task.id, status: task.status, revision: task.revision, packet_id: task.packet_id ?? null, lease_id: task.lease_id ?? null, strike_count: task.strike_count ?? 0, block_reason: task.block_reason ?? null }; }
function stripReplayMetadata(record) { const copy = { ...record }; for (const key of ["id", "type", "revision", "updated_at", "last_event_id"]) delete copy[key]; return copy; }

export function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`; }
