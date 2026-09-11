import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export const STATE_ENTITY_TYPES = Object.freeze([
  "run",
  "requirement",
  "task",
  "packet",
  "worktree",
  "candidate",
  "snapshot",
  "evidence",
  "capacity_observation",
  "finding",
  "human_decision",
  "merge_event",
  "timer",
  "watcher",
  "delivery",
  "provider_event",
  "mutation_evidence",
]);

const stateEntityTypeSet = new Set(STATE_ENTITY_TYPES);
const STATE_LOCK_WAIT_MS = 25;
const STATE_LOCK_STALE_MS = 60 * 1000;

export function stateEventPath(root, runId) {
  assertNonEmptyString(root, "root");
  assertNonEmptyString(runId, "runId");
  return join(root, ".hush", "runs", runId, "events.jsonl");
}

export function readStateEvents(root, runId) {
  const path = stateEventPath(root, runId);
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => parseEventLine(line, index + 1, path));
}

export function appendStateEvent(root, runId, change) {
  assertPlainObject(change, "change");

  return withStateLock(root, runId, () => appendStateEventUnlocked(root, runId, change));
}

export function claimAction(root, runId, { actionKey, sourceEventId, eventType, leaseExpiresAt, now = new Date().toISOString(), actor = "hush" } = {}) {
  assertNonEmptyString(actionKey, "actionKey");
  assertNonEmptyString(sourceEventId, "sourceEventId");
  assertNonEmptyString(eventType, "eventType");
  assertNonEmptyString(leaseExpiresAt, "leaseExpiresAt");

  return withStateLock(root, runId, () => {
    const events = readStateEvents(root, runId);
    const actionEventsForKey = events.filter((event) => event.action_key === actionKey || event.data?.action_key === actionKey);
    if (actionEventsForKey.some((event) => event.action === "action-completed" || event.data?.action_status === "COMPLETED")) {
      return { status: "COMPLETED", action_key: actionKey };
    }
    const dispatches = actionEventsForKey.filter((event) => event.action === "action-dispatched");
    const latest = dispatches.at(-1);
    if (latest && Date.parse(latest.data?.lease_expires_at ?? "") > Date.parse(now)) {
      return { status: "IN_FLIGHT", action_key: actionKey, lease_expires_at: latest.data.lease_expires_at };
    }
    const attempt = dispatches.length + 1;
    const event = appendStateEventUnlocked(root, runId, {
      entity_type: "watcher",
      entity_id: actionKey,
      action: "action-dispatched",
      action_key: actionKey,
      actor,
      cause: sourceEventId,
      timestamp: now,
      data: { action_key: actionKey, source_event_id: sourceEventId, action_status: "IN_FLIGHT", lease_expires_at: leaseExpiresAt, event_type: eventType, attempt },
    });
    return { status: "CLAIMED", action_key: actionKey, attempt, event };
  });
}

export function withStateLock(root, runId, callback, { lockName = "state", staleMs = STATE_LOCK_STALE_MS } = {}) {
  assertNonEmptyString(root, "root");
  assertNonEmptyString(runId, "runId");
  if (typeof callback !== "function") throw new Error("callback must be a function");
  const lockPath = join(root, ".hush", "runs", runId, `${lockName}.lock`);
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, "wx");
      writeFileSync(fd, `${process.pid}\n`, "utf8");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) unlinkSync(lockPath);
      } catch {}
      if (fd === undefined) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STATE_LOCK_WAIT_MS);
      }
    }
  }
  try {
    return callback();
  } finally {
    closeSync(fd);
    try { unlinkSync(lockPath); } catch {}
  }
}

