import { createHash } from "node:crypto";

const PHASES = new Set(["PRE_INTEGRATION", "TARGETED_FINAL"]);
const GATES = new Set(["PUCK", "VERA"]);
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function computeReportDigest(report) { const copy = { ...report }; delete copy.report_digest; return `sha256:${createHash("sha256").update(canonical(copy), "utf8").digest("hex")}`; }

export function validateGateReport(report, packet, snapshot, options = {}) {
  const errors = [];
  for (const field of ["report_id", "report_digest", "gate", "phase", "packet_id", "source_manifest_digest", "candidate_id", "candidate_tree_digest", "candidate_diff_digest", "snapshot_id", "gate_run_id", "verdict", "created_by"]) if (!report?.[field]) errors.push(`${field} is required`);
  if (!GATES.has(report?.gate)) errors.push("gate must be PUCK or VERA");
  if (!PHASES.has(report?.phase)) errors.push("phase must be PRE_INTEGRATION or TARGETED_FINAL");
  if (packet && (report?.packet_id !== packet.packet_id || report?.source_manifest_digest !== packet.source_refs?.[0]?.manifest_digest)) errors.push("packet/source binding mismatch");
  if (snapshot && (report?.snapshot_id !== snapshot.snapshot_id || report?.candidate_tree_digest !== snapshot.tree_digest || report?.candidate_diff_digest !== snapshot.diff_digest)) errors.push("snapshot binding mismatch");
  if (options.candidate?.patch_digest && report?.candidate_patch_digest !== options.candidate.patch_digest) errors.push("candidate patch binding mismatch");
  if (report?.report_digest !== computeReportDigest(report)) errors.push("report digest mismatch");
  return errors.length ? { valid: false, errors } : { valid: true };
}

export function validateCheckCoverage(packet, report) {
  const errors = [];
  const writePaths = packet?.write_paths ?? [];
  if (!Array.isArray(writePaths) || writePaths.length === 0) return { valid: false, errors: ["packet write_paths are required"] };
  const checks = packet.acceptance_checks ?? [];
  const results = report?.check_results ?? [];
  const resultById = new Map(results.map((result) => [result.check_id, result]));
  const covered = new Set();
  for (const check of checks) {
    if (!Array.isArray(check.write_paths) || check.write_paths.length === 0) errors.push(`${check.check_id} must declare explicit write_paths`);
    for (const path of check.write_paths ?? []) {
      if (!writePaths.includes(path)) errors.push(`${check.check_id} covers undeclared write path: ${path}`);
      covered.add(path);
    }
    const result = resultById.get(check.check_id);
    if (!result) { errors.push(`missing evidence result for ${check.check_id}`); continue; }
    if (result.status !== "PASS" || result.exit_status !== 0) errors.push(`${check.check_id} evidence did not pass`);
    if (!result.artifact_id || !result.artifact_path || !DIGEST.test(result.artifact_digest ?? "")) errors.push(`${check.check_id} evidence artifact binding is incomplete`);
    if (!Array.isArray(result.write_paths) || !check.write_paths.every((path) => result.write_paths.includes(path))) errors.push(`${check.check_id} evidence write-path binding is incomplete`);
  }
  for (const path of writePaths) if (!covered.has(path)) errors.push(`no acceptance check covers write path: ${path}`);
  return errors.length ? { valid: false, errors } : { valid: true };
}

export function validateAcceptance({ packet, snapshot, candidate, puck, vera, required = packet?.vera_required }) {
  const errors = [];
  if (!packet || !snapshot || snapshot.frozen !== true && snapshot.state !== "FROZEN") errors.push("packet and frozen snapshot are required");
  const puckResult = validateGateReport(puck, packet, snapshot, { candidate });
  if (!puckResult.valid || puck?.gate !== "PUCK" || puck?.verdict !== "PASS") errors.push("passing Puck report is required");
  const coverage = validateCheckCoverage(packet, puck);
  if (!coverage.valid) errors.push(...coverage.errors);
  if (required) {
    const veraResult = validateGateReport(vera, packet, snapshot, { candidate });
    if (!veraResult.valid || vera?.gate !== "VERA" || vera?.verdict !== "PASS") errors.push("passing Vera report is required");
  }
  return errors.length ? { valid: false, errors } : { valid: true };
}

function canonical(value) { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; }
