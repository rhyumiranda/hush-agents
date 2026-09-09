import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

test("ships six agent profiles", () => {
  for (const name of ["fable", "rook", "flint", "puck", "vera", "hush"]) {
    assert.equal(existsSync(join(root, "agents", `${name}.toml`)), true);
  }
});

test("ships six Claude Code agent profiles", () => {
  for (const name of ["fable", "rook", "flint", "puck", "vera", "hush"]) {
    const agent = readFileSync(join(root, "agents", "claude", `${name}.md`), "utf8");
    assert.match(agent, new RegExp(`name: ${name}`));
    assert.match(agent, /description:/);
    assert.match(agent, /tools:/);
    assert.match(agent, /model: inherit/);
  }
});

test("ships six Gemini CLI agent profiles", () => {
  for (const name of ["fable", "rook", "flint", "puck", "vera", "hush"]) {
    const agent = readFileSync(join(root, "agents", "gemini", `${name}.md`), "utf8");
    assert.match(agent, new RegExp(`name: ${name}`));
    assert.match(agent, /kind: local/);
    assert.match(agent, /tools:\n/);
  }
});

test("ships six OpenCode agent profiles", () => {
  for (const name of ["fable", "rook", "flint", "puck", "vera", "hush"]) {
    const agent = readFileSync(join(root, "agents", "opencode", `${name}.md`), "utf8");
    assert.match(agent, /mode: subagent/);
    assert.match(agent, /permission:/);
    assert.match(agent, /description:/);
  }
});

test("ships hush-agents skill", () => {
  const skill = readFileSync(join(root, "skills", "hush-agents", "SKILL.md"), "utf8");
  assert.match(skill, /name: hush-agents/);
  assert.match(skill, /Fable/);
  assert.match(skill, /Puck/);
  assert.match(skill, /Vera/);
});

test("readme stays proportionate", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.ok(readme.length < 6000);
  assert.match(readme, /PRD -> Fable -> Rook -> parallel Flint -> Puck\/Vera -> integrate once -> PR -> CI -> release/);
  assert.match(readme, /Claude Code/);
  assert.match(readme, /Gemini CLI/);
  assert.match(readme, /OpenCode/);
});
