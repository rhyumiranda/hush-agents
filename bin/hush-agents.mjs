#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { PACKET_STATUS, validatePacket } from "../lib/runtime/packet.mjs";
import { applyHashline, readHashline } from "../lib/runtime/hashline.mjs";
import { dispatchOne, dispatchReadyTasks, recoverExpiredLeases, recoverInterruptedLeases, recordCapacityObservation, writeRunSummary } from "../lib/runtime/scheduler.mjs";
import { allocateWorktree, createWorktree, listWorktrees, releaseWorktree, warmWorktree } from "../lib/runtime/worktree.mjs";
import { abortMerge, enqueueCandidate, processNextMerge, queueStatus } from "../lib/runtime/merge-queue.mjs";
import { pauseRun, replayRun, resumeRun, watchRun } from "../lib/runtime/watcher.mjs";
import { renderPrPayload } from "../lib/runtime/delivery.mjs";
import { validateWritePathCoverage } from "../lib/runtime/evidence.mjs";
import { replayRunState } from "../lib/runtime/state.mjs";
import { RUN_EXIT_CODES, RunnerError, runWorkflow } from "../lib/runtime/runner.mjs";
import { SUPPORTED_HARNESSES, buildHarnessInvocation, loadBundledProfile, parseHarnessOutput } from "../lib/runtime/harness-adapter.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.HOME;
const agentNames = ["fable", "rook", "flint", "puck", "vera", "hush"];
const skillNames = ["hush-agents", "readme-craft"];

function usage() {
  console.log(`hush-agents[3]{command,what,next}:
  install [--agents <list>],"copy selected agents to Codex, Claude Code, Gemini CLI, and OpenCode","hush-agents doctor"
  list-agents,"show available agents","hush-agents install --agents fable,rook"
  codex-register [--agents <list>] [--dry-run],"register selected agents as native Codex roles","hush-agents codex-register --agents fable,rook"
  run <prd-path> --repo <path> --target <branch> --config <file> [--resume <run-id>] [--dry-run] [--json] [--max-workers <n>],"run a configured PRD through Fable, Rook, Flint, Puck, Vera, and local integration","hush-agents run docs/prd.md --repo . --target main --config .hush/run-config.json"
  doctor,"check package files + installed files","hush-agents install"
  validate-packet <packet.json> [context options],"validate packet shape, digest, and status","hush-agents validate-packet packet.json"
  hashline-read <file>,"read a file with content-hashed line anchors","hush-agents hashline-read src/file.js"
  hashline-patch <file> <patch.json> [--dry-run],"apply hash-anchored edits and reject stale reads","hush-agents hashline-patch src/file.js patch.json"
  run-state <run-id> --root <repo>,"print durable scheduler state summary","hush-agents run-state RUN-1 --root ."
  schedule <run-id> --root <repo> --max-workers 8,"admit all safe ready tasks","hush-agents schedule RUN-1 --root . --max-workers 8"
  schedule-once <run-id> --root <repo>,"admit one safe ready task","hush-agents schedule-once RUN-1 --root ."
  recover <run-id> --root <repo>,"block expired worker leases","hush-agents recover RUN-1 --root ."
  recover-interrupted <run-id> --root <repo>,"make interrupted worker leases retryable","hush-agents recover-interrupted RUN-1 --root ."
  harness-adapter --harness <name> --agent <name>,"bridge a native harness to the Hush JSON adapter contract","hush-agents harness-adapter --harness claude --agent fable"
  observe-capacity <run-id> --root <repo> --available-workers <n> --confidence HIGH,"record measured host capacity","hush-agents observe-capacity RUN-1 --root . --available-workers 6 --confidence HIGH"
  watch --run <id> --root <repo> [--follow],"consume durable run events and optionally stay in the foreground","hush-agents watch --run RUN-1 --root . --follow"
  pause --run <id> --root <repo>,"pause automatic actions without deleting events","hush-agents pause --run RUN-1 --root ."
  resume --run <id> --root <repo>,"resume automatic actions from the durable cursor","hush-agents resume --run RUN-1 --root ."
  replay --run <id> --root <repo>,"replay the event log with idempotent action keys","hush-agents replay --run RUN-1 --root ."
  verify-write-paths --packet <file> --report <file>,"verify complete per-write-path evidence coverage","hush-agents verify-write-paths --packet packet.json --report report.json"
  render-pr --run <id> --root <repo>,"render a deterministic PR payload","hush-agents render-pr --run RUN-1 --root ."
  worktree-create --repo <path> --base <sha> --run <id> --task <id>,"create an owned worker worktree","hush-agents worktree-create --repo . --base HEAD --run RUN-1 --task TASK-1"
  worktree-warm --repo <path> --base <sha> --profile <file> --packet <file>,"warm a packet-bound worker worktree","hush-agents worktree-warm --repo . --base <sha> --profile profile.json --packet packet.json"
  worktree-allocate --repo <path> --run <id> --task <id> --packet <file>,"lease one warm worktree","hush-agents worktree-allocate --repo . --run RUN-1 --task TASK-1 --packet packet.json"
  worktree-release --root <repo> --worktree <id> [--cleanup],"release or safely destroy a worker worktree","hush-agents worktree-release --root . --worktree WT-RUN-1-TASK-1 --cleanup"
  worktree-list --repo <path>,"list owned worktree pool records","hush-agents worktree-list --repo ."
  merge-enqueue --root <repo> --repo <path> --run <id> --candidate <id> --target <branch>,"admit one evidence-complete candidate","hush-agents merge-enqueue --root . --repo . --run RUN-1 --candidate CAND-1 --target main"
  merge-status --repo <path> [--target <branch>],"show deterministic merge queue state","hush-agents merge-status --repo . --target main"
  merge-process --root <repo> --repo <path> --target <branch>,"integrate the next accepted candidate","hush-agents merge-process --root . --repo . --target main"
  merge-abort --root <repo> --repo <path> --item <id> --reason <code>,"route an aborted queue item","hush-agents merge-abort --root . --repo . --item MQ-main-CAND-1 --reason HUMAN_ABORT"
  help,"show commands","hush-agents install"`);
}

