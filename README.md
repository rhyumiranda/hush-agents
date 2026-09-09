# Hush Agents

**Turn a PRD into code without letting one agent grade its own homework.**

Hush Agents is a small multi-harness crew for agentic engineering:

| Agent | Job |
|---|---|
| Fable | turns intent into clear requirements |
| Rook | splits work into safe tasks |
| Flint | writes one scoped code change |
| Puck | tests the change independently |
| Vera | checks code still matches the requirement |
| Hush | controls packets, worktrees, routing, and acceptance |

That is the whole idea:

```text
PRD -> Fable -> Rook -> parallel Flint -> Puck/Vera -> integrate once -> PR -> CI -> release
```

If something is vague, Fable asks.
If work conflicts, Rook blocks.
If code is wrong, Puck catches it.
If tests pass but intent is wrong, Vera catches it.
If evidence is weak, Hush refuses to accept.

Independent tasks run in parallel. Hush integrates only when a candidate is ready for a PR. A clean integration reuses Puck/Vera evidence when the implementation patch and affected dependencies are unchanged; conflict resolution triggers targeted checks only.

## Install

Install agents + skills into Codex, Claude Code, Gemini CLI, and OpenCode:

```sh
npx hush-agents install
```

This copies:

- Codex agents into `~/.codex/agents`
- Codex skills into `~/.codex/skills/hush-agents` and `~/.codex/skills/readme-craft`
- Claude Code agents into `~/.claude/agents`
- Claude Code skills into `~/.claude/skills/hush-agents` and `~/.claude/skills/readme-craft`
- Gemini CLI agents into `~/.gemini/agents`
- Gemini CLI skills into `~/.gemini/skills/hush-agents` and `~/.gemini/skills/readme-craft`
- OpenCode agents into `~/.config/opencode/agents`
- OpenCode skills into `~/.config/opencode/skills/hush-agents` and `~/.config/opencode/skills/readme-craft`

Check install:

```sh
npx hush-agents doctor
```

Install only the reusable skill into skill-compatible harnesses:

```sh
npx skills add rhyumiranda/hush-agents --skill hush-agents
```

## Use

In any supported harness, call the agents by name:

```text
@fable turn this PRD into requirements
@rook make the task graph
@flint implement T-01
@puck verify the frozen candidate
@vera align code to requirements
@hush decide the next route
```

If Claude Code only shows `general-purpose`, run `npx hush-agents install` again. That means Claude does not see the custom `.md` agents yet.

Use the skill when you want the whole workflow explained or applied:

```text
$hush-agents run this PRD through the loop
$readme-craft improve this README for a new user
```

## Runtime Foundation

`hush-agents` now includes the first runtime pieces:

- `validate-packet <packet.json>` checks sealed packet integrity
- packet digests use canonical JSON with `digest` omitted
- invalid packets return stable JSON with `status`, `issue.field`, and `issue.rule`
- append-only state helpers write JSONL under `.hush/runs/<run_id>/events.jsonl`
- Flint can use hash-anchored reads and edits that reject stale files before changing code
- Hush tracks pre-integration evidence and targeted final rechecks

Example:

```sh
hush-agents validate-packet packet.json

hush-agents hashline-read src/file.js
hush-agents hashline-patch src/file.js patch.json --dry-run
```

## Why It Works

Most AI coding fails from mixed roles.

One agent writes code.
The same agent says it is fine.
Nobody checks whether the code still means what the PRD meant.

Hush Agents separates the jobs.

Small roles. Hard gates. Better evidence.

## Proof

We tested the crew on a sample shipping project:

- Fable found unknowns.
- Rook made one safe task.
- Flint changed only `src/shipping.js`.
- Puck blocked bad packet digests until Hush fixed them.
- Puck verified exact outputs.
- Vera matched code back to requirements.

Final result: Puck `VERIFIED`, Vera `ALIGNED`, Hush accepted.

See [`docs/live-agent-shipping-runtime-report.md`](docs/live-agent-shipping-runtime-report.md).

## Not Magic

This package gives you Codex, Claude Code, Gemini CLI, and OpenCode profiles, plus a workflow skill and the first packet/state runtime foundation.

It does not yet ship the full Hush runtime. Warm worktree bases, scheduler, merge queue, and full run commands are next.

## License

MIT
