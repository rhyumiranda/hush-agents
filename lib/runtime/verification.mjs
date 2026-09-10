import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { computeReportDigest } from "./evidence.mjs";
import { appendStateEvent } from "./state.mjs";

const DENIED_VERA = /(?:^|\s)(?:rm|mv|cp|touch|mkdir|rmdir|chmod|chown|git\s+(?:commit|merge|cherry-pick|reset|checkout|switch|push|pull|fetch|rebase|remote|ls-remote)|npm|npx|yarn|pnpm|gh|curl|wget|nc|ssh|make|pytest|vitest|jest|accept|approve|merge)(?:\s|$)/i;
const SHELL_WRITE = /(?:>>?|\|\s*tee(?:\s|$)|\b(?:sed|perl|python|node)\b[^\n]*(?:-i|writeFile|appendFile)|\bheredoc\b)/i;

export function mutationPolicyForRequirements(requirements) {
  if (!requirements) return { required: false, requirement_ids: [], checks: [], tool: "strykerjs", command: "npx stryker run" };
  const highRisk = requirements.filter((requirement) => requirement?.risk === "HIGH" || requirement?.risk_class === "HIGH" || requirement?.high_risk === true);
  const tagged = highRisk.filter((requirement) => [...(requirement.tags ?? String()), ...(requirement.fable_tags ?? String())].some((tag) => String(tag).toUpperCase() === "FABLE" || String(tag).toUpperCase() === "FABLE-HIGH-RISK"));
  const checks = tagged.flatMap((requirement) => requirement.mutation_checks ?? ["authorization", "publication", "consent", "audit", "security"]);
  return { required: tagged.length > 0, requirement_ids: tagged.map((item) => item.requirement_id ?? item.id).filter(Boolean).sort(), checks: [...new Set(checks)].sort(), tool: "strykerjs", command: "npx stryker run" };
}

export function validateMutationPolicy(policy, { requirements, packet } = {}) {
  const expected = mutationPolicyForRequirements(requirements);
  const actual = policy ?? packet?.mutation_policy;
  if (!actual) return expected.required ? { valid: false, errors: ["mutation policy required for Fable-tagged HIGH requirement"] } : { valid: true, policy: expected };
  const errors = [];
  if (actual.required !== expected.required && expected.requirement_ids.length > 0) errors.push("mutation policy required flag does not match Fable high-risk requirements");
  if (actual.required && actual.tool !== "strykerjs") errors.push("mutation tool must be strykerjs");
  if (actual.required && (!Array.isArray(actual.checks) || !expected.checks.every((check) => actual.checks.includes(check)))) errors.push("mutation policy does not cover all required high-risk checks");
  return errors.length ? { valid: false, errors } : { valid: true, policy: actual };
}

export function runStrykerPolicy({ cwd, command, reportPath = "reports/mutation.json", packet, candidate, snapshot, changedPaths, timeoutMs = 120_000, env = {}, root, runId, now, actor = "puck" } = {}) {
  if (!cwd) throw new Error("MUTATION_CWD_REQUIRED");
  if (!packet || !packet.packet_id || !candidate || !candidate.candidate_id || !candidate.patch_digest || !snapshot || !snapshot.snapshot_id || !snapshot.diff_digest) throw new Error("MUTATION_BINDINGS_REQUIRED");
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) throw new Error("MUTATION_CHANGED_PATHS_REQUIRED");
  const mutationArgs = changedPaths.flatMap((path) => ["--mutate", shellQuote(path)]);
  const effectiveCommand = command ?? `npx --no-install stryker run ${mutationArgs.join(" ")}`;
  const version = readStrykerVersion(cwd, timeoutMs, env);
  const result = spawnSync("/bin/sh", ["-c", effectiveCommand], { cwd, env: { ...process.env, ...env, HUSH_NETWORK_POLICY: "disabled" }, timeout: timeoutMs });
  const timedOut = result.error?.code === "ETIMEDOUT";
  const reportFile = resolve(cwd, reportPath);
  if (!existsSync(reportFile)) throw Object.assign(new Error("MUTATION_REPORT_MISSING"), { code: "MUTATION_REPORT_MISSING", result: { command: effectiveCommand, exit_status: result.status, report_path: reportFile } });
  const reportBytes = readFileSync(reportFile);
  let rawReport;
  try { rawReport = JSON.parse(reportBytes.toString()); } catch (error) { throw Object.assign(new Error(`MUTATION_REPORT_INVALID: ${error.message}`), { code: "MUTATION_REPORT_INVALID" }); }
  const summary = summarizeStrykerReport(rawReport);
  const report = createMutationEvidence({
    report_id: `MUTATION-${sha256(`${effectiveCommand}\0${reportFile}\0${summary.report_digest}`).slice(-16)}`,
    packet_id: packet.packet_id,
    candidate_id: candidate.candidate_id,
    candidate_patch_digest: candidate.patch_digest,
    candidate_diff_digest: snapshot.diff_digest,
    snapshot_id: snapshot.snapshot_id,
    changed_paths: [...new Set(changedPaths)].sort(),
    mutation_tool: "strykerjs",
    tool_version: version,
    command: effectiveCommand,
    report_path: reportPath,
    source_report_digest: sha256(reportBytes),
    mutation_score: summary.mutation_score,
    total_mutations: summary.total_mutations,
    killed_mutations: summary.killed_mutations,
    surviving_mutations: summary.surviving_mutations,
    status: timedOut || result.status !== 0 || summary.surviving_mutations > 0 ? "FAIL" : "PASS",
    exit_status: timedOut ? null : result.status ?? 1,
    timed_out: timedOut,
    stdout_digest: sha256(result.stdout ?? String()),
    stderr_digest: sha256(result.stderr ?? String()),
  });
  if (root && runId) recordMutationEvidence(root, runId, report, { now, actor });
  return report;
}

