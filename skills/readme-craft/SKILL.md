---
name: readme-craft
description: "Write or improve project READMEs that make the right reader reach a first useful result quickly, understand the core idea, and trust what the project can do."
---

# Readme Craft

Make the README feel like a good first conversation with the project:

`identity -> first win -> aha -> trust -> next step`

The reader should know what this is, do something useful, understand why it is
different, and know where to continue without wading through a template.

## Modes

Choose one mode before editing:

- **Create:** inspect the project, then write the smallest truthful README that
  gets a new user to a first result.
- **Improve:** preserve useful project-specific information, remove friction,
  repair stale instructions, and sharpen the first-use path.
- **Audit:** report broken commands, missing context, unsupported claims, and
  unnecessary sections. Do not rewrite unless asked.

## Inspect First

Read the existing README and inspect the project. Confirm the real project name,
purpose, entry points, install command, runnable examples, package scripts,
supported platforms, license, current status, and useful docs. Treat source
code and configuration as truth.

Identify the primary reader: user, contributor, operator, maintainer, or
evaluator. A README can serve several readers, but one must own the opening.

Never invent features, links, screenshots, badges, performance claims, roadmap
items, environment variables, output, or support guarantees. Mark unknowns
clearly or leave them out.

## Route By Project Type

Use the matching route as a guide, not a mandatory checklist:

- **CLI:** promise, install, first command, common commands, examples, output,
  options, and troubleshooting.
- **Library:** what it solves, install, smallest usage example, API entry points,
  types and type inference, supported runtime, and deeper docs.
- **App:** purpose, install or deploy, first useful workflow, screenshots or a
  verified demo when available, configuration, and known limitations.
- **Agent:** role, invocation, inputs, workflow, boundaries, outputs, tools or
  permissions, and a small real example.
- **Monorepo:** what lives here, a map of apps/packages, workspace setup, root
  commands, package navigation, dependency relationships, and release flow when
  one exists.

Combine routes when needed. A monorepo containing a CLI should explain the
repository map first, then link to the CLI's own first-use path.

## Badge Design

Treat badges as a compact trust layer below the project identity. Add one only
when it answers a real reader question and the repository can verify its value.

Choose from these groups:

- **Trust:** current release/version, build or test status, license, supported
  runtime, and package metadata.
- **Community:** stars, downloads, Discord, discussions, sponsors, or funding
  when that community signal is established and useful.
- **Proof:** a linked demo, benchmark, compatibility result, or project-specific
  metric when its source, date, and meaning are clear.

Use three to six high-signal badges by default. A small project may need only a
version and license badge. A mature project may earn more. Never use stars,
downloads, or made-up static numbers as proof that the software works.

For GitHub or npm READMEs, a centered HTML header is appropriate when it makes
the project easier to recognize and still renders acceptably as plain Markdown:

```html
<p align="center">
  <a href="https://github.com/OWNER/REPO">
    <img src="https://raw.githubusercontent.com/OWNER/REPO/main/path/to/logo.svg" alt="Project logo" width="160">
  </a>
</p>
<h1 align="center">Project name</h1>
<p align="center">One concrete sentence about the useful outcome.</p>
<p align="center">
  <a href="https://github.com/OWNER/REPO/releases">
    <img src="https://img.shields.io/github/v/release/OWNER/REPO" alt="Latest release">
  </a>
  <a href="https://github.com/OWNER/REPO/actions">
    <img src="https://img.shields.io/github/actions/workflow/status/OWNER/REPO/WORKFLOW.yml?branch=main" alt="Build status">
  </a>
  <a href="https://github.com/OWNER/REPO/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/OWNER/REPO" alt="License">
  </a>
</p>
```

Replace every placeholder and remove any badge whose source does not exist.
Link each badge to the page that explains or verifies it. Give every image
useful `alt` text; add `title` text when the metric needs context. Prefer
dynamic provider badges over hand-edited numbers. Do not add CI, coverage,
downloads, benchmark, community, or sponsor badges just because the format is
available. If a repository has no workflow or metric, leave that badge out.

The opening should still work when images fail: name, promise, install command,
and first example must carry the README. Keep generated badge blocks stable and
small; do not let them push the first useful action below the fold.

## Write In Reader Order

Use the smallest structure that answers these questions in order:

1. What is this?
2. Why would I use it?
3. How do I install it?
4. What is the shortest successful example?
5. What should I notice or understand after it works?
6. Where do I go next?

Usually this means:

- project title and one-sentence promise
- one useful install command
- one copyable quick-start example
- expected result or a clear success signal
- one short explanation of the core idea or workflow
- only the configuration, API, roles, package map, or troubleshooting the
  project actually needs
- development, contributing, and license details when they are real and useful

Put the memorable idea near the first example. Make it concrete and truthful,
not a slogan floating above the work. Show the project doing its job before
explaining every option.

## Taste Rules

- Make the first viewport answer “what is this?” and “why care?”
- Optimize three reading tests: identity in **3 seconds**, first useful result in
  **60 seconds**, and a confident next step in **5 minutes**.
- Prefer concrete verbs, commands, inputs, and outputs over adjectives.
- Make the first code block runnable, or label every value the reader must
  replace.
- Include expected output when it removes doubt or teaches the key idea.
- Explain the one idea that makes the project click; move secondary detail into
  later sections or linked docs.
- Use compact tables for roles, commands, options, packages, or comparisons.
- Use diagrams only when a relationship or workflow is genuinely easier to see.
- Keep sections proportional. Small tools need a short path; large frameworks
  need navigation and deeper guides.
- Use a warm, distinctive voice only where it improves recall. Every claim still
  needs evidence in the repository or a linked source.
- Be honest about alpha status, missing features, platform limits, and unsafe or
  destructive commands.
- Use badges sparingly and only for current, verifiable status.
- Keep badges near the identity, before the first useful command; never use them
  to hide an unclear project promise.
- Never leave template placeholders, empty sections, fake contact details, or
  generic marketing copy.

The Best README Template is inspiration for progressive disclosure and
practical sections, not a checklist. Do not copy its table of contents, badges,
roadmap, contact block, or acknowledgements unless this project needs them.

## Verify

Before finishing:

- run or dry-run the documented install and quick-start commands when safe
- check every command, path, package name, script, and link against the repo
- ensure code blocks use the correct language and match the current API
- confirm screenshots, demos, badges, and version claims are real and current
- check that a clean reader can tell what success looks like
- remove claims that cannot be verified
- apply the 3-second, 60-second, and 5-minute tests
- keep the README short enough that the main workflow is easy to scan

Report an unverified command, missing project information, or unavailable asset
instead of fabricating it.
