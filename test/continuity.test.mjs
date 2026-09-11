import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { persistHazardInventory, validateEnvironment } from "../lib/runtime/environment.mjs";
import { computeReportDigest, validateCheckCoverage } from "../lib/runtime/evidence.mjs";
import { canAutoMerge, deliverPullRequest, GhAxiAdapter, normalizeCiEvent, pollPullRequestCi, renderPrPayload, validateCiIdentity } from "../lib/runtime/delivery.mjs";
import { validateRequirementRecord } from "../lib/runtime/requirements.mjs";
import { capacityPolicy } from "../lib/runtime/scheduler.mjs";
import { appendStateEvent, readStateEvents, replayRunState } from "../lib/runtime/state.mjs";
import { createMutationEvidence, mutationPolicyForRequirements, recordMutationEvidence, runStrykerPolicy, runVeraShell, summarizeStrykerReport, validateMutationPolicy, validateMutationReport, validateVeraShellCommand } from "../lib/runtime/verification.mjs";
import { drainRun, pauseRun, replayRun, resolveHumanDecision, resumeRun, scheduleDurableTimer, watchOnce, watchRun, writeCursor } from "../lib/runtime/watcher.mjs";

const now = "2026-09-10T02:00:00.000Z";
const root = () => mkdtempSync(join(tmpdir(), "hush-continuity-"));
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const cli = join(process.cwd(), "bin", "hush-agents.mjs");

function mutationBindings() {
  return {
    packet: { packet_id: "P1" },
    candidate: { candidate_id: "C1", patch_digest: "patch-1" },
    snapshot: { snapshot_id: "S1", diff_digest: "diff-1" },
  };
}

function mutationReport(statuses = ["Killed"]) {
  return { files: { "src/example.mjs": { mutants: statuses.map((status) => ({ status })) } } };
}

function mutationFixture({ report = mutationReport(), exitStatus = 0, versionStatus = 0, writeReport = true, sleepSeconds = 0, versionSleepSeconds = 0 } = {}) {
  const cwd = root();
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const npx = join(bin, "npx");
  writeFileSync(npx, `#!/bin/sh
if [ "$1" != "--no-install" ] || [ "$2" != "stryker" ] || [ "$HUSH_NETWORK_POLICY" != "disabled" ]; then exit 9; fi
if [ "$3" = "--version" ]; then
  if [ "${versionSleepSeconds}" -gt 0 ]; then sleep "${versionSleepSeconds}"; fi
  if [ "${versionStatus}" -ne 0 ]; then exit "${versionStatus}"; fi
  printf '%s\\n' '10.0.0'
  exit 0
fi
if [ "${sleepSeconds}" -gt 0 ]; then sleep "${sleepSeconds}"; fi
printf '%s' "$HUSH_NETWORK_POLICY"
printf '%s' "$HUSH_MUTATION_STDERR" >&2
if [ "${writeReport}" = "true" ]; then
  mkdir -p "$(dirname "$HUSH_REPORT_PATH")"
  printf '%s' "$HUSH_MUTATION_REPORT" > "$HUSH_REPORT_PATH"
fi
exit "${exitStatus}"
`);
  chmodSync(npx, 0o755);
  return { cwd, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HUSH_REPORT_PATH: "reports/mutation.json", HUSH_MUTATION_REPORT: JSON.stringify(report), HUSH_MUTATION_STDERR: "stderr" }, ...mutationBindings() };
}

test("watcher resumes from durable cursor and duplicate action keys are idempotent", () => {
  const path = root();
  appendStateEvent(path, "RUN-1", { entity_type: "run", entity_id: "RUN-1", action: "created", actor: "hush", cause: "test", timestamp: now, data: { status: "OPEN" } });
  appendStateEvent(path, "RUN-1", { entity_type: "run", entity_id: "RUN-1", action: "custom", actor: "fixture", cause: "test", timestamp: now, data: { event_type: "TASK_READY", action_key: "fixed-action" } });
  let calls = 0;
  const handlers = { TASK_READY: () => { calls += 1; return { calls }; } };
  const first = watchOnce(path, "RUN-1", { now, handlers });
  const second = watchOnce(path, "RUN-1", { now, handlers });
  assert.equal(first.processed.at(-1).status, "COMPLETED");
  assert.equal(second.processed.length, 0);
  assert.equal(calls, 1);
  assert.equal(writeCursor(path, "RUN-1", first.cursor.cursor, { now }).revision > first.cursor.revision, true);
  const replay = replayRun(path, "RUN-1", { now, handlers });
  assert.equal(replay.replay, true);
  assert.equal(calls, 1);
});

test("drain processes handler-generated follow-up events and remains idempotent", () => {
  const path = root();
  appendStateEvent(path, "RUN-1", { entity_type: "task", entity_id: "TASK-1", action: "ready", actor: "fixture", cause: "test", timestamp: now, data: { event_type: "TASK_READY", action_key: "first" } });
  let calls = 0;
  const handlers = { TASK_READY: () => {
    calls += 1;
    if (calls === 1) appendStateEvent(path, "RUN-1", { entity_type: "task", entity_id: "TASK-2", action: "ready", actor: "fixture", cause: "follow-up", timestamp: now, data: { event_type: "TASK_READY", action_key: "follow-up" } });
    return { calls };
  } };
  const first = drainRun(path, "RUN-1", { now, handlers });
  assert.equal(first.status, "DRAINED");
  assert.equal(first.pending_events, 0);
  assert.equal(first.cycles > 1, true);
  assert.equal(calls, 2);
  const second = drainRun(path, "RUN-1", { now, handlers });
  assert.equal(second.status, "DRAINED");
  assert.equal(second.processed.length, 0);
  assert.equal(calls, 2);
});

