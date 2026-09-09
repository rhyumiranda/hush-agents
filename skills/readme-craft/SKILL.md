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