function copyDirFiles(src, dest, extension, selectedNames = agentNames) {
  mkdirSync(dest, { recursive: true });
  const selectedFiles = new Set(selectedNames.map((name) => `${name}${extension}`));
  for (const name of readdirSync(src)) {
    const source = join(src, name);
    if (!statSync(source).isFile()) continue;
    if (extension && !name.endsWith(extension)) continue;
    if (!selectedFiles.has(name)) continue;
    copyFileSync(source, join(dest, name));
  }
}

function copySkills(destRoot) {
  for (const skillName of skillNames) {
    mkdirSync(join(destRoot, "skills", skillName), { recursive: true });
    copyFileSync(
      join(root, "skills", skillName, "SKILL.md"),
      join(destRoot, "skills", skillName, "SKILL.md"),
    );
  }
}

function readTomlString(source, key) {
  const triple = source.match(new RegExp(`^${key}\\s*=\\s*"""\\n?([\\s\\S]*?)\\n?"""`, "m"));
  if (triple) return triple[1].trim();
  const quoted = source.match(new RegExp(`^${key}\\s*=\\s*"([^"\\n]*)"`, "m"));
  if (quoted) return JSON.parse(`"${quoted[1]}"`);
  throw new Error(`agent profile is missing ${key}`);
}

function copyCodexAgentSkills(destRoot, selectedNames) {
  for (const name of selectedNames) {
    const profile = readFileSync(join(root, "agents", `${name}.toml`), "utf8");
    const description = readTomlString(profile, "description");
    const sandboxMode = readTomlString(profile, "sandbox_mode");
    const instructions = readTomlString(profile, "developer_instructions");
    const skill = [
      "---",
      `name: ${name}`,
      `description: ${JSON.stringify(description)}`,
      "---",
      "",
      `# ${name} agent`,
      "",
      `This terminal skill activates the ${name} agent instructions. Keep the profile boundary: ${sandboxMode}.`,
      "",
      instructions,
      "",
    ].join("\n");
    const destination = join(destRoot, "skills", name, "SKILL.md");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, skill);
  }
}

