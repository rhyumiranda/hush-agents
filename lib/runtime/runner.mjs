import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";

import { preflightEnvironment, persistHazardInventory, validateEnvironment } from "./environment.mjs";
import { validateAcceptance, validateCheckCoverage, validateGateReport } from "./evidence.mjs";
import { enqueueCandidate, processNextMerge } from "./merge-queue.mjs";
import { validatePacket } from "./packet.mjs";
import { hasBlockingUnknowns, validateRequirementRecord } from "./requirements.mjs";
import { dispatchReadyTasks, recoverInterruptedLeases, recordCapacityObservation, routeFailure } from "./scheduler.mjs";
import { appendStateEvent, replayRunState } from "./state.mjs";
import { mutationPolicyForRequirements, runStrykerPolicy, validateMutationPolicy, validateMutationReport } from "./verification.mjs";
import { allocateWorktree, recoverInterruptedWorktreeLeases, warmWorktree } from "./worktree.mjs";
import { renderPrPayload } from "./delivery.mjs";

export const RUN_EXIT_CODES = Object.freeze({ SUCCESS: 0, INVALID_INPUT: 2, BLOCKED: 3, ENVIRONMENT: 4, FAILED: 5 });
export const RUNNER_VERSION = "runner.v1";
const REQUIRED_ADAPTERS = Object.freeze(["fable", "rook", "flint", "puck", "vera"]);
const TERMINAL_STATUSES = new Set(["ACCEPTED", "BLOCKED", "HUMAN_DECISION", "FAILED"]);

export class RunnerError extends Error {
  constructor(message, exitCode = RUN_EXIT_CODES.FAILED, result = {}) {
    super(message);
    this.name = "RunnerError";
    this.exitCode = exitCode;
    this.result = result;
  }
}

export async function runWorkflow(options) {
  let context;
  try {
    return await runWorkflowInternal(options, (value) => { context = value; });
  } catch (error) {
    if (context) {
      const status = error.exitCode === RUN_EXIT_CODES.BLOCKED || error.exitCode === RUN_EXIT_CODES.ENVIRONMENT ? "BLOCKED" : "FAILED";
      try {
        appendRunStatus(context, status, "runner-error", { error: error.message, result: error.result ?? null });
        const summary = finalize(context, replayRunState(context.repository, context.runId), error.exitCode ?? RUN_EXIT_CODES.FAILED, status, error.result ?? [error.message]);
        error.result = { ...summary, ...(error.result ?? {}), run_id: context.runId, summary_path: summary.summary_path, status };
      } catch (persistenceError) {
        error.result = { ...(error.result ?? {}), run_id: context.runId, persistence_error: persistenceError.message };
      }
    }
    throw error;
  }
}

