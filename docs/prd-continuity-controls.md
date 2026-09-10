# PRD: Hush Workflow Continuity Controls

Status: Ready for Fable and Rook review
Owner: Hush Agents
Related: scheduler, warm worktree base, merge queue, evidence contract, end-to-end runner

## Problem

Hush now has durable state, packets, a scheduler, warm worktrees, independent
verification, and a merge queue. The workflow still stops between many of
those components. Operators must manually notice an event and run the next
command. Several safety controls also exist only as data fields or generic
validators rather than enforced workflow gates.

The missing continuity is:

```text
event -> decision -> action -> evidence -> next event
```

The required improvements are grouped into two classes:

- Red: missing connectors that stop the workflow.
- Yellow: controls that exist but are not enforced strongly enough.

## Goal

Create a durable event loop and complete the safety gates so Hush can advance
normal runs automatically, recover after restart, and stop only for a real
human decision, unresolved conflict, or unsafe condition. The same controls
must be reachable through one resumable command from PRD input through local
integration.

## Non-goals

- Choosing product behavior or resolving requirement ambiguity automatically.
- Giving agents permission to modify outside their packets.
- Removing the existing manual CLI commands; they remain recovery tools.
- Building a general-purpose message broker.
- Replacing the local merge queue with a remote provider in this PRD.

## State model

The append-only JSONL event log remains the source of truth. Every automatic
action must be represented by an event and be safe to retry.

Each action event must include:

- `event_id`
- `run_id`
- `entity_id`
- `revision` and `prior_revision`
- `actor`
- `cause`
- `action_key`
- timestamp
- result or durable retry information

## Requirements

### Event-driven continuity

| ID | Requirement | Acceptance evidence |
|---|---|---|
| CONT-001 | Hush provides `watch --run <id> --root <repo>` that consumes new run events and advances eligible work. | A task completion automatically causes the next eligible verification or routing event without a second manual command. |
| CONT-002 | The watcher stores a durable event cursor and can resume after process termination. | Restarting the watcher processes no event twice and does not skip an event. |
| CONT-003 | Hush maps workflow events to deterministic handlers for scheduling, worktree allocation, Puck, Vera, merge queue, PR, and CI actions. | Handler fixture maps each supported event to one expected action or an explicit block. |
| CONT-004 | Every automatic action has an idempotent `action_key`; an existing completed or in-flight key prevents duplicate dispatch. | Replayed events do not launch duplicate workers, leases, checks, merges, PR updates, or CI polls. |
| CONT-005 | Lease expiry, retry deadlines, and CI polling deadlines are durable timers derived from state, not only in-memory timers. | A restarted watcher discovers overdue timers and records the same recovery decision as a continuously running watcher. |
| CONT-006 | `pause`, `resume`, and `replay` commands operate on the same event log without deleting events. | Paused runs emit no new actions; resume continues from the cursor; replay produces the same derived state. |
| CONT-007 | A handler must verify packet, snapshot, environment, and evidence bindings before dispatch. | Stale or mismatched input emits a blocking event and does not invoke the worker or integration adapter. |
| CONT-008 | Handler failures become durable `ACTION_FAILED`, `ACTION_RETRY_SCHEDULED`, or `HUMAN_DECISION_REQUIRED` events. | Exceptions cannot silently terminate the run or leave an entity in an unexplained active state. |

### Verification continuity

| ID | Requirement | Acceptance evidence |
|---|---|---|
| CONT-009 | High-risk requirements can declare mutation checks covering authorization, publication, consent, audit, and security behavior. | A surviving mutation creates a blocking finding and prevents acceptance. |
| CONT-010 | Mutation checks run against the frozen candidate snapshot and bind results to packet, candidate, changed paths, and report digest. | A result from another candidate or snapshot is rejected. |
| CONT-010A | The repository contains a versioned StrykerJS configuration and a deterministic command for running the required mutation checks. | A clean checkout can run the configured mutation command without an untracked or machine-local configuration. |
| CONT-010B | Hush executes the configured StrykerJS run against the frozen candidate snapshot and records its exact command, tool version, changed paths, exit status, mutation score, surviving mutations, and report digest. | A real mutation run produces a bound durable evidence record; missing configuration, unavailable StrykerJS, timeout, or incomplete report blocks acceptance. |
| CONT-011 | Puck live verification and Vera requirement alignment remain separate gates. | A Puck pass cannot satisfy a required Vera decision, and a Vera result cannot replace live verification. |
| CONT-012 | Vera has read-only shell access to inspect its frozen snapshot and run approved non-mutating checks. | Vera can verify commit/tree identity and required inputs but cannot write files, commit, merge, or accept. |

