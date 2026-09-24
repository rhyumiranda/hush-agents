import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_HARNESSES = Object.freeze(["codex", "claude", "gemini", "opencode"]);

/** Reserved key in adapter stdout JSON. The bridge puts token usage here, and the runner removes it before it reads the role result. */
export const HARNESS_USAGE_KEY = "hush_usage";

const quoteIfSpaced = (value) => (/\s/.test(value) ? JSON.stringify(value) : value);
/**
 * The exact command that Puck and Vera run to seal their reports. It uses this checkout's CLI, because a globally
 * installed hush-agents can be an older version. The Claude allowlist matches this string as a prefix.
 */
export const REPORT_DIGEST_COMMAND = `${quoteIfSpaced(process.execPath)} ${quoteIfSpaced(fileURLToPath(new URL("../../bin/hush-agents.mjs", import.meta.url)))} report-digest`;

/**
 * Build the harness CLI invocation for one role call.
 * `model` is optional. When it is set, the harness gets `--model <model>`. All four harness CLIs accept that flag.
 * When it is not set, the harness uses its configured default model, which is the earlier behavior.
 * Use it to put faster models on the review roles and keep a strong model on Flint.
 * When the role has a result schema (resultSchemaFor), Claude gets it with `--json-schema`. Codex gets it with
 * `--output-schema <schemaPath>`, and the caller must write the schema to that file. Both harnesses enforce the
 * schema while they generate, so a long result cannot come back as broken JSON.
 */
export function buildHarnessInvocation({ harness, role, payload, outputPath, executable = harness, profileText = "", sandbox, model, schemaPath } = {}) {
  if (!SUPPORTED_HARNESSES.includes(harness)) throw new Error(`unsupported harness: ${harness}`);
  if (!role) throw new Error("agent role is required");
  if (model !== undefined && (typeof model !== "string" || model.trim() === "" || model.startsWith("-"))) throw new Error("model must be a non-empty name that does not start with '-'");
  const workdir = payload.worktree_path ?? payload.repository ?? process.cwd();
  const prompt = promptFor({ role, payload, profileText });
  const mode = sandbox ?? (role === "flint" ? "workspace-write" : "read-only");
  const modelArgs = model ? ["--model", model] : [];
  const schema = resultSchemaFor(role);
  if (harness === "codex") {
    // `--json` puts the `turn.completed` usage events on stdout. The final message still goes to the `--output-last-message` file.
    return { command: executable, args: ["exec", ...modelArgs, ...(schema && schemaPath ? ["--output-schema", schemaPath] : []), "--ephemeral", "--json", "--cd", workdir, "--sandbox", mode, "--output-last-message", outputPath, "-"], input: prompt };
  }
  if (harness === "claude") {
    // The prompt goes on stdin. `--add-dir <directories...>` is variadic, so a prompt after it would be taken as a directory.
    // `--agent` silently turns off `--json-schema` (checked on 2.1.270: no structured_output). A role with a schema runs
    // without it. The prompt still has the full profile text, and plan mode keeps read-only roles read-only.
    const roleArgs = schema ? ["--json-schema", JSON.stringify(schema)] : ["--agent", role];
    return { command: executable, args: ["-p", ...modelArgs, ...roleArgs, "--output-format", "json", "--no-session-persistence", ...claudePermissionArgs(role, mode, payload.packet), "--add-dir", workdir], input: prompt };
  }
  if (harness === "gemini") {
    return { command: executable, args: [...modelArgs, "-p", prompt, "--output-format", "json", "--approval-mode", mode === "read-only" ? "plan" : "auto_edit", "--include-directories", workdir], input: "" };
  }
  return { command: executable, args: ["run", ...modelArgs, "--agent", role, "--format", "json", "--dir", workdir, prompt], input: "" };
}

const STRING_SCHEMA = { type: "string" };
/**
 * JSON Schemas for role results. The schemas use only strict-mode features: each object lists all of its properties
 * in `required` and sets `additionalProperties: false`. Codex `--output-schema` requires strict mode.
 * Each schema matches RESULT_CONTRACTS. The runner still validates everything that it gets.
 */
