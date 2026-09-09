#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PACKET_STATUS, validatePacket } from "../lib/runtime/packet.mjs";
import { applyHashline, readHashline } from "../lib/runtime/hashline.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.HOME;

function usage() {
  console.log(`hush-agents[3]{command,what,next}:
  install,"copy Codex, Claude Code, Gemini CLI, and OpenCode agents","hush-agents doctor"
  doctor,"check package files + installed files","hush-agents install"
  validate-packet <packet.json> [context options],"validate packet shape, digest, and status","hush-agents validate-packet packet.json"
  hashline-read <file>,"read a file with content-hashed line anchors","hush-agents hashline-read src/file.js"
  hashline-patch <file> <patch.json> [--dry-run],"apply hash-anchored edits and reject stale reads","hush-agents hashline-patch src/file.js patch.json"
  help,"show commands","hush-agents install"`);
}

function copyDirFiles(src, dest, extension) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const source = join(src, name);
    if (!statSync(source).isFile()) continue;
    if (extension && !name.endsWith(extension)) continue;
    copyFileSync(source, join(dest, name));
  }
}

function copySkill(destRoot) {
  mkdirSync(join(destRoot, "skills", "hush-agents"), { recursive: true });
  copyFileSync(
    join(root, "skills", "hush-agents", "SKILL.md"),
    join(destRoot, "skills", "hush-agents", "SKILL.md"),
  );
}

function install() {
  if (!home) {
    console.log("error: HOME is not set");
    process.exit(1);
  }
  copyDirFiles(join(root, "agents"), join(home, ".codex", "agents"), ".toml");
  copyDirFiles(join(root, "agents", "claude"), join(home, ".claude", "agents"), ".md");
  copyDirFiles(join(root, "agents", "gemini"), join(home, ".gemini", "agents"), ".md");
  copyDirFiles(join(root, "agents", "opencode"), join(home, ".config", "opencode", "agents"), ".md");
  copySkill(join(home, ".codex"));
  copySkill(join(home, ".claude"));
  copySkill(join(home, ".gemini"));
  copySkill(join(home, ".config", "opencode"));
  console.log(`installed[8]{kind,harness,path}:
  agents,codex,${join(home, ".codex", "agents")}
  skill,codex,${join(home, ".codex", "skills", "hush-agents")}
  agents,claude-code,${join(home, ".claude", "agents")}
  skill,claude-code,${join(home, ".claude", "skills", "hush-agents")}
  agents,gemini-cli,${join(home, ".gemini", "agents")}
  skill,gemini-cli,${join(home, ".gemini", "skills", "hush-agents")}
  agents,opencode,${join(home, ".config", "opencode", "agents")}
  skill,opencode,${join(home, ".config", "opencode", "skills", "hush-agents")}`);
}

function doctor() {
  const agentNames = ["fable", "rook", "flint", "puck", "vera", "hush"];
  const bundledCodexAgents = agentNames.filter((name) => existsSync(join(root, "agents", `${name}.toml`)));
  const bundledClaudeAgents = agentNames.filter((name) => existsSync(join(root, "agents", "claude", `${name}.md`)));
  const bundledGeminiAgents = agentNames.filter((name) => existsSync(join(root, "agents", "gemini", `${name}.md`)));
  const bundledOpencodeAgents = agentNames.filter((name) => existsSync(join(root, "agents", "opencode", `${name}.md`)));
  const installedCodexAgents = home
    ? agentNames.filter((name) => existsSync(join(home, ".codex", "agents", `${name}.toml`)))
    : [];
  const installedClaudeAgents = home
    ? agentNames.filter((name) => existsSync(join(home, ".claude", "agents", `${name}.md`)))
    : [];
  const installedGeminiAgents = home
    ? agentNames.filter((name) => existsSync(join(home, ".gemini", "agents", `${name}.md`)))
    : [];
  const installedOpencodeAgents = home
    ? agentNames.filter((name) => existsSync(join(home, ".config", "opencode", "agents", `${name}.md`)))
    : [];
  const bundledSkill = existsSync(join(root, "skills", "hush-agents", "SKILL.md"));
  const installedCodexSkill = home && existsSync(join(home, ".codex", "skills", "hush-agents", "SKILL.md"));
  const installedClaudeSkill = home && existsSync(join(home, ".claude", "skills", "hush-agents", "SKILL.md"));
  const installedGeminiSkill = home && existsSync(join(home, ".gemini", "skills", "hush-agents", "SKILL.md"));
  const installedOpencodeSkill = home && existsSync(join(home, ".config", "opencode", "skills", "hush-agents", "SKILL.md"));
  const readme = readFileSync(join(root, "README.md"), "utf8");
  console.log(`doctor:
  package: hush-agents
  bundled_codex_agents: ${bundledCodexAgents.length}/6
  bundled_claude_code_agents: ${bundledClaudeAgents.length}/6
  bundled_gemini_cli_agents: ${bundledGeminiAgents.length}/6
  bundled_opencode_agents: ${bundledOpencodeAgents.length}/6
  bundled_skill: ${bundledSkill ? "yes" : "no"}
  installed_codex_agents: ${installedCodexAgents.length}/6
  installed_claude_code_agents: ${installedClaudeAgents.length}/6
  installed_gemini_cli_agents: ${installedGeminiAgents.length}/6
  installed_opencode_agents: ${installedOpencodeAgents.length}/6
  installed_codex_skill: ${installedCodexSkill ? "yes" : "no"}
  installed_claude_code_skill: ${installedClaudeSkill ? "yes" : "no"}
  installed_gemini_cli_skill: ${installedGeminiSkill ? "yes" : "no"}
  installed_opencode_skill: ${installedOpencodeSkill ? "yes" : "no"}
  readme_chars: ${readme.length}`);
}

