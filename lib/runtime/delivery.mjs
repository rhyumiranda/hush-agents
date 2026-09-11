import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendStateEvent, replayRunState } from "./state.mjs";

export const GH_AXI_COMMAND = "gh-axi";

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function digest(value) { return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`; }

export function renderPrPayload(input = {}) {
  const requirements = [...new Set(input.requirements ?? input.requirement_ids ?? [])].sort();
  const checks = [...(input.checks ?? input.integration_checks ?? [])].map(normalizeCheck).sort((a, b) => a.id.localeCompare(b.id));
  const evidence = [...(input.evidence ?? input.evidence_ids ?? [])].map(normalizeEvidence).sort((a, b) => a.id.localeCompare(b.id));
  const findings = [...(input.findings ?? [])].map(normalizeFinding).sort((a, b) => a.id.localeCompare(b.id));
  const candidate = input.candidate ?? {};
  const title = input.title ?? `Hush: ${candidate.candidate_id ?? input.candidate_id ?? input.run_id ?? "candidate"}`;
  const lines = [
    `# ${title}`,
    "",
    "## Summary",
    input.summary ?? `Automated candidate ${candidate.candidate_id ?? input.candidate_id ?? "unknown"}.`,
    "",
    "## Requirements",
    ...(requirements.length ? requirements.map((id) => `- ${id}`) : ["- none"]),
    "",
    "## Checks",
    ...(checks.length ? checks.map((check) => `- ${check.id}: ${check.status}`) : ["- none"]),
    "",
    "## Evidence",
    ...(evidence.length ? evidence.map((item) => `- ${item.id}: ${item.digest ?? "unbound"}`) : ["- none"]),
    "",
    "## Risk Findings",
    ...(findings.length ? findings.map((finding) => `- ${finding.id}: ${finding.cause}`) : ["- none"]),
  ];
  const payload = { title, body: lines.join("\n"), base: input.base ?? input.target ?? "main", head: input.head ?? candidate.branch ?? candidate.candidate_id ?? null, draft: input.draft === true, labels: [...new Set(input.labels ?? ["hush"])].sort(), requirements, checks, evidence, findings };
  return { ...payload, payload_digest: digest(payload) };
}

export const renderPullRequest = renderPrPayload;

export class GhAxiAdapter {
  constructor({ repository, repositorySlug, executor = defaultExecutor, timeoutMs = 30_000 } = {}) {
    this.repository = repository;
    this.repositorySlug = repositorySlug;
    this.executor = executor;
    this.timeoutMs = timeoutMs;
  }

  createOrUpdatePr(payload, { prNumber } = {}) {
    const args = prNumber
      ? ["pr", "edit", String(prNumber), "--title", payload.title, "--body", payload.body, "--base", payload.base]
      : ["pr", "create", "--title", payload.title, "--body", payload.body, "--base", payload.base, "--head", payload.head, ...(payload.draft ? ["--draft"] : []), ...payload.labels.flatMap((label) => ["--label", label])];
    const result = this.executor(GH_AXI_COMMAND, args, { cwd: this.repository, timeoutMs: this.timeoutMs });
    if (result.timeout || result.status !== 0) throw providerError("PROVIDER_UNAVAILABLE", result);
    const remote = result.stdout ?? result;
    return { provider: "github", command: [GH_AXI_COMMAND, ...args], status: prNumber ? "UPDATED" : "CREATED", pr_number: prNumber ?? pullRequestNumber(remote), response_digest: digest(remote), remote };
  }

  readCi(prNumber) {
    const args = ["pr", "checks", String(prNumber)];
    const result = this.executor(GH_AXI_COMMAND, args, { cwd: this.repository, timeoutMs: this.timeoutMs });
    if (result.timeout || result.status !== 0) throw providerError("PROVIDER_UNAVAILABLE", result);
    return normalizeCiEvent({ provider: "github", pr_id: String(prNumber), raw: result.stdout ?? result });
  }