export function validateVeraShellCommand(command, { snapshotRoot, cwd = snapshotRoot, packet, approvedCommands } = {}) {
  const errors = [];
  if (typeof command !== "string" || command.trim() === "") errors.push("command is required");
  if (DENIED_VERA.test(command ?? String())) errors.push("command is not read-only or is outside Vera capability");
  if (SHELL_WRITE.test(command ?? String())) errors.push("shell write operation is forbidden");
  const allowed = approvedCommands ?? packet?.vera_shell_commands ?? packet?.approved_read_only_commands;
  if (packet && (!Array.isArray(allowed) || !allowed.some((item) => item === command))) errors.push("command is not approved by the Vera packet");
  if (snapshotRoot && cwd) { const rel = relative(resolve(snapshotRoot), resolve(cwd)); if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + "/")) errors.push("cwd must remain inside the frozen snapshot"); }
  return errors.length ? { valid: false, errors } : { valid: true };
}

export function runVeraShell({ command, snapshotRoot, cwd = snapshotRoot, timeoutMs = 30_000, packet, approvedCommands } = {}) {
  const validation = validateVeraShellCommand(command, { snapshotRoot, cwd, packet, approvedCommands });
  if (!validation.valid) throw Object.assign(new Error(`VERA_READ_ONLY_BLOCK: ${validation.errors.join("; ")}`), { code: "VERA_READ_ONLY_BLOCK" });
  const result = spawnSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8", timeout: timeoutMs, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HUSH_NETWORK_POLICY: "disabled", HUSH_VERA_READ_ONLY: "1" } });
  return { command, cwd, exit_status: result.status ?? 1, stdout: result.stdout ?? String(), stderr: result.stderr ?? String(), stdout_digest: sha256(result.stdout ?? String()), stderr_digest: sha256(result.stderr ?? String()) };
}

export function createMutationEvidence(input) {
  const report = { ...input };
  delete report.report_digest;
  return { ...report, report_digest: computeReportDigest(report) };
}

export function validateMutationReport(report, bindings = {}) {
  const errors = [];
  if (!report || bindings.packet?.packet_id !== report.packet_id) errors.push("packet binding mismatch");
  if (!report || bindings.candidate?.candidate_id !== report.candidate_id || bindings.candidate?.patch_digest !== report.candidate_patch_digest) errors.push("candidate binding mismatch");
  if (!report || bindings.snapshot?.snapshot_id !== report.snapshot_id || bindings.snapshot?.diff_digest !== report.candidate_diff_digest) errors.push("snapshot binding mismatch");
  if (!report || report.status !== "PASS" || Number(report.surviving_mutations ?? 0) !== 0) errors.push("surviving mutation blocks acceptance");
  if (report?.report_digest !== computeReportDigest(report ?? {})) errors.push("report digest mismatch");
  return errors.length ? { valid: false, errors } : { valid: true };
}

export function recordMutationEvidence(root, runId, report, { now, actor = "puck" } = {}) {
  if (!report || !report.report_id) throw new Error("MUTATION_REPORT_ID_REQUIRED");
  return appendStateEvent(root, runId, { entity_type: "mutation_evidence", entity_id: report.report_id, action: "recorded", actor, cause: report.packet_id ?? "mutation-check", timestamp: now, data: report });
}

export function summarizeStrykerReport(report) {
  const mutants = Object.values(report?.files ?? {}).flatMap((file) => Array.isArray(file?.mutants) ? file.mutants : []);
  const statuses = mutants.map((mutant) => String(mutant.status ?? String()));
  const killed = statuses.filter((status) => status === "Killed").length;
  const blocking = statuses.filter((status) => !["Killed", "Ignored", "NoMutation"].includes(status)).length;
  const total = statuses.filter((status) => status !== "Ignored").length;
  return { total_mutations: total, killed_mutations: killed, surviving_mutations: blocking, mutation_score: total === 0 ? 0 : Number(((killed / total) * 100).toFixed(2)), report_digest: computeReportDigest(report) };
}

function sha256(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function readStrykerVersion(cwd, timeoutMs, env) {
  const result = spawnSync("npx", ["--no-install", "stryker", "--version"], { cwd, env: { ...process.env, ...env, HUSH_NETWORK_POLICY: "disabled" }, timeout: timeoutMs });
  if (result.status !== 0) throw Object.assign(new Error("MUTATION_TOOL_UNAVAILABLE"), { code: "MUTATION_TOOL_UNAVAILABLE", result });
  return String(result.stdout ?? String()).trim();
}
