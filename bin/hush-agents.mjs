#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PACKET_STATUS, validatePacket } from "../lib/runtime/packet.mjs";
import { applyHashline, readHashline } from "../lib/runtime/hashline.mjs";
import { dispatchOne, dispatchReadyTasks, recoverExpiredLeases, recordCapacityObservation, writeRunSummary } from "../lib/runtime/scheduler.mjs";
import { allocateWorktree, createWorktree, listWorktrees, releaseWorktree, warmWorktree } from "../lib/runtime/worktree.mjs";
import { abortMerge, enqueueCandidate, processNextMerge, queueStatus } from "../lib/runtime/merge-queue.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.HOME;
const skillNames = ["hush-agents", "readme-craft"];

function usage() {
  console.log(`hush-agents[3]{command,what,next}:
  install,"copy Codex, Claude Code, Gemini CLI, and OpenCode agents","hush-agents doctor"
  doctor,"check package files + installed files","hush-agents install"
  validate-packet <packet.json> [context options],"validate packet shape, digest, and status","hush-agents validate-packet packet.json"
  hashline-read <file>,"read a file with content-hashed line anchors","hush-agents hashline-read src/file.js"
  hashline-patch <file> <patch.json> [--dry-run],"apply hash-anchored edits and reject stale reads","hush-agents hashline-patch src/file.js patch.json"
  run-state <run-id> --root <repo>,"print durable scheduler state summary","hush-agents run-state RUN-1 --root ."
  schedule <run-id> --root <repo> --max-workers 8,"admit all safe ready tasks","hush-agents schedule RUN-1 --root . --max-workers 8"
  schedule-once <run-id> --root <repo>,"admit one safe ready task","hush-agents schedule-once RUN-1 --root ."
  recover <run-id> --root <repo>,"block expired worker leases","hush-agents recover RUN-1 --root ."
  observe-capacity <run-id> --root <repo> --available-workers <n> --confidence HIGH,"record measured host capacity","hush-agents observe-capacity RUN-1 --root . --available-workers 6 --confidence HIGH"
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

function copyDirFiles(src, dest, extension) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const source = join(src, name);
    if (!statSync(source).isFile()) continue;
    if (extension && !name.endsWith(extension)) continue;
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

function install() {
  if (!home) {
    console.log("error: HOME is not set");
    process.exit(1);
  }
  copyDirFiles(join(root, "agents"), join(home, ".codex", "agents"), ".toml");
  copyDirFiles(join(root, "agents", "claude"), join(home, ".claude", "agents"), ".md");
  copyDirFiles(join(root, "agents", "gemini"), join(home, ".gemini", "agents"), ".md");
  copyDirFiles(join(root, "agents", "opencode"), join(home, ".config", "opencode", "agents"), ".md");
  copySkills(join(home, ".codex"));
  copySkills(join(home, ".claude"));
  copySkills(join(home, ".gemini"));
  copySkills(join(home, ".config", "opencode"));
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
  const bundledSkills = skillNames.filter((name) => existsSync(join(root, "skills", name, "SKILL.md")));
  const installedSkills = (destRoot) =>
    home ? skillNames.filter((name) => existsSync(join(destRoot, "skills", name, "SKILL.md"))) : [];
  const installedCodexSkills = installedSkills(join(home, ".codex"));
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
    else if (parsed.name === "--available-workers") result.capacityObservation = { ...(result.capacityObservation ?? {}), available_workers: Number(value) };
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
  else console.log(JSON.stringify(recoverExpiredLeases(options.root, runId, options)));
}

function runtimeArgs(args) {
  const result = { root: ".", checks: [] };
  for (let index = 0; index < args.length; index += 1) {
    const parsed = parseOption(args[index]);
    if (parsed.name === "--cleanup" && parsed.value === undefined) {
      result.cleanup = true;
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
    else throw new Error(`unknown option ${parsed.name}`);
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

const command = process.argv[2] ?? "help";
if (command === "install") install();
else if (command === "doctor") doctor();
else if (command === "validate-packet") validatePacketCommand(process.argv[3], process.argv.slice(4));
else if (command === "hashline-read") hashlineReadCommand(process.argv[3]);
else if (command === "hashline-patch") hashlinePatchCommand(process.argv[3], process.argv[4], process.argv.slice(5));
else if (["run-state", "schedule", "schedule-once", "recover", "observe-capacity"].includes(command)) {
  try { schedulerCommand(command, process.argv[3], process.argv.slice(4)); }
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
 help: valid commands are install, doctor, validate-packet, hashline-read, hashline-patch, run-state, schedule, schedule-once, recover, observe-capacity, worktree-create, worktree-warm, worktree-allocate, worktree-release, worktree-list, merge-enqueue, merge-status, merge-process, merge-abort, help`);
  process.exit(2);
}