  readBranchProtection({ repositorySlug = this.repositorySlug, branch = "main", expectedPolicyRevision } = {}) {
    const slug = normalizeRepositorySlug(repositorySlug);
    if (!slug) throw providerError("BRANCH_PROTECTION_IDENTITY_REQUIRED", { error: "repository owner/name is required" });
    if (!branch || branch.includes("/")) throw providerError("BRANCH_PROTECTION_BRANCH_INVALID", { error: "branch must be a single Git ref name" });
    const path = `/repos/${slug}/branches/${encodeURIComponent(branch)}/protection`;
    const result = this.executor(GH_AXI_COMMAND, ["api", path], { cwd: this.repository, timeoutMs: this.timeoutMs });
    if (result.timeout) throw providerError("PROVIDER_UNAVAILABLE", result);
    if (result.status !== 0) {
      const message = `${result.stderr ?? ""} ${result.stdout ?? ""}`.toLowerCase();
      if (result.status === 404 || message.includes("not protected") || message.includes("http 404")) {
        return { provider: "github", status: "UNPROTECTED", repository: slug, branch, request: [GH_AXI_COMMAND, "api", path], checked_at: new Date().toISOString(), response_digest: digest(result.stdout ?? result), reason: "branch is not protected" };
      }
      throw providerError("PROVIDER_UNAVAILABLE", result);
    }
    let raw;
    try {
      raw = typeof result.stdout === "string" ? JSON.parse(result.stdout) : result.stdout;
    } catch (error) {
      throw providerError("BRANCH_PROTECTION_RESPONSE_INVALID", { error: error.message, stdout: result.stdout });
    }
    const evidence = normalizeBranchProtection(raw, { repository: slug, branch, request: [GH_AXI_COMMAND, "api", path], checkedAt: new Date().toISOString() });
    if (expectedPolicyRevision && evidence.policy_revision !== expectedPolicyRevision) {
      return { ...evidence, status: "STALE", reason: "branch protection policy revision mismatch", expected_policy_revision: expectedPolicyRevision };
    }
    return evidence;
  }

  mergePr(prNumber, policy, { method = "merge", deleteBranch = false, root, runId, now, actor = "hush" } = {}) {
    if (!root || !runId) throw providerError("DELIVERY_STATE_REQUIRED", { error: "root and runId are required to record branch-protection evidence" });
    const target = policy.target ?? policy.target_branch ?? "main";
    const protection = this.readBranchProtection({ repositorySlug: policy.repository_slug ?? policy.repositorySlug, branch: target, expectedPolicyRevision: policy.expected_policy_revision ?? policy.expectedPolicyRevision });
    recordBranchProtectionEvidence(root, runId, protection, { prNumber, policy, now, actor });
    const guard = canAutoMerge({ ...policy, branch_protection: protection });
    if (!guard.allowed) throw providerError("AUTO_MERGE_BLOCKED", { error: guard.reason });
    const args = ["pr", "merge", String(prNumber), "--auto", `--${method}`];
    if (deleteBranch) args.push("--delete-branch");
    const result = this.executor(GH_AXI_COMMAND, args, { cwd: this.repository, timeoutMs: this.timeoutMs });
    if (result.timeout || result.status !== 0) throw providerError("PROVIDER_UNAVAILABLE", result);
    return { provider: "github", command: [GH_AXI_COMMAND, ...args], status: "AUTO_MERGE_REQUESTED", response_digest: digest(result.stdout ?? result), branch_protection: protection, remote: result.stdout ?? result };
  }
}