function parseInstallArgs(args) {
  let selected = null;
  let listOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const parsed = parseOption(args[index]);
    if (parsed.name === "--list-agents") {
      listOnly = true;
      continue;
    }
    if (parsed.name === "--all") {
      if (selected) throw new Error("--all cannot be combined with --agents");
      selected = [...agentNames];
      continue;
    }
    if (parsed.name !== "--agents" && parsed.name !== "--agent") {
      throw new Error(`unknown install option ${parsed.name}`);
    }

    const value = parsed.value ?? args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${parsed.name} requires an agent name`);
    selected ??= [];
    selected.push(...value.split(",").map((name) => name.trim()).filter(Boolean));
  }

  if (listOnly) {
    if (selected || args.some((arg) => arg === "--all")) {
      throw new Error("--list-agents cannot be combined with install options");
    }
    return { listOnly: true, agents: agentNames };
  }

  const agents = selected ?? [...agentNames];
  const invalid = agents.filter((name) => !agentNames.includes(name));
  if (invalid.length) throw new Error(`unknown agent(s): ${[...new Set(invalid)].join(", ")}. Available: ${agentNames.join(", ")}`);
  return { listOnly: false, agents: [...new Set(agents)] };
}

function listAgents() {
  console.log(agentNames.join("\n"));
}

function codexHomePath() {
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  if (!home) return undefined;
  return join(home, ".codex");
}

function upsertTomlSection(source, section, entries) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source ? source.split(/\r?\n/) : [];
  if (lines.at(-1) === "") lines.pop();
  const header = `[${section}]`;
  let headerIndex = lines.findIndex((line) => line.trim() === header);
  if (headerIndex === -1) {
    if (lines.length && lines.at(-1).trim() !== "") lines.push("");
    lines.push(header, ...entries);
    return `${lines.join(newline)}${newline}`;
  }

  let end = lines.findIndex((line, index) => index > headerIndex && /^\s*\[[^\]]+\]\s*$/.test(line));
  if (end === -1) end = lines.length;
  for (const entry of entries) {
    const key = entry.slice(0, entry.indexOf(" = "));
    const keyIndex = lines.findIndex((line, index) => index > headerIndex && index < end && new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}\\s*=`).test(line));
    if (keyIndex === -1) {
      lines.splice(end, 0, entry);
      end += 1;
    } else {
      lines[keyIndex] = entry;
    }
  }
  return `${lines.join(newline)}${newline}`;
}

function parseCodexRegisterArgs(args) {
  let dryRun = false;
  const selectionArgs = [];
  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else selectionArgs.push(arg);
  }
  return { ...parseInstallArgs(selectionArgs), dryRun };
}

function registerCodexAgents(args = []) {
  const options = parseCodexRegisterArgs(args);
  if (options.listOnly) {
    listAgents();
    return;
  }
  const codexHome = codexHomePath();
  if (!codexHome) {
    console.log("error: HOME or CODEX_HOME is not set");
    process.exit(1);
  }

  const configPath = join(codexHome, "config.toml");
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  let next = upsertTomlSection(existing, "features", ["multi_agent = true"]);
  next = upsertTomlSection(next, "agents", ["enabled = true"]);
  for (const name of options.agents) {
    const profilePath = `agents/${name}.toml`;
    const profile = readFileSync(join(root, "agents", `${name}.toml`), "utf8");
    const description = readTomlString(profile, "description");
    next = upsertTomlSection(next, `agents.${name}`, [
      `description = ${JSON.stringify(description)}`,
      `config_file = ${JSON.stringify(profilePath)}`,
    ]);
  }

  const changed = next !== existing;
  if (changed && !options.dryRun) {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(configPath, next);
  }
  console.log(`codex_register{status,config,agents,changed}:
  ${options.dryRun ? "DRY_RUN" : "REGISTERED"},${configPath},${options.agents.join("|")},${changed}
help[1]:
  restart Codex to reload native agent roles`);
}

