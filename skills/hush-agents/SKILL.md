---
name: hush-agents
description: Run a PRD-to-code workflow with Fable, Rook, Flint, Puck, Vera, and Hush: requirements, task graph, scoped implementation, independent verification, alignment, and acceptance.
---

# Hush Agents

Use this when a user wants to turn a PRD, issue, or product intent into code through a safer multi-agent loop.

## Roles

- Fable turns intent into traceable requirements and preserves unknowns.
- Rook maps requirements to code surfaces, finds shared hubs, and creates safe task batches.
- Flint implements one Hush packet in one worktree and reports evidence.
- Puck independently verifies the frozen candidate.
- Vera lifts behavior from code and compares it to the approved requirements.
- Hush owns state, packets, worktrees, routing, retry limits, and final acceptance.

## Core Loop

1. Fable creates requirement IDs and unknowns.
2. Rook creates a dependency-backed task graph.
3. Hush issues one immutable packet for one task.
4. Flint implements only allowed writable surfaces.
5. Hush freezes the candidate snapshot.
6. Puck verifies behavior; Vera checks requirement alignment only when required.
7. Independent tasks keep moving in parallel.
8. Hush integrates a ready candidate once at the PR boundary.
9. Hush reuses evidence when the implementation patch is unchanged; otherwise it runs targeted rechecks.
10. Hush accepts only when the integrated candidate has valid evidence and passing integration checks.

## Single-command runner

When the repository has a run config, invoke the durable workflow with:

```sh
hush-agents run <prd-path> --repo <path> --target <branch> --config <run-config.json> --json
```

Use `--dry-run` to validate without dispatching, and `--resume <run-id>` after
an interruption. Exit `0` means local acceptance and `READY_FOR_PR`; remote
GitHub delivery and merge require their own provider evidence.

## Hard Rules

- Do not let Flint verify itself.
- Do not let Puck or Vera patch code.
- Do not accept without packet, snapshot, report, and digest bindings.
- Do not parallelize tasks that share writable files, migrations, auth policy, route registration, global state, or test fixtures.
- If the PRD is vague, route to Fable or a human before coding.
- Do not rerun Puck or Vera only because a clean rebase changed the commit SHA.
- Recheck only changed behavior or affected dependencies after integration.

## Useful Output

Prefer concise artifacts:

- requirement map
- task graph
- immutable packet
- implementation report
- verification report
- alignment report
- acceptance record

When a gate fails, patch the smallest proven issue and rerun only the affected gate.
