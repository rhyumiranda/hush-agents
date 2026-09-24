import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SUPPORTED_HARNESSES = Object.freeze(["codex", "claude", "gemini", "opencode"]);

/** Reserved key in adapter stdout JSON. The bridge puts token usage here, and the runner removes it before it reads the role result. */
export const HARNESS_USAGE_KEY = "hush_usage";

/**
 * Build the harness CLI invocation for one role call.
 * `model` is optional. When it is set, the harness gets `--model <model>`. All four harness CLIs accept that flag.
 * When it is not set, the harness uses its configured default model, which is the earlier behavior.
 * Use it to put faster models on the review roles and keep a strong model on Flint.
 */
export function buildHarnessInvocation({ harness, role, payload, outputPath, executable = harness, profileText = "", sandbox, model } = {}) {
  if (!SUPPORTED_HARNESSES.includes(harness)) throw new Error(`unsupported harness: ${harness}`);
  if (!role) throw new Error("agent role is required");
  if (model !== undefined && (typeof model !== "string" || model.trim() === "" || model.startsWith("-"))) throw new Error("model must be a non-empty name that does not start with '-'");
  const workdir = payload.worktree_path ?? payload.repository ?? process.cwd();
  const prompt = promptFor({ role, payload, profileText });
  const mode = sandbox ?? (role === "flint" ? "workspace-write" : "read-only");
  const modelArgs = model ? ["--model", model] : [];
  if (harness === "codex") {
    // `--json` puts the `turn.completed` usage events on stdout. The final message still goes to the `--output-last-message` file.
    return { command: executable, args: ["exec", ...modelArgs, "--ephemeral", "--json", "--cd", workdir, "--sandbox", mode, "--output-last-message", outputPath, "-"], input: prompt };
  }
  if (harness === "claude") {
    // The prompt goes on stdin. `--add-dir <directories...>` is variadic, so a prompt after it would be taken as a directory.
    return { command: executable, args: ["-p", ...modelArgs, "--agent", role, "--output-format", "json", "--no-session-persistence", "--permission-mode", mode === "read-only" ? "plan" : "dontAsk", "--add-dir", workdir], input: prompt };
  }
  if (harness === "gemini") {
    return { command: executable, args: [...modelArgs, "-p", prompt, "--output-format", "json", "--approval-mode", mode === "read-only" ? "plan" : "auto_edit", "--include-directories", workdir], input: "" };
  }
  return { command: executable, args: ["run", ...modelArgs, "--agent", role, "--format", "json", "--dir", workdir, prompt], input: "" };
}

export function parseHarnessOutput({ harness, stdout = "", outputText = "" } = {}) {
  // With `codex exec --json`, stdout is JSONL. If the final-message file is missing, fall back to the last agent_message item.
  const codexMessages = harness === "codex" ? jsonLines(stdout).map(parseJson).filter((event) => event?.item?.type === "agent_message" && typeof event.item.text === "string").map((event) => event.item.text).reverse() : [];
  const candidates = [outputText, ...codexMessages, ...jsonLines(stdout), stdout].filter((value) => typeof value === "string" && value.trim());
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

/**
 * Read token usage from raw harness stdout. Returns null when the harness printed no usage.
 * This function never throws: usage is for reporting only, so it must not fail a role call.
 * Normalized fields: input_tokens (input that was not served from cache), cache_read_tokens, cache_write_tokens,
 * output_tokens (reasoning and thought tokens included), and cost_usd (null when the harness reports no cost).
 * Sources: claude `result.usage`, codex `turn.completed.usage`, gemini `stats.models[*].tokens`,
 * opencode `step_finish.part.tokens`. Codex and gemini count cached tokens inside their input total, so this function subtracts them.
 */
export function parseHarnessUsage({ harness, stdout = "" } = {}) {
  const whole = parseJson(stdout);
  const records = (whole && typeof whole === "object" ? [whole] : jsonLines(stdout).map(parseJson)).filter((value) => value && typeof value === "object");
  const usage = { input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, cost_usd: null };
  let found = false;
  const add = (tokens, cost) => {
    found = true;
    for (const [key, value] of Object.entries(tokens)) usage[key] += Math.max(0, count(value));
    if (cost !== undefined && cost !== null) usage.cost_usd = (usage.cost_usd ?? 0) + count(cost);
  };
  for (const record of records) {
    if (harness === "claude" && record.type === "result" && record.usage) {
      add({ input_tokens: record.usage.input_tokens, cache_read_tokens: record.usage.cache_read_input_tokens, cache_write_tokens: record.usage.cache_creation_input_tokens, output_tokens: record.usage.output_tokens }, record.total_cost_usd);
    } else if (harness === "codex" && record.type === "turn.completed" && record.usage) {
      add({ input_tokens: count(record.usage.input_tokens) - count(record.usage.cached_input_tokens), cache_read_tokens: record.usage.cached_input_tokens, output_tokens: record.usage.output_tokens });
    } else if (harness === "gemini" && record.stats?.models && typeof record.stats.models === "object") {
      for (const { tokens = {} } of Object.values(record.stats.models)) add({ input_tokens: count(tokens.prompt) - count(tokens.cached), cache_read_tokens: tokens.cached, output_tokens: count(tokens.candidates) + count(tokens.thoughts) });
    } else if (harness === "opencode" && record.type === "step_finish" && record.part?.tokens) {
      const tokens = record.part.tokens;
      add({ input_tokens: tokens.input, cache_read_tokens: tokens.cache?.read, cache_write_tokens: tokens.cache?.write, output_tokens: count(tokens.output) + count(tokens.reasoning) }, record.part.cost);
    }
  }
  return found ? usage : null;
}

function count(value) { const number = Number(value); return Number.isFinite(number) ? number : 0; }

export function loadBundledProfile(root, harness, role) {
  const profilePath = harness === "codex" ? join(root, "agents", `${role}.toml`) : join(root, "agents", harness, `${role}.md`);
  return existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "";
}

/**
 * Hush-owned fields for each role. This text overrides the role profile. Hush issues every packet and seals its
 * SHA-256 digest (agents/hush.toml), so Rook does not compute it. Puck, Vera, and Flint verify digests themselves,
 * as their profiles require.
 */
const DIGEST_NOTES = { rook: "Hush seals the `digest` field of each packet. You may omit it." };

/**
 * Build the LLM-facing prompt for one role call.
 * The runner passes the packet twice (`payload.packet` and `payload.task.packet`, ~2.7 KB each), so the copy
 * under `task` is dropped here. Only the prompt text changes; custom adapters still get the full payload.
 */
function promptFor({ role, payload, profileText }) {
  const request = payload.packet && payload.task?.packet ? { ...payload, task: { ...payload.task, packet: undefined } } : payload;
  return [
    `Act as the Hush ${role} role.`,
    profileText ? `Follow this installed role profile exactly:\n${profileText}` : "Follow the installed role profile exactly.",
    "Read the Hush request below. Return exactly one JSON object and no markdown, commentary, progress output, or code fence.",
    "The JSON object must be the role's Hush adapter result. Hush independently validates it; do not claim acceptance.",
    ...(DIGEST_NOTES[role] ? [`Hush-owned fields (these rules override the profile): ${DIGEST_NOTES[role]}`] : []),
    `Hush request JSON:\n${JSON.stringify(request)}`,
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
