import { createHash } from "node:crypto";

export const PACKET_STATUS = Object.freeze({
  VALID: "VALID",
  INVALID_SHAPE: "INVALID_SHAPE",
  INVALID_DIGEST: "INVALID_DIGEST",
  EXPIRED: "EXPIRED",
  SUPERSEDED: "SUPERSEDED",
  WRONG_BASE: "WRONG_BASE",
  WRONG_AGENT: "WRONG_AGENT",
  OUT_OF_SCOPE: "OUT_OF_SCOPE",
  BLOCKED_DEPENDENCY: "BLOCKED_DEPENDENCY",
});

export const REQUIRED_PACKET_FIELDS = Object.freeze([
  "run_id",
  "task_id",
  "packet_id",
  "packet_revision",
  "target_agent",
  "base_sha",
  "requirements",
  "allowed_paths",
  "allowed_operations",
  "blocked_paths",
  "required_commands",
  "expected_evidence",
  "vera_required",
  "expires_at",
  "supersedes",
  "digest",
]);

const ARRAY_FIELDS = new Set([
  "requirements",
  "allowed_paths",
  "allowed_operations",
  "blocked_paths",
  "required_commands",
  "expected_evidence",
  "supersedes",
]);

const STRING_FIELDS = new Set(["run_id", "task_id", "packet_id", "target_agent", "base_sha", "digest"]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HEX_SHA_PATTERN = /^[a-f0-9]{40,64}$/;

export function canonicalJson(value) {
  return serializeCanonical(value, { omitDigest: false });
}

export function canonicalPacketJson(packet) {
  return serializeCanonical(packet, { omitDigest: true });
}

export function computePacketDigest(packet) {
  return `sha256:${createHash("sha256").update(canonicalPacketJson(packet), "utf8").digest("hex")}`;
}

export function sealPacket(packet) {
  const nextPacket = { ...packet };
  delete nextPacket.digest;
  return { ...nextPacket, digest: computePacketDigest(nextPacket) };
}

export function validatePacket(packet, options = {}) {
  const shapeError = validatePacketShape(packet);
  if (shapeError) return invalid(PACKET_STATUS.INVALID_SHAPE, shapeError);

  const expectedDigest = computePacketDigest(packet);
  if (packet.digest !== expectedDigest) {
    return invalid(PACKET_STATUS.INVALID_DIGEST, "digest", {
      expected: expectedDigest,
      actual: packet.digest,
    });
  }

  if (isExpired(packet, options.now)) {
    return invalid(PACKET_STATUS.EXPIRED, "expires_at", {
      expires_at: packet.expires_at,
    });
  }

  if (isSuperseded(packet, options)) {
    return invalid(PACKET_STATUS.SUPERSEDED, "packet_id");
  }

  if (options.currentBaseSha && packet.base_sha !== options.currentBaseSha) {
    return invalid(PACKET_STATUS.WRONG_BASE, "base_sha", {
      expected: packet.base_sha,
      actual: options.currentBaseSha,
    });
  }

  if (options.targetAgent && packet.target_agent !== options.targetAgent) {
    return invalid(PACKET_STATUS.WRONG_AGENT, "target_agent", {
      expected: packet.target_agent,
      actual: options.targetAgent,
    });
  }

  const scopeError = validateScope(packet, options.changedPaths);
  if (scopeError) return scopeError;

  const blockedDependency = findBlockedDependency(options.dependencies);
  if (blockedDependency) {
    return invalid(PACKET_STATUS.BLOCKED_DEPENDENCY, "dependencies", {
      dependency: blockedDependency,
    });
  }

  return { status: PACKET_STATUS.VALID };
}

export function validatePacketShape(packet) {
  if (!isPlainObject(packet)) return { field: "$", rule: "must be an object" };

  for (const field of REQUIRED_PACKET_FIELDS) {
    if (!Object.hasOwn(packet, field)) return { field, rule: "is required" };
  }

  for (const field of STRING_FIELDS) {
    if (typeof packet[field] !== "string" || packet[field].length === 0) {
      return { field, rule: "must be a non-empty string" };
    }
  }

  if (!Number.isInteger(packet.packet_revision) || packet.packet_revision < 1) {
    return { field: "packet_revision", rule: "must be a positive integer" };
  }

  if (typeof packet.vera_required !== "boolean") {
    return { field: "vera_required", rule: "must be a boolean" };
  }

  if (packet.expires_at !== null && (typeof packet.expires_at !== "string" || Number.isNaN(Date.parse(packet.expires_at)))) {
    return { field: "expires_at", rule: "must be null or an ISO date string" };
  }

  if (!HEX_SHA_PATTERN.test(packet.base_sha)) {
    return { field: "base_sha", rule: "must be a hex git SHA" };
  }

  if (!DIGEST_PATTERN.test(packet.digest)) {
    return { field: "digest", rule: "must be sha256:<64 lowercase hex chars>" };
  }

  for (const field of ARRAY_FIELDS) {
    if (!Array.isArray(packet[field])) return { field, rule: "must be an array" };
    if (packet[field].some((item) => typeof item !== "string" || item.length === 0)) {
      return { field, rule: "must contain only non-empty strings" };
    }
  }

  if (packet.requirements.length === 0) return { field: "requirements", rule: "must not be empty" };
  if (packet.allowed_paths.length === 0) return { field: "allowed_paths", rule: "must not be empty" };
  if (packet.allowed_operations.length === 0) return { field: "allowed_operations", rule: "must not be empty" };
  if (packet.required_commands.length === 0) return { field: "required_commands", rule: "must not be empty" };

  for (const operation of packet.allowed_operations) {
    if (!["create", "edit", "modify", "delete", "rename"].includes(operation)) {
      return { field: "allowed_operations", rule: `unsupported operation ${operation}` };
    }
  }

  return null;
}

function serializeCanonical(value, options) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => serializeCanonical(item, options)).join(",")}]`;
  if (!isPlainObject(value)) throw new TypeError("canonical JSON supports only plain objects, arrays, and JSON primitives");

  const keys = Object.keys(value)
    .filter((key) => !(options.omitDigest && key === "digest"))
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key], options)}`).join(",")}}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function isSuperseded(packet, options) {
  if (options.activePacketIds && !toSet(options.activePacketIds).has(packet.packet_id)) return true;
  if (options.supersededPacketIds && toSet(options.supersededPacketIds).has(packet.packet_id)) return true;
  return packet.supersedes.includes(packet.packet_id);
}