async function runWorkflowInternal(options, captureContext) {
  const input = validateRunnerInput(options);
  const config = loadRunnerConfig(input.configPath);
  const repository = realpathSync(input.repository);
  const prdPath = realpathSync(input.prdPath);
  const baseSha = gitOutput(repository, ["rev-parse", "HEAD"]);
  const prdBytes = readFileSync(prdPath);
  const prdDigest = sha256(prdBytes);
  const runId = input.resume ?? config.run_id ?? createRunId(prdDigest);
  const source = sourceManifest(repository, prdPath, prdDigest);

  if (input.dryRun) {
    const environment = validateConfiguredEnvironment(config.environment, repository, undefined, input.now);
    return runnerResult({ run_id: runId, status: environment.status === "SAFE" ? "DRY_RUN_READY" : "BLOCKED", exit_code: environment.status === "SAFE" ? 0 : RUN_EXIT_CODES.ENVIRONMENT, prd_digest: prdDigest, base_sha: baseSha, source, blockers: environment.findings });
  }

  const existing = replayRunState(repository, runId);
  if (existing.events.length > 0 && !input.resume) throw new RunnerError(`run already exists: ${runId}; use --resume ${runId}`, RUN_EXIT_CODES.INVALID_INPUT);
  if (input.resume && existing.events.length === 0) throw new RunnerError(`run does not exist: ${runId}`, RUN_EXIT_CODES.INVALID_INPUT);

  const context = { ...input, ...config, max_workers: input.maxWorkers ?? config.max_workers, repository, prdPath, prdDigest, prdText: prdBytes.toString("utf8"), baseSha, source, runId, environmentDigest: sha256(JSON.stringify(config.environment)), now: input.now ?? new Date().toISOString() };
  captureContext(context);
  if (!input.resume) initializeRun(context);
  assertResumeBinding(context);

  if (input.resume) {
    recoverInterruptedLeases(repository, runId, { now: context.now });
    recoverInterruptedWorktreeLeases(repository, runId, { now: context.now });
  }

  let state = replayRunState(repository, runId);
  const currentStatus = state.entities.run?.[runId]?.status;
  if (TERMINAL_STATUSES.has(currentStatus) && !["FAILED", "ACCEPTED"].includes(currentStatus)) return finalize(context, state, RUN_EXIT_CODES.BLOCKED, currentStatus);

  const environment = ensureEnvironment(context, state);
  if (environment.status !== "SAFE") return finishBlocked(context, RUN_EXIT_CODES.ENVIRONMENT, "ENVIRONMENT_BLOCKED", environment.findings);

  state = replayRunState(repository, runId);
  validateStoredRequirements(context, state);
  if (state.entities.run?.[runId]?.status === "ACCEPTED") return finalize(context, state, 0, "ACCEPTED");
  const requirements = state.entities.requirement && Object.keys(state.entities.requirement).length
    ? Object.values(state.entities.requirement).map(stripStateMetadata)
    : await runFable(context);
  if (requirements.some(hasBlockingUnknowns)) return finishBlocked(context, RUN_EXIT_CODES.BLOCKED, "BLOCKING_UNKNOWN", requirements.filter(hasBlockingUnknowns).map((item) => item.requirement_id));

  state = replayRunState(repository, runId);
  const tasks = Object.keys(state.entities.task ?? {}).length
    ? Object.values(state.entities.task).map(stripStateMetadata)
    : await runRook(context, requirements);
  if (!tasks.length) throw new RunnerError("Rook returned no tasks", RUN_EXIT_CODES.BLOCKED);

  state = replayRunState(repository, runId);
  if (!state.entities.capacity_observation || Object.keys(state.entities.capacity_observation).length === 0) {
    if (context.capacity) recordCapacityObservation(repository, runId, { ...context.capacity, observed_at: context.now }, { now: context.now });
  }
  appendRunStatus(context, "RUNNING", "runner-dispatch");
  await processTasks(context);

  state = replayRunState(repository, runId);
  const taskStates = Object.values(state.entities.task ?? {});
  const blockedTask = taskStates.find((task) => ["BLOCKED", "FAILED", "HUMAN_DECISION"].includes(task.status));
  if (blockedTask) return finishBlocked(context, blockedTask.status === "FAILED" ? RUN_EXIT_CODES.FAILED : RUN_EXIT_CODES.BLOCKED, blockedTask.status, { task_id: blockedTask.id, reason: blockedTask.block_reason ?? blockedTask.primary_cause ?? null });
  if (taskStates.some((task) => !["ACCEPTED", "ALIGNED"].includes(task.status))) return finishBlocked(context, RUN_EXIT_CODES.BLOCKED, "TASKS_INCOMPLETE", taskStates.map((task) => ({ task_id: task.id, status: task.status })));

  const acceptedCandidates = Object.values(state.entities.candidate ?? {})
    .filter((candidate) => candidate.status === "ACCEPTED")
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  if (!acceptedCandidates.length) return finishBlocked(context, RUN_EXIT_CODES.BLOCKED, "CANDIDATE_MISSING", null);

  const deliveries = [];
  for (const candidate of acceptedCandidates) {
    const queue = enqueueCandidate({ root: repository, repo: repository, runId, candidateId: candidate.id, target: context.target, now: context.now });
    const integration = processNextMerge({ root: repository, repo: repository, target: context.target, itemId: queue.item.item_id, now: context.now, integrationChecks: context.integration_checks });
    if (integration.status !== "READY_FOR_PR") return finishBlocked(context, RUN_EXIT_CODES.FAILED, integration.status, { item_id: queue.item.item_id, reason: integration.reason ?? null });

    const accepted = replayRunState(repository, runId);
    const acceptedCandidate = accepted.entities.candidate?.[candidate.id] ?? candidate;
    const payload = renderPrPayload({ run_id: runId, candidate: acceptedCandidate, requirements: requirements.map((item) => item.requirement_id), checks: integration.integration_record?.checks ?? [], evidence: evidenceIds(accepted, acceptedCandidate), target: context.target });
    const delivery = { candidate_id: candidate.id, queue_item_id: queue.item.item_id, integration_id: integration.integration_record?.integration_id ?? null, payload, payload_digest: payload.payload_digest };
    appendStateEvent(repository, runId, { entity_type: "delivery", entity_id: `PR-${runId}-${candidate.id}`, action: "pr-payload-rendered", actor: "hush", cause: "runner-local-integration", timestamp: context.now, data: { status: "READY_FOR_PR", ...delivery } });
    deliveries.push(delivery);
  }
  appendRunStatus(context, "ACCEPTED", "runner-acceptance", { acceptance_record_ids: deliveries.map((item) => `ACC-${item.queue_item_id}`), candidate_ids: deliveries.map((item) => item.candidate_id), integration_ids: deliveries.map((item) => item.integration_id), pr_payload_digests: deliveries.map((item) => item.payload_digest) });
  return finalize(context, replayRunState(repository, runId), RUN_EXIT_CODES.SUCCESS, "ACCEPTED");
}

