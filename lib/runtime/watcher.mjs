import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { validatePacket } from "./packet.mjs";
import { invalidateHazardChanges } from "./environment.mjs";
import { renderPrPayload, canAutoMerge } from "./delivery.mjs";
import { validateRequirementRecord } from "./requirements.mjs";
import { assertTaskTransition, dispatchReadyTasks, recoverExpiredLeases } from "./scheduler.mjs";
import { actionKeyFor, appendStateEvent, hasActionKey, readStateEvents, replayRunState } from "./state.mjs";

export const WATCHER_VERSION = "continuity.v1";
export const ACTION_LEASE_MS = 15 * 60 * 1000;
export const EVENT_HANDLERS = Object.freeze([
  "TASK_READY", "WORKTREE_AVAILABLE", "WORKER_COMPLETED", "PUCK_VERIFIED", "VERA_ALIGNED",
  "LEASE_EXPIRED", "READY_FOR_PR", "CI_PASSED", "CI_FAILED", "HAZARD_CHANGED", "CAPACITY_OBSERVED",
  "RETRY_ACTION", "TIMER_DUE",
]);

export function cursorPath(root, runId) { return join(root, ".hush", "runs", runId, "watcher-cursor.jsonl"); }

export function readCursor(root, runId) {
  const path = cursorPath(root, runId);
  if (!existsSync(path)) return { cursor: 0, revision: 0, event_id: null };
  const records = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return records.at(-1) ?? { cursor: 0, revision: 0, event_id: null };
}