### Source-grounded requirements

| ID | Requirement | Acceptance evidence |
|---|---|---|
| CONT-013 | Fable requirement records must include source path, location, digest, exact quote, discovery method, and verified quote-back. | Missing, truncated, fabricated, or mismatched source data is rejected before approval. |
| CONT-014 | Hush re-reads the declared source during packet validation when the source is available in the repository or supplied snapshot. | A changed source digest or quote mismatch blocks dispatch. |
| CONT-015 | Requirement enumerations must be marked `EXHAUSTIVE` or `ILLUSTRATIVE`; illustrative lists cannot narrow the rule's scope. | A missing route is reported as a finding rather than treated as out of scope. |

### Per-write-path evidence

| ID | Requirement | Acceptance evidence |
|---|---|---|
| CONT-016 | Every packet declares the complete set of in-scope write paths separately from allowed paths. | A packet with no write-path inventory is invalid. |
| CONT-017 | Every required acceptance check declares the write paths it covers and an evidence artifact ID. | A category-level check without path coverage cannot pass acceptance. |
| CONT-018 | Puck reports must bind observed write paths to checks and must cover every packet write path. | Missing, extra, or unbound paths create `EVIDENCE_INCOMPLETE`. |
| CONT-019 | An uncertain route inventory produces a blocking finding or full-scope check, never silent acceptance. | Unknown route ownership triggers Fable/human review or expanded verification. |

### Repository hazard inventory

| ID | Requirement | Acceptance evidence |
|---|---|---|
| CONT-020 | Each repository has a versioned hazard inventory for database, credentials, email, webhooks, uploads, and network. | Inventory events identify repository, category, policy, evidence, revision, and digest. |
| CONT-021 | Environment preflight requires a complete, current inventory whose policies match the packet environment. | Missing, stale, contradictory, or unsafe inventory blocks boot before application import. |
| CONT-022 | Hazard evidence records how the policy was established, including config path, command, or explicit human decision. | A policy without inspectable evidence is `UNKNOWN` and blocks live execution. |
| CONT-023 | Hazard inventory changes invalidate affected warm bases and active packets. | A changed database, credential, email, upload, webhook, or network policy prevents reuse. |

### Measured concurrency

| ID | Requirement | Acceptance evidence |
|---|---|---|
| CONT-024 | Hush records host-capacity observations with available workers, safe limit, confidence, timestamp, and measurement evidence. | Capacity observations replay as durable state. |
| CONT-025 | Scheduler uses the most recent trusted safe limit, defaults to a conservative baseline of 3, and never exceeds hard maximum 8. | A measured limit of 3 admits at most 3; a request for 9 never admits more than 8. |
| CONT-026 | Missing, stale, contradictory, or low-confidence capacity produces zero new admissions until a new observation is recorded. | Uncertain capacity cannot cause speculative parallelism. |
| CONT-027 | Capacity changes affect new admissions only and do not revoke active leases. | Existing tasks continue under their leases; new tasks use the new limit. |

### PR and CI continuity