function validateRunnerInput(options = {}) {
  const repository = options.repo ?? options.repository;
  if (!repository || !existsSync(repository)) throw new RunnerError("--repo must point to an existing repository", RUN_EXIT_CODES.INVALID_INPUT);
  if (!options.prdPath || !existsSync(options.prdPath)) throw new RunnerError("PRD path is required and must be readable", RUN_EXIT_CODES.INVALID_INPUT);
  if (!options.configPath || !existsSync(options.configPath)) throw new RunnerError("--config is required and must be readable", RUN_EXIT_CODES.INVALID_INPUT);
  if (!options.target || options.target.startsWith("-") || options.target.includes("..") || options.target.includes("~") || options.target.includes("^") || options.target.includes(":") || /\s/.test(options.target)) throw new RunnerError("--target must be a valid branch name", RUN_EXIT_CODES.INVALID_INPUT);
  if (options.maxWorkers !== undefined && (!Number.isInteger(options.maxWorkers) || options.maxWorkers < 1)) throw new RunnerError("--max-workers must be a positive integer", RUN_EXIT_CODES.INVALID_INPUT);
  const resolvedRepository = realpathSync(repository);
  const resolvedPrd = realpathSync(options.prdPath);
  const prdRelative = relative(resolvedRepository, resolvedPrd);
  if (!prdRelative || prdRelative.startsWith("..") || resolve(resolvedRepository, prdRelative) !== resolvedPrd) throw new RunnerError("PRD must be inside --repo", RUN_EXIT_CODES.INVALID_INPUT);
  return { ...options, repository: resolvedRepository, prdPath: resolvedPrd, configPath: resolve(options.configPath), target: options.target, maxWorkers: options.maxWorkers };
}

function loadRunnerConfig(path) {
  let config;
  try { config = JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new RunnerError(`invalid runner config: ${error.message}`, RUN_EXIT_CODES.INVALID_INPUT); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new RunnerError("runner config must be an object", RUN_EXIT_CODES.INVALID_INPUT);
  if (!config.environment || !Array.isArray(config.environment.hazards)) throw new RunnerError("config.environment with a complete hazard inventory is required", RUN_EXIT_CODES.INVALID_INPUT);
  const configDirectory = dirname(path);
  const setupProfile = config.setup_profile ? resolve(configDirectory, config.setup_profile) : null;
  if (!setupProfile || !existsSync(setupProfile)) throw new RunnerError("config.setup_profile must point to a readable setup profile", RUN_EXIT_CODES.INVALID_INPUT);
  if (!Array.isArray(config.integration_checks)) throw new RunnerError("config.integration_checks must be an array", RUN_EXIT_CODES.INVALID_INPUT);
  if (!config.adapters || typeof config.adapters !== "object") throw new RunnerError("config.adapters is required", RUN_EXIT_CODES.INVALID_INPUT);
  for (const role of REQUIRED_ADAPTERS) {
    const command = Array.isArray(config.adapters[role]) ? config.adapters[role] : config.adapters[role]?.command;
    if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0)) throw new RunnerError(`config.adapters.${role}.command must be a non-empty argv array`, RUN_EXIT_CODES.INVALID_INPUT);
    const passEnv = Array.isArray(config.adapters[role]) ? [] : config.adapters[role]?.pass_env ?? [];
    if (!Array.isArray(passEnv) || passEnv.some((name) => typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(name))) throw new RunnerError(`config.adapters.${role}.pass_env must contain valid environment variable names`, RUN_EXIT_CODES.INVALID_INPUT);
  }
  return { ...config, setup_profile: setupProfile, max_workers: config.max_workers ?? 3 };
}

function initializeRun(context) {
  appendStateEvent(context.repository, context.runId, { entity_type: "run", entity_id: context.runId, action: "created", actor: "hush", cause: "runner-initialize", timestamp: context.now, data: { runner_version: RUNNER_VERSION, status: "INITIALIZED", repository: context.repository, target: context.target, prd_path: relative(context.repository, context.prdPath), prd_digest: context.prdDigest, source_manifest: context.source, base_sha: context.baseSha, config_path: context.configPath, max_workers: context.max_workers, integration_checks: context.integration_checks } });
  appendStateEvent(context.repository, context.runId, { entity_type: "run", entity_id: context.runId, action: "source-manifest-recorded", actor: "hush", cause: "runner-initialize", timestamp: context.now, data: { source_manifest: context.source, prd_digest: context.prdDigest } });
}

function assertResumeBinding(context) {
  const state = replayRunState(context.repository, context.runId);
  const run = state.entities.run?.[context.runId];
  if (!run) throw new RunnerError(`run does not exist: ${context.runId}`, RUN_EXIT_CODES.INVALID_INPUT);
  if (run.prd_digest && run.prd_digest !== context.prdDigest) throw new RunnerError("resume PRD digest does not match the original run", RUN_EXIT_CODES.INVALID_INPUT);
  if (run.repository && realpathSync(run.repository) !== context.repository) throw new RunnerError("resume repository does not match the original run", RUN_EXIT_CODES.INVALID_INPUT);
  if (run.target && run.target !== context.target) throw new RunnerError("resume target does not match the original run", RUN_EXIT_CODES.INVALID_INPUT);
  if (run.base_sha && run.base_sha !== context.baseSha) throw new RunnerError("resume base SHA does not match the original run", RUN_EXIT_CODES.INVALID_INPUT);
}