test("follow mode can drain each polling cycle", async () => {
  const path = root();
  appendStateEvent(path, "RUN-1", { entity_type: "task", entity_id: "TASK-1", action: "ready", actor: "fixture", cause: "test", timestamp: now, data: { event_type: "TASK_READY", action_key: "first" } });
  let calls = 0;
  const result = await watchRun(path, "RUN-1", { now, follow: true, drain: true, iterations: 1, handlers: { TASK_READY: () => {
    calls += 1;
    if (calls === 1) appendStateEvent(path, "RUN-1", { entity_type: "task", entity_id: "TASK-2", action: "ready", actor: "fixture", cause: "follow-up", timestamp: now, data: { event_type: "TASK_READY", action_key: "follow-up" } });
  } } });
  assert.equal(result.status, "DRAINED");
  assert.equal(calls, 2);
});

test("drain reports pause, no progress, and bounded backlog", () => {
  const pausedPath = root();
  appendStateEvent(pausedPath, "RUN-1", { entity_type: "run", entity_id: "RUN-1", action: "created", actor: "hush", cause: "test", timestamp: now, data: { status: "PAUSED" } });
  appendStateEvent(pausedPath, "RUN-1", { entity_type: "task", entity_id: "TASK-1", action: "ready", actor: "fixture", cause: "test", timestamp: now, data: { event_type: "TASK_READY" } });
  let pausedCalls = 0;
  const paused = drainRun(pausedPath, "RUN-1", { now, handlers: { TASK_READY: () => { pausedCalls += 1; } } });
  assert.equal(paused.status, "PAUSED");
  assert.equal(pausedCalls, 0);
  assert.equal(paused.pending_events > 0, true);

  const limitedPath = root();
  for (const taskId of ["TASK-1", "TASK-2"]) appendStateEvent(limitedPath, "RUN-1", { entity_type: "task", entity_id: taskId, action: "ready", actor: "fixture", cause: "test", timestamp: now, data: { event_type: "TASK_READY", action_key: taskId } });
  const limited = drainRun(limitedPath, "RUN-1", { now, maxEvents: 1, handlers: { TASK_READY: () => "ok" } });
  assert.equal(limited.status, "LIMIT_REACHED");
  assert.equal(limited.pending_events > 0, true);

  const stalled = drainRun(limitedPath, "RUN-1", { now, maxEvents: 1, limit: 0, handlers: { TASK_READY: () => "never" } });
  assert.equal(stalled.status, "NO_PROGRESS");
});

