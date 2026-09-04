import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  STATE_ENTITY_TYPES,
  appendStateEvent,
  readStateEvents,
  replayRunState,
  replayStateEvents,
  stateEventPath,
} from "../lib/runtime/state.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "hush-state-"));
}

test("events append as JSONL under the run state path", () => {
  const root = tempRoot();
  const event = appendStateEvent(root, "RUN-1", {
    entity_type: "run",
    entity_id: "RUN-1",
    action: "created",
    actor: "hush",
    cause: "init-run",
    timestamp: "2026-09-05T00:00:00.000Z",
    data: { status: "OPEN" },
  });

  assert.equal(stateEventPath(root, "RUN-1"), join(root, ".hush", "runs", "RUN-1", "events.jsonl"));
  assert.equal(event.revision, 1);
  assert.equal(event.prior_revision, null);

  const lines = readFileSync(stateEventPath(root, "RUN-1"), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), event);
  assert.deepEqual(readStateEvents(root, "RUN-1"), [event]);
});

test("revisions are derived from prior state for the same entity", () => {
  const root = tempRoot();

  appendStateEvent(root, "RUN-1", {
    entityType: "task",
    entityId: "T-02",
    action: "created",
    actor: "rook",
    cause: "plan-v1",
    timestamp: "2026-09-05T00:00:00.000Z",
    data: { status: "READY" },
  });
  const second = appendStateEvent(root, "RUN-1", {
    entityType: "task",
    entityId: "T-02",
    action: "dispatched",
    actor: "hush",
    cause: "packet PKT-T02-R1",
    timestamp: "2026-09-05T00:01:00.000Z",
    data: { status: "ACTIVE", packet_id: "PKT-T02-R1" },
  });
  const otherEntity = appendStateEvent(root, "RUN-1", {
    entityType: "task",
    entityId: "T-03",
    action: "created",
    actor: "rook",
    cause: "plan-v1",
    timestamp: "2026-09-05T00:02:00.000Z",
    data: { status: "WAITING" },
  });

  assert.equal(second.revision, 2);
  assert.equal(second.prior_revision, 1);
  assert.equal(otherEntity.revision, 1);
  assert.equal(otherEntity.prior_revision, null);
});

test("replay derives latest entity state from append-only events", () => {
  const root = tempRoot();
  appendStateEvent(root, "RUN-1", {
    entityType: "candidate",
    entityId: "CAND-1",
    action: "created",
    actor: "flint",
    cause: "implementation",
    timestamp: "2026-09-05T00:00:00.000Z",
    data: { status: "BUILT", start_sha: "abc" },
  });
  appendStateEvent(root, "RUN-1", {
    entityType: "candidate",
    entityId: "CAND-1",
    action: "snapshot-requested",
    actor: "flint",
    cause: "ready for puck",
    timestamp: "2026-09-05T00:01:00.000Z",
    data: { status: "READY_FOR_PUCK", end_sha: "def" },
  });

  const state = replayRunState(root, "RUN-1");

  assert.equal(state.events.length, 2);
  assert.deepEqual(state.entities.candidate["CAND-1"], {
    id: "CAND-1",
    type: "candidate",
    revision: 2,
    updated_at: "2026-09-05T00:01:00.000Z",
    last_event_id: "EVT-000002",
    status: "READY_FOR_PUCK",
    start_sha: "abc",
    end_sha: "def",
  });
});

test("runtime state covers every required entity type", () => {
  assert.deepEqual(STATE_ENTITY_TYPES, [
    "run",
    "requirement",
    "task",
    "packet",
    "worktree",
    "candidate",
    "snapshot",
    "evidence",
    "finding",
    "human_decision",
    "merge_event",
  ]);
});

test("invalid event data is rejected before append or replay", () => {
  const root = tempRoot();

  assert.throws(
    () =>
      appendStateEvent(root, "RUN-1", {
        entityType: "unknown",
        entityId: "X",
        action: "created",
        actor: "hush",
        cause: "test",
      }),
    /Unsupported entity_type/,
  );

  assert.throws(
    () =>
      replayStateEvents([
        {
          event_id: "EVT-000001",
          run_id: "RUN-1",
          entity_type: "run",
          entity_id: "RUN-1",
          revision: 0,
          prior_revision: null,
          action: "created",
          actor: "hush",
          cause: "test",
          timestamp: "2026-09-05T00:00:00.000Z",
          data: {},
        },
      ]),
    /revision must be a positive integer/,
  );
});