function appendStateEventUnlocked(root, runId, change) {

  const entityType = change.entity_type ?? change.entityType;
  const entityId = change.entity_id ?? change.entityId;
  assertStateEntityType(entityType);
  assertNonEmptyString(entityId, "entity_id");
  assertNonEmptyString(change.action, "action");
  assertNonEmptyString(change.actor, "actor");
  assertNonEmptyString(change.cause, "cause");

  const events = readStateEvents(root, runId);
  const prior = latestRevision(events, entityType, entityId);
  const revision = prior + 1;
  const event = {
    event_id: change.event_id ?? nextEventId(events),
    run_id: runId,
    entity_type: entityType,
    entity_id: entityId,
    revision,
    prior_revision: prior === 0 ? null : prior,
    action: change.action,
    actor: change.actor,
    cause: change.cause,
    timestamp: change.timestamp ?? new Date().toISOString(),
    data: change.data ?? {},
  };
  if (change.action_key !== undefined) assertNonEmptyString(change.action_key, "action_key");
  if (change.action_key !== undefined) event.action_key = change.action_key;

  assertNonEmptyString(event.event_id, "event_id");
  assertPlainObject(event.data, "data");

  const path = stateEventPath(root, runId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export function actionKeyFor({ eventId, entityId, action, attempt = 1 }) {
  for (const [name, value] of Object.entries({ eventId, entityId, action })) assertNonEmptyString(value, name);
  assertPositiveInteger(attempt, "attempt");
  return `sha256:${createHash("sha256").update(`${eventId}\0${entityId}\0${action}\0${attempt}`, "utf8").digest("hex")}`;
}

export function actionEvents(events, actionKey) {
  assertNonEmptyString(actionKey, "actionKey");
  return events.filter((event) => event.action_key === actionKey || event.data?.action_key === actionKey);
}

export function hasActionKey(events, actionKey) {
  return actionEvents(events, actionKey).some((event) => ["action-dispatched", "action-started", "action-completed", "action-in-flight"].includes(event.action) || event.data?.action_status === "IN_FLIGHT" || event.data?.action_status === "COMPLETED");
}

export function replayStateEvents(events) {
  const state = {
    events: [],
    entities: Object.fromEntries(STATE_ENTITY_TYPES.map((type) => [type, {}])),
  };

  for (const event of events) {
    assertStateEvent(event);
    state.events.push(event);
    state.entities[event.entity_type][event.entity_id] = {
      ...(state.entities[event.entity_type][event.entity_id] ?? {}),
      ...event.data,
      id: event.entity_id,
      type: event.entity_type,
      revision: event.revision,
      updated_at: event.timestamp,
      last_event_id: event.event_id,
    };
  }

  return state;
}

export function replayRunState(root, runId) {
  return replayStateEvents(readStateEvents(root, runId));
}

function latestRevision(events, entityType, entityId) {
  return events.reduce((revision, event) => {
    if (event.entity_type !== entityType || event.entity_id !== entityId) return revision;
    return Math.max(revision, event.revision);
  }, 0);
}

function nextEventId(events) {
  return `EVT-${String(events.length + 1).padStart(6, "0")}`;
}

function parseEventLine(line, lineNumber, path) {
  try {
    const event = JSON.parse(line);
    assertStateEvent(event);
    return event;
  } catch (error) {
    throw new Error(`Invalid state event at ${path}:${lineNumber}: ${error.message}`);
  }
}

function assertStateEvent(event) {
  assertPlainObject(event, "event");
  assertNonEmptyString(event.event_id, "event_id");
  assertNonEmptyString(event.run_id, "run_id");
  assertStateEntityType(event.entity_type);
  assertNonEmptyString(event.entity_id, "entity_id");
  assertPositiveInteger(event.revision, "revision");
  if (event.prior_revision !== null) assertPositiveInteger(event.prior_revision, "prior_revision");
  assertNonEmptyString(event.action, "action");
  assertNonEmptyString(event.actor, "actor");
  assertNonEmptyString(event.cause, "cause");
  assertNonEmptyString(event.timestamp, "timestamp");
  assertPlainObject(event.data, "data");
}

function assertStateEntityType(entityType) {
  assertNonEmptyString(entityType, "entity_type");
  if (!stateEntityTypeSet.has(entityType)) {
    throw new Error(`Unsupported entity_type: ${entityType}`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}
