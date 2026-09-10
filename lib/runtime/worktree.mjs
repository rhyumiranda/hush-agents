import { createHash } from "node:crypto";
import { openSync, closeSync, unlinkSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";

import { validateEnvironment } from "./environment.mjs";
import { validatePacket } from "./packet.mjs";
import { appendStateEvent, replayRunState } from "./state.mjs";

export const WORKTREE_LEASE_MS = 10 * 60 * 1000;
export const WORKTREE_HEARTBEAT_MS = 5 * 60 * 1000;

export function repositoryIdentity(repo) {
  const canonicalRepo = canonicalRepository(repo);
  const commonDir = git(canonicalRepo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim();
  return sha256(realpathSync(commonDir));
}

export function hushWorktreeRoot(repo) {
  const canonicalRepo = canonicalRepository(repo);
  const root = resolve(canonicalRepo, ".hush", "worktrees", repositoryIdentity(canonicalRepo));
  assertInside(root, resolve(canonicalRepo, ".hush", "worktrees"));
  return root;
}

export function profileDigest(repo, profile, packetEnvironment) {
  const profileData = readJson(profile, "setup profile");
  const setupCommands = setupCommandsFrom(profileData);
  const lockfiles = profileData.lockfiles ?? ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
  const lockfileDigests = Object.fromEntries(lockfiles.filter((file) => existsSync(join(repo, file))).sort().map((file) => [file, sha256(readFileSync(join(repo, file)))]));
  return sha256(canonical({
    setup_commands: setupCommands,
    environment_policy_digest: sha256(canonical(packetEnvironment ?? {})),
    lockfile_digests: lockfileDigests,
    tool_versions: profileData.tool_versions ?? profileData.toolVersions ?? {},
  }));
}

export function createWorktree({ repo, baseSha, runId, taskId, worktreeId, sourceHead, timestamp, root = repo }) {
  const canonicalRepo = canonicalRepository(repo);
  const base = requireSha(baseSha, "baseSha");
  const run = safeSegment(runId, "runId");
  const task = safeSegment(taskId, "taskId");
  const id = safeSegment(worktreeId ?? `WT-${run}-${task}`, "worktreeId");
  const worktreeRoot = hushWorktreeRoot(canonicalRepo);
  const path = safeWorktreePath(worktreeRoot, id);
  if (existsSync(path)) throw new Error(`WORKTREE_EXISTS: ${id}`);
  git(canonicalRepo, ["cat-file", "-e", `${base}^{commit}`]);
  mkdirSync(worktreeRoot, { recursive: true });
  const branch = id === `WT-${run}-${task}` ? `hush/${run}/${task}` : `hush/${run}/${task}-retry-${id}`;
  const result = git(canonicalRepo, ["worktree", "add", "-b", branch, path, base]);
  if (result.status !== 0) throw gitError("WORKTREE_CREATE_FAILED", result);
  const record = {
    worktree_id: id,
    absolute_path: path,
    repository: canonicalRepo,
    repository_id: repositoryIdentity(canonicalRepo),
    base_sha: base,
    source_head: sourceHead ?? git(canonicalRepo, ["rev-parse", "HEAD"]).stdout.trim(),
    branch,
    profile_digest: null,
    lease_owner: null,
    lease_id: null,
    lease_expires_at: null,
    state: "CREATED",
    cleanup_status: "PENDING",
    run_id: run,
    task_id: task,
    created_at: timestamp ?? new Date().toISOString(),
    command: result.command,
  };
  recordWorktreeEvent(root, run, id, "created", record, "hush-worktree-create", timestamp);
  appendPoolEvent(canonicalRepo, "created", record, timestamp);
  return record;
}

export function warmWorktree({ repo, baseSha, runId = "WARM", taskId = "BASE", worktreeId, profile, packet, packetPath, timestamp, root = repo }) {
  const canonicalRepo = canonicalRepository(repo);
  const packetData = packet ?? (packetPath ? readJson(packetPath, "packet") : null);
  if (!packetData?.environment) throw new Error("PACKET_ENVIRONMENT_REQUIRED");
  const environment = validateEnvironment(packetData.environment, { checkedAt: timestamp, root, repository: canonicalRepo });
  if (environment.status !== "SAFE") throw new Error(`BLOCKED_ENVIRONMENT: ${JSON.stringify(environment.findings)}`);
  const digest = profileDigest(canonicalRepo, profile, packetData.environment);
  const worktree = createWorktree({ repo: canonicalRepo, baseSha, runId, taskId, worktreeId, timestamp, root });
  const commands = setupCommandsFrom(readJson(profile, "setup profile"));
  const commandRecords = [];
  const safeEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HUSH_NETWORK_POLICY: String(packetData.environment.network),
    HUSH_DATABASE_POLICY: String(packetData.environment.database),
    HUSH_CREDENTIAL_POLICY: String(packetData.environment.credentials),
    HUSH_EMAIL_POLICY: String(packetData.environment.email),
    HUSH_WEBHOOK_POLICY: String(packetData.environment.webhooks),
    HUSH_UPLOAD_POLICY: String(packetData.environment.uploads),
  };
  for (const command of commands) {
    const result = spawnSync("/bin/sh", ["-c", command], { cwd: worktree.absolute_path, env: safeEnv, encoding: "utf8" });
    const commandRecord = { command, cwd: worktree.absolute_path, exit_status: result.status ?? 1, stdout_digest: sha256(result.stdout ?? ""), stderr_digest: sha256(result.stderr ?? "") };
    commandRecords.push(commandRecord);
    if (result.status !== 0) {
      const failed = { ...worktree, profile_digest: digest, state: "BLOCKED", cleanup_status: "PENDING", setup_commands: commandRecords, block_reason: "WARM_SETUP_FAILED" };
      recordWorktreeEvent(root, worktree.run_id, worktree.worktree_id, "warm-failed", failed, "setup-command-failed", timestamp);
      appendPoolEvent(canonicalRepo, "warm-failed", failed, timestamp);
      return { status: "BLOCKED", worktree: failed, commands: commandRecords };
    }
  }
  const validation = validateWorktree({ ...worktree, profile_digest: digest }, packetData);
  if (validation.status !== "VALID") {
    const failed = { ...worktree, profile_digest: digest, state: "BLOCKED", cleanup_status: "PENDING", setup_commands: commandRecords, block_reason: validation.code };
    recordWorktreeEvent(root, worktree.run_id, worktree.worktree_id, "warm-failed", failed, validation.code, timestamp);
    appendPoolEvent(canonicalRepo, "warm-failed", failed, timestamp);
    return { status: "BLOCKED", worktree: failed, commands: commandRecords };
  }
  const warmed = { ...worktree, profile_digest: digest, state: "WARM", cleanup_status: "PENDING", setup_commands: commandRecords, warmed_at: timestamp ?? new Date().toISOString() };
  recordWorktreeEvent(root, worktree.run_id, worktree.worktree_id, "warmed", warmed, "setup-complete", timestamp);
  appendPoolEvent(canonicalRepo, "warmed", warmed, timestamp);
  return { status: "WARM", worktree: warmed, commands: commandRecords };
}

export function allocateWorktree({ root = ".", repo, runId, taskId, packet, packetPath, profileDigest: expectedProfileDigest, leaseMs = WORKTREE_LEASE_MS, now, worktreeId }) {
  const canonicalRepo = canonicalRepository(repo);
  const packetData = packet ?? (packetPath ? readJson(packetPath, "packet") : null);
  if (!packetData) throw new Error("PACKET_REQUIRED");
  const packetResult = validatePacket(packetData);
  if (packetResult.status !== "VALID") throw new Error(`PACKET_INVALID: ${packetResult.status}`);
  const candidates = listWorktrees(canonicalRepo).filter((item) => item.state === "WARM" && (!worktreeId || item.worktree_id === worktreeId) && item.base_sha === packetData.base_sha && (!expectedProfileDigest || item.profile_digest === expectedProfileDigest));
  const candidate = candidates.sort((left, right) => left.worktree_id.localeCompare(right.worktree_id))[0];
  if (!candidate) throw new Error("WORKTREE_UNAVAILABLE");
  const timestamp = now ?? new Date().toISOString();
  const leaseId = `LEASE-${runId}-${taskId}-${candidate.worktree_id}-R${Date.parse(timestamp)}`;
  const allocated = { ...candidate, state: "ALLOCATED", lease_owner: `${runId}/${taskId}/${packetData.packet_id}`, lease_id: leaseId, lease_expires_at: new Date(Date.parse(timestamp) + leaseMs).toISOString(), lease_heartbeat_at: timestamp, packet_id: packetData.packet_id, run_id: safeSegment(runId, "runId"), task_id: safeSegment(taskId, "taskId") };
  recordWorktreeEvent(root, runId, candidate.worktree_id, "allocated", allocated, "hush-lease", timestamp);
  appendPoolEvent(canonicalRepo, "allocated", allocated, timestamp);
  const validation = validateWorktree(allocated, packetData);
  if (validation.status !== "VALID") throw new Error(`WORKTREE_INVALID: ${validation.code}`);
  return allocated;
}

export function validateWorktree(record, packet = null, { expectedHead = null } = {}) {
  if (!record?.absolute_path || !record.repository || !record.repository_id) return { status: "INVALID", code: "WORKTREE_INVALID" };
  try {
    const root = hushWorktreeRoot(record.repository);
    assertInside(record.absolute_path, root);
    const actualPath = realpathSync(record.absolute_path);
    assertInside(actualPath, root);
    const actualRepo = git(record.absolute_path, ["rev-parse", "--show-toplevel"]).stdout.trim();
    const actualCommon = realpathSync(git(record.absolute_path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim());
    const head = git(record.absolute_path, ["rev-parse", "HEAD"]).stdout.trim();
    const branch = git(record.absolute_path, ["branch", "--show-current"]).stdout.trim();
    const status = git(record.absolute_path, ["status", "--porcelain"]).stdout.trim();
    if (realpathSync(actualRepo) !== realpathSync(record.absolute_path) || sha256(actualCommon) !== record.repository_id) return { status: "INVALID", code: "WORKTREE_REPOSITORY_MISMATCH" };
    if (branch !== record.branch) return { status: "INVALID", code: "WORKTREE_BRANCH_MISMATCH", actual: branch };
    if (expectedHead ? head !== expectedHead : head !== record.base_sha) return { status: "INVALID", code: "WORKTREE_STALE_BASE", actual: head, expected: expectedHead ?? record.base_sha };
    if (status) return { status: "INVALID", code: "WORKTREE_DIRTY", status };
    if (packet?.base_sha && packet.base_sha !== head) return { status: "INVALID", code: "WORKTREE_PACKET_BASE_MISMATCH" };
    return { status: "VALID", head, branch, repository_id: record.repository_id };
  } catch (error) {
    return { status: "INVALID", code: error.code ?? "WORKTREE_INVALID", message: error.message };
  }
}

export function releaseWorktree({ root = ".", worktreeId, runId, cleanup = false, expectedHead = null, now }) {
  const located = findWorktree(root, worktreeId, runId);
  if (!located) throw new Error("WORKTREE_NOT_FOUND");
  const { record, recordRunId } = located;
  if (record.state !== "ALLOCATED") return { status: "BLOCKED", code: "LEASE_NOT_ACTIVE", worktree: record };
  const validation = validateWorktree(record, null, { expectedHead });
  if (validation.status !== "VALID") {
    const blocked = { ...record, state: "BLOCKED", cleanup_status: "PRESERVED", block_reason: validation.code };
    recordWorktreeEvent(root, recordRunId, worktreeId, "release-blocked", blocked, validation.code, now);
    appendPoolEvent(record.repository, "release-blocked", blocked, now);
    return { status: "BLOCKED", code: validation.code, worktree: blocked };
  }
  const timestamp = now ?? new Date().toISOString();
  const released = { ...record, state: "RELEASED", lease_owner: null, lease_id: null, lease_expires_at: null, released_at: timestamp };
  recordWorktreeEvent(root, recordRunId, worktreeId, "released", released, "hush-release", timestamp);
  let result = { status: "WARM", worktree: { ...released, state: "WARM" } };
  if (cleanup) {
    const removed = git(record.repository, ["worktree", "remove", record.absolute_path]);
    if (removed.status !== 0 || existsSync(record.absolute_path)) {
      const blocked = { ...released, state: "BLOCKED", cleanup_status: "PRESERVED", block_reason: "WORKTREE_CLEANUP_FAILED" };
      recordWorktreeEvent(root, recordRunId, worktreeId, "cleanup-blocked", blocked, "cleanup-failed", timestamp);
      appendPoolEvent(record.repository, "cleanup-blocked", blocked, timestamp);
      return { status: "BLOCKED", code: "WORKTREE_CLEANUP_FAILED", worktree: blocked };
    }
    result = { status: "DESTROYED", worktree: { ...released, state: "DESTROYED", cleanup_status: "REMOVED" } };
    recordWorktreeEvent(root, recordRunId, worktreeId, "cleaned", result.worktree, "hush-cleanup", timestamp);
  } else {
    recordWorktreeEvent(root, recordRunId, worktreeId, "returned", result.worktree, "warm-pool-reuse", timestamp);
  }
  appendPoolEvent(record.repository, cleanup ? "cleaned" : "returned", result.worktree, timestamp);
  return result;
}

export function cleanupWorktree({ root = ".", worktreeId, runId, expectedHead = null, now }) {
  const located = findWorktree(root, worktreeId, runId);
  if (!located) throw new Error("WORKTREE_NOT_FOUND");
  const { record, recordRunId } = located;
  if (!["CREATED", "WARM", "BLOCKED"].includes(record.state)) return { status: "BLOCKED", code: "WORKTREE_NOT_CLEANABLE", worktree: record };
  const validation = validateWorktree(record, null, { expectedHead });
  if (validation.status !== "VALID") {
    const blocked = { ...record, state: "BLOCKED", cleanup_status: "PRESERVED", block_reason: validation.code };
    recordWorktreeEvent(root, recordRunId, worktreeId, "cleanup-blocked", blocked, validation.code, now);
    appendPoolEvent(record.repository, "cleanup-blocked", blocked, now);
    return { status: "BLOCKED", code: validation.code, worktree: blocked };
  }
  const timestamp = now ?? new Date().toISOString();
  const removed = git(record.repository, ["worktree", "remove", record.absolute_path]);
  if (removed.status !== 0 || existsSync(record.absolute_path)) {
    const blocked = { ...record, state: "BLOCKED", cleanup_status: "PRESERVED", block_reason: "WORKTREE_CLEANUP_FAILED" };
    recordWorktreeEvent(root, recordRunId, worktreeId, "cleanup-blocked", blocked, "cleanup-failed", timestamp);
    appendPoolEvent(record.repository, "cleanup-blocked", blocked, timestamp);
    return { status: "BLOCKED", code: "WORKTREE_CLEANUP_FAILED", worktree: blocked };
  }
  const cleaned = { ...record, state: "DESTROYED", cleanup_status: "REMOVED", cleaned_at: timestamp };
  recordWorktreeEvent(root, recordRunId, worktreeId, "cleaned", cleaned, "hush-cleanup", timestamp);
  appendPoolEvent(record.repository, "cleaned", cleaned, timestamp);
  return { status: "DESTROYED", worktree: cleaned };
}

export function invalidateWarmBases(repo, { root = repo, profile, packetEnvironment, now } = {}) {
  const canonicalRepo = canonicalRepository(repo);
  const currentHead = git(canonicalRepo, ["rev-parse", "HEAD"]).stdout.trim();
  const expectedProfile = profile ? profileDigest(canonicalRepo, profile, packetEnvironment) : null;
  const invalidated = [];
  for (const record of listWorktrees(canonicalRepo)) {
    if (record.state !== "WARM") continue;
    const reason = record.source_head !== currentHead ? "SOURCE_HEAD_CHANGED" : expectedProfile && record.profile_digest !== expectedProfile ? "PROFILE_CHANGED" : null;
    if (!reason) continue;
    const next = { ...record, state: "INVALIDATED", invalidation_reason: reason, invalidated_at: now ?? new Date().toISOString() };
    recordWorktreeEvent(root, record.run_id, record.worktree_id, "invalidated", next, reason, now);
    appendPoolEvent(canonicalRepo, "invalidated", next, now);
    invalidated.push(next);
  }
  return invalidated;
}

export function listWorktrees(repo) {
  const events = readPoolEvents(canonicalRepository(repo));
  const latest = new Map();
  for (const event of events) latest.set(event.worktree_id, { ...event.data, pool_revision: event.revision });
  return [...latest.values()].sort((left, right) => left.worktree_id.localeCompare(right.worktree_id));
}

export function recoverExpiredWorktreeLeases(root, runId, { now } = {}) {
  const state = replayRunState(root, runId);
  const time = Date.parse(now ?? new Date().toISOString());
  const recovered = [];
  for (const record of Object.values(state.entities.worktree ?? {})) {
    if (record.state !== "ALLOCATED" || !record.lease_expires_at || Date.parse(record.lease_expires_at) > time) continue;
    const cleanup = releaseWorktree({ root, runId, worktreeId: record.worktree_id, cleanup: true, expectedHead: record.base_sha, now });
    const next = { ...(cleanup.worktree ?? record), previous_lease_id: record.lease_id, recovered_at: now ?? new Date().toISOString(), recovery_reason: "WORKTREE_LEASE_EXPIRED" };
    if (cleanup.status !== "DESTROYED") {
      next.state = "BLOCKED";
      next.block_reason = "WORKTREE_LEASE_EXPIRED";
      next.cleanup_block_reason = cleanup.code ?? null;
    }
    recordWorktreeEvent(root, runId, record.worktree_id, "lease-expired", next, "WORKTREE_LEASE_EXPIRED", now);
    appendPoolEvent(record.repository, "lease-expired", next, now);
    recovered.push(next);
  }
  return recovered;
}

export function recoverInterruptedWorktreeLeases(root, runId, { now, owner = "hush" } = {}) {
  const state = replayRunState(root, runId);
  const recovered = [];
  for (const record of Object.values(state.entities.worktree ?? {})) {
    if (record.state !== "ALLOCATED") continue;
    const cleanup = releaseWorktree({ root, runId, worktreeId: record.worktree_id, cleanup: true, expectedHead: record.base_sha, now });
    const next = { ...(cleanup.worktree ?? record), previous_lease_id: record.lease_id, recovered_at: now ?? new Date().toISOString(), recovery_reason: "WORKER_INTERRUPTED", owner };
    if (cleanup.status !== "DESTROYED") {
      next.block_reason = "WORKER_INTERRUPTED";
      recordWorktreeEvent(root, runId, record.worktree_id, "lease-interrupted", next, "RUNNER_RESUME", now);
      appendPoolEvent(record.repository, "lease-interrupted", next, now);
    }
    recovered.push(next);
  }
  return recovered;
}

function recordWorktreeEvent(root, runId, id, action, data, cause, timestamp) {
  return appendStateEvent(root, runId, { entity_type: "worktree", entity_id: id, action, actor: "hush", cause, timestamp, data });
}

function appendPoolEvent(repo, action, data, timestamp) {
  const path = join(hushWorktreeRoot(repo), "pool-events.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  let fd;
  try {
    fd = openSync(lock, "wx");
    const events = readPoolEvents(repo);
    const prior = events.filter((event) => event.worktree_id === data.worktree_id).at(-1)?.revision ?? 0;
    const event = { event_id: `POOL-${String(events.length + 1).padStart(6, "0")}`, worktree_id: data.worktree_id, revision: prior + 1, prior_revision: prior || null, action, actor: "hush", cause: action, timestamp: timestamp ?? new Date().toISOString(), data };
    writeFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
    return event;
  } finally {
    if (fd !== undefined) { closeSync(fd); try { unlinkSync(lock); } catch {} }
  }
}

function readPoolEvents(repo) {
  const path = join(hushWorktreeRoot(repo), "pool-events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function findWorktree(root, worktreeId, runId) {
  if (runId) {
    const state = replayRunState(root, runId);
    const record = state.entities.worktree?.[worktreeId];
    return record ? { record, recordRunId: runId } : null;
  }
  const runsRoot = join(root, ".hush", "runs");
  if (!existsSync(runsRoot)) return null;
  for (const candidateRun of readdirSync(runsRoot)) {
    const state = replayRunState(root, candidateRun);
    const record = state.entities.worktree?.[worktreeId];
    if (record) return { record, recordRunId: candidateRun };
  }
  return null;
}

function setupCommandsFrom(profile) {
  const commands = profile?.setup_commands ?? profile?.setupCommands ?? [];
  if (!Array.isArray(commands) || commands.some((command) => typeof command !== "string" || command.length === 0)) throw new Error("SETUP_PROFILE_INVALID");
  return commands;
}

function canonicalRepository(repo) {
  const candidate = realpathSync(resolve(repo));
  const result = git(candidate, ["rev-parse", "--show-toplevel"]);
  if (result.status !== 0) throw gitError("REPOSITORY_REQUIRED", result);
  return realpathSync(result.stdout.trim());
}

function safeWorktreePath(root, id) {
  const path = resolve(root, id);
  assertInside(path, root);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("WORKTREE_SYMLINK_ESCAPE");
  return path;
}

function assertInside(path, root) {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || resolve(path) === resolve(root)) throw new Error("PATH_OUTSIDE_HUSH_ROOT");
  return true;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ...result, command: ["git", ...args].join(" "), stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

function gitError(code, result) { return new Error(`${code}: ${result.stderr.trim() || result.stdout.trim() || result.command}`); }
function requireSha(value, name) { if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/.test(value)) throw new Error(`${name} must be a git SHA`); return value; }
function safeSegment(value, name) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") throw new Error(`${name} must be a safe path segment`); return value; }
function readJson(path, name) { try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`${name} unreadable: ${error.message}`); } }
function sha256(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function canonical(value) { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; }
