import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SUPPORTED_HARNESSES, buildHarnessInvocation, parseHarnessOutput } from "../lib/runtime/harness-adapter.mjs";

const payload = { role: "fable", run_id: "RUN-1", repository: process.cwd(), prd_text: "test" };
const cli = join(process.cwd(), "bin", "hush-agents.mjs");

test("all supported harnesses use the same Hush request boundary", () => {
  for (const harness of SUPPORTED_HARNESSES) {
    const invocation = buildHarnessInvocation({ harness, role: "fable", payload, outputPath: "/tmp/last-message.json", executable: "/bin/test" });
    assert.equal(invocation.command, "/bin/test");
    assert.ok(invocation.args.includes(process.cwd()));
    assert.match(invocation.args.join(" ") + invocation.input, /RUN-1/);
  }
});

test("only Flint receives a writable native harness mode by default", () => {
  for (const harness of SUPPORTED_HARNESSES) {
    const readOnly = buildHarnessInvocation({ harness, role: "puck", payload, outputPath: "/tmp/last-message.json" });
    const writable = buildHarnessInvocation({ harness, role: "flint", payload, outputPath: "/tmp/last-message.json" });
    if (harness !== "opencode") {
      assert.doesNotMatch(readOnly.args.join(" "), /workspace-write|auto_edit|dontAsk/);
      assert.match(writable.args.join(" "), /workspace-write|auto_edit|dontAsk/);
    }
  }
});

test("adapter output parser normalizes native text and JSON envelopes", () => {
  const result = { requirements: [{ requirement_id: "REQ-1" }] };
  assert.deepEqual(parseHarnessOutput({ harness: "codex", outputText: "```json\n" + JSON.stringify(result) + "\n```" }), result);
  assert.deepEqual(parseHarnessOutput({ harness: "claude", stdout: JSON.stringify({ result: JSON.stringify(result) }) }), result);
  assert.deepEqual(parseHarnessOutput({ harness: "gemini", stdout: JSON.stringify({ response: result }) }), result);
  assert.deepEqual(parseHarnessOutput({ harness: "opencode", stdout: JSON.stringify({ part: { text: JSON.stringify(result) } }) }), result);
});

test("CLI bridge invokes every installed harness and returns the Hush JSON result", () => {
  const root = mkdtempSync(join(tmpdir(), "hush-harness-cli-"));
  const fake = join(root, "fake-harness.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const result = { requirements: [{ requirement_id: "REQ-1" }] };
const args = process.argv.slice(2);
const output = args.indexOf("--output-last-message");
if (output >= 0) writeFileSync(args[output + 1], JSON.stringify(result));
else process.stdout.write(JSON.stringify({ result: JSON.stringify(result) }));
readFileSync(0, "utf8");
`);
  chmodSync(fake, 0o755);
  for (const harness of SUPPORTED_HARNESSES) {
    const run = spawnSync(process.execPath, [cli, "harness-adapter", "--harness", harness, "--agent", "fable", "--executable", fake], { input: JSON.stringify(payload), encoding: "utf8" });
    assert.equal(run.status, 0, `${harness}: ${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout), { requirements: [{ requirement_id: "REQ-1" }] });
  }
});
