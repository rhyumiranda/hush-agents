import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  PACKET_STATUS,
  canonicalPacketJson,
  computePacketDigest,
  sealPacket,
  validatePacket,
} from "../lib/runtime/packet.mjs";

const root = new URL("..", import.meta.url).pathname;

function basePacket() {
  return sealPacket({
    run_id: "RUN-HUSH-RUNTIME-OPT-001",
    task_id: "T-01",
    packet_id: "PKT-T01-R1",
    packet_revision: 1,
    target_agent: "flint",
    base_sha: "b205ad1b2e1dada14e2c6380561c1204d783c518",
    requirements: ["R-01", "R-02"],
    allowed_paths: ["lib/runtime/packet.mjs", "schemas/packet.schema.json", "test/packet.test.mjs"],
    allowed_operations: ["create", "edit"],
    blocked_paths: ["bin/hush-agents.mjs", "package.json", "README.md"],
    required_commands: ["node --test test/packet.test.mjs"],
    expected_evidence: ["test output", "changed surfaces", "revision SHA"],
    vera_required: true,
    expires_at: null,
    supersedes: [],
  });
}

test("canonical packet JSON sorts object keys and omits digest", () => {
  const packet = basePacket();

  assert.equal(
    canonicalPacketJson({ z: 1, digest: "sha256:bad", a: { b: true, a: false } }),
    "{\"a\":{\"a\":false,\"b\":true},\"z\":1}",
  );
  assert.equal(computePacketDigest(packet), packet.digest);
});

test("sample T-01 packet digest matches packet artifact", () => {
  const packet = JSON.parse(
    readFileSync(
      "/Users/rhyu/Documents/Codex/2026-09-03/i-want-you-to-look-for/outputs/hush-runtime-packets/PKT-T01-R1.json",
      "utf8",
    ),
  );

  assert.equal(computePacketDigest(packet), packet.digest);
  assert.equal(validatePacket(packet).status, PACKET_STATUS.VALID);
});

test("field mutation breaks digest", () => {
  const original = basePacket();
  const packet = { ...original, target_agent: "puck" };

  assert.deepEqual(validatePacket(packet), {
    status: PACKET_STATUS.INVALID_DIGEST,
    issue: {
      field: "digest",
      rule: "must match canonical packet digest",
      expected: computePacketDigest(packet),
      actual: original.digest,
    },
  });
});

test("missing required field is invalid shape", () => {
  const packet = basePacket();
  delete packet.allowed_paths;

  assert.deepEqual(validatePacket(packet), {
    status: PACKET_STATUS.INVALID_SHAPE,
    issue: { field: "allowed_paths", rule: "is required" },
  });
});

test("superseded packet is rejected", () => {
  const packet = basePacket();

  assert.deepEqual(validatePacket(packet, { supersededPacketIds: [packet.packet_id] }), {
    status: PACKET_STATUS.SUPERSEDED,
    issue: { field: "packet_id", rule: "must be active" },
  });
});

test("past expires_at is rejected as expired", () => {
  const packet = sealPacket({ ...basePacket(), expires_at: "2026-09-05T00:00:00.000Z" });

  assert.deepEqual(validatePacket(packet, { now: "2026-09-05T00:00:01.000Z" }), {
    status: PACKET_STATUS.EXPIRED,
    issue: {
      field: "expires_at",
      rule: "must not be expired",
      expires_at: "2026-09-05T00:00:00.000Z",
    },
  });
});