const RESULT_SCHEMAS = {
  fable: {
    type: "object", additionalProperties: false, required: ["requirements"],
    properties: {
      requirements: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          required: ["requirement_id", "quote", "expected_behavior", "actor", "permissions", "baseline_status", "enumeration_status", "approval_state", "unknowns"],
          properties: {
            requirement_id: STRING_SCHEMA, quote: STRING_SCHEMA, expected_behavior: STRING_SCHEMA, actor: STRING_SCHEMA,
            permissions: { type: "array", items: STRING_SCHEMA },
            baseline_status: { type: "string", enum: ["PROVEN", "REPORTED", "UNKNOWN"] },
            enumeration_status: { type: "string", enum: ["EXHAUSTIVE", "ILLUSTRATIVE"] },
            approval_state: { type: "string", enum: ["APPROVED", "DRAFT"] },
            unknowns: { type: "array", items: { type: "object", additionalProperties: false, required: ["question", "blocking"], properties: { question: STRING_SCHEMA, blocking: { type: "boolean" } } } },
          },
        },
      },
    },
  },
  rook: {
    type: "object", additionalProperties: false, required: ["tasks"],
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          required: ["task_id", "requirements", "dependencies", "allowed_paths", "write_paths", "allowed_operations", "blocked_paths", "exclusive_hubs", "required_commands", "acceptance_checks", "expected_evidence", "vera_required"],
          properties: {
            task_id: STRING_SCHEMA,
            requirements: { type: "array", items: STRING_SCHEMA },
            dependencies: { type: "array", items: STRING_SCHEMA },
            allowed_paths: { type: "array", items: STRING_SCHEMA },
            write_paths: { type: "array", items: STRING_SCHEMA },
            allowed_operations: { type: "array", items: { type: "string", enum: ["read", "create", "edit", "modify", "delete", "rename", "test"] } },
            blocked_paths: { type: "array", items: STRING_SCHEMA },
            exclusive_hubs: { type: "array", items: STRING_SCHEMA },
            required_commands: { type: "array", items: STRING_SCHEMA },
            acceptance_checks: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["check_id", "requirement_ids", "write_paths", "executor", "command", "expected_result", "evidence_artifact_id"],
                properties: { check_id: STRING_SCHEMA, requirement_ids: { type: "array", items: STRING_SCHEMA }, write_paths: { type: "array", items: STRING_SCHEMA }, executor: STRING_SCHEMA, command: STRING_SCHEMA, expected_result: STRING_SCHEMA, evidence_artifact_id: STRING_SCHEMA },
              },
            },
            expected_evidence: { type: "array", items: STRING_SCHEMA },
            vera_required: { type: "boolean" },
          },
        },
      },
    },
  },
  puck: gateReportSchema("PUCK", {
    observed_write_paths: { type: "array", items: STRING_SCHEMA },
    check_results: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["check_id", "status", "exit_status", "artifact_id", "artifact_path", "artifact_digest", "write_paths"],
        properties: { check_id: STRING_SCHEMA, status: { type: "string", enum: ["PASS", "FAIL"] }, exit_status: { type: "integer" }, artifact_id: STRING_SCHEMA, artifact_path: STRING_SCHEMA, artifact_digest: STRING_SCHEMA, write_paths: { type: "array", items: STRING_SCHEMA } },
      },
    },
  }),
  vera: gateReportSchema("VERA", {
    requirement_verdicts: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["requirement_id", "verdict", "evidence"],
        properties: { requirement_id: STRING_SCHEMA, verdict: { type: "string", enum: ["MATCH", "MISSING", "CONFLICT", "AMBIGUOUS", "INSUFFICIENT_EVIDENCE"] }, evidence: STRING_SCHEMA },
      },
    },
  }),
};

