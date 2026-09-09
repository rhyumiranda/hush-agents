import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const HASHLINE_VERSION = "1";

function normalizedText(text) {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function splitLines(text) {
  const normalized = normalizedText(text);
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function digest(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function lineHash(line) {
  return createHash("sha256").update(line.trimEnd()).digest("hex").slice(0, 4);
}

export function anchorFor(lineNumber, line) {
  return `${lineNumber}:${lineHash(line)}`;
}

export function parseAnchor(anchor) {
  if (typeof anchor !== "string") throw new Error("anchor must be a string");
  const match = /^(\d+):([0-9a-f]{4})$/.exec(anchor);
  if (!match) throw new Error(`invalid anchor: ${anchor}`);
  return { lineNumber: Number(match[1]), hash: match[2] };
}

export function readHashline(filePath) {
  const text = normalizedText(readFileSync(filePath, "utf8"));
  const lines = splitLines(text).map((content, index) => ({
    line: index + 1,
    hash: lineHash(content),
    content,
    anchor: anchorFor(index + 1, content),
  }));

  return {
    version: HASHLINE_VERSION,
    path: filePath,
    file_sha256: digest(text),
    lines,
  };
}

function resolveAnchor(snapshot, anchor) {
  const parsed = parseAnchor(anchor);
  const exact = snapshot.lines[parsed.lineNumber - 1];
  if (exact?.hash === parsed.hash) return exact.line - 1;

  const matches = snapshot.lines.filter((line) => line.hash === parsed.hash);
  if (matches.length === 1) return matches[0].line - 1;
  if (matches.length > 1) throw new Error(`ambiguous anchor: ${anchor}`);
  throw new Error(`stale anchor: ${anchor}`);
}

function linesFromOperation(operation) {
  if (!Array.isArray(operation.lines) || operation.lines.some((line) => typeof line !== "string")) {
    throw new Error("operation.lines must be an array of strings");
  }
  return operation.lines;
}

function operationRange(snapshot, operation) {
  const start = resolveAnchor(snapshot, operation.start ?? operation.anchor);
  const end = resolveAnchor(snapshot, operation.end ?? operation.start ?? operation.anchor);
  if (end < start) throw new Error("operation end must not precede start");
  return { start, end };
}

export function applyHashline(filePath, patch, { dryRun = false } = {}) {
  const snapshot = readHashline(filePath);
  if (patch.version !== HASHLINE_VERSION) throw new Error("unsupported hashline patch version");
  if (patch.file_sha256 !== snapshot.file_sha256) throw new Error("stale file: reread before editing");
  if (!Array.isArray(patch.operations) || patch.operations.length === 0) {
    throw new Error("operations must be a non-empty array");
  }

  const changes = patch.operations.map((operation) => {
    const op = operation.op;
    if (!["replace", "delete", "insert_before", "insert_after"].includes(op)) {
      throw new Error(`unsupported operation: ${op}`);
    }
    const range = operationRange(snapshot, operation);
    const lines = linesFromOperation(operation);
    return { op, ...range, lines };
  });

  const overlaps = [...changes].sort((a, b) => a.start - b.start).some((change, index, sorted) => {
    const previous = sorted[index - 1];
    return previous && change.start <= previous.end;
  });
  if (overlaps) throw new Error("overlapping operations are not allowed");

  const nextLines = snapshot.lines.map((line) => line.content);
  for (const change of [...changes].sort((a, b) => b.start - a.start)) {
    if (change.op === "replace") nextLines.splice(change.start, change.end - change.start + 1, ...change.lines);
    if (change.op === "delete") nextLines.splice(change.start, change.end - change.start + 1);
    if (change.op === "insert_before") nextLines.splice(change.start, 0, ...change.lines);
    if (change.op === "insert_after") nextLines.splice(change.end + 1, 0, ...change.lines);
  }

  const nextText = nextLines.length === 0 ? "" : `${nextLines.join("\n")}\n`;
  const result = {
    version: HASHLINE_VERSION,
    path: filePath,
    before_sha256: snapshot.file_sha256,
    after_sha256: digest(nextText),
    operations: changes.length,
    dry_run: dryRun,
  };
  if (!dryRun) writeFileSync(filePath, nextText);
  return result;
}
