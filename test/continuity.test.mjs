import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { persistHazardInventory, validateEnvironment } from "../lib/runtime/environment.mjs";
import { computeReportDigest, validateCheckCoverage } from "../lib/runtime/evidence.mjs";
import { canAutoMerge, GhAxiAdapter, normalizeCiEvent, renderPrPayload, validateCiIdentity } from "../lib/runtime/delivery.mjs";
import { validateRequirementRecord } from "../lib/runtime/requirements.mjs";
import { capacityPolicy } from "../lib/runtime/scheduler.mjs";
import { appendStateEvent, readStateEvents } from "../lib/runtime/state.mjs";
import { mutationPolicyForRequirements, runStrykerPolicy, runVeraShell, summarizeStrykerReport, validateMutationReport, validateVeraShellCommand } from "../lib/runtime/verification.mjs";
import { pauseRun, replayRun, resumeRun, scheduleDurableTimer, watchOnce, writeCursor } from "../lib/runtime/watcher.mjs";

const now = "2026-09-10T02:00:00.000Z";
const root = () => mkdtempSync(join(tmpdir(), "hush-continuity-"));
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

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

test("replay is read-only and unsupported events become durable blocks", () => {
  const path = root();
  appendStateEvent(path, "RUN-1", { entity_type: "run", entity_id: "RUN-1", action: "created", actor: "hush", cause: "test", timestamp: now, data: { status: "OPEN" } });
  appendStateEvent(path, "RUN-1", { entity_type: "run", entity_id: "RUN-1", action: "future-event", actor: "fixture", cause: "test", timestamp: now, data: { event_type: "FUTURE_EVENT" } });
  let calls = 0;
  const replay = replayRun(path, "RUN-1", { handlers: { FUTURE_EVENT: () => { calls += 1; } }, now });
  assert.equal(replay.status, "REPLAYED");
  assert.equal(calls, 0);
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