function validatePacketCommand(packetPath, args = []) {
  if (!packetPath) {
    console.log(
      JSON.stringify({
        status: "READ_ERROR",
        issue: { field: "path", rule: "packet path is required" },
      }),
    );
    process.exit(2);
  }

  let packet;
  try {
    packet = JSON.parse(readFileSync(packetPath, "utf8"));
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "READ_ERROR",
        issue: {
          field: "path",
          path: packetPath,
          rule: error instanceof SyntaxError ? "must be valid JSON" : "must be readable",
          message: error.message,
        },
      }),
    );
    process.exit(2);
  }

  const context = parsePacketContextArgs(args);
  const result = validatePacket(packet, context);
  console.log(JSON.stringify(result));
  process.exit(result.status === PACKET_STATUS.VALID ? 0 : 1);
}

function parsePacketContextArgs(args) {
  const context = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const parsed = parseOption(arg);
    const name = parsed.name;
    const value = parsed.value ?? args[index + 1];
    if (parsed.value === undefined) index += 1;

    if (value === undefined) {
      console.log(
        JSON.stringify({
          status: "READ_ERROR",
          issue: { field: name, rule: "option value is required" },
        }),
      );
      process.exit(2);
    }

    if (name === "--current-base-sha") context.currentBaseSha = value;
    else if (name === "--target-agent") context.targetAgent = value;
    else if (name === "--changed-path") pushValue(context, "changedPaths", value);
    else if (name === "--dependency") pushDependency(context, value);
    else if (name === "--active-packet-id") pushValue(context, "activePacketIds", value);
    else if (name === "--superseded-packet-id") pushValue(context, "supersededPacketIds", value);
    else if (name === "--now") context.now = value;
    else {
      console.log(
        JSON.stringify({
          status: "READ_ERROR",
          issue: { field: name, rule: "unknown option" },
        }),
      );
      process.exit(2);
    }
  }

  return context;
}

function hashlineReadCommand(filePath) {
  if (!filePath) {
    console.log(JSON.stringify({ status: "READ_ERROR", issue: { field: "path", rule: "file path is required" } }));
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(readHashline(filePath)));
  } catch (error) {
    console.log(JSON.stringify({ status: "READ_ERROR", issue: { field: "path", rule: error.message } }));
    process.exit(2);
  }
}

function hashlinePatchCommand(filePath, patchPath, args) {
  if (!filePath || !patchPath) {
    console.log(JSON.stringify({ status: "READ_ERROR", issue: { field: "path", rule: "file and patch paths are required" } }));
    process.exit(2);
  }
  try {
    const patch = JSON.parse(readFileSync(patchPath, "utf8"));
    console.log(JSON.stringify(applyHashline(filePath, patch, { dryRun: args.includes("--dry-run") })));
  } catch (error) {
    console.log(JSON.stringify({ status: "BLOCKED", issue: { field: "edit", rule: error.message } }));
    process.exit(1);
  }
}

function parseOption(arg) {
  const separator = arg.indexOf("=");
  if (separator === -1) return { name: arg, value: undefined };
  return { name: arg.slice(0, separator), value: arg.slice(separator + 1) };
}

function pushValue(context, key, value) {
  context[key] ??= [];
  context[key].push(value);
}

function pushDependency(context, value) {
  const separator = value.indexOf("=");
  const dependency =
    separator === -1
      ? { id: value, status: "BLOCKED" }
      : { id: value.slice(0, separator), status: value.slice(separator + 1) };
  pushValue(context, "dependencies", dependency);
}

const command = process.argv[2] ?? "help";
if (command === "install") install();
else if (command === "doctor") doctor();
else if (command === "validate-packet") validatePacketCommand(process.argv[3], process.argv.slice(4));
else if (command === "hashline-read") hashlineReadCommand(process.argv[3]);
else if (command === "hashline-patch") hashlinePatchCommand(process.argv[3], process.argv[4], process.argv.slice(5));
else if (command === "help" || command === "--help" || command === "-h") usage();
else {
  console.log(`error: unknown command ${command}
help: valid commands are install, doctor, validate-packet, hashline-read, hashline-patch, help`);
  process.exit(2);
}