export function writeCursor(root, runId, cursor, { eventId = null, now = new Date().toISOString(), actor = "hush" } = {}) {
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error("CURSOR_INVALID");
  const prior = readCursor(root, runId);
  const record = { cursor_id: `CUR-${runId}-R${prior.revision + 1}`, revision: prior.revision + 1, prior_revision: prior.revision || null, cursor, event_id: eventId, timestamp: now, actor, cause: "watcher-progress" };
  const path = cursorPath(root, runId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export function scheduleDurableTimer(root, runId, { timerId, kind, dueAt, payload = {}, actionKey, now, actor = "hush" }) {
  if (!timerId || !kind || !dueAt) throw new Error("TIMER_FIELDS_REQUIRED");
  const state = replayRunState(root, runId);
  const existing = state.entities.timer?.[timerId];
  if (existing && ["SCHEDULED", "DUE"].includes(existing.status)) return existing;
  const timer = { timer_id: timerId, kind, due_at: dueAt, payload, action_key: actionKey ?? `timer:${timerId}`, status: "SCHEDULED", created_at: now ?? new Date().toISOString() };
  appendStateEvent(root, runId, { entity_type: "timer", entity_id: timerId, action: "scheduled", action_key: timer.action_key, actor, cause: "durable-timer", timestamp: now, data: timer });
  return timer;
}

export function dueTimers(root, runId, now = new Date().toISOString()) {
  const time = Date.parse(now);
  return Object.values(replayRunState(root, runId).entities.timer ?? {}).filter((timer) => timer.status === "SCHEDULED" && Number.isFinite(Date.parse(timer.due_at)) && Date.parse(timer.due_at) <= time);
}

export function pauseRun(root, runId, { now, reason = "operator-pause" } = {}) {
  return appendStateEvent(root, runId, { entity_type: "run", entity_id: runId, action: "paused", actor: "hush", cause: reason, timestamp: now, data: { status: "PAUSED", pause_reason: reason } });
}

export function resumeRun(root, runId, { now, reason = "operator-resume" } = {}) {
  return appendStateEvent(root, runId, { entity_type: "run", entity_id: runId, action: "resumed", actor: "hush", cause: reason, timestamp: now, data: { status: "OPEN", pause_reason: null } });
}

export function createHandlerRegistry(overrides = {}) {
  const handlers = {
    TASK_READY: ({ root, runId, options }) => dispatchReadyTasks(root, runId, options),
    CAPACITY_OBSERVED: ({ root, runId, options }) => dispatchReadyTasks(root, runId, options),
    LEASE_EXPIRED: ({ root, runId, options }) => recoverExpiredLeases(root, runId, options),
    WORKTREE_AVAILABLE: ({ root, runId, options }) => dispatchReadyTasks(root, runId, options),
    WORKER_COMPLETED: ({ root, runId, event }) => updateTaskAfterWorker(root, runId, event, "READY_FOR_PUCK"),
    PUCK_VERIFIED: ({ root, runId, event }) => routePuck(root, runId, event),
    VERA_ALIGNED: ({ root, runId, event }) => routeVera(root, runId, event),
    HAZARD_CHANGED: ({ root, runId, event }) => invalidateHazardChanges(root, runId, { repository: event.data?.repository, categories: event.data?.categories, now: event.timestamp }),
    READY_FOR_PR: ({ root, runId, event }) => recordPrPayload(root, runId, event),
    CI_PASSED: ({ root, runId, event }) => recordCi(root, runId, event, true),
    CI_FAILED: ({ root, runId, event }) => recordCi(root, runId, event, false),
    RETRY_ACTION: ({ root, runId, event, options }) => dispatchRetry(root, runId, event, options),
    TIMER_DUE: (context) => {
      const payload = context.event.data?.payload ?? {};
      const handler = handlers[String(payload.event_type ?? "").toUpperCase()];
      return handler ? handler({ ...context, event: { ...context.event, data: { ...payload, retry_count: payload.retry_count ?? 0 } } }) : payload;
    },
  };
  return new Map([...Object.entries(handlers), ...Object.entries(overrides)].map(([key, value]) => [key.toUpperCase(), value]));
}

export function watchOnce(root, runId, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const initial = replayRunState(root, runId);
  if (initial.entities.run?.[runId]?.status === "PAUSED") return { status: "PAUSED", processed: [], cursor: readCursor(root, runId) };
  materializeDueTimers(root, runId, now);
  const events = readStateEvents(root, runId);
  const cursor = options.replay ? 0 : readCursor(root, runId).cursor;
  const registry = options.registry instanceof Map ? options.registry : createHandlerRegistry(options.handlers);
  const processed = [];
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  for (let index = cursor; index < events.length && processed.length < limit; index += 1) {
    const event = events[index];
    const eventType = eventTypeFor(event);
    if (event.entity_type === "watcher") {
      writeCursor(root, runId, index + 1, { eventId: event.event_id, now });
      continue;
    }
    if (!eventType) {
      const actionKey = event.data?.action_key ?? actionKeyFor({ eventId: event.event_id, entityId: event.entity_id, action: "UNSUPPORTED_EVENT" });
      if (!hasActionKey(readStateEvents(root, runId), actionKey)) {
        appendStateEvent(root, runId, { entity_type: "watcher", entity_id: actionKey, action: "unsupported-event", action_key: actionKey, actor: "hush", cause: "UNSUPPORTED_EVENT", timestamp: now, data: { action_key: actionKey, source_event_id: event.event_id, action_status: "BLOCKED", reason: "UNSUPPORTED_EVENT" } });
      }
      writeCursor(root, runId, index + 1, { eventId: event.event_id, now });
      processed.push({ event_id: event.event_id, status: "BLOCKED", action_key: actionKey, reason: "UNSUPPORTED_EVENT" });
      continue;
    }
    const handler = registry.get(eventType);
    if (!handler) {
      const actionKey = event.data?.action_key ?? actionKeyFor({ eventId: event.event_id, entityId: event.entity_id, action: eventType });
      recordActionBlock(root, runId, event, actionKey, { reason: "HANDLER_NOT_REGISTERED" }, now);
      writeCursor(root, runId, index + 1, { eventId: event.event_id, now });
      processed.push({ event_id: event.event_id, status: "BLOCKED", action_key: actionKey, reason: "HANDLER_NOT_REGISTERED" });
      continue;
    }
    const actionKey = event.data?.action_key ?? actionKeyFor({ eventId: event.event_id, entityId: event.entity_id, action: eventType });
    const currentEvents = readStateEvents(root, runId);
    if (actionCompleted(currentEvents, actionKey) || actionInFlight(currentEvents, actionKey, now)) {
      writeCursor(root, runId, index + 1, { eventId: event.event_id, now });
      processed.push({ event_id: event.event_id, status: "IDEMPOTENT", action_key: actionKey });
      continue;
    }
    const binding = validateDispatchBindings(root, runId, event, options);
    if (!binding.valid) {
      recordActionBlock(root, runId, event, actionKey, binding, now);
      writeCursor(root, runId, index + 1, { eventId: event.event_id, now });
      processed.push({ event_id: event.event_id, status: "BLOCKED", action_key: actionKey, reason: binding.reason });
      continue;
    }
    appendStateEvent(root, runId, { entity_type: "watcher", entity_id: actionKey, action: "action-dispatched", action_key: actionKey, actor: "hush", cause: event.event_id, timestamp: now, data: { action_key: actionKey, source_event_id: event.event_id, action_status: "IN_FLIGHT", lease_expires_at: new Date(Date.parse(now) + (options.actionLeaseMs ?? ACTION_LEASE_MS)).toISOString(), event_type: eventType } });
    try {
      const result = awaitMaybe(handler({ root, runId, event, state: replayRunState(root, runId), options }));
      appendStateEvent(root, runId, { entity_type: "watcher", entity_id: actionKey, action: "action-completed", action_key: actionKey, actor: "hush", cause: event.event_id, timestamp: now, data: { action_key: actionKey, source_event_id: event.event_id, action_status: "COMPLETED", result: result ?? null } });
      processed.push({ event_id: event.event_id, status: "COMPLETED", action_key: actionKey, result: result ?? null });
    } catch (error) {
      const failure = handleActionFailure(root, runId, event, actionKey, error, options, now);
      processed.push({ event_id: event.event_id, ...failure, action_key: actionKey });
    }
    writeCursor(root, runId, index + 1, { eventId: event.event_id, now });
  }
  return { status: "WATCHED", processed, cursor: readCursor(root, runId), state_revision: readStateEvents(root, runId).length };
}

export async function watchRun(root, runId, options = {}) {
  if (options.follow !== true) return watchOnce(root, runId, options);
  let result = null;
  const iterations = options.iterations ?? Number.POSITIVE_INFINITY;
  for (let index = 0; index < iterations; index += 1) {
    result = watchOnce(root, runId, options);
    if (index + 1 < iterations) await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
  }
  return result;
}

export function replayRun(root, runId, options = {}) {
  const events = readStateEvents(root, runId);
  return { status: "REPLAYED", replay: true, processed: [], cursor: readCursor(root, runId), derived_state: replayRunState(root, runId), action_keys: events.filter((event) => event.action_key).map((event) => event.action_key).sort() };
}

export function validateDispatchBindings(root, runId, event, options = {}) {
  const state = replayRunState(root, runId);
  const data = event.data ?? {};
  const packetId = data.packet_id ?? data.packetId;
  if (packetId) {
    const packet = state.entities.packet?.[packetId];
    if (!packet) return { valid: false, reason: "PACKET_MISSING" };
    const result = validatePacket(strip(packet), { root, repository: options.repository ?? root, now: options.now ?? event.timestamp, activePacketIds: Object.values(state.entities.packet ?? {}).filter((item) => item.packet_state === "ACTIVE").map((item) => item.id) });
    if (result.status !== "VALID") return { valid: false, reason: result.status, issue: result.issue };
    for (const requirementId of packet.requirements ?? []) {
      const requirement = state.entities.requirement?.[requirementId];
      if (!requirement) return { valid: false, reason: "REQUIREMENT_MISSING", requirement_id: requirementId };
      const requirementResult = validateRequirementRecord({ ...requirement, requirement_id: requirement.requirement_id ?? requirement.id ?? requirementId }, { root });
      if (requirementResult) return { valid: false, reason: "REQUIREMENT_SOURCE_INVALID", issue: requirementResult, requirement_id: requirementId };
    }
  }
  if (data.snapshot_id) {
    const snapshot = state.entities.snapshot?.[data.snapshot_id];
    if (!snapshot || !(snapshot.frozen === true || snapshot.state === "FROZEN")) return { valid: false, reason: "SNAPSHOT_NOT_FROZEN" };
    if (data.candidate_diff_digest && data.candidate_diff_digest !== snapshot.diff_digest) return { valid: false, reason: "SNAPSHOT_DIGEST_MISMATCH" };
  }
  if (data.candidate_id && data.candidate_patch_digest) {
    const candidate = state.entities.candidate?.[data.candidate_id];
    if (!candidate || candidate.patch_digest !== data.candidate_patch_digest) return { valid: false, reason: "CANDIDATE_DIGEST_MISMATCH" };
  }
  if (data.evidence_id && !state.entities.evidence?.[data.evidence_id]) return { valid: false, reason: "EVIDENCE_MISSING" };
  return { valid: true };
}

function materializeDueTimers(root, runId, now) {
  for (const timer of dueTimers(root, runId, now)) {
    appendStateEvent(root, runId, { entity_type: "timer", entity_id: timer.timer_id, action: "due", action_key: timer.action_key, actor: "hush", cause: "durable-deadline", timestamp: now, data: { ...timer, status: "DUE", event_type: "TIMER_DUE" } });
  }
}

function eventTypeFor(event) {
  const value = event.data?.event_type ?? event.action;
  if (!value) return null;
  const normalized = String(value).replaceAll("-", "_").toUpperCase();
  if (EVENT_HANDLERS.includes(normalized)) return normalized;
  if (event.entity_type === "task" && normalized === "READY") return "TASK_READY";
  if (event.entity_type === "capacity_observation" && normalized === "OBSERVED") return "CAPACITY_OBSERVED";
  return null;
}

function updateTaskAfterWorker(root, runId, event, status) {
  const taskId = event.data?.task_id ?? event.entity_id;
  const state = replayRunState(root, runId);
  const task = state.entities.task?.[taskId];
  if (!task) throw new Error("TASK_MISSING");
  assertTaskTransition(task.status, status);
  appendStateEvent(root, runId, { entity_type: "task", entity_id: taskId, action: status.toLowerCase(), actor: "hush", cause: event.event_id, timestamp: event.timestamp, data: { status, candidate_id: event.data?.candidate_id ?? task.candidate_id ?? null, snapshot_id: event.data?.snapshot_id ?? task.snapshot_id ?? null } });
  return { task_id: taskId, status };
}

function routePuck(root, runId, event) {
  const state = replayRunState(root, runId);
  const taskId = event.data?.task_id ?? event.entity_id;
  const task = state.entities.task?.[taskId];
  if (!task) throw new Error("TASK_MISSING");
  const packet = task.packet_id ? state.entities.packet?.[task.packet_id] : null;
  updateTaskAfterWorker(root, runId, event, "VERIFIED");
  return updateTaskAfterWorker(root, runId, event, packet?.vera_required ? "READY_FOR_VERA" : "ACCEPTED");
}

function routeVera(root, runId, event) {
  updateTaskAfterWorker(root, runId, event, "ALIGNED");
  return updateTaskAfterWorker(root, runId, event, "ACCEPTED");
}

function recordPrPayload(root, runId, event) {
  const payload = event.data?.payload ?? renderPrPayload(event.data ?? {});
  return appendStateEvent(root, runId, { entity_type: "delivery", entity_id: event.data?.delivery_id ?? `PR-${event.entity_id}`, action: "pr-payload-rendered", action_key: event.data?.action_key, actor: "hush", cause: event.event_id, timestamp: event.timestamp, data: { status: "READY_FOR_PR", payload, payload_digest: payload.payload_digest ?? null } });
}

function recordCi(root, runId, event, passing) {
  const guard = passing ? canAutoMerge(event.data ?? {}) : { allowed: false, reason: "CI_FAILED" };
  if (passing && !guard.allowed) throw new Error(`AUTO_MERGE_GUARD: ${guard.reason}`);
  return appendStateEvent(root, runId, { entity_type: "delivery", entity_id: event.data?.pr_id ?? event.entity_id, action: passing ? "ci-passed" : "ci-failed", actor: "hush", cause: event.event_id, timestamp: event.timestamp, data: { status: passing ? "CI_PASSED" : "CI_FAILED", identity: event.data?.identity ?? null, auto_merge: guard.allowed } });
}

function dispatchRetry(root, runId, event, options) {
  const original = event.data?.original_event;
  if (!original) throw new Error("RETRY_EVENT_MISSING");
  return watchOnce(root, runId, { ...options, handlers: options.handlers, replay: false, limit: 1 });
}

function recordActionBlock(root, runId, event, actionKey, binding, now) {
  appendStateEvent(root, runId, { entity_type: "finding", entity_id: `BLOCK-${actionKey}`, action: "dispatch-blocked", action_key: actionKey, actor: "hush", cause: binding.reason, timestamp: now, data: { source_event_id: event.event_id, action_key: actionKey, reason: binding.reason, issue: binding.issue, blocking: true } });
}

function actionCompleted(events, actionKey) {
  return events.some((event) => event.action_key === actionKey && event.action === "action-completed");
}

function actionInFlight(events, actionKey, now) {
  const dispatch = events.filter((event) => event.action_key === actionKey && event.action === "action-dispatched").at(-1);
  if (!dispatch) return false;
  const expiry = Date.parse(dispatch.data?.lease_expires_at ?? "");
  return Number.isFinite(expiry) && expiry > Date.parse(now);
}

function handleActionFailure(root, runId, event, actionKey, error, options, now) {
  const retries = Number(event.data?.retry_count ?? 0);
  const limit = Number(options.retryLimit ?? 2);
  appendStateEvent(root, runId, { entity_type: "watcher", entity_id: actionKey, action: "action-failed", action_key: actionKey, actor: "hush", cause: error.code ?? "HANDLER_FAILURE", timestamp: now, data: { action_key: actionKey, action_status: "FAILED", error: error.message, retry_count: retries } });
  if (retries < limit) {
    const timerId = `RETRY-${actionKey}-R${retries + 1}`;
    scheduleDurableTimer(root, runId, { timerId, kind: "ACTION_RETRY", dueAt: options.retryAt ?? now, actionKey: `${actionKey}:retry:${retries + 1}`, payload: { event_type: eventTypeFor(event), original_event: event, retry_count: retries + 1 }, now });
    appendStateEvent(root, runId, { entity_type: "watcher", entity_id: actionKey, action: "action-retry-scheduled", action_key: `${actionKey}:retry:${retries + 1}`, actor: "hush", cause: error.code ?? "HANDLER_FAILURE", timestamp: now, data: { action_key: actionKey, retry_count: retries + 1, timer_id: timerId } });
    return { status: "RETRY_SCHEDULED", error: error.message, retry_count: retries + 1 };
  }
  appendStateEvent(root, runId, { entity_type: "human_decision", entity_id: `DEC-${actionKey}`, action: "required", action_key: actionKey, actor: "hush", cause: error.code ?? "HANDLER_FAILURE", timestamp: now, data: { status: "HUMAN_DECISION_REQUIRED", action_key: actionKey, error: error.message, source_event_id: event.event_id } });
  return { status: "HUMAN_DECISION_REQUIRED", error: error.message };
}

function strip(record) { const copy = { ...record }; for (const key of ["id", "type", "revision", "updated_at", "last_event_id"]) delete copy[key]; return copy; }
function awaitMaybe(value) { return value; }