function validateStoredRequirements(context, state) {
  for (const requirement of Object.values(state.entities.requirement ?? {})) {
    const record = { ...requirement };
    for (const key of ["id", "type", "updated_at", "last_event_id"]) delete record[key];
    const issue = validateRequirementRecord(record, { root: context.repository });
    if (issue) throw new RunnerError(`stored requirement ${requirement.id} is stale: ${issue.field} ${issue.rule}`, RUN_EXIT_CODES.BLOCKED, { requirement_id: requirement.id, issue });
  }
}

function ensureEnvironment(context, state) {
  const run = state.entities.run?.[context.runId] ?? {};
  const current = run.environment_status;
  if (current === "SAFE" && run.environment_digest && run.environment_digest !== context.environmentDigest) return { status: "BLOCKED", findings: [{ type: "environment-config-changed", detail: "run environment differs from the recorded safe environment", severity: "HARD_BLOCK" }] };
  let environment;
  try {
    const staticCheck = validateEnvironment(context.environment, { repository: context.repository });
    if (staticCheck.status !== "SAFE") return finishEnvironment(context, staticCheck);
    if (!run.environment_status) persistHazardInventory(context.repository, context.repository, context.environment.hazards, { timestamp: context.now });
    environment = preflightEnvironment(context.environment, { root: context.repository, repository: context.repository, requireFreshInventory: true, checkedAt: context.now, now: context.now });
  } catch (error) {
    environment = { status: "BLOCKED", findings: [{ type: "environment-preflight-error", detail: error.message, severity: "HARD_BLOCK" }] };
  }
  if (environment.status === "SAFE") appendEnvironmentSafe(context, state);
  else finishEnvironment(context, environment);
  return environment;
}

function appendEnvironmentSafe(context, state) {
  appendStateEvent(context.repository, context.runId, { entity_type: "run", entity_id: context.runId, action: "environment-preflight", actor: "hush", cause: "environment-preflight", timestamp: context.now, data: { status: state.entities.run?.[context.runId]?.status ?? "INITIALIZED", environment_status: "SAFE", environment_digest: context.environmentDigest, hazard_inventory_digest: context.environment.hazard_inventory_digest ?? null } });
}

function validateConfiguredEnvironment(environment, repository, root, now) {
  const staticCheck = validateEnvironment(environment, { repository });
  if (staticCheck.status !== "SAFE") return staticCheck;
  return preflightEnvironment(environment, { root, repository, requireFreshInventory: false, checkedAt: now, now });
}

function finishEnvironment(context, result) {
  appendRunStatus(context, "BLOCKED", "environment-preflight", { environment_status: "BLOCKED", blockers: result.findings });
  appendStateEvent(context.repository, context.runId, { entity_type: "finding", entity_id: `ENV-${context.runId}`, action: "environment-blocked", actor: "hush", cause: "ENVIRONMENT_HAZARD", timestamp: context.now, data: { blocking: true, findings: result.findings } });
  return result;
}

async function runFable(context) {
  const result = await runAdapter(context, "fable", null, { prd_path: relative(context.repository, context.prdPath), prd_digest: context.prdDigest, prd_text: context.prdText, source_manifest: context.source });
  if (!Array.isArray(result.requirements) || result.requirements.length === 0) throw new RunnerError("Fable returned no requirements", RUN_EXIT_CODES.BLOCKED);
  for (const requirement of result.requirements) {
    const issue = validateRequirementRecord(requirement, { root: context.repository });
    if (issue) throw new RunnerError(`Fable requirement ${requirement.requirement_id ?? "unknown"} is invalid: ${issue.field} ${issue.rule}`, RUN_EXIT_CODES.BLOCKED);
    appendStateEvent(context.repository, context.runId, { entity_type: "requirement", entity_id: requirement.requirement_id, action: "approved", actor: "fable", cause: "runner-fable", timestamp: context.now, data: requirement });
  }
  appendRunStatus(context, "FABLE_COMPLETE", "fable-complete", { requirement_ids: result.requirements.map((item) => item.requirement_id).sort() });
  return result.requirements;
}

