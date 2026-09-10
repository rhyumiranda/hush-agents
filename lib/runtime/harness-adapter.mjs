import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SUPPORTED_HARNESSES = Object.freeze(["codex", "claude", "gemini", "opencode"]);

export function buildHarnessInvocation({ harness, role, payload, outputPath, executable = harness, profileText = "", sandbox } = {}) {
  if (!SUPPORTED_HARNESSES.includes(harness)) throw new Error(`unsupported harness: ${harness}`);
  if (!role) throw new Error("agent role is required");
  const workdir = payload.worktree_path ?? payload.repository ?? process.cwd();
  const prompt = promptFor({ role, payload, profileText });
  const mode = sandbox ?? (role === "flint" ? "workspace-write" : "read-only");
  if (harness === "codex") {
    return { command: executable, args: ["exec", "--ephemeral", "--cd", workdir, "--sandbox", mode, "--output-last-message", outputPath, "-"], input: prompt };
  }
  if (harness === "claude") {
    return { command: executable, args: ["-p", "--agent", role, "--output-format", "json", "--no-session-persistence", "--permission-mode", mode === "read-only" ? "plan" : "dontAsk", "--add-dir", workdir, prompt], input: "" };
  }
  if (harness === "gemini") {
    return { command: executable, args: ["-p", prompt, "--output-format", "json", "--approval-mode", mode === "read-only" ? "plan" : "auto_edit", "--include-directories", workdir], input: "" };
  }
  return { command: executable, args: ["run", "--agent", role, "--format", "json", "--dir", workdir, prompt], input: "" };
}

export function parseHarnessOutput({ harness, stdout = "", outputText = "" } = {}) {
  const candidates = [outputText, ...jsonLines(stdout), stdout].filter((value) => typeof value === "string" && value.trim());
  for (const candidate of candidates) {
    for (const value of [candidate, unwrapJson(candidate)]) {
      const parsed = parseJson(value);
      if (parsed === undefined) continue;
      const structured = structuredValue(parsed, harness);
      if (structured && typeof structured === "object" && !Array.isArray(structured)) return structured;
    }
  }
  throw new Error(`${harness} adapter did not return one JSON object`);
}

export function loadBundledProfile(root, harness, role) {
  const profilePath = harness === "codex" ? join(root, "agents", `${role}.toml`) : join(root, "agents", harness, `${role}.md`);
  return existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "";
}

function promptFor({ role, payload, profileText }) {
  return [
    `Act as the Hush ${role} role.`,
    profileText ? `Follow this installed role profile exactly:\n${profileText}` : "Follow the installed role profile exactly.",
    "Read the Hush request below. Return exactly one JSON object and no markdown, commentary, progress output, or code fence.",
    "The JSON object must be the role's Hush adapter result. Hush independently validates it; do not claim acceptance.",
    `Hush request JSON:\n${JSON.stringify(payload)}`,
  ].join("\n\n");
}

function jsonLines(value) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function parseJson(value) {
  try { return JSON.parse(value.trim()); } catch { return undefined; }
}

function unwrapJson(value) {
  const text = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (text !== value.trim()) return text;
  const start = text.search(/[\[{]/);
  if (start < 0) return text;
  for (let end = text.length; end > start; end -= 1) {
    const parsed = parseJson(text.slice(start, end));
    if (parsed !== undefined) return text.slice(start, end);
  }
  return text;
}

function structuredValue(value, harness) {
  if (hasRoleShape(value)) return value;
  if (Array.isArray(value)) return undefined;
  for (const key of ["result", "response", "part", "message", "text", "content", "output"]) {
    const nested = value?.[key];
    if (typeof nested === "string") {
      const parsed = parseJson(nested) ?? parseJson(unwrapJson(nested));
      if (parsed && hasRoleShape(parsed)) return parsed;
    }
    if (nested && typeof nested === "object" && hasRoleShape(nested)) return nested;
    if (nested && typeof nested === "object") {
      const deeper = structuredValue(nested, harness);
      if (deeper) return deeper;
    }
  }
  return undefined;
}

function hasRoleShape(value) {
  return value && typeof value === "object" && ["requirements", "tasks", "candidate", "report", "requirements_map", "status"].some((key) => Object.hasOwn(value, key));
}
