import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const SAFE_VALUES = new Set(["disabled", "ephemeral-test-only", "fake-only", "sink-only", "generated", "none"]);
export const HAZARD_CATEGORIES = Object.freeze(["database", "credentials", "email", "webhooks", "uploads", "network"]);
const HAZARD_STATUSES = new Set(["MITIGATED"]);
const HAZARD_POLICIES = new Map([
  ["database", new Set(["ephemeral-test-only", "disabled"])],
  ["credentials", new Set(["fake-only", "none"])],
  ["email", new Set(["sink-only", "disabled"])],
  ["webhooks", new Set(["disabled"])],
  ["uploads", new Set(["disabled", "ephemeral-test-only"])],
  ["network", new Set(["disabled"])],
]);

export function validateHazardRecord(record, context = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return { valid: false, errors: ["hazard record must be an object"] };
  const errors = [];
  for (const field of ["hazard_id", "repository", "category", "policy", "status", "evidence"]) if (typeof record[field] !== "string" || record[field].length === 0) errors.push(`${field} is required`);
  if (!HAZARD_CATEGORIES.includes(record.category)) errors.push("category is unsupported");
  if (!HAZARD_STATUSES.has(record.status)) errors.push("status must be MITIGATED");
  if (record.category && record.policy && !HAZARD_POLICIES.get(record.category)?.has(record.policy)) errors.push("policy is not a safe value for category");
  if (context.repository && record.repository !== repositoryIdentity(context.repository)) errors.push("repository does not match inventory repository");
  if (record.revision !== undefined && (!Number.isInteger(record.revision) || record.revision < 1)) errors.push("revision must be a positive integer");
  if (record.record_digest && record.record_digest !== computeHazardDigest(record)) errors.push("record_digest mismatch");
  return errors.length ? { valid: false, errors } : { valid: true };
}

export function computeHazardDigest(record) {
  const copy = { ...record };
  delete copy.record_digest;
  return `sha256:${createHash("sha256").update(canonical(copy), "utf8").digest("hex")}`;
}

export function repositoryIdentity(repository) { return createHash("sha256").update(realpathSync(resolve(repository)), "utf8").digest("hex").slice(0, 16); }
export function hazardInventoryPath(root, repository) { return resolve(root, ".hush", "hazards", repositoryIdentity(repository), "events.jsonl"); }

export function persistHazardRecord(root, repository, record, { timestamp = new Date().toISOString(), actor = "hush" } = {}) {
  const validation = validateHazardRecord(record);
  if (!validation.valid) throw new Error(`INVALID_HAZARD_RECORD: ${validation.errors.join("; ")}`);
  const events = readHazardEvents(root, repository);
  const prior = events.filter((event) => event.hazard_id === record.hazard_id).at(-1);
  const next = { ...record, repository: repositoryIdentity(repository), revision: (prior?.revision ?? 0) + 1 };
  next.record_digest = computeHazardDigest(next);
  const event = { event_id: `HAZ-EVT-${String(events.length + 1).padStart(6, "0")}`, hazard_id: next.hazard_id, revision: next.revision, prior_revision: prior?.revision ?? null, timestamp, actor, cause: "hazard-inventory-observation", data: next };
  const path = hazardInventoryPath(root, repository);
  mkdirSync(resolve(path, ".."), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export function persistHazardInventory(root, repository, records, options = {}) {
  const validation = validateHazardInventory(records);
  if (!validation.valid) throw new Error(`INVALID_HAZARD_INVENTORY: ${validation.errors.join("; ")}`);
  return records.map((record) => persistHazardRecord(root, repository, record, options));
}

export function readHazardInventory(root, repository) {
  const latest = new Map();
  for (const event of readHazardEvents(root, repository)) latest.set(event.hazard_id, event.data);
  return [...latest.values()];
}

export function validateHazardInventory(records) {
  if (!Array.isArray(records)) return { valid: false, errors: ["hazards must be an array"] };
  const errors = [];
  const seen = new Set();
  for (const record of records) {
    const result = validateHazardRecord(record);
    if (!result.valid) errors.push(...result.errors);
    if (seen.has(record?.category)) errors.push(`duplicate hazard category: ${record.category}`);
    seen.add(record?.category);
  }
  for (const category of HAZARD_CATEGORIES) if (!seen.has(category)) errors.push(`missing hazard category: ${category}`);
  return errors.length ? { valid: false, errors } : { valid: true };
}

export function validateEnvironment(environment, context = {}) {
  const findings = [];
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) return blocked("missing-policy", "environment");
  for (const field of ["network", "database", "credentials", "email", "webhooks", "uploads", "test_data", "cleanup", "hazards"]) if (!Object.hasOwn(environment, field)) findings.push(finding("missing-policy", field));
  if (!Array.isArray(environment.cleanup)) findings.push(finding("invalid-cleanup", "cleanup"));
  if (environment.credentials && !["fake-only", "none"].includes(environment.credentials)) findings.push(finding("non-fake-credentials", "credentials", environment.credentials));
  for (const field of ["network", "database", "credentials", "email", "webhooks", "uploads", "test_data"]) if (environment[field] && !SAFE_VALUES.has(environment[field])) findings.push(finding("unsafe-value", field, environment[field]));
  if (environment.credentials === "production" || environment.database === "production" || environment.network === "live") findings.push(finding("live-side-effect", "environment"));
  const inventory = validateHazardInventory(environment.hazards);
  if (!inventory.valid) for (const error of inventory.errors) findings.push(finding("hazard-inventory-invalid", "hazards", error));
  for (const hazard of environment.hazards ?? []) if (environment[hazard.category] !== hazard.policy) findings.push(finding("hazard-policy-contradiction", hazard.category, { expected: environment[hazard.category], actual: hazard.policy }));
  if (context.root && context.repository) {
    const persisted = readHazardInventory(context.root, context.repository);
    const persistedByCategory = new Map(persisted.map((record) => [record.category, record]));
    for (const hazard of environment.hazards ?? []) {
      const stored = persistedByCategory.get(hazard.category);
      if (!stored || stored.policy !== hazard.policy || stored.status !== hazard.status) findings.push(finding("hazard-inventory-missing-or-stale", hazard.category));
    }
  }
  if (environment.override?.allowed && !context.humanDecisionId) findings.push(finding("unauthorized-override", "override"));
  return { status: findings.some((item) => item.severity === "HARD_BLOCK") ? "BLOCKED" : "SAFE", findings };
}

export function preflightEnvironment(environment, context = {}) {
  const result = validateEnvironment(environment, context);
  return { ...result, checked_at: context.checkedAt ?? new Date().toISOString(), boot_allowed: result.status === "SAFE" };
}

function readHazardEvents(root, repository) {
  try { return readFileSync(hazardInventoryPath(root, repository), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}
function canonical(value) { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; }
function finding(type, field, detail = null) { return { type, field, detail, severity: "HARD_BLOCK" }; }
function blocked(type, field) { return { status: "BLOCKED", findings: [finding(type, field)] }; }