async function runRook(context, requirements) {
  const result = await runAdapter(context, "rook", null, { requirements, requirement_ids: requirements.map((item) => item.requirement_id), base_sha: context.baseSha, target: context.target, environment: context.environment });
  if (!Array.isArray(result.tasks) || result.tasks.length === 0) throw new RunnerError("Rook returned no tasks", RUN_EXIT_CODES.BLOCKED);
  const requirementIds = new Set(requirements.map((item) => item.requirement_id));
  const covered = new Set();
  const packets = [];
  for (const task of result.tasks) {
    if (!task.task_id || !Array.isArray(task.requirements) || !task.packet) throw new RunnerError("Rook task must include task_id, requirements, and packet", RUN_EXIT_CODES.BLOCKED);
    for (const requirementId of task.requirements) {
      if (!requirementIds.has(requirementId)) throw new RunnerError(`Rook references unknown requirement: ${requirementId}`, RUN_EXIT_CODES.BLOCKED);
      const requirement = requirements.find((item) => item.requirement_id === requirementId);
      if (!task.packet.source_refs.some((source) => source.manifest_digest === requirement.source.digest && source.location === requirement.source.location)) throw new RunnerError(`Rook packet ${task.packet.packet_id ?? task.task_id} is not bound to requirement source ${requirementId}`, RUN_EXIT_CODES.BLOCKED);
      covered.add(requirementId);
    }
    const packet = task.packet;
    const packetResult = validatePacket(packet, { root: context.repository, repository: context.repository, currentBaseSha: context.baseSha, now: context.now, environment: context.environment });
    if (packetResult.status !== "VALID" || packet.run_id !== context.runId || packet.task_id !== task.task_id) throw new RunnerError(`Rook packet ${packet.packet_id ?? "unknown"} is invalid: ${packetResult.status}`, RUN_EXIT_CODES.BLOCKED, packetResult);
    const taskRequirements = task.requirements.map((id) => requirements.find((item) => item.requirement_id === id));
    const mutationPolicy = validateMutationPolicy(packet.mutation_policy, { requirements: taskRequirements, packet });
    if (!mutationPolicy.valid) throw new RunnerError(`Rook packet ${packet.packet_id} has invalid mutation policy: ${mutationPolicy.errors.join("; ")}`, RUN_EXIT_CODES.BLOCKED, mutationPolicy);
    appendStateEvent(context.repository, context.runId, { entity_type: "packet", entity_id: packet.packet_id, action: "sealed", actor: "rook", cause: "runner-rook", timestamp: context.now, data: packet });
    appendStateEvent(context.repository, context.runId, { entity_type: "task", entity_id: task.task_id, action: "planned", actor: "rook", cause: "runner-rook", timestamp: context.now, data: { ...task, id: undefined, status: "READY", packet_id: packet.packet_id } });
    packets.push(packet);
  }
  for (const requirementId of requirementIds) if (!covered.has(requirementId)) throw new RunnerError(`Rook omitted requirement coverage: ${requirementId}`, RUN_EXIT_CODES.BLOCKED);
  appendRunStatus(context, "ROOK_COMPLETE", "rook-complete", { plan_id: result.plan_id ?? `PLAN-${context.runId}`, task_ids: result.tasks.map((item) => item.task_id).sort(), packet_ids: packets.map((item) => item.packet_id).sort() });
  return result.tasks;
}