/** Schema of a `{ "report": ... }` gate result: the binding fields that validateGateReport checks, plus the extra gate fields. */
function gateReportSchema(gate, extra) {
  const bindings = ["report_id", "report_digest", "packet_id", "source_manifest_digest", "candidate_id", "candidate_patch_digest", "candidate_tree_digest", "candidate_diff_digest", "snapshot_id", "gate_run_id", "created_by"];
  const properties = {
    ...Object.fromEntries(bindings.map((field) => [field, STRING_SCHEMA])),
    gate: { type: "string", enum: [gate] },
    phase: { type: "string", enum: ["PRE_INTEGRATION", "TARGETED_FINAL"] },
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    ...extra,
  };
  return { type: "object", additionalProperties: false, required: ["report"], properties: { report: { type: "object", additionalProperties: false, required: Object.keys(properties), properties } } };
}

/** The JSON Schema that the harness enforces for the result of a role, or null when the role has no schema yet. */
export function resultSchemaFor(role) { return RESULT_SCHEMAS[role] ?? null; }

/**
 * Claude permission flags for one role call. In a `-p` run nobody can answer a permission prompt, so Claude denies
 * any call that would prompt:
 * - `plan` blocks every command outside the built-in read-only set, so Puck could not run the checks.
 * - `dontAsk` also denies file edits and `git commit`, so Flint could not change code. Seen in a live run: "denied by
 *   sandbox permission layer".
 * Each role now gets an exact allowlist (the pattern for CI in the Claude docs):
 * - Flint: `acceptEdits`, the packet commands, `git add`, `git commit`, and the hashline editor.
 * - Puck: `dontAsk` with the packet commands, `shasum -a 256`, and report-digest. Puck can run the checks, hash the
 *   evidence, and seal its own report, and it can edit nothing.
 * - Vera: `dontAsk` with only `shasum -a 256` and report-digest.
 * The gates must compute their own digests (agents/hush.toml:64 and agents/puck.toml). These tools are their
 * calculator. Other roles stay in `plan` mode (read-only).
 */