| ID | Requirement | Acceptance evidence |
|---|---|---|
| CONT-028 | A `READY_FOR_PR` integration record can be converted into a deterministic PR payload containing title, summary, requirements, checks, evidence, and risk findings. | Same acceptance record produces the same payload. |
| CONT-029 | Hush creates or updates a PR through a provider adapter without treating remote success as local acceptance. | Provider request and response are recorded; local acceptance remains bound to the integrated snapshot. |
| CONT-030 | Hush polls or receives CI results and records them as events bound to PR, commit, workflow, and report digest. | A result for another commit cannot advance the run. |
| CONT-031 | Passing CI advances only candidates satisfying all local acceptance rules; failing CI routes repair or human decision. | CI pass cannot bypass missing Puck, Vera, evidence, or environment records. |
| CONT-032 | Provider outage, permission failure, or ambiguous status blocks delivery without mutating the candidate or target. | The run remains resumable with a durable reason. |
| CONT-032A | Before any auto-merge request, Hush queries GitHub branch protection for the target branch through `gh-axi` and verifies that the response matches the repository, target branch, and expected policy revision. | Auto-merge is blocked when protection is missing, disabled, ambiguous, stale, or from another repository or branch. |
| CONT-032B | Hush records the branch-protection response, request identity, response digest, checked timestamp, and policy fields used by the auto-merge decision. | The acceptance record proves which live protection state authorized or blocked the merge. |

### End-to-end runner

The end-to-end runner is in scope for this PRD. It is the command-level entry
point over the durable event loop; it does not replace the event log, packet
boundaries, or individual recovery commands.

| ID | Requirement | Acceptance evidence |
|---|---|---|
| E2E-001 | Runner accepts a PRD path, repository root, target branch, and run options. | Invalid or missing inputs fail before state mutation. |
| E2E-002 | Runner creates a run ID, source manifest, environment preflight, and initial append-only state. | Run directory contains immutable initialization records. |
| E2E-003 | Runner invokes configured Fable and refuses scheduling when blocking unknowns remain. | An ambiguous fixture stops at Fable with clear questions. |
| E2E-004 | Runner invokes configured Rook and validates task graph, hub ownership, and dependency coverage. | Missing requirement or task coverage blocks dispatch. |
| E2E-005 | Runner delegates ready tasks through the scheduler and worktree pool. | Flint receives a packet-bound isolated worktree. |
| E2E-006 | Runner invokes Flint, routes candidates to Puck, and invokes required Vera using frozen snapshots. | Gate reports bind to packet, snapshot, and digests. |
| E2E-007 | Runner sends failures to the correct repair path and resumes from state after restart. | A failure fixture resumes without duplicating completed evidence. |
| E2E-008 | Runner passes accepted candidates to the merge queue and integration checks. | Integration outcome appears in the acceptance record. |
| E2E-009 | Runner exits with stable codes for success, blocked, failed, human decision, and invalid input. | CLI code and JSON summary match run state. |
| E2E-010 | Runner supports `--resume <run-id>`, `--dry-run`, `--json`, and `--max-workers <n>`. | Options are deterministic and covered by CLI tests. |
| E2E-011 | Runner writes no secrets into reports and retains artifacts with redaction and restricted-access policy. | Secret-redaction and artifact-permission fixtures pass. |
| E2E-012 | Runner never claims acceptance unless all required evidence and integration checks are valid. | Missing Puck, Vera, evidence, or integration fixtures exit non-success. |

## Event handler table

| Event | Handler | Next action |
|---|---|---|
| `TASK_READY` | Scheduler | Admit task or record capacity/block reason |
| `WORKTREE_AVAILABLE` | Worktree allocator | Issue packet-bound lease |
| `WORKER_COMPLETED` | Candidate handler | Freeze snapshot and route Puck |
| `PUCK_VERIFIED` | Verification router | Route Vera or acceptance |
| `VERA_ALIGNED` | Queue handler | Enqueue accepted candidate |
| `LEASE_EXPIRED` | Recovery handler | Block, retry with new packet, or request human decision |
| `READY_FOR_PR` | Delivery adapter | Render or update PR payload |
| `CI_PASSED` | Acceptance handler | Record delivery readiness or merge according to policy |
| `CI_FAILED` | Failure router | Route repair or human decision |
| `HAZARD_CHANGED` | Safety handler | Invalidate affected packets and warm bases |
| `CAPACITY_OBSERVED` | Scheduler | Recompute future admission limit |

