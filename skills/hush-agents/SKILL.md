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
6. Puck verifies behavior and regression evidence.
7. Vera checks whether the code still matches the requirement.
8. Hush accepts only when required evidence matches.

## Hard Rules

- Do not let Flint verify itself.
- Do not let Puck or Vera patch code.
- Do not accept without packet, snapshot, report, and digest bindings.
- Do not parallelize tasks that share writable files, migrations, auth policy, route registration, global state, or test fixtures.
- If the PRD is vague, route to Fable or a human before coding.

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
