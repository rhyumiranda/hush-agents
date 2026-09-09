import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyHashline, readHashline } from "../lib/runtime/hashline.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hush-hashline-"));
  const file = join(dir, "sample.js");
  writeFileSync(file, "alpha\nbeta\ngamma\n");
  return file;
}

test("read returns file digest and line anchors", () => {
  const snapshot = readHashline(fixture());
  assert.equal(snapshot.lines.length, 3);
  assert.match(snapshot.lines[1].anchor, /^2:[0-9a-f]{4}$/);
  assert.equal(snapshot.lines[1].content, "beta");
});

test("replace applies only when file digest and anchors match", () => {
  const file = fixture();
  const snapshot = readHashline(file);
  const result = applyHashline(file, {
    version: "1",
    file_sha256: snapshot.file_sha256,
    operations: [{ op: "replace", start: snapshot.lines[1].anchor, lines: ["BETA"] }],
  });

  assert.equal(result.operations, 1);
  assert.equal(readFileSync(file, "utf8"), "alpha\nBETA\ngamma\n");
});

test("stale files are rejected before writing", () => {
  const file = fixture();
  const snapshot = readHashline(file);
  writeFileSync(file, "alpha\nchanged\ngamma\n");

  assert.throws(
    () => applyHashline(file, {
      version: "1",
      file_sha256: snapshot.file_sha256,
      operations: [{ op: "replace", start: snapshot.lines[1].anchor, lines: ["BETA"] }],
    }),
    /stale file/,
  );
  assert.equal(readFileSync(file, "utf8"), "alpha\nchanged\ngamma\n");
});

test("dry run validates without writing", () => {
  const file = fixture();
  const snapshot = readHashline(file);
  const result = applyHashline(file, {
    version: "1",
    file_sha256: snapshot.file_sha256,
    operations: [{ op: "delete", start: snapshot.lines[0].anchor, lines: [] }],
  }, { dryRun: true });

  assert.equal(result.dry_run, true);
  assert.equal(readFileSync(file, "utf8"), "alpha\nbeta\ngamma\n");
});
