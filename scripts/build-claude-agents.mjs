#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const codexAgentsDir = join(root, "agents");
const claudeAgentsDir = join(root, "agents", "claude");
const geminiAgentsDir = join(root, "agents", "gemini");
const opencodeAgentsDir = join(root, "agents", "opencode");

function readTomlString(source, key) {
  const triple = source.match(new RegExp(`${key}\\s*=\\s*"""\\n?([\\s\\S]*?)\\n?"""`));
  if (triple) return triple[1].trim();
  const quoted = source.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`));
  if (quoted) return quoted[1];
  throw new Error(`missing ${key}`);
}

function yamlQuote(value) {
  return JSON.stringify(value);
}

function toolsFor(sandboxMode) {
  if (sandboxMode === "read-only") return "Read, Grep, Glob, LS";
  return "Read, Grep, Glob, LS, Bash, Edit, MultiEdit, Write";
}

function geminiToolsFor(name, sandboxMode) {
  if (sandboxMode === "read-only") {
    return ["read_file", "grep_search"];
  }
  if (name === "hush" || name === "puck") {
    return ["*"];
  }
  return ["read_file", "grep_search", "run_shell_command", "replace"];
}

function yamlList(values) {
  return values.map((value) => `  - ${value}`).join("\n");
}

function opencodePermissionFor(sandboxMode) {
  const edit = sandboxMode === "read-only" ? "deny" : "ask";
  return `permission:\n  read: allow\n  glob: allow\n  grep: allow\n  list: allow\n  edit: ${edit}\n  bash: ask\n  task: ask\n  skill: allow\n  external_directory: ask`;
}

mkdirSync(claudeAgentsDir, { recursive: true });
mkdirSync(geminiAgentsDir, { recursive: true });
mkdirSync(opencodeAgentsDir, { recursive: true });

for (const file of readdirSync(codexAgentsDir).filter((name) => name.endsWith(".toml")).sort()) {
  const source = readFileSync(join(codexAgentsDir, file), "utf8");
  const name = readTomlString(source, "name");
  const description = readTomlString(source, "description");
  const sandboxMode = readTomlString(source, "sandbox_mode");
  const body = readTomlString(source, "developer_instructions");
  const stem = basename(file, ".toml");

  const claudeMarkdown = `---\nname: ${name}\ndescription: ${yamlQuote(description)}\ntools: ${toolsFor(sandboxMode)}\nmodel: inherit\n---\n\n${body}\n`;
  writeFileSync(join(claudeAgentsDir, `${stem}.md`), claudeMarkdown);

  const geminiMarkdown = `---\nname: ${name}\ndescription: ${yamlQuote(description)}\nkind: local\ntools:\n${yamlList(geminiToolsFor(name, sandboxMode))}\nmodel: inherit\n---\n\n${body}\n`;
  writeFileSync(join(geminiAgentsDir, `${stem}.md`), geminiMarkdown);

  const opencodeMarkdown = `---\ndescription: ${yamlQuote(description)}\nmode: subagent\n${opencodePermissionFor(sandboxMode)}\n---\n\n${body}\n`;
  writeFileSync(join(opencodeAgentsDir, `${stem}.md`), opencodeMarkdown);
}