test("wrong base and wrong target agent are distinct results", () => {
  const packet = basePacket();

  assert.deepEqual(validatePacket(packet, { currentBaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), {
    status: PACKET_STATUS.WRONG_BASE,
    issue: {
      field: "base_sha",
      rule: "must match current base SHA",
      expected: packet.base_sha,
      actual: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  });
  assert.deepEqual(validatePacket(packet, { targetAgent: "puck" }), {
    status: PACKET_STATUS.WRONG_AGENT,
    issue: { field: "target_agent", rule: "must match target agent", expected: "flint", actual: "puck" },
  });
});

test("changed paths must stay in allowed scope and out of blocked paths", () => {
  const packet = basePacket();

  assert.equal(
    validatePacket(packet, { changedPaths: ["lib/runtime/packet.mjs", "test/packet.test.mjs"] }).status,
    PACKET_STATUS.VALID,
  );
  assert.deepEqual(validatePacket(packet, { changedPaths: ["README.md"] }), {
    status: PACKET_STATUS.OUT_OF_SCOPE,
    issue: { field: "blocked_paths", rule: "must not include blocked paths", path: "README.md" },
  });
  assert.deepEqual(validatePacket(packet, { changedPaths: ["lib/runtime/state.mjs"] }), {
    status: PACKET_STATUS.OUT_OF_SCOPE,
    issue: { field: "allowed_paths", rule: "must include only allowed paths", path: "lib/runtime/state.mjs" },
  });
});

test("blocked dependency can be represented as validator result", () => {
  const packet = basePacket();

  assert.deepEqual(validatePacket(packet, { dependencies: { "T-02": "BLOCKED" } }), {
    status: PACKET_STATUS.BLOCKED_DEPENDENCY,
    issue: {
      field: "dependencies",
      rule: "must have verified dependencies",
      dependency: { id: "T-02", status: "BLOCKED" },
    },
  });
});

test("every invalid packet result includes stable issue field and rule", () => {
  const validPacket = basePacket();
  const invalidShapePacket = basePacket();
  delete invalidShapePacket.allowed_paths;

  const cases = [
    validatePacket(invalidShapePacket),
    validatePacket({ ...validPacket, target_agent: "puck" }),
    validatePacket(sealPacket({ ...validPacket, expires_at: "2026-09-05T00:00:00.000Z" }), {
      now: "2026-09-05T00:00:01.000Z",
    }),
    validatePacket(validPacket, { supersededPacketIds: [validPacket.packet_id] }),
    validatePacket(validPacket, { currentBaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    validatePacket(validPacket, { targetAgent: "puck" }),
    validatePacket(validPacket, { changedPaths: ["README.md"] }),
    validatePacket(validPacket, { dependencies: { "T-02": "BLOCKED" } }),
  ];

  for (const result of cases) {
    assert.notEqual(result.status, PACKET_STATUS.VALID);
    assert.equal(typeof result.issue.field, "string", result.status);
    assert.notEqual(result.issue.field.length, 0, result.status);
    assert.equal(typeof result.issue.rule, "string", result.status);
    assert.notEqual(result.issue.rule.length, 0, result.status);
  }
});

test("schema artifact lists required packet fields", () => {
  const schema = JSON.parse(readFileSync(join(root, "schemas", "packet.schema.json"), "utf8"));

  for (const field of Object.keys(basePacket())) {
    assert.ok(schema.required.includes(field), `${field} is required`);
  }
  assert.match(schema.properties.digest.pattern, /sha256/);
});

test("validate-packet CLI prints machine-readable valid status", () => {
  const packetPath =
    "/Users/rhyu/Documents/Codex/2026-09-03/i-want-you-to-look-for/outputs/hush-runtime-packets/PKT-T01-R1.json";
  const result = spawnSync(process.execPath, [join(root, "bin", "hush-agents.mjs"), "validate-packet", packetPath], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: PACKET_STATUS.VALID });
  assert.equal(result.stderr, "");
});

test("validate-packet CLI exits nonzero with issue details for invalid packet", () => {
  const packet = { ...basePacket(), target_agent: "puck" };
  const packetPath = join(mkdtempSync(join(tmpdir(), "hush-packet-")), "invalid.json");
  writeFileSync(packetPath, JSON.stringify(packet));
  const result = spawnSync(process.execPath, [join(root, "bin", "hush-agents.mjs"), "validate-packet", packetPath], {
    cwd: root,
    encoding: "utf8",
  });
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(output.status, PACKET_STATUS.INVALID_DIGEST);
  assert.equal(output.issue.field, "digest");
  assert.equal(output.issue.rule, "must match canonical packet digest");
  assert.equal(result.stderr, "");
});

test("validate-packet CLI accepts context options for packet status checks", () => {
  const cases = [
    {
      name: "wrong-base",
      packet: basePacket(),
      args: ["--current-base-sha", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      status: PACKET_STATUS.WRONG_BASE,
    },
    {
      name: "wrong-agent",
      packet: basePacket(),
      args: ["--target-agent", "puck"],
      status: PACKET_STATUS.WRONG_AGENT,
    },
    {
      name: "out-of-scope",
      packet: basePacket(),
      args: ["--changed-path", "README.md"],
      status: PACKET_STATUS.OUT_OF_SCOPE,
    },
    {
      name: "blocked-dependency",
      packet: basePacket(),
      args: ["--dependency", "T-02=BLOCKED"],
      status: PACKET_STATUS.BLOCKED_DEPENDENCY,
    },
    {
      name: "superseded",
      packet: basePacket(),
      args: ["--superseded-packet-id", "PKT-T01-R1"],
      status: PACKET_STATUS.SUPERSEDED,
    },
    {
      name: "expired",
      packet: sealPacket({ ...basePacket(), expires_at: "2026-09-05T00:00:00.000Z" }),
      args: ["--now", "2026-09-05T00:00:01.000Z"],
      status: PACKET_STATUS.EXPIRED,
    },
  ];

  for (const cliCase of cases) {
    const packetDir = mkdtempSync(join(tmpdir(), `hush-packet-${cliCase.name}-`));
    const packetPath = join(packetDir, "packet.json");
    writeFileSync(packetPath, JSON.stringify(cliCase.packet));
    const result = spawnSync(
      process.execPath,
      [join(root, "bin", "hush-agents.mjs"), "validate-packet", packetPath, ...cliCase.args],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 1, cliCase.name);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, cliCase.status, cliCase.name);
    assert.equal(typeof output.issue.field, "string", cliCase.name);
    assert.notEqual(output.issue.field.length, 0, cliCase.name);
    assert.equal(typeof output.issue.rule, "string", cliCase.name);
    assert.notEqual(output.issue.rule.length, 0, cliCase.name);
    assert.equal(result.stderr, "", cliCase.name);
  }
});
