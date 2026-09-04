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
PRD -> Fable -> Rook -> Flint -> Puck -> Vera -> Hush accepts
```

If something is vague, Fable asks.
If work conflicts, Rook blocks.
If code is wrong, Puck catches it.
If tests pass but intent is wrong, Vera catches it.
If evidence is weak, Hush refuses to accept.

## Install

Install agents + skill into Codex, Claude Code, Gemini CLI, and OpenCode:

```sh
npx hush-agents install
```

This copies:

- Codex agents into `~/.codex/agents`
- Codex skill into `~/.codex/skills/hush-agents`
- Claude Code agents into `~/.claude/agents`
- Claude Code skill into `~/.claude/skills/hush-agents`
- Gemini CLI agents into `~/.gemini/agents`
- Gemini CLI skill into `~/.gemini/skills/hush-agents`
- OpenCode agents into `~/.config/opencode/agents`
- OpenCode skill into `~/.config/opencode/skills/hush-agents`

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

This package gives you Codex, Claude Code, Gemini CLI, and OpenCode profiles, plus a workflow skill.

It does not yet ship a full production Hush runtime. The runtime proof exists as a local prototype; the next step is turning that into a stable CLI.

## License

MIT
