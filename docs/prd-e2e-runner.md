# PRD: Hush End-to-End Runner

Status: Superseded; requirements merged into `docs/prd-continuity-controls.md`
Owner: Hush Agents
Related: scheduler, warm worktree base, merge queue, evidence contract

## Problem

Users can install profiles and validate packets, but no single command starts a PRD run. The workflow exists as instructions spread across agents and docs, so normal execution depends on manual coordination and cannot reliably produce a complete acceptance record.

## Goal

Provide one command that initializes a run, invokes the configured Fable/Rook/Flint/Puck/Vera adapters through Hush, integrates accepted candidates, and exits with a deterministic status plus durable artifacts.

## Non-goals

- Choosing a model or harness automatically when the user has not configured one.
- Resolving product ambiguity without Fable or a human.
- Publishing packages or merging remote pull requests in v1.
- Hiding intermediate reports; every handoff remains inspectable.

## Requirements

| ID | Requirement | Acceptance evidence |
|---|---|---|
| E2E-001 | Runner accepts a PRD path, repository root, target branch, and run options. | Invalid/missing inputs fail before state mutation. |
| E2E-002 | Runner creates a run ID, source manifest, environment preflight, and initial append-only state. | Run directory contains immutable initialization records. |
| E2E-003 | Runner invokes Fable and refuses scheduling when blocking unknowns remain. | Ambiguous fixture stops at Fable with clear questions. |
| E2E-004 | Runner invokes Rook and validates task graph, hub ownership, and dependency coverage. | Missing requirement/task coverage blocks dispatch. |
| E2E-005 | Runner delegates ready tasks through the scheduler and worktree pool. | Flint receives a packet-bound isolated worktree. |
| E2E-006 | Runner routes candidates to Puck and required Vera using frozen snapshots. | Gate reports bind to packet, snapshot, and digests. |
| E2E-007 | Runner sends failures to the correct repair path and resumes from state after restart. | Failure fixture resumes without duplicating completed evidence. |
| E2E-008 | Runner passes accepted candidates to the merge queue and integration checks. | Integration outcome appears in the acceptance record. |
| E2E-009 | Runner exits with stable codes: success, blocked, failed, human decision, or invalid input. | CLI code and JSON summary match run state. |
| E2E-010 | Runner supports `--resume <run-id>`, `--dry-run`, `--json`, and `--max-workers 8`. | Options are deterministic and covered by CLI tests. |
| E2E-011 | Runner writes no secrets into reports and retains indefinitely stored artifacts with redaction and restricted access policy. | Secret-redaction fixture passes; artifact permissions are checked. |
| E2E-012 | Runner never claims acceptance unless all required evidence and integration checks are valid. | Missing Puck/Vera/evidence fixture exits non-success. |

## CLI interface

```text
hush-agents run <prd-path> \
  --repo <path> \
  --target <branch> \
  --config <run-config.json> \
  [--resume <run-id>] [--dry-run] [--json] [--max-workers 8]
```

Run configuration names the harness adapters, safe environment profile, target branch, setup commands, required gates, and artifact root. No implicit production credentials or service defaults are allowed.

JSON summary must include run ID, PRD revision, state, task counts, current blockers, candidate/integration IDs, evidence IDs, and exit reason.

## Failure behavior

- Invalid input: exit `2`, no run dispatch.
- Blocking unknown: exit `3`, state `HUMAN_DECISION` or `BLOCKED`.
- Environment hazard: exit `4`, no application boot.
- Implementation/verification failure: exit `5`, preserve evidence and repair route.
- Successful acceptance: exit `0` only after integration checks and required gates.
- Interrupted process: append interruption event; `--resume` recovers leases and continues safely.

## Implementation slices

1. CLI config parsing, run initialization, and stable exit codes.
2. Adapter contract for Fable/Rook/Flint/Puck/Vera.
3. Scheduler/worktree orchestration.
4. Verification, repair, resume, and evidence routing.
5. Merge queue integration and final acceptance record.
6. JSON output, dry-run, redaction, and package documentation.

## Verification

- Full happy-path fixture from PRD to accepted local integration.
- Ambiguous PRD, missing dependency, unsafe environment, packet mismatch, Puck failure, Vera mismatch, merge conflict, and CI failure fixtures.
- Kill-and-resume test during each major state.
- Deterministic replay test from event log.
- CLI exit-code and JSON contract tests.
- `npm test`, `npm run pack:check`, and a packed-package smoke test.

## Done

An engineer can run one command, follow a durable Hush workflow from PRD through independent verification and local integration, resume interrupted work, inspect every artifact, and trust the exit status.
