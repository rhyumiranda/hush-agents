import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const cli = join(root, "bin", "hush-agents.mjs");

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

test("ships readme-craft skill", () => {
  const skill = readFileSync(join(root, "skills", "readme-craft", "SKILL.md"), "utf8");
  assert.match(skill, /name: readme-craft/);
  assert.match(skill, /sections proportional/);
  assert.match(skill, /Badge Design/);
  assert.match(skill, /Replace every placeholder/);
  assert.match(skill, /Never leave template placeholders/);
});

test("readme stays proportionate", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.ok(readme.length < 6000);
  assert.match(readme, /assets\/hush-agents-banner\.jpeg/);
  assert.doesNotMatch(readme, /PRD -> Fable -> Rook -> Flint -> Puck \+ Vera -> Hush -> PR/);
  assert.match(readme, /Claude Code/);
  assert.match(readme, /Gemini CLI/);
  assert.match(readme, /OpenCode/);
});

test("installer selects agents across all harnesses", () => {
  const home = mkdtempSync(join(tmpdir(), "hush-agents-install-"));
  try {
    const result = spawnSync(process.execPath, [cli, "install", "--agents", "fable,vera"], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /selected_agents,all,fable,vera/);

    for (const [directory, extension] of [
      [join(home, ".codex", "agents"), ".toml"],
      [join(home, ".claude", "agents"), ".md"],
      [join(home, ".gemini", "agents"), ".md"],
      [join(home, ".config", "opencode", "agents"), ".md"],
    ]) {
      assert.equal(existsSync(join(directory, `fable${extension}`)), true);
      assert.equal(existsSync(join(directory, `vera${extension}`)), true);
      assert.equal(existsSync(join(directory, `rook${extension}`)), false);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("installer rejects unknown agents before writing", () => {
  const home = mkdtempSync(join(tmpdir(), "hush-agents-install-"));
  try {
    const result = spawnSync(process.execPath, [cli, "install", "--agents", "fable,unknown"], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stdout, /unknown agent\(s\): unknown/);
    assert.equal(existsSync(join(home, ".codex", "agents")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("list-agents reports the supported profiles", () => {
  const output = execFileSync(process.execPath, [cli, "list-agents"], { encoding: "utf8" });
  assert.deepEqual(output.trim().split("\n"), ["fable", "rook", "flint", "puck", "vera", "hush"]);
});
