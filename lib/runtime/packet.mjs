import { createHash } from "node:crypto";

import { validateEnvironment } from "./environment.mjs";

export const PACKET_STATUS = Object.freeze({
  VALID: "VALID", INVALID_SHAPE: "INVALID_SHAPE", INVALID_DIGEST: "INVALID_DIGEST", EXPIRED: "EXPIRED",
  SUPERSEDED: "SUPERSEDED", WRONG_BASE: "WRONG_BASE", WRONG_AGENT: "WRONG_AGENT", OUT_OF_SCOPE: "OUT_OF_SCOPE",
  BLOCKED_DEPENDENCY: "BLOCKED_DEPENDENCY", BLOCKED_ENVIRONMENT: "BLOCKED_ENVIRONMENT",
});

export const REQUIRED_PACKET_FIELDS = Object.freeze([
  "contract_version", "run_id", "plan_id", "task_id", "packet_id", "packet_revision", "requirement_map_revision",
  "target_agent", "base_sha", "source_refs", "requirements", "allowed_paths", "write_paths", "allowed_operations", "blocked_paths",
  "exclusive_hubs", "dependencies", "required_commands", "acceptance_checks", "expected_evidence", "environment",
  "vera_required", "vera_trigger", "attempt", "strike_count", "expires_at", "supersedes", "packet_state", "digest",
]);