test("watch --drain drains through the CLI boundary", () => {
  const path = root();
  appendStateEvent(path, "RUN-1", { entity_type: "run", entity_id: "RUN-1", action: "future", actor: "fixture", cause: "test", timestamp: now, data: { event_type: "FUTURE_EVENT", status: "OPEN" } });
  const result = spawnSync(process.execPath, [cli, "watch", "--run", "RUN-1", "--root", path, "--drain", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "DRAINED");
  assert.equal(output.pending_events, 0);
});

test("replay is read-only and unsupported events become durable blocks", () => {
  const path = root();
  appendStateEvent(path, "RUN-1", { entity_type: "run", entity_id: "RUN-1", action: "created", actor: "hush", cause: "test", timestamp: now, data: { status: "OPEN" } });
  appendStateEvent(path, "RUN-1", { entity_type: "run", entity_id: "RUN-1", action: "future-event", actor: "fixture", cause: "test", timestamp: now, data: { event_type: "FUTURE_EVENT" } });
  let calls = 0;
  const replay = replayRun(path, "RUN-1", { handlers: { FUTURE_EVENT: () => { calls += 1; } }, now });
  assert.equal(replay.status, "REPLAYED");
  assert.equal(calls, 0);
  assert.throws(() => drainRun(path, "RUN-1", { replay: true }), /DRAIN_REPLAY_FORBIDDEN/);
  const watched = watchOnce(path, "RUN-1", { now });
  assert.equal(watched.processed.at(-1).reason, "UNSUPPORTED_EVENT");
  assert.ok(readStateEvents(path, "RUN-1").some((event) => event.action === "unsupported-event"));
});

test("pause and resume keep the append-only event log and durable timers", () => {
  const path = root();
  appendStateEvent(path, "RUN-1", { entity_type: "run", entity_id: "RUN-1", action: "created", actor: "hush", cause: "test", timestamp: now, data: { status: "OPEN" } });
  pauseRun(path, "RUN-1", { now });
  appendStateEvent(path, "RUN-1", { entity_type: "run", entity_id: "RUN-1", action: "custom", actor: "fixture", cause: "test", timestamp: now, data: { event_type: "TASK_READY" } });
  const paused = watchOnce(path, "RUN-1", { now, handlers: { TASK_READY: () => { throw new Error("must not run"); } } });
  assert.equal(paused.status, "PAUSED");
  scheduleDurableTimer(path, "RUN-1", { timerId: "TIMER-1", kind: "retry", dueAt: now, now });
  resumeRun(path, "RUN-1", { now });
  const resumed = watchOnce(path, "RUN-1", { now, handlers: { TASK_READY: () => "ok", TIMER_DUE: () => "due" } });
  assert.equal(resumed.status, "WATCHED");
  assert.ok(readStateEvents(path, "RUN-1").some((event) => event.entity_type === "timer" && event.action === "due"));
});

test("provider delivery records PR and CI continuity events", () => {
  const path = root();
  const prPayload = renderPrPayload({ run_id: "RUN-DELIVERY", candidate_id: "CAND-1", head: "feature/cand-1", target: "main" });
  const adapter = {
    createOrUpdatePr: () => ({ provider: "github", status: "CREATED", pr_number: 7, response_digest: "sha256:pr", command: ["gh-axi", "pr", "create"] }),
    readCi: () => ({ provider: "github", event_type: "CI_PASSED", status: "CI_PASSED", identity: { pr_id: "7", commit_sha: "abc", workflow_id: "checks", report_digest: "sha256:report" }, report_digest: "sha256:report" }),
  };
  const source = appendStateEvent(path, "RUN-DELIVERY", { entity_type: "delivery", entity_id: "PR-RUN-DELIVERY-CAND-1", action: "pr-payload-rendered", actor: "hush", cause: "test", timestamp: now, data: { status: "READY_FOR_PR", payload: prPayload } });
  const pr = deliverPullRequest(path, "RUN-DELIVERY", source, { adapter, now });
  const ci = pollPullRequestCi(path, "RUN-DELIVERY", { event_id: "EVT-CI", data: { pr_id: pr.pr_id, expected_identity: { pr_id: "7", commit_sha: "abc", workflow_id: "checks", report_digest: "sha256:report" } }, timestamp: now }, { adapter, now });
  const events = readStateEvents(path, "RUN-DELIVERY");

  assert.equal(pr.status, "CREATED");
  assert.equal(pr.pr_id, 7);
  assert.equal(ci.status, "CI_PASSED");
  assert.ok(events.some((event) => event.action === "pr-created" && event.data.status === "PR_OPEN"));
  assert.ok(events.some((event) => event.action === "ci-passed" && event.data.pr_id === "7"));
  assert.ok(events.some((event) => event.entity_type === "provider_event" && event.data.status === "CI_PASSED"));
});

test("watcher drains provider delivery stages without reprocessing its own records", () => {
  const path = root();
  const payload = renderPrPayload({ run_id: "RUN-WATCH-DELIVERY", candidate_id: "CAND-1", head: "feature/cand-1", target: "main" });
  let creates = 0;
  let polls = 0;
  const adapter = {
    createOrUpdatePr: () => { creates += 1; return { provider: "github", status: "CREATED", pr_number: 9, response_digest: "sha256:pr", command: ["gh-axi", "pr", "create"] }; },
    readCi: () => { polls += 1; return { provider: "github", event_type: "CI_PASSED", status: "CI_PASSED", identity: { pr_id: "9", commit_sha: "abc", workflow_id: "checks", report_digest: "sha256:report" }, report_digest: "sha256:report" }; },
  };
  appendStateEvent(path, "RUN-WATCH-DELIVERY", { entity_type: "delivery", entity_id: "PR-RUN-WATCH-DELIVERY-CAND-1", action: "pr-payload-rendered", actor: "hush", cause: "test", timestamp: now, data: { status: "READY_FOR_PR", event_type: "READY_FOR_PR", payload, expected_identity: { pr_id: "9", commit_sha: "abc", workflow_id: "checks", report_digest: "sha256:report" } } });
  const drained = drainRun(path, "RUN-WATCH-DELIVERY", { now, deliveryAdapter: adapter });
  const events = readStateEvents(path, "RUN-WATCH-DELIVERY");

  assert.equal(drained.status, "DRAINED");
  assert.equal(creates, 1);
  assert.equal(polls, 1);
  assert.equal(events.filter((event) => event.action === "pr-created").length, 1);
  assert.equal(events.filter((event) => event.action === "ci-passed").length, 1);
});

test("human decisions resolve and schedule an auditable retry", () => {
  const path = root();
  appendStateEvent(path, "RUN-DECISION", { entity_type: "task", entity_id: "TASK-1", action: "ready", actor: "fixture", cause: "test", timestamp: now, data: { event_type: "TASK_READY" } });
  const blocked = watchOnce(path, "RUN-DECISION", { now, retryLimit: 0, handlers: { TASK_READY: () => { throw new Error("needs operator"); } } });
  const decision = Object.values(replayRunState(path, "RUN-DECISION").entities.human_decision ?? {})[0];
  const resolved = resolveHumanDecision(path, "RUN-DECISION", { decisionId: decision.id, decision: "retry", reason: "operator approved retry", now });
  const state = replayRunState(path, "RUN-DECISION");

  assert.equal(blocked.processed.at(-1).status, "HUMAN_DECISION_REQUIRED");
  assert.equal(resolved.status, "RETRY_SCHEDULED");
  assert.equal(state.entities.human_decision[decision.id].status, "RESOLVED");
  assert.ok(Object.values(state.entities.timer).some((timer) => timer.kind === "DECISION_RETRY"));
});

test("source byte validation rejects stale source and quote mismatch", () => {
  const path = root();
  mkdirSync(join(path, "docs"), { recursive: true });
  const source = "exact source quote\n";
  writeFileSync(join(path, "docs", "prd.md"), source);
  const digest = sha(source);
  const record = { requirement_id: "REQ-1", revision: 1, source: { path: "docs/prd.md", location: "docs/prd.md:1", digest }, quote: "exact source quote", expected_behavior: "x", actor: "fable", permissions: ["hush"], baseline_status: "REPORTED", enumeration_status: "EXHAUSTIVE", approval_state: "APPROVED", unknowns: [], source_discovery: { method: "filesystem-read", path: "docs/prd.md", location: "docs/prd.md:1", digest, status: "VERIFIED" }, quote_back: { quote: "exact source quote", location: "docs/prd.md:1", digest, verified: true } };
  assert.equal(validateRequirementRecord(record, { root: path }), null);
  writeFileSync(join(path, "docs", "prd.md"), "changed source\n");
  assert.equal(validateRequirementRecord(record, { root: path }).field, "source");
});

test("hazard freshness blocks missing or stale inventory", () => {
  const path = root();
  const repo = root();
  const hazards = ["database", "credentials", "email", "webhooks", "uploads", "network"].map((category, index) => ({ hazard_id: `HAZ-${index}`, repository: repo, category, policy: { database: "ephemeral-test-only", credentials: "fake-only", email: "sink-only", webhooks: "disabled", uploads: "disabled", network: "disabled" }[category], status: "MITIGATED", evidence: { method: "fixture", source: "test" } }));
  persistHazardInventory(path, repo, hazards, { timestamp: now });
  const environment = { network: "disabled", database: "ephemeral-test-only", credentials: "fake-only", email: "sink-only", webhooks: "disabled", uploads: "disabled", test_data: "generated", cleanup: [], hazards };
  assert.equal(validateEnvironment(environment, { root: path, repository: repo, requireFreshInventory: true, now }).status, "SAFE");
  assert.equal(validateEnvironment(environment, { root: path, repository: repo, requireFreshInventory: true, now: "2026-09-10T02:06:00.000Z" }).status, "BLOCKED");
});

test("write-path evidence must cover and observe every declared path", () => {
  const packet = { write_paths: ["a.js", "b.js"], acceptance_checks: [{ check_id: "C1", write_paths: ["a.js"], requirement_ids: ["R1"] }, { check_id: "C2", write_paths: ["b.js"], requirement_ids: ["R1"] }] };
  const artifact = { artifact_id: "A", artifact_path: "/tmp/a", artifact_digest: "sha256:" + "a".repeat(64) };
  const report = { observed_write_paths: ["a.js", "b.js"], check_results: [{ check_id: "C1", status: "PASS", exit_status: 0, write_paths: ["a.js"], ...artifact }, { check_id: "C2", status: "PASS", exit_status: 0, write_paths: ["b.js"], ...artifact }] };
  assert.deepEqual(validateCheckCoverage(packet, report), { valid: true });
  assert.equal(validateCheckCoverage(packet, { ...report, observed_write_paths: ["a.js"] }).valid, false);
});

test("capacity requires fresh HIGH confidence and never exceeds eight", () => {
  assert.equal(capacityPolicy({ available_workers: 12, safe_limit: 12, confidence: "HIGH", observed_at: now }, { now }).safe_limit, 8);
  assert.equal(capacityPolicy({ available_workers: 12, safe_limit: 12, confidence: "LOW", observed_at: now }, { now }).safe_limit, 0);
  assert.equal(capacityPolicy({ available_workers: 12, safe_limit: 12, confidence: "HIGH", observed_at: "2026-09-10T01:54:59.000Z" }, { now }).safe_limit, 0);
  assert.equal(capacityPolicy({ available_workers: 2, safe_limit: 3, confidence: "HIGH", observed_at: now }, { now }).safe_limit, 0);
});

test("Fable high-risk policy, mutation bindings, and Vera shell restrictions are enforced", () => {
  const policy = mutationPolicyForRequirements([{ requirement_id: "R-HIGH", risk: "HIGH", tags: ["FABLE"] }]);
  assert.equal(policy.required, true);
  const blocked = validateVeraShellCommand("git commit -am nope", { snapshotRoot: "/tmp/snapshot", cwd: "/tmp/snapshot" });
  assert.equal(blocked.valid, false);
  assert.throws(() => runVeraShell({ command: "echo ok > file", snapshotRoot: "/tmp/snapshot" }), /VERA_READ_ONLY_BLOCK/);
  const report = { report_id: "M1", packet_id: "P1", candidate_id: "C1", candidate_patch_digest: "p", candidate_diff_digest: "d", snapshot_id: "S1", changed_paths: ["a.js"], mutation_tool: "strykerjs", tool_version: "8.6.0", command: "npx --no-install stryker run", report_path: "reports/mutation.json", source_report_digest: sha("source"), mutation_score: 100, total_mutations: 1, killed_mutations: 1, surviving_mutations: 0, exit_status: 0, stdout_digest: sha("stdout"), stderr_digest: sha("stderr"), status: "PASS" };
  const bound = { ...report, report_digest: "" };
  bound.report_digest = computeReportDigest(bound);
  assert.equal(validateMutationReport(bound, { packet: { packet_id: "P1" }, candidate: { candidate_id: "C1", patch_digest: "p" }, snapshot: { snapshot_id: "S1", diff_digest: "d" } }).valid, true);
  const summary = summarizeStrykerReport({ files: { "lib/example.mjs": { mutants: [{ status: "Killed" }, { status: "Survived" }, { status: "Ignored" }] } } });
  assert.deepEqual({ ...summary, report_digest: undefined }, { total_mutations: 2, killed_mutations: 1, surviving_mutations: 1, mutation_score: 50, report_digest: undefined });
  assert.match(summary.report_digest, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => runStrykerPolicy({ cwd: "/tmp" }), /MUTATION_BINDINGS_REQUIRED/);
});

test("mutation policy selects every supported Fable high-risk form deterministically", () => {
  assert.deepEqual(mutationPolicyForRequirements(), { required: false, requirement_ids: [], checks: [], tool: "strykerjs", command: "npx stryker run" });
  assert.deepEqual(mutationPolicyForRequirements([
    null,
    { risk: "LOW", tags: ["FABLE"] },
    { risk: "LOW", tags: ["FABLE"], id: "LOW-ID", mutation_checks: ["low"] },
    { risk: "HIGH", tags: ["fable", "OTHER"], id: "B", mutation_checks: ["security", "security"] },
    { risk_class: "HIGH", fable_tags: ["FABLE-HIGH-RISK"], requirement_id: "A", mutation_checks: ["audit"] },
    { high_risk: true, tags: ["FABLE"], requirement_id: null },
    { risk: "HIGH", tags: ["OTHER"], id: "ignored" },
  ]), { required: true, requirement_ids: ["A", "B"], checks: ["audit", "authorization", "consent", "publication", "security"], tool: "strykerjs", command: "npx stryker run" });
  assert.deepEqual(mutationPolicyForRequirements([{ risk: "HIGH", tags: ["FABLE"], id: "DEFAULT" }]).checks, ["audit", "authorization", "consent", "publication", "security"]);
  assert.equal(mutationPolicyForRequirements([{ risk: "LOW", tags: ["FABLE"] }]).required, false);
});

test("mutation policy validation rejects missing, incomplete, and incorrect policies", () => {
  const requirements = [{ requirement_id: "HIGH-1", risk: "HIGH", tags: ["FABLE"] }];
  assert.deepEqual(validateMutationPolicy(undefined, { requirements }), { valid: false, errors: ["mutation policy required for Fable-tagged HIGH requirement"] });
  assert.equal(validateMutationPolicy(undefined).valid, true);
  assert.deepEqual(validateMutationPolicy({ required: false, tool: "strykerjs", checks: [] }, { requirements }), { valid: false, errors: ["mutation policy required flag does not match Fable high-risk requirements"] });
  assert.deepEqual(validateMutationPolicy({ required: true, tool: "other", checks: ["audit"] }, { requirements }), { valid: false, errors: ["mutation tool must be strykerjs", "mutation policy does not cover all required high-risk checks"] });
  assert.equal(validateMutationPolicy({ required: true, tool: "strykerjs", checks: ["audit", "authorization", "consent", "publication", "security"] }, { requirements }).valid, true);
  assert.equal(validateMutationPolicy({ required: true, tool: "strykerjs", checks: ["audit"] }, { requirements }).errors.includes("mutation policy does not cover all required high-risk checks"), true);
  assert.equal(validateMutationPolicy({ required: true, tool: "strykerjs", checks: ["audit"] }, { packet: { mutation_policy: { required: true, tool: "strykerjs", checks: ["audit"] } } }).valid, true);
});

test("Vera command validation covers every denied write or execution boundary", () => {
  const snapshot = root();
  for (const command of ["rm", "mv", "cp", "touch", "mkdir", "rmdir", "chmod", "chown", "git  commit", "npm", "npx", "yarn", "pnpm", "gh", "curl", "wget", "nc", "ssh", "make", "pytest", "vitest", "jest", "accept", "approve", "merge"]) {
    assert.equal(validateVeraShellCommand(command, { snapshotRoot: snapshot, cwd: snapshot }).valid, false, command);
  }
  assert.equal(validateVeraShellCommand("echo rm ", { snapshotRoot: snapshot, cwd: snapshot }).valid, false);
  for (const command of ["echo x > file", "echo x >> file", "printf x | tee", "printf x |  tee out", "sed -i s/a/b/ file", "perl -i -pe s/a/b/ file", "python writeFile", "node appendFile", "node xxappendFile", "cat << heredoc"]) {
    assert.equal(validateVeraShellCommand(command, { snapshotRoot: snapshot, cwd: snapshot }).valid, false, command);
  }
  assert.equal(validateVeraShellCommand("printf read-only", { snapshotRoot: snapshot, cwd: snapshot }).valid, true);
  assert.equal(validateVeraShellCommand("printf read-only", { snapshotRoot: snapshot, cwd: snapshot, packet: { vera_shell_commands: ["printf other"] } }).valid, false);
  assert.equal(validateVeraShellCommand("printf read-only", { snapshotRoot: snapshot, cwd: snapshot, packet: { approved_read_only_commands: ["printf read-only"] } }).valid, true);
  assert.deepEqual(validateVeraShellCommand(null).errors, ["command is required"]);
  assert.deepEqual(validateVeraShellCommand("rm").errors, ["command is not read-only or is outside Vera capability"]);
  assert.deepEqual(validateVeraShellCommand("echo x > file").errors, ["shell write operation is forbidden"]);
  assert.deepEqual(validateVeraShellCommand("printf read-only", { snapshotRoot: snapshot, cwd: snapshot, packet: { vera_shell_commands: ["printf other"] } }).errors, ["command is not approved by the Vera packet"]);
  assert.deepEqual(validateVeraShellCommand("printf read-only", { snapshotRoot: snapshot, cwd: join(snapshot, "..") }).errors, ["cwd must remain inside the frozen snapshot"]);
  assert.equal(validateVeraShellCommand("   ").valid, false);
  assert.equal(validateVeraShellCommand("printf read-only", { snapshotRoot: snapshot, cwd: join(snapshot, "nested") }).valid, true);
  assert.equal(validateVeraShellCommand("printf read-only", { snapshotRoot: snapshot, cwd: join(snapshot, "..") }).valid, false);
  assert.equal(validateVeraShellCommand("printf read-only", { snapshotRoot: snapshot, cwd: join(snapshot, "..", "outside") }).valid, false);
  assert.equal(validateVeraShellCommand("printf read-only", { snapshotRoot: snapshot, cwd: join(snapshot, "..foo") }).valid, true);
  assert.doesNotThrow(() => validateVeraShellCommand("printf read-only", { snapshotRoot: snapshot, cwd: null }));
  assert.doesNotThrow(() => validateVeraShellCommand("printf read-only", { snapshotRoot: null, cwd: snapshot }));
  assert.equal(validateVeraShellCommand("printf read-only", { approvedCommands: ["printf read-only"], packet: { vera_shell_commands: ["printf other"] } }).valid, true);
  assert.equal(validateVeraShellCommand("printf read-only", { approvedCommands: ["printf read-only", "printf other"], packet: { vera_shell_commands: ["printf other"] } }).valid, true);
});

test("Vera shell returns success, failure, and timeout evidence without mutation capability", () => {
  const snapshot = root();
  const success = runVeraShell({ command: "printf ok", snapshotRoot: snapshot });
  assert.deepEqual({ exit_status: success.exit_status, stdout: success.stdout, stderr: success.stderr }, { exit_status: 0, stdout: "ok", stderr: "" });
  assert.equal(success.stdout_digest, sha("ok"));
  assert.equal(success.stderr_digest, sha(""));
  assert.equal(runVeraShell({ command: 'printf "$HUSH_VERA_READ_ONLY:$HUSH_NETWORK_POLICY"', snapshotRoot: snapshot }).stdout, "1:disabled");
  const failure = runVeraShell({ command: "printf bad; exit 7", snapshotRoot: snapshot });
  assert.equal(failure.exit_status, 7);
  assert.equal(failure.stdout, "bad");
  const stderr = runVeraShell({ command: "node -e 'console.error(\"err\")'", snapshotRoot: snapshot });
  assert.equal(stderr.stderr, "err\n");
  assert.equal(stderr.stderr_digest, sha("err\n"));
  const pathOutput = runVeraShell({ command: "printf \"$PATH\"", snapshotRoot: snapshot });
  assert.equal(pathOutput.stdout, process.env.PATH ?? "/usr/bin:/bin");
  const savedPath = process.env.PATH;
  delete process.env.PATH;
  try {
    assert.equal(runVeraShell({ command: "printf \"$PATH\"", snapshotRoot: snapshot }).stdout, "/usr/bin:/bin");
  } finally {
    process.env.PATH = savedPath;
  }
  const timeout = runVeraShell({ command: "sleep 1", snapshotRoot: snapshot, timeoutMs: 10 });
  assert.equal(timeout.exit_status, 1);
  assert.throws(() => runVeraShell({ command: "printf ok", snapshotRoot: snapshot, packet: { vera_shell_commands: ["printf other"] } }), /VERA_READ_ONLY_BLOCK/);
  assert.throws(() => runVeraShell({ command: "echo x > file", snapshotRoot: snapshot, packet: { vera_shell_commands: ["echo other"] } }), (error) => error.code === "VERA_READ_ONLY_BLOCK" && error.message === "VERA_READ_ONLY_BLOCK: shell write operation is forbidden; command is not approved by the Vera packet");
});

test("mutation evidence binds exact sources and rejects every binding or verdict mismatch", () => {
  const input = { report_id: "M1", packet_id: "P1", candidate_id: "C1", candidate_patch_digest: "patch-1", candidate_diff_digest: "diff-1", snapshot_id: "S1", status: "PASS", surviving_mutations: 0, report_digest: "forged" };
  const evidence = createMutationEvidence(input);
  assert.notEqual(evidence.report_digest, "forged");
  assert.equal(evidence.report_digest, computeReportDigest({ ...input, report_digest: undefined }));
  const bindings = mutationBindings();
  assert.equal(validateMutationReport(evidence, bindings).valid, true);
  assert.equal(validateMutationReport(evidence, {}).valid, false);
  const missingCandidate = createMutationEvidence({ ...evidence, candidate_id: undefined, candidate_patch_digest: undefined });
  assert.equal(validateMutationReport(missingCandidate, { packet: bindings.packet, candidate: null, snapshot: bindings.snapshot }).valid, true);
  const missingSnapshot = createMutationEvidence({ ...evidence, snapshot_id: undefined, candidate_diff_digest: undefined });
  assert.equal(validateMutationReport(missingSnapshot, { packet: bindings.packet, candidate: bindings.candidate, snapshot: null }).valid, true);
  assert.equal(validateMutationReport(evidence, { packet: bindings.packet, candidate: { candidate_id: "C1" }, snapshot: bindings.snapshot }).errors.includes("candidate binding mismatch"), true);
  assert.equal(validateMutationReport(evidence, { packet: bindings.packet, candidate: bindings.candidate, snapshot: { snapshot_id: "S1" } }).errors.includes("snapshot binding mismatch"), true);
  for (const [name, altered] of [
    ["packet", { ...evidence, packet_id: "P2" }],
    ["candidate id", { ...evidence, candidate_id: "C2" }],
    ["candidate patch", { ...evidence, candidate_patch_digest: "patch-2" }],
    ["snapshot id", { ...evidence, snapshot_id: "S2" }],
    ["snapshot diff", { ...evidence, candidate_diff_digest: "diff-2" }],
    ["status", { ...evidence, status: "FAIL" }],
    ["survivors", { ...evidence, surviving_mutations: 1 }],
    ["digest", { ...evidence, report_digest: "sha256:" + "0".repeat(64) }],
  ]) {
    const checked = name === "digest" ? altered : createMutationEvidence(altered);
    const result = validateMutationReport(checked, bindings);
    assert.equal(result.valid, false, name);
    if (name !== "digest") assert.deepEqual(result.errors, [name === "packet" ? "packet binding mismatch" : ["candidate id", "candidate patch"].includes(name) ? "candidate binding mismatch" : ["snapshot id", "snapshot diff"].includes(name) ? "snapshot binding mismatch" : "surviving mutation blocks acceptance"]);
    if (name === "digest") assert.deepEqual(result.errors, ["report digest mismatch"]);
  }
  assert.equal(validateMutationReport(undefined).valid, false);
  assert.throws(() => recordMutationEvidence(root(), "RUN-1", {}), /MUTATION_REPORT_ID_REQUIRED/);
  const stateRoot = root();
  recordMutationEvidence(stateRoot, "RUN-1", evidence, { now, actor: "test" });
  const recorded = readStateEvents(stateRoot, "RUN-1").at(-1);
  assert.equal(recorded.entity_type, "mutation_evidence");
  assert.equal(recorded.actor, "test");
  assert.equal(recorded.timestamp, now);
  const defaultStateRoot = root();
  recordMutationEvidence(defaultStateRoot, "RUN-2", { report_id: "M2" });
  const defaultRecorded = readStateEvents(defaultStateRoot, "RUN-2").at(-1);
  assert.equal(defaultRecorded.actor, "puck");
  assert.equal(defaultRecorded.cause, "mutation-check");
});

test("Stryker runner records pass and durable failures with exact bindings", () => {
  const passFixture = mutationFixture();
  const pass = runStrykerPolicy({ ...passFixture, changedPaths: ["src/b.js", "src/a.js", "src/a.js"], root: passFixture.cwd, runId: "RUN-PASS", now });
  assert.equal(pass.status, "PASS");
  assert.equal(pass.tool_version, "10.0.0");
  assert.deepEqual(pass.changed_paths, ["src/a.js", "src/b.js"]);
  assert.match(pass.command, /--mutate 'src\/a\.js'/);
  assert.equal(pass.report_id, `MUTATION-${sha(`${pass.command}\0${join(passFixture.cwd, "reports/mutation.json")}\0${summarizeStrykerReport(mutationReport()).report_digest}`).slice(-16)}`);
  assert.equal(pass.mutation_tool, "strykerjs");
  assert.equal(pass.stdout_digest, sha("disabled"));
  assert.equal(pass.stderr_digest, sha("stderr"));
  const passEvent = readStateEvents(passFixture.cwd, "RUN-PASS").at(-1);
  assert.equal(passEvent.entity_type, "mutation_evidence");
  assert.equal(passEvent.actor, "puck");
  assert.equal(passEvent.timestamp, now);
  assert.doesNotThrow(() => runStrykerPolicy({ ...passFixture, root: null, runId: "RUN-NO-ROOT", changedPaths: ["src/a.js"] }));
  const quoted = runStrykerPolicy({ ...passFixture, changedPaths: ["src/a'b.js"] });
  assert.equal(quoted.command.includes("'src/a'\\''b.js'"), true);

  const survivorFixture = mutationFixture({ report: mutationReport(["Killed", "Survived"]) });
  assert.equal(runStrykerPolicy({ ...survivorFixture, changedPaths: ["src/a.js"] }).status, "FAIL");
  const exitFixture = mutationFixture({ exitStatus: 2 });
  assert.equal(runStrykerPolicy({ ...exitFixture, changedPaths: ["src/a.js"] }).status, "FAIL");
  assert.equal(runStrykerPolicy({ ...exitFixture, command: "npx --no-install stryker run", changedPaths: ["src/a.js"] }).exit_status, 2);
  const missingFixture = mutationFixture({ writeReport: false });
  assert.throws(() => runStrykerPolicy({ ...missingFixture, changedPaths: ["src/a.js"] }), (error) => {
    assert.equal(error.code, "MUTATION_REPORT_MISSING");
    assert.equal(error.message, "MUTATION_REPORT_MISSING");
    assert.equal(error.result.report_path, join(missingFixture.cwd, "reports", "mutation.json"));
    return true;
  });
  const invalidFixture = mutationFixture({ writeReport: false });
  mkdirSync(join(invalidFixture.cwd, "reports"));
  writeFileSync(join(invalidFixture.cwd, "reports", "mutation.json"), "not-json");
  assert.throws(() => runStrykerPolicy({ ...invalidFixture, changedPaths: ["src/a.js"] }), (error) => {
    assert.equal(error.code, "MUTATION_REPORT_INVALID");
    assert.match(error.message, /^MUTATION_REPORT_INVALID:/);
    return true;
  });
  const unavailableFixture = mutationFixture({ versionStatus: 1 });
  assert.throws(() => runStrykerPolicy({ ...unavailableFixture, changedPaths: ["src/a.js"] }), (error) => error.code === "MUTATION_TOOL_UNAVAILABLE");
  assert.throws(() => runStrykerPolicy({ ...unavailableFixture, changedPaths: ["src/a.js"] }), (error) => error.message === "MUTATION_TOOL_UNAVAILABLE");
  const timeoutFixture = mutationFixture({ writeReport: false, sleepSeconds: 10 });
  mkdirSync(join(timeoutFixture.cwd, "reports"));
  writeFileSync(join(timeoutFixture.cwd, "reports", "mutation.json"), JSON.stringify(mutationReport()));
  const timedOut = runStrykerPolicy({ ...timeoutFixture, timeoutMs: 1000, changedPaths: ["src/a.js"] });
  assert.equal(timedOut.status, "FAIL");
  assert.equal(timedOut.timed_out, true);
  assert.equal(timedOut.exit_status, null);
  const versionTimeoutFixture = mutationFixture({ versionSleepSeconds: 10 });
  assert.throws(() => runStrykerPolicy({ ...versionTimeoutFixture, timeoutMs: 1000, changedPaths: ["src/a.js"] }), (error) => error.code === "MUTATION_TOOL_UNAVAILABLE" && error.message === "MUTATION_TOOL_UNAVAILABLE");
  assert.throws(() => runStrykerPolicy({ ...passFixture, cwd: undefined, changedPaths: ["src/a.js"] }), (error) => error.message === "MUTATION_CWD_REQUIRED");
  for (const missing of [
    { packet: {} },
    { candidate: {} },
    { candidate: { candidate_id: "C1" } },
    { snapshot: {} },
    { snapshot: { snapshot_id: "S1" } },
  ]) {
    assert.throws(() => runStrykerPolicy({ ...passFixture, ...missing, changedPaths: ["src/a.js"] }), (error) => error.message === "MUTATION_BINDINGS_REQUIRED");
  }
  assert.throws(() => runStrykerPolicy({ ...passFixture, changedPaths: [] }), (error) => error.message === "MUTATION_CHANGED_PATHS_REQUIRED");
  assert.throws(() => runStrykerPolicy({ ...passFixture, changedPaths: "src/a.js" }), (error) => error.message === "MUTATION_CHANGED_PATHS_REQUIRED");
  assert.throws(() => runStrykerPolicy({ ...passFixture }), (error) => error.message === "MUTATION_CHANGED_PATHS_REQUIRED");
});

test("Stryker summary handles empty, ignored, unrecognized, and array report shapes", () => {
  const empty = summarizeStrykerReport();
  assert.deepEqual({ total_mutations: empty.total_mutations, killed_mutations: empty.killed_mutations, surviving_mutations: empty.surviving_mutations, mutation_score: empty.mutation_score }, { total_mutations: 0, killed_mutations: 0, surviving_mutations: 0, mutation_score: 0 });
  const summary = summarizeStrykerReport({ files: [{ mutants: [{ status: "NoMutation" }, { status: "Ignored" }, { status: "Killed" }, { status: "Survived" }, { status: "Timeout" }] }, { mutants: "invalid" }] });
  assert.deepEqual({ total_mutations: summary.total_mutations, killed_mutations: summary.killed_mutations, surviving_mutations: summary.surviving_mutations, mutation_score: summary.mutation_score }, { total_mutations: 4, killed_mutations: 1, surviving_mutations: 2, mutation_score: 25 });
  assert.equal(summarizeStrykerReport({ files: [null] }).total_mutations, 0);
});

test("PR rendering, provider timeout, CI identity, and auto-merge guards are deterministic", () => {
  const first = renderPrPayload({ run_id: "R", requirements: ["R2", "R1"], checks: [{ id: "z", status: "PASS" }, { id: "a", status: "PASS" }], evidence: [{ id: "E", digest: "d" }] });
  const second = renderPrPayload({ run_id: "R", requirements: ["R1", "R2"], checks: [{ id: "a", status: "PASS" }, { id: "z", status: "PASS" }], evidence: [{ id: "E", digest: "d" }] });
  assert.equal(first.payload_digest, second.payload_digest);
  const adapter = new GhAxiAdapter({ repository: ".", executor: () => ({ timeout: true, status: null }) });
  assert.throws(() => adapter.createOrUpdatePr({ ...first, head: "feature" }), /PROVIDER_UNAVAILABLE/);
  const mergeCalls = [];
  const protection = { url: "https://api.github.com/repos/rhyumiranda/hush-agents/branches/main/protection", required_status_checks: { strict: true, contexts: ["test"] }, required_pull_request_reviews: { required_approving_review_count: 1 } };
  const mergeRoot = root();
  const mergeAdapter = new GhAxiAdapter({ repository: ".", repositorySlug: "rhyumiranda/hush-agents", executor: (command, args) => { mergeCalls.push([command, args]); return args[0] === "api" ? { status: 0, stdout: JSON.stringify(protection) } : { status: 0, stdout: "queued" }; } });
  assert.equal(mergeAdapter.mergePr(7, { target: "main", repository_slug: "rhyumiranda/hush-agents", local_acceptance: true, puck_verified: true, evidence_complete: true, ci_passed: true }, { root: mergeRoot, runId: "RUN-MERGE", now }).status, "AUTO_MERGE_REQUESTED");
  assert.equal(mergeCalls[0][1][0], "api");
  assert.equal(mergeCalls[1][1].includes("--auto"), true);
  assert.equal(readStateEvents(mergeRoot, "RUN-MERGE").find((event) => event.action === "branch-protection-checked")?.data.status, "PROTECTED");
  const unprotected = new GhAxiAdapter({ repository: ".", repositorySlug: "rhyumiranda/hush-agents", executor: () => ({ status: 404, stdout: "Branch not protected (HTTP 404)" }) });
  assert.throws(() => unprotected.mergePr(7, { target: "main", local_acceptance: true, puck_verified: true, evidence_complete: true, ci_passed: true }, { root: mergeRoot, runId: "RUN-MERGE", now }), /AUTO_MERGE_BLOCKED/);
  const ci = normalizeCiEvent({ pr_id: "1", commit_sha: "abc", workflow_id: "w", report_digest: "d", conclusion: "success" });
  assert.equal(validateCiIdentity(ci, { pr_id: "1", commit_sha: "other", workflow_id: "w", report_digest: "d" }).valid, false);
  assert.equal(canAutoMerge({ branch_protection: { status: "PROTECTED" }, target: "main", local_acceptance: true, puck_verified: true, vera_required: false, evidence_complete: true, ci_passed: true }).allowed, true);
  assert.equal(canAutoMerge({ protected_main: true, target: "main", local_acceptance: true, puck_verified: false, evidence_complete: true, ci_passed: true }).allowed, false);
});