export function normalizeCiEvent(input = {}) {
  const identity = input.identity ?? {
    pr_id: input.pr_id ?? input.pull_request_id ?? null,
    commit_sha: input.commit_sha ?? input.sha ?? input.head_sha ?? null,
    workflow_id: input.workflow_id ?? input.workflow ?? null,
    report_digest: input.report_digest ?? input.digest ?? null,
  };
  const conclusion = String(input.conclusion ?? input.status ?? "").toUpperCase();
  const status = ["SUCCESS", "PASSED", "PASS", "COMPLETED"].includes(conclusion) ? "CI_PASSED" : ["FAILURE", "FAILED", "FAIL", "CANCELLED"].includes(conclusion) ? "CI_FAILED" : "CI_PENDING";
  return { provider: input.provider ?? "github", event_type: status, status, identity, workflow: input.workflow ?? input.workflow_id ?? null, report_digest: identity.report_digest, raw_digest: digest(input.raw ?? input) };
}

export function providerActionKey(event) {
  return digest({ provider: event.provider ?? "github", identity: event.identity ?? {}, status: event.status ?? event.event_type ?? "UNKNOWN" });
}

export function ingestProviderEvent(root, runId, event, { expectedIdentity = {}, now, actor = "hush", internal = false } = {}) {
  const normalized = event.event_type ? event : normalizeCiEvent(event);
  const identity = validateCiIdentity(normalized, expectedIdentity);
  const actionKey = providerActionKey(normalized);
  const state = replayRunState(root, runId);
  const existing = Object.values(state.entities.provider_event ?? {}).find((item) => item.action_key === actionKey);
  if (existing) return { status: "IDEMPOTENT", event: existing, action_key: actionKey };
  const eventId = `PROVIDER-${actionKey.slice(-16)}`;
  if (!identity.valid) {
    const recorded = appendStateEvent(root, runId, { entity_type: "provider_event", entity_id: eventId, action: "rejected", action_key: actionKey, actor, cause: "CI_IDENTITY_MISMATCH", timestamp: now, data: { ...normalized, action_key: actionKey, status: "BLOCKED", errors: identity.errors, internal } });
    return { status: "BLOCKED", event: recorded, action_key: actionKey, errors: identity.errors };
  }
  const recorded = appendStateEvent(root, runId, { entity_type: "provider_event", entity_id: eventId, action: "received", action_key: actionKey, actor, cause: "provider-event", timestamp: now, data: { ...normalized, action_key: actionKey, internal } });
  return { status: normalized.status, event: recorded, action_key: actionKey };
}

export function deliverPullRequest(root, runId, event, { adapter, now, actor = "hush" } = {}) {
  if (!adapter || typeof adapter.createOrUpdatePr !== "function") throw providerError("DELIVERY_ADAPTER_REQUIRED");
  const payload = event.data?.payload ?? event.data;
  const result = adapter.createOrUpdatePr(payload, { prNumber: event.data?.pr_id ?? event.data?.pr_number });
  const prNumber = result.pr_number ?? event.data?.pr_id ?? event.data?.pr_number ?? null;
  if (!prNumber) throw providerError("PR_ID_UNRESOLVED", { error: "provider response did not identify the pull request", response_digest: result.response_digest });
  const recorded = appendStateEvent(root, runId, {
    entity_type: "delivery",
    entity_id: event.data?.delivery_id ?? `PR-${runId}-${prNumber ?? event.entity_id}`,
    action: "pr-created",
    actor,
    cause: event.event_id,
    timestamp: now ?? event.timestamp,
    data: { status: "PR_OPEN", event_type: "PR_CREATED", provider: result.provider, pr_id: prNumber, payload_digest: payload.payload_digest ?? null, response_digest: result.response_digest, command: result.command, remote: result.remote ?? null, target: event.data?.target ?? payload.base ?? "main", repository: event.data?.repository ?? adapter.repository ?? null, expected_identity: event.data?.expected_identity ?? {}, auto_merge_policy: event.data?.auto_merge_policy ?? null },
  });
  return { ...result, event: recorded, pr_id: prNumber };
}

