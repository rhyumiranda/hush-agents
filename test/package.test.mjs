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

test("ships hush-agents skill", () => {
  const skill = readFileSync(join(root, "skills", "hush-agents", "SKILL.md"), "utf8");
  assert.match(skill, /name: hush-agents/);
  assert.match(skill, /Fable/);
  assert.match(skill, /Puck/);
  assert.match(skill, /Vera/);
});

test("readme stays proportionate", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.ok(readme.length < 5000);
  assert.match(readme, /PRD -> Fable -> Rook -> Flint -> Puck -> Vera -> Hush accepts/);
});