const ARRAY_FIELDS = new Set(["source_refs", "requirements", "allowed_paths", "write_paths", "allowed_operations", "blocked_paths", "exclusive_hubs", "dependencies", "required_commands", "acceptance_checks", "expected_evidence", "supersedes"]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HEX_SHA_PATTERN = /^[a-f0-9]{40,64}$/;
const OPERATIONS = new Set(["read", "create", "edit", "modify", "delete", "rename", "test"]);

export function canonicalJson(value) { return serializeCanonical(value, { omitDigest: false }); }
export function canonicalPacketJson(packet) { return serializeCanonical(packet, { omitDigest: true }); }
export function computePacketDigest(packet) { return `sha256:${createHash("sha256").update(canonicalPacketJson(packet), "utf8").digest("hex")}`; }
export function sealPacket(packet) { const next = { ...packet }; delete next.digest; return { ...next, digest: computePacketDigest(next) }; }

export function validatePacket(packet, options = {}) {
  const shapeError = validatePacketShape(packet);
  if (shapeError) return invalid(PACKET_STATUS.INVALID_SHAPE, shapeError);
  const expectedDigest = computePacketDigest(packet);
  if (packet.digest !== expectedDigest) return invalid(PACKET_STATUS.INVALID_DIGEST, "digest", { expected: expectedDigest, actual: packet.digest });
  if (isExpired(packet, options.now)) return invalid(PACKET_STATUS.EXPIRED, "expires_at", { expires_at: packet.expires_at });
  if (packet.packet_state === "SUPERSEDED" || isSuperseded(packet, options)) return invalid(PACKET_STATUS.SUPERSEDED, "packet_id");
  if (options.currentBaseSha && packet.base_sha !== options.currentBaseSha) return invalid(PACKET_STATUS.WRONG_BASE, "base_sha", { expected: packet.base_sha, actual: options.currentBaseSha });
  if (options.targetAgent && packet.target_agent !== options.targetAgent) return invalid(PACKET_STATUS.WRONG_AGENT, "target_agent", { expected: packet.target_agent, actual: options.targetAgent });
  const scopeError = validateScope(packet, options.changedPaths);
  if (scopeError) return scopeError;
  const blockedDependency = findBlockedDependency(options.dependencies ?? packet.dependencies);
  if (blockedDependency) return invalid(PACKET_STATUS.BLOCKED_DEPENDENCY, "dependencies", { dependency: blockedDependency });
  const environment = validateEnvironment(packet.environment, { ...(options.environment ?? {}), root: options.root, repository: options.repository });
  if (environment.status !== "SAFE") return invalid(PACKET_STATUS.BLOCKED_ENVIRONMENT, "environment", { findings: environment.findings });
  return { status: PACKET_STATUS.VALID };
}

export function validatePacketShape(packet) {
  if (!isPlainObject(packet)) return { field: "$", rule: "must be an object" };
  for (const field of REQUIRED_PACKET_FIELDS) if (!Object.hasOwn(packet, field)) return { field, rule: "is required" };
  if (packet.contract_version !== "hec.v1") return { field: "contract_version", rule: "must be hec.v1" };
  for (const field of ["run_id", "plan_id", "task_id", "packet_id", "target_agent", "base_sha", "digest"]) if (typeof packet[field] !== "string" || packet[field].length === 0) return { field, rule: "must be a non-empty string" };
  for (const field of ["packet_revision", "requirement_map_revision", "attempt"]) if (!Number.isInteger(packet[field]) || packet[field] < 1) return { field, rule: "must be a positive integer" };
  if (!Number.isInteger(packet.strike_count) || packet.strike_count < 0) return { field: "strike_count", rule: "must be a non-negative integer" };
  if (!HEX_SHA_PATTERN.test(packet.base_sha)) return { field: "base_sha", rule: "must be a hex git SHA" };
  if (!DIGEST_PATTERN.test(packet.digest)) return { field: "digest", rule: "must be sha256:<64 lowercase hex chars>" };
  if (typeof packet.vera_required !== "boolean") return { field: "vera_required", rule: "must be a boolean" };
  if (packet.vera_required && (typeof packet.vera_trigger !== "string" || packet.vera_trigger.length === 0)) return { field: "vera_trigger", rule: "is required when vera_required is true" };
  if (packet.vera_trigger !== null && typeof packet.vera_trigger !== "string") return { field: "vera_trigger", rule: "must be null or a non-empty string" };
  if (!["ACTIVE", "SUPERSEDED"].includes(packet.packet_state)) return { field: "packet_state", rule: "must be ACTIVE or SUPERSEDED" };
  if (packet.expires_at !== null && (typeof packet.expires_at !== "string" || Number.isNaN(Date.parse(packet.expires_at)))) return { field: "expires_at", rule: "must be null or an ISO date string" };
  for (const field of ARRAY_FIELDS) {
    if (!Array.isArray(packet[field])) return { field, rule: "must be an array" };
    if (!["source_refs", "acceptance_checks"].includes(field) && packet[field].some((item) => typeof item !== "string" || item.length === 0)) return { field, rule: "must contain only non-empty strings" };
  }
  for (const field of ["requirements", "source_refs", "allowed_paths", "write_paths", "allowed_operations", "required_commands", "acceptance_checks", "expected_evidence"]) if (packet[field].length === 0) return { field, rule: "must not be empty" };
  if (packet.allowed_operations.some((operation) => !OPERATIONS.has(operation))) return { field: "allowed_operations", rule: "contains unsupported operation" };
  if (packet.write_paths.some((path) => !packet.allowed_paths.includes(path))) return { field: "write_paths", rule: "must be contained in allowed_paths" };
  for (const [index, source] of packet.source_refs.entries()) {
    if (!isPlainObject(source)) return { field: `source_refs[${index}]`, rule: "must be an object" };
    for (const key of ["snapshot_id", "manifest_digest", "location"]) if (typeof source[key] !== "string" || source[key].length === 0) return { field: `source_refs[${index}].${key}`, rule: "must be a non-empty string" };
    if (!DIGEST_PATTERN.test(source.manifest_digest)) return { field: `source_refs[${index}].manifest_digest`, rule: "must be a sha256 digest" };
  }
  for (const [index, check] of packet.acceptance_checks.entries()) {
    if (!isPlainObject(check)) return { field: `acceptance_checks[${index}]`, rule: "must be an object" };
    for (const key of ["check_id", "executor", "command", "expected_result", "evidence_artifact_id"]) if (typeof check[key] !== "string" || check[key].length === 0) return { field: `acceptance_checks[${index}].${key}`, rule: "must be a non-empty string" };
    if (!Array.isArray(check.requirement_ids) || check.requirement_ids.length === 0) return { field: `acceptance_checks[${index}].requirement_ids`, rule: "must be a non-empty array" };
    if (!Array.isArray(check.write_paths) || check.write_paths.length === 0) return { field: `acceptance_checks[${index}].write_paths`, rule: "must be a non-empty array" };
    if (check.write_paths.some((path) => !packet.write_paths.includes(path))) return { field: `acceptance_checks[${index}].write_paths`, rule: "must be contained in packet.write_paths" };
  }
  return null;
}

function serializeCanonical(value, options) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => serializeCanonical(item, options)).join(",")}]`;
  if (!isPlainObject(value)) throw new TypeError("canonical JSON supports only plain objects, arrays, and JSON primitives");
  const keys = Object.keys(value).filter((key) => !(options.omitDigest && key === "digest")).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key], options)}`).join(",")}}`;
}
function isPlainObject(value) { return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype; }
function isSuperseded(packet, options) { return (options.activePacketIds && !new Set(options.activePacketIds).has(packet.packet_id)) || (options.supersededPacketIds && new Set(options.supersededPacketIds).has(packet.packet_id)) || packet.supersedes.includes(packet.packet_id); }
function isExpired(packet, now) { return packet.expires_at !== null && Date.parse(packet.expires_at) < (now === undefined ? Date.now() : new Date(now).getTime()); }
function validateScope(packet, changedPaths) {
  if (!changedPaths) return null;
  const allowed = new Set(packet.allowed_paths); const blocked = new Set(packet.blocked_paths);
  for (const path of changedPaths) { if (blocked.has(path)) return invalid(PACKET_STATUS.OUT_OF_SCOPE, "blocked_paths", { path }); if (!allowed.has(path)) return invalid(PACKET_STATUS.OUT_OF_SCOPE, "allowed_paths", { path }); }
  return null;
}
function findBlockedDependency(dependencies) {
  if (!dependencies) return null;
  if (Array.isArray(dependencies)) return dependencies.find((dependency) => (typeof dependency === "object" ? dependency.status : dependency) !== "VERIFIED") ?? null;
  for (const [id, status] of Object.entries(dependencies)) if (status !== "VERIFIED") return { id, status };
  return null;
}
function invalid(status, field, detail = {}) { return { status, issue: typeof field === "string" ? { field, rule: ruleForIssue(status, field), ...detail } : { rule: ruleForIssue(status, field.field), ...field } }; }
function ruleForIssue(status, field) {
  if (status === PACKET_STATUS.INVALID_DIGEST) return "must match canonical packet digest";
  if (status === PACKET_STATUS.EXPIRED) return "must not be expired";
  if (status === PACKET_STATUS.SUPERSEDED) return "must be active";
  if (status === PACKET_STATUS.WRONG_BASE) return "must match current base SHA";
  if (status === PACKET_STATUS.WRONG_AGENT) return "must match target agent";
  if (status === PACKET_STATUS.OUT_OF_SCOPE && field === "blocked_paths") return "must not include blocked paths";
  if (status === PACKET_STATUS.OUT_OF_SCOPE && field === "allowed_paths") return "must include only allowed paths";
  if (status === PACKET_STATUS.BLOCKED_DEPENDENCY) return "must have verified dependencies";
  if (status === PACKET_STATUS.BLOCKED_ENVIRONMENT) return "must pass environment preflight";
  return "must satisfy packet validation";
}