function isExpired(packet, now) {
  if (packet.expires_at === null) return false;
  const nowMs = now === undefined ? Date.now() : new Date(now).getTime();
  return Date.parse(packet.expires_at) < nowMs;
}

function validateScope(packet, changedPaths) {
  if (!changedPaths) return null;
  const allowed = new Set(packet.allowed_paths);
  const blocked = new Set(packet.blocked_paths);

  for (const changedPath of changedPaths) {
    if (blocked.has(changedPath)) return invalid(PACKET_STATUS.OUT_OF_SCOPE, "blocked_paths", { path: changedPath });
    if (!allowed.has(changedPath)) return invalid(PACKET_STATUS.OUT_OF_SCOPE, "allowed_paths", { path: changedPath });
  }

  return null;
}

function findBlockedDependency(dependencies) {
  if (!dependencies) return null;
  if (Array.isArray(dependencies)) {
    return dependencies.find((dependency) => dependency && dependency.status && dependency.status !== "VERIFIED") ?? null;
  }
  for (const [id, status] of Object.entries(dependencies)) {
    if (status !== "VERIFIED") return { id, status };
  }
  return null;
}

function toSet(value) {
  return value instanceof Set ? value : new Set(value);
}

function invalid(status, field, detail = {}) {
  const issue = typeof field === "string" ? { field, ...detail } : field;
  return { status, issue };
}
