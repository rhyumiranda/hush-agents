<p align="center">
  <img src="assets/hush-agents-banner.jpeg" alt="Hush Agents workflow: PRD to Fable, Rook, Flint, Puck, Vera, Hush, and a pull request" width="100%">
</p>

<h1 align="center">Hush Agents</h1>

<p align="center">
  Turn a PRD into code without letting one agent grade its own homework.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/hush-agents"><img src="https://img.shields.io/npm/v/hush-agents?style=flat-square" alt="Latest npm version"></a>
  <a href="https://www.npmjs.com/package/hush-agents"><img src="https://img.shields.io/node/v/hush-agents?style=flat-square" alt="Supported Node.js version"></a>
  <a href="https://github.com/rhyumiranda/hush-agents/stargazers"><img src="https://img.shields.io/github/stars/rhyumiranda/hush-agents?style=flat-square" alt="GitHub stars"></a>
  <a href="https://github.com/rhyumiranda/hush-agents/blob/main/LICENSE"><img src="https://img.shields.io/github/license/rhyumiranda/hush-agents?style=flat-square" alt="MIT license"></a>
</p>

Hush Agents installs a multi-harness crew for turning product intent into
scoped implementation, independent verification, and requirement alignment.
It installs the agents and runtime foundations; the full scheduler is not yet
automatic.

## Install

Install all agents and skills:

```sh
npx hush-agents install
```

Choose only the agents you need:

```sh
npx hush-agents install --agents fable,rook
```

List agents with `npx hush-agents list-agents`; repeat `--agent` also works.
Old profiles stay.

Check:

```sh
npx hush-agents doctor
```

The installer adds:

| Harness | Agents | Skills |
|---|---|---|
| Codex | `~/.codex/agents` | `hush-agents`, `readme-craft` |
| Claude Code | `~/.claude/agents` | `hush-agents`, `readme-craft` |
| Gemini CLI | `~/.gemini/agents` | `hush-agents`, `readme-craft` |
| OpenCode | `~/.config/opencode/agents` | `hush-agents`, `readme-craft` |

Install only the workflow skill with `skills`:

```sh
npx skills add rhyumiranda/hush-agents --skill hush-agents
```

## Run The Workflow

Give the crew a PRD or product intent in your harness:

```text
@fable turn this PRD into clear, traceable requirements
@rook split the requirements into dependency-aware tasks
@flint implement task T-01 in its assigned worktree
@puck verify the frozen candidate independently
@vera compare the implementation with the approved requirements
@hush route the next step and accept only when the evidence is complete
```

Or invoke the full workflow skill:

```text
$hush-agents run this PRD through the implementation and verification loop
```

The useful result is not just passing tests. You get a chain of evidence:
requirements, task graph, immutable packet, implementation report, verification
report, alignment report, and acceptance record.

## Try The Runtime

Use a packet produced by Hush to check its shape and digest:

```sh
hush-agents validate-packet path/to/packet.json
```

Use hash-anchored editing when a worker must change an existing file:

```sh
hush-agents hashline-read src/file.js
hush-agents hashline-patch src/file.js patch.json --dry-run
```

If a packet is stale, incomplete, or out of scope, the command reports the
reason instead of silently accepting it.

## The Crew

| Agent | Responsibility | Boundary |
|---|---|---|
| **Fable** | Turns intent into requirements and preserves unknowns. | Does not implement. |
| **Rook** | Maps requirements to code surfaces and safe task batches. | Blocks unsafe parallel work. |
| **Flint** | Implements one scoped task in one worktree. | Does not grade its own work. |
| **Puck** | Tests the frozen candidate independently. | Does not patch code. |
| **Vera** | Compares lifted behavior with approved requirements. | Does not patch code. |
| **Hush** | Owns packets, state, routing, worktrees, retries, and acceptance. | Accepts only valid evidence. |

## How It Works

1. **Fable** gives requirements stable IDs and records ambiguity.
2. **Rook** builds a dependency graph and marks tasks that can run in parallel.
3. **Hush** issues one immutable packet per task.
4. **Flint** edits only its allowed surfaces in an isolated worktree.
5. **Hush** freezes the candidate snapshot.
6. **Puck** checks behavior; **Vera** checks alignment when required.
7. Independent tasks continue in parallel. Shared files, migrations, auth,
   global state, and shared fixtures stay ordered.
8. **Hush** integrates once at the PR boundary and reruns only checks affected
   by changed behavior or dependencies.

If a gate fails, the smallest proven fix is made and only the affected gate is
rerun. A clean rebase does not automatically invalidate evidence when the patch
and affected dependencies are unchanged.

`validate-packet` checks packet shape, digest, scope, target agent, dependencies,
and status context. Hashline editing rejects stale reads before writing. Runtime
events are append-only under `.hush/runs/<run_id>/events.jsonl`.

## Evidence

The live shipping sample demonstrates the full loop:

- Fable found an ambiguous `zone` contract.
- Rook made one safe task.
- Flint changed only `src/shipping.js`.
- Puck independently checked exact outputs and packet integrity.
- Vera matched lifted code behavior back to the requirements.
- Hush accepted only after `VERIFIED` and `ALIGNED` results.

Read the [runtime report](docs/live-agent-shipping-runtime-report.md).

## Current Scope

This package ships agent profiles for Codex, Claude Code, Gemini CLI, and
OpenCode, plus the `hush-agents` and `readme-craft` skills and runtime
foundations for packets, state, and hashline edits.

It does not yet ship a complete scheduler, warm worktree base, merge queue, or
single-command end-to-end runner.

## Contributing

```sh
npm test
npm run pack:check
npm run build:claude-agents
```

## Go Deeper

- [Workflow skill](skills/hush-agents/SKILL.md)
- [Packet schema](schemas/packet.schema.json)
- [Live runtime report](docs/live-agent-shipping-runtime-report.md)

## License

MIT
