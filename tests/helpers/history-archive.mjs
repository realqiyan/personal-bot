import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeMixedArchive(directory, record) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, record.id + ".json");
  await writeFile(path, JSON.stringify(record, null, 2) + "\n");
  return path;
}

export async function legacyArchive(root, record) {
  const { host, ...value } = record;
  const directory = join(root, "." + host, "pbot/history");
  return { directory, path: await writeMixedArchive(directory, value) };
}

export function assertArchiveReadable(service, record) {
  for (const expected of record.nodes) {
    const node = service.read(expected.id, 0, 12000, 0, record.host);
    assert.deepEqual(node.source, { host: record.host, sessionId: record.sessionId, entryIds: expected.entryIds });
    assert.equal(node.kind, expected.kind);
    assert.equal(node.text, expected.text);
    assert.equal(node.ready, expected.ready);
    assert.equal(node.completed, expected.completed);
    assert.equal(node.from, expected.from);
    assert.equal(node.to, expected.to);
    assert.deepEqual(node.parents.map(parent => parent.id).sort(), [...expected.parents].sort());
    const children = node.children.map(child => child.id);
    if (expected.kind === "summary") assert.deepEqual(children, expected.children);
    else assert.deepEqual(children.sort(), [...expected.children].sort());
    assert.ok([...node.parents, ...node.children].every(link => link.host === record.host));
  }
}