function claudePermissionArgs(role, mode, packet) {
  const commands = [...new Set([...(packet?.required_commands ?? []), ...(packet?.acceptance_checks ?? []).map((check) => check.command)].filter((command) => typeof command === "string" && command.trim()))];
  const allow = (list) => list.length ? ["--allowedTools", ...list.map((command) => `Bash(${command})`)] : [];
  const gateTools = ["shasum -a 256 *", `${REPORT_DIGEST_COMMAND} *`];
  if (role === "flint" && mode !== "read-only") return ["--permission-mode", "acceptEdits", ...allow([...commands, "git add *", "git commit *", "hush-agents hashline-read *", "hush-agents hashline-patch *"])];
  if (role === "puck") return ["--permission-mode", "dontAsk", ...allow([...commands, ...gateTools])];
  if (role === "vera") return ["--permission-mode", "dontAsk", ...allow(gateTools)];
  return ["--permission-mode", mode === "read-only" ? "plan" : "dontAsk"];
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
 * The exact JSON result that the runner validates for each role. This text overrides the handoff format of the
 * profile. Without it, a model returns the markdown-shaped map of its profile, which the runner rejects. Only the fields
 * that the model decides are listed. Hush fills the bookkeeping fields (see completeRequirementSource).
 */
const RESULT_CONTRACTS = {
  fable: [
    'Return {"requirements": [...]} with one object for each requirement in the PRD:',
    '{"requirement_id": "R-01", "quote": "<text copied exactly from prd_text: same characters, spaces, and punctuation; no paraphrase>", "expected_behavior": "<observable behavior>", "actor": "<who uses it>", "permissions": ["<permission, or none>"], "baseline_status": "REPORTED", "enumeration_status": "EXHAUSTIVE", "approval_state": "APPROVED", "unknowns": [{"question": "<question>", "blocking": false}]}',
    "baseline_status is PROVEN, REPORTED, or UNKNOWN. enumeration_status is EXHAUSTIVE or ILLUSTRATIVE. approval_state is APPROVED when the requirement is clear enough to implement; otherwise DRAFT.",
    "Set blocking true only when a correct implementation is impossible without an answer. A blocking unknown stops the run.",
    "Hush fills revision, source, source_discovery, and quote_back from the PRD. Do not add them. Keep other fields out of the result.",
  ].join("\n"),
  rook: [
    'Return {"tasks": [...]} with one object for each task:',
    '{"task_id": "TASK-1", "requirements": ["R-01"], "dependencies": ["<task_id that must be accepted first>"], "allowed_paths": ["src/a.js", "test/a.test.js"], "write_paths": ["src/a.js", "test/a.test.js"], "allowed_operations": ["create", "edit", "test"], "blocked_paths": [], "exclusive_hubs": ["<shared file that only this task may edit>"], "required_commands": ["npm test"], "acceptance_checks": [{"check_id": "CHECK-1", "requirement_ids": ["R-01"], "write_paths": ["src/a.js", "test/a.test.js"], "executor": "puck", "command": "npm test", "expected_result": "<observable result>", "evidence_artifact_id": "ART-1"}], "expected_evidence": ["ART-1"], "vera_required": true}',
    "Each requirement ID in the request goes into exactly one task. write_paths must be inside allowed_paths. Each write path must be in the write_paths of at least one acceptance check. allowed_operations uses read, create, edit, modify, delete, rename, and test.",
    "Put work on different files in separate tasks, so that the tasks can run in parallel. List dependencies only when a task needs the result of another task.",
    "Hush builds the packet: identity, sources, environment, revisions, and digest. Do not add them.",
  ].join("\n"),
  puck: gateContract("PUCK", "puck", [
    'verdict: "PASS" only when every acceptance check passed; otherwise "FAIL".',
    "observed_write_paths: the paths in packet.write_paths that the candidate changed (see snapshot.changed_paths).",
    'check_results: one entry for each item of packet.acceptance_checks: {"check_id": <the check_id>, "status": "PASS" or "FAIL", "exit_status": <exit code of the command you ran>, "artifact_id": <the evidence_artifact_id of the check>, "artifact_path": "<a file in the worktree that proves the check, for example the test file>", "artifact_digest": "sha256:<hex printed by shasum -a 256 <artifact_path>>", "write_paths": <the write_paths of the check>}.',
    "Run the check commands from the packet yourself. Do not trust Flint's report as proof.",
  ]),
  vera: gateContract("VERA", "vera", [
    'requirement_verdicts: one entry for each requirement in the request: {"requirement_id", "verdict": MATCH, MISSING, CONFLICT, AMBIGUOUS, or INSUFFICIENT_EVIDENCE, "evidence": "<file and symbol in the candidate that shows it>"}.',
    'verdict: "PASS" only when every requirement_verdict is MATCH; otherwise "FAIL".',
    "Read the candidate files in the worktree. Compare them with the requirement text, not with Flint's report.",
  ]),
};

/**
 * Result contract of a Puck or Vera report. The gate copies each binding from the request and computes its own
 * report_digest with the report-digest command, as agents/hush.toml:64 and the gate profiles require. The command is a
 * real calculator, so the gate never has to guess a SHA-256.
 */
function gateContract(gate, role, rules) {
  return [
    'Return {"report": {...}} and fill every field. Copy these values exactly from the Hush request:',
    `report_id: "${gate}-" + candidate.candidate_id. gate: "${gate}". phase: "PRE_INTEGRATION". created_by: "${role}". gate_run_id: run_id + "-${gate}-" + candidate.candidate_id.`,
    "packet_id: packet.packet_id. source_manifest_digest: packet.source_refs[0].manifest_digest. candidate_id: candidate.candidate_id. candidate_patch_digest: candidate.patch_digest. candidate_tree_digest: snapshot.tree_digest. candidate_diff_digest: snapshot.diff_digest. snapshot_id: snapshot.snapshot_id.",
    ...rules,
    `report_digest: do this step last. Run: ${REPORT_DIGEST_COMMAND} --report '<your report JSON without report_digest>'. Put its output in report_digest exactly. Do not change any other field after this step, because Hush checks the digest over every field.`,
    "Hash files only with shasum -a 256. Never write a digest yourself.",
  ].join("\n");
}

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
    ...(RESULT_CONTRACTS[role] ? [`Required result format (this overrides the handoff format of the profile):\n${RESULT_CONTRACTS[role]}`] : []),
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
  // `structured_output` holds the result that Claude validated against `--json-schema`.
  for (const key of ["structured_output", "result", "response", "part", "message", "text", "content", "output"]) {
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