## CLI interface

```text
hush-agents watch --run <id> --root <repo>
hush-agents pause --run <id> --root <repo>
hush-agents resume --run <id> --root <repo>
hush-agents replay --run <id> --root <repo>
hush-agents run <prd-path> --repo <path> --target <branch> --config <run-config.json> [--resume <run-id>] [--dry-run] [--json] [--max-workers <n>]
hush-agents observe-capacity --run <id> --root <repo> --available <n> --safe-limit <n> --confidence <level>
hush-agents verify-write-paths --packet <file> --report <file>
hush-agents render-pr --run <id> --root <repo>
```

Existing manual commands remain supported for recovery and diagnostics.

The run configuration names the Fable, Rook, Flint, Puck, and Vera adapters,
safe environment profile, target branch, setup commands, required gates, and
artifact root. No implicit production credentials or service defaults are
allowed. JSON output includes the run ID, PRD revision, state, task counts,
blockers, candidate and integration IDs, evidence IDs, and exit reason.

Runner failure behavior:

- Invalid input: exit `2`, with no run dispatch.
- Blocking unknown or human decision: exit `3`.
- Environment hazard: exit `4`, with no application boot.
- Implementation or verification failure: exit `5`, preserving evidence and repair routing.
- Successful local acceptance: exit `0` only after integration checks and required gates.
- Interrupted process: append an interruption event; `--resume` recovers leases and continues safely.

## Implementation slices

1. Event cursor, handler registry, action keys, durable timers, pause/resume/replay.
2. Source, write-path, hazard, and capacity validation gates.
3. Mutation-check policy, committed StrykerJS configuration, real candidate mutation execution, and separate Vera shell capability.
4. PR payload, provider adapter boundary, live branch-protection lookup, and CI result ingestion.
5. End-to-end CLI configuration, adapter contracts, run initialization, stable exit codes, and JSON output.
6. Scheduler/worktree orchestration, agent invocation, repair routing, resume, redaction, and final acceptance record.
7. Restart, duplicate-event, outage, stale-input, high-risk mutation, and full PRD-to-integration fixtures.

## Verification plan

- `npm test`
- `npm run pack:check`
- `git diff --check`
- Restart watcher at every handler boundary.
- Replay the same event log twice and compare state and action keys.
- Submit duplicate events and prove no duplicate side effect.
- Reject truncated quotes, stale hazards, incomplete write paths, and uncertain capacity.
- Survive PR/CI provider timeout without advancing acceptance.
- Kill each high-risk guard and require mutation failure.
- Run StrykerJS from a clean checkout using only the committed configuration.
- Reject missing, stale, ambiguous, or mismatched GitHub branch-protection responses before auto-merge.
- Run a complete happy-path fixture from PRD input to accepted local integration.
- Stop correctly for ambiguous PRD, missing dependency, unsafe environment, packet mismatch, Puck failure, Vera mismatch, merge conflict, and CI failure.
- Kill and resume during each major state without duplicating completed evidence.
- Verify deterministic replay, CLI exit codes, JSON output, redaction, and packed-package smoke behavior.

## Success metrics

- 0 duplicate side effects after event replay.
- 100% of approved requirements have verified source quote-back.
- 100% of in-scope write paths have bound evidence.
- 0 runs boot with missing or stale hazard inventory.
- 0 admissions when capacity is unknown.
- 100% of delivery transitions have PR/CI identity bindings.
- 100% of auto-merge decisions have live branch-protection evidence.
- 100% of required mutation checks have real StrykerJS evidence bound to the candidate snapshot.
- Normal runs advance without manual commands between successful gates.
- A single command can take a valid PRD through independent verification and local integration.

## Done

Hush can run one command from a valid PRD through Fable, Rook, Flint, Puck,
Vera, the scheduler, worktrees, merge queue, and local integration; restart
and continue from its event log; enforce all yellow safety controls; create a
bound PR payload; process CI results; and stop with an explainable durable
decision when the workflow cannot safely continue.
