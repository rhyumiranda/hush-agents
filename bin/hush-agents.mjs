#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.HOME;

function usage() {
  console.log(`hush-agents[3]{command,what,next}:
  install,"copy Codex agents + skill","hush-agents doctor"
  doctor,"check package files + installed files","hush-agents install"
  help,"show commands","hush-agents install"`);
}

function copyDirFiles(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    copyFileSync(join(src, name), join(dest, name));
  }
}

function install() {
  if (!home) {
    console.log("error: HOME is not set");
    process.exit(1);
  }
  copyDirFiles(join(root, "agents"), join(home, ".codex", "agents"));
  mkdirSync(join(home, ".codex", "skills", "hush-agents"), { recursive: true });
  copyFileSync(
    join(root, "skills", "hush-agents", "SKILL.md"),
    join(home, ".codex", "skills", "hush-agents", "SKILL.md"),
  );
  console.log(`installed[2]{kind,path}:
  agents,${join(home, ".codex", "agents")}
  skill,${join(home, ".codex", "skills", "hush-agents")}`);
}

function doctor() {
  const agentNames = ["fable", "rook", "flint", "puck", "vera", "hush"];
  const bundledAgents = agentNames.filter((name) => existsSync(join(root, "agents", `${name}.toml`)));
  const installedAgents = home
    ? agentNames.filter((name) => existsSync(join(home, ".codex", "agents", `${name}.toml`)))
    : [];
  const bundledSkill = existsSync(join(root, "skills", "hush-agents", "SKILL.md"));
  const installedSkill = home && existsSync(join(home, ".codex", "skills", "hush-agents", "SKILL.md"));
  const readme = readFileSync(join(root, "README.md"), "utf8");
  console.log(`doctor:
  package: hush-agents
  bundled_agents: ${bundledAgents.length}/6
  bundled_skill: ${bundledSkill ? "yes" : "no"}
  installed_agents: ${installedAgents.length}/6
  installed_skill: ${installedSkill ? "yes" : "no"}
  readme_chars: ${readme.length}`);
}

const command = process.argv[2] ?? "help";
if (command === "install") install();
else if (command === "doctor") doctor();
else if (command === "help" || command === "--help" || command === "-h") usage();
else {
  console.log(`error: unknown command ${command}
help: valid commands are install, doctor, help`);
  process.exit(2);
}