export function pollPullRequestCi(root, runId, event, { adapter, now, actor = "hush" } = {}) {
  if (!adapter || typeof adapter.readCi !== "function") throw providerError("DELIVERY_ADAPTER_REQUIRED");
  const prNumber = event.data?.pr_id ?? event.data?.pr_number;
  if (!prNumber) throw providerError("PR_ID_REQUIRED");
  const result = adapter.readCi(prNumber);
  const provider = ingestProviderEvent(root, runId, result, { expectedIdentity: event.data?.expected_identity ?? {}, now, actor, internal: true });
  const action = result.status === "CI_PASSED" ? "ci-passed" : result.status === "CI_FAILED" ? "ci-failed" : "ci-pending";
  const recorded = appendStateEvent(root, runId, {
    entity_type: "delivery",
    entity_id: `PR-${runId}-${prNumber}`,
    action,
    actor,
    cause: event.event_id,
    timestamp: now ?? event.timestamp,
    data: { status: result.status, event_type: result.event_type, internal: true, pr_id: String(prNumber), identity: result.identity, provider_event_id: provider.event?.event_id ?? null, report_digest: result.report_digest ?? null, auto_merge_policy: event.data?.auto_merge_policy ?? null },
  });
  return { ...result, provider, event: recorded };
}

export function requestAutoMerge(root, runId, event, { adapter, now, actor = "hush" } = {}) {
  if (!adapter || typeof adapter.mergePr !== "function") throw providerError("DELIVERY_ADAPTER_REQUIRED");
  const prNumber = event.data?.pr_id ?? event.data?.pr_number;
  if (!prNumber) throw providerError("PR_ID_REQUIRED");
  const policy = { ...(event.data?.auto_merge_policy ?? {}), ci_passed: true, target: event.data?.target ?? event.data?.auto_merge_policy?.target ?? "main" };
  const result = adapter.mergePr(prNumber, policy, { root, runId, now, actor });
  const recorded = appendStateEvent(root, runId, {
    entity_type: "delivery",
    entity_id: `PR-${runId}-${prNumber}`,
    action: "merge-requested",
    actor,
    cause: event.event_id,
    timestamp: now ?? event.timestamp,
    data: { status: "MERGE_REQUESTED", pr_id: String(prNumber), response_digest: result.response_digest, branch_protection: result.branch_protection, command: result.command },
  });
  return { ...result, event: recorded };
}

export function recordBranchProtectionEvidence(root, runId, protection, { prNumber, policy = {}, now, actor = "hush" } = {}) {
  const evidenceId = `BRANCH-PROTECTION-${digest({ repository: protection?.repository, branch: protection?.branch, policy_revision: protection?.policy_revision }).slice(-16)}`;
  return appendStateEvent(root, runId, {
    entity_type: "delivery",
    entity_id: evidenceId,
    action: "branch-protection-checked",
    actor,
    cause: `PR-${prNumber ?? "unknown"}`,
    timestamp: now,
    data: {
      status: protection?.status ?? "UNKNOWN",
      repository: protection?.repository ?? null,
      branch: protection?.branch ?? null,
      pr_id: prNumber ?? null,
      policy_revision: protection?.policy_revision ?? null,
      response_digest: protection?.response_digest ?? null,
      checked_at: protection?.checked_at ?? null,
      expected_policy_revision: policy.expected_policy_revision ?? policy.expectedPolicyRevision ?? null,
      required_status_checks: protection?.required_status_checks ?? null,
      required_pull_request_reviews: protection?.required_pull_request_reviews ?? null,
      enforce_admins: protection?.enforce_admins ?? null,
      restrictions: protection?.restrictions ?? null,
      reason: protection?.reason ?? null,
    },
  });
}

export function validateCiIdentity(event, expected = {}) {
  const actual = event?.identity ?? {};
  const fields = ["pr_id", "commit_sha", "workflow_id", "report_digest"];
  const errors = [];
  for (const field of fields) if (expected[field] !== undefined && actual[field] !== expected[field]) errors.push(`${field} identity mismatch`);
  for (const field of fields) if (!actual[field]) errors.push(`${field} identity is required`);
  return errors.length ? { valid: false, errors } : { valid: true };
}

