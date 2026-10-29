import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { agentInput } from "../../dist/integrations/pi/agent-input.js";

async function directory(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pbot-agent-input-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("agent input associates each native text and image attachment with its absolute source", async t => {
  const cwd = await directory(t);
  await mkdir(join(cwd, "other"));
  const files = [join(cwd, "evidence.txt"), join(cwd, "other", "evidence.txt"), join(cwd, "pixel.png")];
  await writeFile(files[0], "First source\n17");
  await writeFile(files[1], "Second source\n25");
  await writeFile(files[2], Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==", "base64"));
  const message = "Compare both sources and the image.\nKeep the raw request.";
  const content = await agentInput(cwd, { requestId: "attachments", files, message });
  const read = createReadTool(cwd);
  let index = 0;
  for (const path of files) {
    assert.equal(content[index].type, "text");
    assert.ok(content[index].text.includes(JSON.stringify(path)));
    index++;
    const native = await read.execute("expected", { path });
    assert.deepEqual(content.slice(index, index + native.content.length), native.content);
    index += native.content.length;
  }
  assert.equal(content.filter(part => part.type === "image").length, 1);
  assert.deepEqual(content.slice(index), [{ type: "text", text: message }]);
});

test("agent input preserves native truncation and its source can be read to completion", async t => {
  const cwd = await directory(t), path = join(cwd, "large.txt");
  const lines = Array.from({ length: DEFAULT_MAX_LINES + 3 }, (_, index) => "row " + (index + 1));
  await writeFile(path, lines.join("\n"));
  const content = await agentInput(cwd, { requestId: "large", files: [path], message: "Review" });
  const read = createReadTool(cwd), native = await read.execute("initial", { path });
  assert.equal(native.details.truncation.truncated, true);
  assert.equal(native.details.truncation.outputLines, DEFAULT_MAX_LINES);
  assert.ok(content[0].text.includes(JSON.stringify(path)));
  assert.deepEqual(content.slice(1, 1 + native.content.length), native.content);
  const rest = await read.execute("continuation", { path, offset: native.details.truncation.outputLines + 1 });
  assert.deepEqual(rest.content, [{ type: "text", text: lines.slice(DEFAULT_MAX_LINES).join("\n") }]);
});