function install(args = []) {
  const options = parseInstallArgs(args);
  if (options.listOnly) {
    listAgents();
    return;
  }
  if (!home) {
    console.log("error: HOME is not set");
    process.exit(1);
  }
  copyDirFiles(join(root, "agents"), join(home, ".codex", "agents"), ".toml", options.agents);
  copyDirFiles(join(root, "agents", "claude"), join(home, ".claude", "agents"), ".md", options.agents);
  copyDirFiles(join(root, "agents", "gemini"), join(home, ".gemini", "agents"), ".md", options.agents);
  copyDirFiles(join(root, "agents", "opencode"), join(home, ".config", "opencode", "agents"), ".md", options.agents);
  copySkills(join(home, ".codex"));
  copyCodexAgentSkills(join(home, ".codex"), options.agents);
  copySkills(join(home, ".claude"));
  copySkills(join(home, ".gemini"));
  copySkills(join(home, ".config", "opencode"));
  console.log(`installed[8]{kind,harness,path}:
  selected_agents,all,${options.agents.join(",")}
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
  const bundledSkills = skillNames.filter((name) => existsSync(join(root, "skills", name, "SKILL.md")));
  const installedSkills = (destRoot) =>
    home ? skillNames.filter((name) => existsSync(join(destRoot, "skills", name, "SKILL.md"))) : [];
  const installedCodexSkills = installedSkills(join(home, ".codex"));
  const installedCodexAgentSkills = home
    ? agentNames.filter((name) => existsSync(join(home, ".codex", "skills", name, "SKILL.md")))
    : [];
  const installedClaudeSkills = installedSkills(join(home, ".claude"));
  const installedGeminiSkills = installedSkills(join(home, ".gemini"));
  const installedOpencodeSkills = installedSkills(join(home, ".config", "opencode"));
  const readme = readFileSync(join(root, "README.md"), "utf8");
  console.log(`doctor:
  package: hush-agents
  bundled_codex_agents: ${bundledCodexAgents.length}/6
  bundled_claude_code_agents: ${bundledClaudeAgents.length}/6
  bundled_gemini_cli_agents: ${bundledGeminiAgents.length}/6
  bundled_opencode_agents: ${bundledOpencodeAgents.length}/6
  bundled_skills: ${bundledSkills.length}/${skillNames.length}
  installed_codex_agents: ${installedCodexAgents.length}/6
  installed_claude_code_agents: ${installedClaudeAgents.length}/6
  installed_gemini_cli_agents: ${installedGeminiAgents.length}/6
  installed_opencode_agents: ${installedOpencodeAgents.length}/6
  installed_codex_skills: ${installedCodexSkills.length}/${skillNames.length}
  installed_codex_agent_skills: ${installedCodexAgentSkills.length}/${agentNames.length}
  installed_claude_code_skills: ${installedClaudeSkills.length}/${skillNames.length}
  installed_gemini_cli_skills: ${installedGeminiSkills.length}/${skillNames.length}
  installed_opencode_skills: ${installedOpencodeSkills.length}/${skillNames.length}
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

function schedulerArgs(args) {
  const result = { root: "." };
  for (let index = 0; index < args.length; index += 1) {
    const parsed = parseOption(args[index]);
    const value = parsed.value ?? args[index + 1];
    if (parsed.value === undefined) index += 1;
    if (parsed.name === "--root") result.root = value;
    else if (parsed.name === "--max-workers") result.maxWorkers = Number(value);
    else if (parsed.name === "--now") result.now = value;
    else if (parsed.name === "--lease-ms") result.leaseMs = Number(value);
    else if (parsed.name === "--available-workers" || parsed.name === "--available") result.capacityObservation = { ...(result.capacityObservation ?? {}), available_workers: Number(value) };
    else if (parsed.name === "--safe-limit") result.capacityObservation = { ...(result.capacityObservation ?? {}), safe_limit: Number(value) };
    else if (parsed.name === "--confidence") result.capacityObservation = { ...(result.capacityObservation ?? {}), confidence: value };
    else if (parsed.name === "--host-id") result.capacityObservation = { ...(result.capacityObservation ?? {}), host_id: value };
    else if (parsed.name) throw new Error(`unknown option ${parsed.name}`);
  }
  return result;
}

function schedulerCommand(command, runId, args) {
  if (!runId) throw new Error("run id is required");
  const options = schedulerArgs(args);
  if (command === "run-state") console.log(JSON.stringify(writeRunSummary(options.root, runId)));
  else if (command === "observe-capacity") console.log(JSON.stringify(recordCapacityObservation(options.root, runId, options.capacityObservation ?? {}, { now: options.now })));
  else if (command === "schedule") console.log(JSON.stringify(dispatchReadyTasks(options.root, runId, options)));
  else if (command === "schedule-once") console.log(JSON.stringify(dispatchOne(options.root, runId, options)));
  else if (command === "recover-interrupted") console.log(JSON.stringify(recoverInterruptedLeases(options.root, runId, options)));
  else console.log(JSON.stringify(recoverExpiredLeases(options.root, runId, options)));
}

function harnessAdapterCommand(args) {
  let harness;
  let agent;
  let executable;
  let sandbox;
  for (let index = 0; index < args.length; index += 1) {
    const parsed = parseOption(args[index]);
    const value = parsed.value ?? args[index + 1];
    if (parsed.value === undefined) index += 1;
    if (parsed.name === "--harness") harness = value;
    else if (parsed.name === "--agent") agent = value;
    else if (parsed.name === "--executable") executable = value;
    else if (parsed.name === "--sandbox") sandbox = value;
    else if (parsed.name) throw new Error(`unknown option ${parsed.name}`);
  }
  if (!SUPPORTED_HARNESSES.includes(harness)) throw new Error(`--harness must be one of ${SUPPORTED_HARNESSES.join(", ")}`);
  if (!agentNames.includes(agent)) throw new Error(`--agent must be one of ${agentNames.join(", ")}`);
  const input = JSON.parse(readFileSync(0, "utf8"));
  const tempRoot = mkdtempSync(join(tmpdir(), "hush-harness-adapter-"));
  const outputPath = join(tempRoot, "last-message.txt");
  try {
    const invocation = buildHarnessInvocation({ harness, role: agent, payload: input, outputPath, executable, sandbox, profileText: loadBundledProfile(root, harness, agent) });
    const result = spawnSync(invocation.command, invocation.args, { cwd: input.worktree_path ?? input.repository ?? process.cwd(), input: invocation.input, encoding: "utf8", timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, HUSH_RUN_ID: input.run_id ?? "", HUSH_ROLE: agent } });
    if (result.error || result.status !== 0) throw new Error(`${harness} exited ${result.status ?? "with error"}: ${result.error?.message ?? result.stderr ?? "unknown error"}`);
    const outputText = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
    process.stdout.write(`${JSON.stringify(parseHarnessOutput({ harness, stdout: result.stdout, outputText }))}\n`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runtimeArgs(args) {
  const result = { root: ".", checks: [] };
  for (let index = 0; index < args.length; index += 1) {
    const parsed = parseOption(args[index]);
    if (parsed.name === "--cleanup" && parsed.value === undefined) {
      result.cleanup = true;
      continue;
    }
    if (parsed.name === "--follow" && parsed.value === undefined) {
      result.follow = true;
      continue;
    }
    const value = parsed.value ?? args[index + 1];
    if (parsed.value === undefined) index += 1;
    if (value === undefined) throw new Error(`option value is required: ${parsed.name}`);
    if (parsed.name === "--root") result.root = value;
    else if (parsed.name === "--repo") result.repo = value;
    else if (parsed.name === "--base") result.baseSha = value;
    else if (parsed.name === "--run") result.runId = value;
    else if (parsed.name === "--task") result.taskId = value;
    else if (parsed.name === "--packet") result.packetPath = value;
    else if (parsed.name === "--report") result.reportPath = value;
    else if (parsed.name === "--profile") result.profile = value;
    else if (parsed.name === "--worktree") result.worktreeId = value;
    else if (parsed.name === "--cleanup") result.cleanup = true;
    else if (parsed.name === "--candidate") result.candidateId = value;
    else if (parsed.name === "--target") result.target = value;
    else if (parsed.name === "--item") result.itemId = value;
    else if (parsed.name === "--priority") result.priority = Number(value);
    else if (parsed.name === "--reason") result.reason = value;
    else if (parsed.name === "--check") result.checks.push(value);
    else if (parsed.name === "--now") result.now = value;
    else if (parsed.name === "--iterations") result.iterations = Number(value);
    else if (parsed.name === "--poll-ms") result.pollMs = Number(value);
    else if (parsed.name === "--limit") result.limit = Number(value);
    else if (parsed.name === "--once") result.iterations = 1;
    else throw new Error(`unknown option ${parsed.name}`);
  }
  return result;
}

function runnerArgs(args) {
  const result = { json: false, dryRun: false };
  if (!args[0] || args[0].startsWith("--")) throw new RunnerError("PRD path is required", RUN_EXIT_CODES.INVALID_INPUT);
  result.prdPath = args[0];
  for (let index = 1; index < args.length; index += 1) {
    const parsed = parseOption(args[index]);
    if (parsed.name === "--dry-run") { result.dryRun = true; continue; }
    if (parsed.name === "--json") { result.json = true; continue; }
    const value = parsed.value ?? args[++index];
    if (value === undefined || value.startsWith("--")) throw new RunnerError(`${parsed.name} requires a value`, RUN_EXIT_CODES.INVALID_INPUT);
    if (parsed.name === "--repo") result.repo = value;
    else if (parsed.name === "--target") result.target = value;
    else if (parsed.name === "--config") result.configPath = value;
    else if (parsed.name === "--resume") result.resume = value;
    else if (parsed.name === "--max-workers") result.maxWorkers = Number(value);
    else if (parsed.name === "--now") result.now = value;
    else throw new RunnerError(`unknown run option ${parsed.name}`, RUN_EXIT_CODES.INVALID_INPUT);
  }
  return result;
}

function worktreeCommand(command, args) {
  const options = runtimeArgs(args);
  if (command === "worktree-create") return createWorktree(options);
  if (command === "worktree-warm") return warmWorktree(options);
  if (command === "worktree-allocate") return allocateWorktree(options);
  if (command === "worktree-release") return releaseWorktree(options);
  return listWorktrees(options.repo);
}

function mergeCommand(command, args) {
  const options = runtimeArgs(args);
  if (command === "merge-enqueue") return enqueueCandidate(options);
  if (command === "merge-status") return queueStatus(options.repo, options.target);
  if (command === "merge-process") return processNextMerge({ ...options, integrationChecks: options.checks });
  return abortMerge(options);
}

function continuityCommand(command, args) {
  const options = runtimeArgs(args);
  if (!options.runId) throw new Error("run id is required");
  if (command === "watch") return watchRun(options.root, options.runId, options);
  if (command === "pause") return pauseRun(options.root, options.runId, options);
  if (command === "resume") return resumeRun(options.root, options.runId, options);
  if (command === "replay") return replayRun(options.root, options.runId, options);
  if (command === "render-pr") {
    const state = replayRunState(options.root, options.runId);
    const candidate = Object.values(state.entities.candidate ?? {}).sort((a, b) => String(a.id).localeCompare(String(b.id))).at(-1) ?? {};
    return renderPrPayload({ run_id: options.runId, candidate, requirements: candidate.requirements ?? [], checks: candidate.checks ?? [], evidence: candidate.evidence ?? [], findings: candidate.findings ?? [], target: state.entities.run?.[options.runId]?.target ?? "main" });
  }
  throw new Error(`unknown continuity command: ${command}`);
}

function verifyWritePathsCommand(args) {
  const options = runtimeArgs(args);
  if (!options.packetPath || !options.reportPath) throw new Error("packet and report paths are required");
  const packet = JSON.parse(readFileSync(options.packetPath, "utf8"));
  const report = JSON.parse(readFileSync(options.reportPath, "utf8"));
  const result = validateWritePathCoverage(packet, report);
  console.log(JSON.stringify(result));
  if (!result.valid) process.exit(1);
  return result;
}

const command = process.argv[2] ?? "help";
if (command === "install") {
  try { install(process.argv.slice(3)); }
  catch (error) { console.log(`error: ${error.message}`); process.exit(2); }
}
else if (command === "list-agents") listAgents();
else if (command === "codex-register") {
  try { registerCodexAgents(process.argv.slice(3)); }
  catch (error) { console.log(`error: ${error.message}`); process.exit(2); }
}
else if (command === "run") {
  let options;
  try {
    options = runnerArgs(process.argv.slice(3));
    const result = await runWorkflow(options);
    if (options.json) console.log(JSON.stringify(result));
    else console.log(`run{status,run_id,exit_code}:\n  ${result.status},${result.run_id},${result.exit_code}`);
    process.exit(result.exit_code ?? 0);
  } catch (error) {
    const exitCode = error.exitCode ?? RUN_EXIT_CODES.FAILED;
    const output = error.result?.runner_version
      ? { ...error.result, status: error.result.status ?? (exitCode === RUN_EXIT_CODES.BLOCKED || exitCode === RUN_EXIT_CODES.ENVIRONMENT ? "BLOCKED" : "ERROR"), exit_code: exitCode, error: error.message }
      : { status: error.result?.status ?? (exitCode === RUN_EXIT_CODES.BLOCKED || exitCode === RUN_EXIT_CODES.ENVIRONMENT ? "BLOCKED" : "ERROR"), exit_code: exitCode, error: error.message, result: error.result ?? null };
    console.log(options?.json ? JSON.stringify(output) : `error: ${error.message}`);
    process.exit(output.exit_code);
  }
}
else if (command === "doctor") doctor();
else if (command === "harness-adapter") {
  try { harnessAdapterCommand(process.argv.slice(3)); }
  catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}
else if (command === "validate-packet") validatePacketCommand(process.argv[3], process.argv.slice(4));
else if (command === "hashline-read") hashlineReadCommand(process.argv[3]);
else if (command === "hashline-patch") hashlinePatchCommand(process.argv[3], process.argv[4], process.argv.slice(5));
else if (["run-state", "schedule", "schedule-once", "recover", "recover-interrupted", "observe-capacity"].includes(command)) {
  try { schedulerCommand(command, process.argv[3], process.argv.slice(4)); }
  catch (error) { console.log(JSON.stringify({ status: "READ_ERROR", issue: { rule: error.message } })); process.exit(2); }
}
else if (["watch", "pause", "resume", "replay", "render-pr"].includes(command)) {
  try { console.log(JSON.stringify(await continuityCommand(command, process.argv.slice(3)))); }
  catch (error) { console.log(JSON.stringify({ status: "READ_ERROR", issue: { rule: error.message } })); process.exit(2); }
}
else if (command === "verify-write-paths") {
  try { verifyWritePathsCommand(process.argv.slice(3)); }
  catch (error) { console.log(JSON.stringify({ status: "READ_ERROR", issue: { rule: error.message } })); process.exit(2); }
}
else if (["worktree-create", "worktree-warm", "worktree-allocate", "worktree-release", "worktree-list"].includes(command)) {
  try { console.log(JSON.stringify(worktreeCommand(command, process.argv.slice(3)))); }
  catch (error) { console.log(JSON.stringify({ status: "READ_ERROR", issue: { rule: error.message } })); process.exit(2); }
}
else if (["merge-enqueue", "merge-status", "merge-process", "merge-abort"].includes(command)) {
  try { console.log(JSON.stringify(mergeCommand(command, process.argv.slice(3)))); }
  catch (error) { console.log(JSON.stringify({ status: "READ_ERROR", issue: { rule: error.message } })); process.exit(2); }
}
else if (command === "help" || command === "--help" || command === "-h") usage();
else {
  console.log(`error: unknown command ${command}
  help: valid commands are install, list-agents, codex-register, run, doctor, harness-adapter, validate-packet, hashline-read, hashline-patch, run-state, schedule, schedule-once, recover, recover-interrupted, observe-capacity, watch, pause, resume, replay, verify-write-paths, render-pr, worktree-create, worktree-warm, worktree-allocate, worktree-release, worktree-list, merge-enqueue, merge-status, merge-process, merge-abort, help`);
  process.exit(2);
}
