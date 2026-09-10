# PRD: Event Queue Drain

## Summary

Add a bounded queue-drain mode to the Hush event watcher. A drain must process
events appended by handlers, preserve the durable cursor and action-key
idempotency rules, and stop with an explicit result when the run is paused,
there is no progress, or a safety limit is reached.

## Current Evidence

- `watchOnce()` reads the event log once and loops over that snapshot. Events
  appended by a handler are processed only by a later call.
- `watchRun()` repeats polling only when `follow` is enabled.
- The CLI has no drain flag, queue-depth result, or bounded drain status.
- Existing tests cover cursor recovery and duplicate action keys, but not
  handler-generated follow-up events or drain termination.

## Goals

- Provide an explicit `watch --drain` operation.
- Process the current backlog plus events appended during handling until the
  cursor reaches the current event-log tail.
- Keep at-least-once delivery, deterministic action keys, durable cursors,
  action leases, retries, blocking, pause behavior, and read-only replay.
- Prevent infinite loops from faulty handlers or self-generating events.
- Report enough state for a caller to decide whether to retry or investigate.

## Non-goals

- No broker, external queue service, or database.
- No change to the append-only event-log format.
- No concurrent handler execution in the drain loop.
- No automatic force deletion or skipping of events.

## Requirements

| ID | Requirement | Acceptance evidence |
|---|---|---|
| QDR-001 | `watch --drain` invokes a durable drain operation for one run. | CLI fixture returns `DRAINED` for a finite backlog. |
| QDR-002 | Drain repeatedly invokes the existing watcher until no events remain after the durable cursor. | A handler appends a follow-up event; one drain processes both the original and follow-up. |
| QDR-003 | Drain uses deterministic action keys and the existing cursor, so rerunning it does not duplicate a completed side effect. | Duplicate drain calls produce no second handler call. |
| QDR-004 | Drain stops as `PAUSED` without invoking handlers when the run is paused. | Paused fixture leaves the cursor and handler call count unchanged. |
| QDR-005 | Drain stops as `NO_PROGRESS` if a cycle cannot advance the cursor. | A bounded fixture returns `NO_PROGRESS` rather than looping. |
| QDR-006 | Drain stops as `LIMIT_REACHED` when `max_events` or `max_cycles` is reached and returns the durable cursor and pending count. | Limit fixtures return the limit status and a retryable backlog. |
| QDR-007 | Defaults are finite and conservative: `max_events=10000`, `max_cycles=100`. Callers may lower or raise them explicitly. | Boundary tests cover default and explicit limits. |
| QDR-008 | Drain is not available through replay; replay remains read-only and cannot invoke handlers or providers. | Replay tests show zero handler calls and no action events. |
| QDR-009 | `watch --follow --drain` drains each polling cycle before waiting for new events. | Follow fixture drains a handler-generated event in one cycle. |
| QDR-010 | Results include `status`, `processed`, `cycles`, `cursor`, and `pending_events`. | JSON result schema is asserted in CLI and module tests. |

## Result Contract

```json
{
  "status": "DRAINED | PAUSED | NO_PROGRESS | LIMIT_REACHED",
  "processed": [],
  "cycles": 1,
  "cursor": { "cursor": 4 },
  "pending_events": 0
}
```

`pending_events` is the number of events after the durable cursor at the final
check. A nonzero value means the caller can retry drain. The drain never moves
the cursor past an event it has not handled or durably blocked.

## CLI

```text
hush-agents watch --run <id> --root <repo> --drain
hush-agents watch --run <id> --root <repo> --drain --max-events 100 --max-cycles 10
hush-agents watch --run <id> --root <repo> --follow --drain
```

## Implementation Boundaries

- `lib/runtime/watcher.mjs`: add the drain loop and result calculation.
- `bin/hush-agents.mjs`: parse `--drain`, `--max-events`, and `--max-cycles`.
- `test/continuity.test.mjs`: cover appended events, idempotency, pause,
  limits, no progress, and follow mode.
- `README.md`: document the explicit drain command.

## Unknowns

None. The implementation uses the existing append-only event log and cursor;
no product or provider decision is required.
