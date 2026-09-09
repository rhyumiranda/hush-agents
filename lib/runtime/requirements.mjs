import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
const APPROVAL_STATES = new Set(["DRAFT", "APPROVED", "SUPERSEDED", "REJECTED"]);
const BASELINE_STATES = new Set(["PROVEN", "REPORTED", "UNKNOWN"]);
const ENUMERATION_STATES = new Set(["EXHAUSTIVE", "ILLUSTRATIVE"]);
const SOURCE_VERIFICATION_STATES = new Set(["VERIFIED"]);

export function validateRequirementRecord(record, options = {}) {
  if (!record || typeof record !== "object") return issue("$", "must be an object");
  for (const field of ["requirement_id", "revision", "source", "quote", "expected_behavior", "actor", "permissions", "baseline_status", "enumeration_status", "approval_state", "unknowns", "source_discovery", "quote_back"]) if (!Object.hasOwn(record, field)) return issue(field, "is required");
  if (!Number.isInteger(record.revision) || record.revision < 1) return issue("revision", "must be a positive integer");
  if (!APPROVAL_STATES.has(record.approval_state)) return issue("approval_state", "must be a known approval state");
  if (!BASELINE_STATES.has(record.baseline_status)) return issue("baseline_status", "must be PROVEN, REPORTED, or UNKNOWN");
  if (!ENUMERATION_STATES.has(record.enumeration_status)) return issue("enumeration_status", "must be EXHAUSTIVE or ILLUSTRATIVE");
  if (!Array.isArray(record.unknowns)) return issue("unknowns", "must be an array");
  if (!record.source?.path || !record.source?.location || !record.source?.digest) return issue("source", "requires path, location, and digest");
  if (!/^sha256:[a-f0-9]{64}$/.test(record.source.digest)) return issue("source.digest", "must be a sha256 digest");
  if (typeof record.quote !== "string" || record.quote.length === 0) return issue("quote", "must be a non-empty source quote");
  const discoveryError = validateSourceDiscovery(record);
  if (discoveryError) return discoveryError;
  const quoteBackError = validateQuoteBack(record);
  if (quoteBackError) return quoteBackError;
  if (options.sourceText !== undefined) {
    const verified = validateSourceQuote({ sourceText: options.sourceText, quote: record.quote, location: record.source.location, digest: record.source.digest });
    if (!verified.valid) return issue("quote", verified.reason, { actualDigest: verified.actualDigest });
  } else if (options.root) {
    const source = discoverRequirementSource(record, options);
    if (!source.valid) return issue("source", source.reason, source);
  }
  return null;
}
export function hasBlockingUnknowns(record) { return Array.isArray(record?.unknowns) && record.unknowns.some((unknown) => typeof unknown === "string" ? unknown.length > 0 : unknown?.blocking === true); }
export function validateSourceQuote({ sourceText, quote, location, digest }) { const actualDigest = `sha256:${createHash("sha256").update(sourceText, "utf8").digest("hex")}`; if (actualDigest !== digest) return { valid: false, reason: "source digest mismatch", actualDigest }; if (!sourceText.includes(quote)) return { valid: false, reason: "quote is not an exact source substring" }; if (!location || typeof location !== "string") return { valid: false, reason: "source location is required" }; return { valid: true, actualDigest }; }
export function discoverRequirementSource(record, { root = ".", sourceText } = {}) {
  if (sourceText !== undefined) return validateSourceQuote({ sourceText, quote: record.quote, location: record.source.location, digest: record.source.digest });
  try {
    const repositoryRoot = realpathSync(resolve(root));
    const sourcePath = resolve(repositoryRoot, record.source.path);
    const relativePath = relative(repositoryRoot, sourcePath);
    if (isAbsolute(relativePath) || relativePath.startsWith("..")) return { valid: false, reason: "source path escapes repository root" };
    const text = readFileSync(sourcePath, "utf8");
    return validateSourceQuote({ sourceText: text, quote: record.quote, location: record.source.location, digest: record.source.digest });
  } catch (error) {
    return { valid: false, reason: `source discovery failed: ${error.message}` };
  }
}

function validateSourceDiscovery(record) {
  const discovery = record.source_discovery;
  if (!discovery || typeof discovery !== "object" || Array.isArray(discovery)) return issue("source_discovery", "must be an object");
  for (const field of ["method", "path", "location", "digest", "status"]) if (typeof discovery[field] !== "string" || discovery[field].length === 0) return issue(`source_discovery.${field}`, "must be a non-empty string");
  if (!SOURCE_VERIFICATION_STATES.has(discovery.status)) return issue("source_discovery.status", "must be VERIFIED");
  if (discovery.path !== record.source.path || discovery.location !== record.source.location || discovery.digest !== record.source.digest) return issue("source_discovery", "must match source path, location, and digest");
  if (!/^sha256:[a-f0-9]{64}$/.test(discovery.digest)) return issue("source_discovery.digest", "must be a sha256 digest");
  return null;
}

function validateQuoteBack(record) {
  const quoteBack = record.quote_back;
  if (!quoteBack || typeof quoteBack !== "object" || Array.isArray(quoteBack)) return issue("quote_back", "must be an object");
  if (quoteBack.verified !== true) return issue("quote_back.verified", "must be true");
  if (quoteBack.quote !== record.quote) return issue("quote_back.quote", "must exactly match quote");
  if (quoteBack.location !== record.source.location) return issue("quote_back.location", "must match source location");
  if (quoteBack.digest !== record.source.digest) return issue("quote_back.digest", "must match source digest");
  return null;
}
function issue(field, rule) { return { field, rule }; }
