"use strict";
// Expand test paths in Node so npm test works with both cmd.exe and POSIX shells,
// including Node 20, without accidentally discovering src/speed-test.js as a test.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.join(__dirname, "..");
const files = fs
  .readdirSync(path.join(root, "test"))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(root, "test", name));
if (!files.length) throw new Error("No tests found");
const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
