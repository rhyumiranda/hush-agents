#!/usr/bin/env node
import { VERSION } from "../lib/version.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && ["-v", "-V", "--version"].includes(args[0])) {
  console.log(VERSION);
} else {
  await import("./hush-agents-cli.mjs");
}