async function processTasks(context) {
  const maxLoops = 1000;
  for (let loop = 0; loop < maxLoops; loop += 1) {
    const state = replayRunState(context.repository, context.runId);
    const complete = Object.values(state.entities.task ?? {}).every((task) => ["ACCEPTED", "ALIGNED"].includes(task.status));
    if (complete) return;
    const dispatch = dispatchReadyTasks(context.repository, context.runId, { root: context.repository, repository: context.repository, maxWorkers: context.max_workers, now: context.now, environment: context.environment });
    if (dispatch.dispatched.length === 0) {
      const blockers = dispatch.blocked ?? [];
      if (blockers.length) throw new RunnerError("scheduler could not admit the remaining tasks", RUN_EXIT_CODES.BLOCKED, blockers);
      throw new RunnerError("scheduler made no progress", RUN_EXIT_CODES.FAILED);
    }
    const results = await Promise.allSettled(dispatch.dispatched.map((admission) => processTask(context, admission.task_id)));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  throw new RunnerError("runner exceeded its task progress limit", RUN_EXIT_CODES.FAILED);
}

async function processTask(context, taskId) {
  const state = replayRunState(context.repository, context.runId);
  const task = state.entities.task?.[taskId];
  const packet = state.entities.packet?.[task?.packet_id];
  if (!task || !packet) throw new RunnerError(`task packet missing: ${taskId}`, RUN_EXIT_CODES.FAILED);
  const retryWorktreeId = Number(task.attempt ?? 1) > 1 ? `WT-${context.runId}-${taskId}-A${task.attempt}` : undefined;
  const warm = warmWorktree({ repo: context.repository, baseSha: packet.base_sha, runId: context.runId, taskId, worktreeId: retryWorktreeId, profile: context.setup_profile, packet: stripStateMetadata(packet), root: context.repository, timestamp: context.now });
  if (warm.status !== "WARM") throw new RunnerError(`worktree setup blocked: ${warm.worktree?.block_reason ?? warm.status}`, RUN_EXIT_CODES.ENVIRONMENT);
  const worktree = allocateWorktree({ root: context.repository, repo: context.repository, runId: context.runId, taskId, packet: stripStateMetadata(packet), now: context.now, worktreeId: warm.worktree.worktree_id });
  const flint = await runAdapter(context, "flint", taskId, { task, packet: stripStateMetadata(packet), worktree_path: worktree.absolute_path, base_sha: packet.base_sha });
  let candidate = freezeCandidate(context, task, packet, worktree.absolute_path, flint.candidate ?? flint);
  appendStateEvent(context.repository, context.runId, { entity_type: "task", entity_id: taskId, action: "worker-completed", actor: "flint", cause: "runner-flint", timestamp: context.now, data: { status: "READY_FOR_PUCK", candidate_id: candidate.candidate_id, snapshot_id: candidate.snapshot_id } });

  const taskRequirements = (task.requirements ?? []).map((id) => state.entities.requirement?.[id]).filter(Boolean);
  const mutationPolicy = mutationPolicyForRequirements(taskRequirements);
  const policyCheck = validateMutationPolicy(packet.mutation_policy, { requirements: taskRequirements, packet });
  if (!policyCheck.valid) return blockTask(context, taskId, "MUTATION_POLICY_INVALID", policyCheck.errors);
  if (mutationPolicy.required) {
    const snapshot = replayRunState(context.repository, context.runId).entities.snapshot[candidate.snapshot_id];
    const mutationConfig = packet.mutation_policy?.config ?? context.mutation_config ?? "stryker.config.json";
    if (!existsSync(join(worktree.absolute_path, mutationConfig))) return blockTask(context, taskId, "MUTATION_CONFIG_MISSING", [mutationConfig]);
    let mutation;
    try {
      mutation = runStrykerPolicy({ cwd: worktree.absolute_path, command: packet.mutation_policy?.command ?? context.mutation_command, reportPath: packet.mutation_policy?.report_path ?? "reports/mutation.json", packet: stripStateMetadata(packet), candidate, snapshot, changedPaths: candidate.changed_paths, root: context.repository, runId: context.runId, now: context.now });
    } catch (error) {
      return blockTask(context, taskId, "MUTATION_CHECK_FAILED", [error.code ?? error.message]);
    }
    const mutationCheck = validateMutationReport(mutation, { packet: stripStateMetadata(packet), candidate, snapshot });
    if (!mutationCheck.valid) return blockTask(context, taskId, "MUTATION_CHECK_FAILED", mutationCheck.errors);
    candidate = { ...candidate, mutation_required: true, mutation_evidence: mutation };
    appendStateEvent(context.repository, context.runId, { entity_type: "candidate", entity_id: candidate.candidate_id, action: "mutation-bound", actor: "puck", cause: "runner-mutation-check", timestamp: context.now, data: { mutation_required: true, mutation_evidence: mutation } });
  }

  const puckResult = await runAdapter(context, "puck", taskId, { task, packet: stripStateMetadata(packet), candidate, snapshot: replayRunState(context.repository, context.runId).entities.snapshot[candidate.snapshot_id], worktree_path: worktree.absolute_path });
  const puck = validateAndRecordGate(context, "puck", taskId, packet, candidate, puckResult.report ?? puckResult);
  if (!puck.valid) return failTask(context, taskId, "TEST_FAILURE", puck.errors);
  appendTaskStatus(context, taskId, "VERIFIED", { puck_evidence_id: puck.evidence_id });

  let vera = null;
  if (packet.vera_required) {
    const veraResult = await runAdapter(context, "vera", taskId, { task, packet: stripStateMetadata(packet), candidate, snapshot: replayRunState(context.repository, context.runId).entities.snapshot[candidate.snapshot_id], worktree_path: worktree.absolute_path });
    vera = validateAndRecordGate(context, "vera", taskId, packet, candidate, veraResult.report ?? veraResult);
    if (!vera.valid) return failTask(context, taskId, "REQUIREMENT_OMISSION", vera.errors);
    appendTaskStatus(context, taskId, "ALIGNED", { vera_evidence_id: vera.evidence_id });
  }

  const latest = replayRunState(context.repository, context.runId);
  const acceptedCandidate = latest.entities.candidate[candidate.candidate_id];
  const acceptance = validateAcceptance({ packet: stripStateMetadata(packet), snapshot: latest.entities.snapshot[candidate.snapshot_id], candidate: stripStateMetadata(acceptedCandidate), puck: latest.entities.evidence[puck.evidence_id]?.report, vera: vera ? latest.entities.evidence[vera.evidence_id]?.report : null, required: packet.vera_required });
  if (!acceptance.valid) return failTask(context, taskId, "INTEGRITY_DEFECT", acceptance.errors);
  appendStateEvent(context.repository, context.runId, { entity_type: "candidate", entity_id: candidate.candidate_id, action: "accepted", actor: "hush", cause: "runner-gates", timestamp: context.now, data: { ...candidate, status: "ACCEPTED", puck_evidence_id: puck.evidence_id, vera_evidence_id: vera?.evidence_id ?? null } });
  appendTaskStatus(context, taskId, "ACCEPTED", { candidate_id: candidate.candidate_id, snapshot_id: candidate.snapshot_id });
}

function freezeCandidate(context, task, packet, worktreePath, output) {
  const packetData = stripStateMetadata(packet);
  const endSha = output.end_sha ?? gitOutput(worktreePath, ["rev-parse", "HEAD"]);
  if (endSha === packetData.base_sha) throw new RunnerError(`Flint produced no commit for ${task.id}`, RUN_EXIT_CODES.FAILED);
  const changedPaths = gitOutput(worktreePath, ["diff", "--name-only", `${packetData.base_sha}..${endSha}`]).split("\n").filter(Boolean).sort();
  const diff = gitOutput(worktreePath, ["diff", `${packetData.base_sha}..${endSha}`]);
  const packetCheck = validatePacket(packetData, { root: context.repository, repository: context.repository, currentBaseSha: packetData.base_sha, changedPaths, now: context.now, environment: context.environment });
  if (packetCheck.status !== "VALID") throw new RunnerError(`Flint candidate is outside packet scope: ${packetCheck.status}`, RUN_EXIT_CODES.FAILED, packetCheck);
  const treeDigest = sha256(gitOutput(worktreePath, ["rev-parse", `${endSha}^{tree}`]));
  const diffDigest = sha256(diff);
  const snapshot = { snapshot_id: `SNAP-${task.id}`, candidate_id: output.candidate_id ?? `CAND-${task.id}`, task_id: task.id, base_sha: packetData.base_sha, end_sha: endSha, tree_digest: treeDigest, diff_digest: diffDigest, manifest_digest: sha256(JSON.stringify({ base_sha: packetData.base_sha, end_sha: endSha, changed_paths: changedPaths })), changed_paths: changedPaths, state: "FROZEN", frozen: true, created_at: context.now };
  appendStateEvent(context.repository, context.runId, { entity_type: "snapshot", entity_id: snapshot.snapshot_id, action: "frozen", actor: "hush", cause: "runner-flint-complete", timestamp: context.now, data: snapshot });
  const candidate = { ...output, candidate_id: snapshot.candidate_id, task_id: task.id, packet_id: packetData.packet_id, snapshot_id: snapshot.snapshot_id, status: "IMPLEMENTED", end_sha: endSha, commit_shas: output.commit_shas ?? [endSha], changed_paths: changedPaths, candidate_tree_digest: treeDigest, candidate_diff_digest: diffDigest, patch_digest: output.patch_digest ?? diffDigest, dependency_closure: output.dependency_closure ?? [task.id], dependency_closure_digest: output.dependency_closure_digest ?? sha256(JSON.stringify(output.dependency_closure ?? [task.id])), behavior_class: output.behavior_class ?? "TASK_BEHAVIOR", mutation_required: output.mutation_required === true };
  appendStateEvent(context.repository, context.runId, { entity_type: "candidate", entity_id: candidate.candidate_id, action: "frozen", actor: "hush", cause: "runner-snapshot", timestamp: context.now, data: candidate });
  return candidate;
}

function validateAndRecordGate(context, gate, taskId, packet, candidate, report) {
  const snapshot = replayRunState(context.repository, context.runId).entities.snapshot[candidate.snapshot_id];
  const check = validateGateReport(report, stripStateMetadata(packet), snapshot, { candidate });
  const coverage = gate === "puck" ? validateCheckCoverage(stripStateMetadata(packet), report) : { valid: true };
  const valid = check.valid && coverage.valid && report.verdict === "PASS";
  const errors = [...(check.errors ?? []), ...(coverage.errors ?? [])];
  const evidenceId = `${gate.toUpperCase()}-${candidate.candidate_id}`;
  appendStateEvent(context.repository, context.runId, { entity_type: "evidence", entity_id: evidenceId, action: valid ? "recorded" : "rejected", actor: gate, cause: "runner-gate", timestamp: context.now, data: { evidence_id: evidenceId, gate: gate.toUpperCase(), task_id: taskId, candidate_id: candidate.candidate_id, report, status: valid ? "PASS" : "FAIL", errors } });
  return { valid, errors, evidence_id: evidenceId };
}

function failTask(context, taskId, cause, errors) {
  appendTaskStatus(context, taskId, "FAILED", { block_reason: cause, errors });
  routeFailure(context.repository, context.runId, taskId, { primary_cause: cause, details: errors }, { now: context.now });
  throw new RunnerError(`task ${taskId} failed: ${cause}`, RUN_EXIT_CODES.FAILED, { task_id: taskId, errors });
}

function blockTask(context, taskId, cause, errors) {
  appendTaskStatus(context, taskId, "BLOCKED", { block_reason: cause, errors });
  appendStateEvent(context.repository, context.runId, { entity_type: "finding", entity_id: `FIND-${taskId}-${cause}`, action: "blocked", actor: "hush", cause, timestamp: context.now, data: { task_id: taskId, blocking: true, errors } });
  throw new RunnerError(`task ${taskId} blocked: ${cause}`, RUN_EXIT_CODES.BLOCKED, { task_id: taskId, reason: cause, errors });
}

function appendTaskStatus(context, taskId, status, data = {}) {
  appendStateEvent(context.repository, context.runId, { entity_type: "task", entity_id: taskId, action: status.toLowerCase(), actor: "hush", cause: "runner-transition", timestamp: context.now, data: { status, ...data } });
}

async function runAdapter(context, role, taskId, payload) {
  const state = replayRunState(context.repository, context.runId);
  const attempt = Number(payload.task?.attempt ?? payload.attempt ?? 1);
  const entityId = `ADAPTER-${role.toUpperCase()}-${taskId ?? "RUN"}-A${attempt}`;
  const previous = state.entities.evidence?.[entityId];
  if (previous?.status === "COMPLETED" && previous.artifact_path && existsSync(previous.artifact_path)) return JSON.parse(readFileSync(previous.artifact_path, "utf8"));
  const configured = Array.isArray(context.adapters[role]) ? { command: context.adapters[role] } : context.adapters[role];
  const inheritedEnv = Object.fromEntries((configured.pass_env ?? []).filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  const result = await spawnAdapter(configured.command, JSON.stringify({ protocol_version: RUNNER_VERSION, role, task_id: taskId, run_id: context.runId, ...payload }), { cwd: context.repository, timeout: configured.timeout_ms ?? 120_000, maxBuffer: 8 * 1024 * 1024, env: { ...inheritedEnv, PATH: process.env.PATH ?? "/usr/bin:/bin", HUSH_RUN_ID: context.runId, HUSH_ROLE: role } });
  if (result.error || result.status !== 0) throw new RunnerError(`${role} adapter failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`, RUN_EXIT_CODES.FAILED, { role, task_id: taskId });
  let output;
  try { output = JSON.parse(result.stdout); } catch (error) { throw new RunnerError(`${role} adapter must return JSON on stdout: ${error.message}`, RUN_EXIT_CODES.FAILED); }
  const artifactPath = join(context.repository, ".hush", "runs", context.runId, "artifacts", `${role}-${taskId ?? "run"}-a${attempt}.json`);
  mkdirSync(join(context.repository, ".hush", "runs", context.runId, "artifacts"), { recursive: true });
  const safeOutput = redact(output);
  writeFileSync(artifactPath, `${JSON.stringify(safeOutput, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  appendStateEvent(context.repository, context.runId, { entity_type: "evidence", entity_id: entityId, action: "adapter-completed", actor: role, cause: "runner-adapter", timestamp: context.now, data: { status: "COMPLETED", role, task_id: taskId, artifact_path: artifactPath, artifact_digest: sha256(readFileSync(artifactPath)), command_digest: sha256(JSON.stringify(configured.command)) } });
  return output;
}

function spawnAdapter(command, input, options) {
  return new Promise((resolveResult) => {
    const child = spawn(command[0], command.slice(1), { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let error = null;
    let overflow = false;
    const append = (target, chunk) => {
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
      if (stdout.length > options.maxBuffer || stderr.length > options.maxBuffer) {
        overflow = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.once("error", (childError) => { error = childError; });
    const timer = setTimeout(() => {
      error = new Error(`adapter timed out after ${options.timeout}ms`);
      child.kill("SIGTERM");
    }, options.timeout);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (overflow) error = new Error(`adapter output exceeded ${options.maxBuffer} bytes`);
      resolveResult({ status: status ?? 1, signal, stdout, stderr, error });
    });
    child.stdin.end(input);
  });
}

function appendRunStatus(context, status, cause, data = {}) { appendStateEvent(context.repository, context.runId, { entity_type: "run", entity_id: context.runId, action: cause, actor: "hush", cause, timestamp: context.now, data: { status, ...data } }); }

function finishBlocked(context, exitCode, status, blockers) {
  appendRunStatus(context, status, "runner-blocked", { blockers });
  return finalize(context, replayRunState(context.repository, context.runId), exitCode, status, blockers);
}

function finalize(context, state, exitCode, status, blockers = []) {
  const summary = { runner_version: RUNNER_VERSION, run_id: context.runId, status, exit_code: exitCode, prd_digest: context.prdDigest, target: context.target, state_revision: state.events.length, task_ids: Object.keys(state.entities.task ?? {}).sort(), candidate_ids: Object.keys(state.entities.candidate ?? {}).sort(), evidence_ids: Object.keys(state.entities.evidence ?? {}).sort(), blockers };
  const path = join(context.repository, ".hush", "runs", context.runId, "runner-summary.json");
  mkdirSync(join(context.repository, ".hush", "runs", context.runId), { recursive: true });
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { ...summary, summary_path: path };
}

function runnerResult(fields) { return { runner_version: RUNNER_VERSION, ...fields }; }

function latestAcceptedCandidate(state) { return Object.values(state.entities.candidate ?? {}).filter((candidate) => candidate.status === "ACCEPTED").sort((left, right) => String(left.id).localeCompare(String(right.id))).at(-1); }
function evidenceIds(state, candidate) { return [candidate.puck_evidence_id, candidate.vera_evidence_id].filter(Boolean); }
function sourceManifest(repository, prdPath, digest) { return { path: relative(repository, prdPath) || basename(prdPath), location: `${relative(repository, prdPath) || basename(prdPath)}:1`, digest, discovery_method: "runner-filesystem-read" }; }
function createRunId(prdDigest) { return `RUN-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${prdDigest.slice(-8)}`; }
function stripStateMetadata(value) { if (!value) return value; const copy = { ...value }; for (const key of ["id", "type", "revision", "updated_at", "last_event_id"]) delete copy[key]; return copy; }
function sha256(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function gitOutput(cwd, args) { const result = spawnSync("git", args, { cwd, encoding: "utf8" }); if (result.status !== 0) throw new RunnerError(`git ${args.join(" ")} failed: ${result.stderr.trim()}`, RUN_EXIT_CODES.INVALID_INPUT); return result.stdout.trim(); }
function redact(value, key = "") {
  if (/(token|secret|password|passwd|authorization|api.?key|private.?key)/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(/(bearer\s+|token\s*[:=]\s*|password\s*[:=]\s*|secret\s*[:=]\s*)([^\s,]+)/gi, "$1[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}
