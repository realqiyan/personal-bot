import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { packageVersion, releaseLine } from "../../dist/common/version.js";

test("bundled release comes from the manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(packageVersion, manifest.version);
});

test("subagent release compatibility follows the pre-1.0 minor and stable major", () => {
  for (const version of ["0.6.0", "0.6.1", "0.6.10-beta.1+build"]) assert.equal(releaseLine(version), "0.6");
  assert.equal(releaseLine("0.7.0"), "0.7");
  for (const version of ["1.0.0", "1.1.0", "1.42.3"]) assert.equal(releaseLine(version), "1");
  assert.equal(releaseLine("2.0.0"), "2");
  for (const version of ["1", "1.0", "01.0.0", "v1.0.0", "1.0.0/extra"]) assert.throws(() => releaseLine(version));
});