export function canAutoMerge(input = {}) {
  const errors = [];
  if (input.branch_protection?.status !== "PROTECTED") errors.push(`live protected-main verification is required${input.branch_protection?.reason ? `: ${input.branch_protection.reason}` : ""}`);
  if ((input.target ?? input.target_branch) !== "main") errors.push("target must be main");
  if (input.local_acceptance !== true && input.localAcceptance !== true) errors.push("local acceptance is required");
  if (input.puck_verified !== true && input.puckVerified !== true) errors.push("Puck verification is required");
  if ((input.vera_required === true || input.veraRequired === true) && input.vera_aligned !== true && input.veraAligned !== true) errors.push("Vera alignment is required");
  if (input.evidence_complete !== true && input.evidenceComplete !== true) errors.push("complete evidence is required");
  if (input.ci_passed !== true && input.ciPassed !== true) errors.push("passing CI is required");
  return errors.length ? { allowed: false, reason: errors.join("; "), errors } : { allowed: true, reason: "all protected-main gates pass" };
}

export function providerError(code, result = {}) { const error = new Error(`${code}: ${result.stderr ?? result.error ?? "provider request failed"}`); error.code = code; error.result = result; return error; }
function defaultExecutor(command, args, options) { return spawnSync(command, args, { ...options, encoding: "utf8" }); }
function normalizeRepositorySlug(value) { return typeof value === "string" && /^[^/\s]+\/[^/\s]+$/.test(value) ? value : null; }
function normalizeBranchProtection(raw, { repository, branch, request, checkedAt }) {
  const expectedUrl = `https://api.github.com/repos/${repository}/branches/${encodeURIComponent(branch)}/protection`;
  const responseMatchesRequest = typeof raw?.url === "string" && (raw.url === expectedUrl || raw.url.endsWith(`/repos/${repository}/branches/${encodeURIComponent(branch)}/protection`));
  const normalized = {
    repository,
    branch,
    status: responseMatchesRequest ? "PROTECTED" : "AMBIGUOUS",
    required_status_checks: raw?.required_status_checks ?? null,
    required_pull_request_reviews: raw?.required_pull_request_reviews ?? null,
    enforce_admins: raw?.enforce_admins ?? null,
    restrictions: raw?.restrictions ?? null,
    required_linear_history: raw?.required_linear_history ?? null,
    allow_force_pushes: raw?.allow_force_pushes ?? null,
    allow_deletions: raw?.allow_deletions ?? null,
    url: raw?.url ?? null,
    reason: responseMatchesRequest ? null : "branch protection response identity is ambiguous",
    request,
    checked_at: checkedAt,
  };
  return { ...normalized, policy_revision: digest({ ...normalized, checked_at: undefined }) };
}
function normalizeCheck(check) { return { id: typeof check === "string" ? check : check.id ?? check.check_id ?? check.command ?? "check", status: typeof check === "string" ? "PASS" : check.status ?? (check.exit_status === 0 ? "PASS" : "FAIL") }; }
function normalizeEvidence(item) { return typeof item === "string" ? { id: item, digest: null } : { id: item.id ?? item.evidence_id ?? item.report_id ?? "evidence", digest: item.digest ?? item.report_digest ?? item.artifact_digest ?? null }; }
function normalizeFinding(finding) { return { id: finding.id ?? finding.finding_id ?? "finding", cause: finding.cause ?? finding.primary_cause ?? "UNKNOWN" }; }
function pullRequestNumber(value) {
  if (value && typeof value === "object" && Number.isInteger(value.number)) return value.number;
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const match = text.match(/(?:pull|pulls)\/(\d+)|#(\d+)/i);
  return match ? Number(match[1] ?? match[2]) : null;
}
