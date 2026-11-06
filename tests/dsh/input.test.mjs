import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { dshHost } from "../helpers/dsh-host.mjs";
import { dshInput, dshHumanInput } from "../../dist/integrations/dsh/input.js";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC", "base64");

test("native input stores verbatim binary files and admitted images independently of their original paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pbot-dsh-input-")), host = await dshHost(join(root, "sessions"));
  try {
    const file = join(root, "payload.bin"), image = join(root, "pixel.png"), data = Buffer.alloc(512 * 1024 + 17);
    for (let index = 0; index < data.length; index++) data[index] = index % 251;
    await writeFile(file, data); await writeFile(image, pixel);
    const descriptor = { agentId: randomUUID(), parentSessionId: randomUUID(), cwd: root, workspace: root, options: {} };
    const request = { id: randomUUID(), generation: randomUUID(), message: "Inspect the attachments.", files: [file, image] };
    const input = await dshInput(host.ctx, descriptor, request, new AbortController().signal);
    const binary = input.content.find(block => block.type === "file"), picture = input.content.find(block => block.type === "image");
    assert.ok(binary); assert.ok(picture);
    await rm(file); await rm(image);
    const chunks = [];
    for await (const chunk of host.ctx.attachments.readFileStream(binary.attachment)) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), data);
    const stored = await host.ctx.attachments.readImage(picture.attachment);
    assert.equal(stored.ref.width, 1); assert.equal(stored.ref.height, 1); assert.ok(stored.data.byteLength > 0);
    const human = await dshHumanInput(host.ctx, root, "", [], [binary, picture], new AbortController().signal);
    assert.equal(human.source.kind, "user"); assert.deepEqual(human.content.slice(0, 2), [binary, picture]);
    await assert.rejects(dshHumanInput(host.ctx, root, "", [file], [binary], new AbortController().signal));
    await assert.rejects(dshHumanInput(host.ctx, root, "", [], Array(33).fill(binary), new AbortController().signal));
    await assert.rejects(dshHumanInput(host.ctx, root, "", [], [binary], AbortSignal.abort()));
    await writeFile(image, pixel);
    await assert.rejects(dshInput(host.ctx, descriptor, { ...request, files: Array(host.ctx.attachments.imageLimits.maxImagesPerMessage + 1).fill(image) }, new AbortController().signal));
    await assert.rejects(dshInput(host.ctx, descriptor, { ...request, files: [root] }, new AbortController().signal));
    await assert.rejects(dshInput(host.ctx, descriptor, request, AbortSignal.abort()));
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
