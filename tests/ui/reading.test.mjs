import { test } from "node:test";
import assert from "node:assert/strict";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { loadThemeFromPath } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { Reader } from "../../dist/ui/pi/reader.js";
import { Menu } from "../../dist/ui/pi/menu.js";

const theme = name => loadThemeFromPath(new URL(`../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${name}.json`, import.meta.url).pathname);
const plain = lines => lines.map(line => stripTerminalSequences(line).trimEnd());

test("read-only pages keep all wrapped text reachable across widths and themes", () => {
  const text = Array.from({ length: 70 }, (_, index) => `${index}: 中文🙂 é ` + "内容 ".repeat(8)).join("\n");
  for (const appearance of ["dark", "light"]) for (const [width, height] of [[24, 12], [80, 24], [120, 40]]) {
    const reader = new Reader("title", text, theme(appearance), new KeybindingsManager(), () => height, () => {}, () => {});
    const expected = plain(new Text(text, 0, 0).render(width - 2));
    const first = reader.render(width), viewport = Math.floor(height * 0.8) - 4, seen = [];
    assert.equal(first.length, Math.floor(height * 0.8));
    for (let index = 0; index <= expected.length - viewport; index++) {
      const lines = reader.render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      seen.push(...plain(lines.slice(2, 3))); reader.handleInput("\x1b[B");
    }
    seen.push(...plain(reader.render(width).slice(3, 2 + viewport)));
    assert.deepEqual(seen, expected);
    reader.handleInput("typing cannot edit"); reader.handleInput("\x1b[H");
    assert.deepEqual(plain(reader.render(width).slice(2, 2 + viewport)), expected.slice(0, viewport));
  }
});

test("reading resize remains bounded and escape leaves without editing", () => {
  let height = 24, closed = 0;
  const reader = new Reader("title", "内容🙂\n".repeat(60), theme("dark"), new KeybindingsManager(), () => height, () => {}, () => closed++);
  reader.render(80); reader.handleInput("\x1b[F");
  for (const [width, rows] of [[16, 8], [80, 40], [32, 12]]) {
    height = rows; reader.invalidate(); const lines = reader.render(width);
    assert.ok(lines.length <= Math.floor(rows * 0.8)); assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  reader.handleInput("\r"); assert.equal(closed, 0);
  reader.handleInput("\x1b"); assert.equal(closed, 1);
});

test("native menu reaches long lists and preserves selection through resize", () => {
  const choices = Array.from({ length: 50 }, (_, index) => `${index} 中文🙂`), selected = [];
  let height = 24;
  const menu = new Menu("title", choices, theme("light"), () => height, () => {}, value => selected.push(value));
  menu.render(80);
  for (let index = 0; index < 49; index++) { menu.handleInput("\x1b[B"); menu.render(80); }
  for (const [width, rows] of [[24, 12], [80, 40], [32, 8]]) {
    height = rows; const lines = menu.render(width);
    assert.ok(lines.length <= Math.floor(rows * 0.8)); assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  menu.handleInput("\r"); assert.deepEqual(selected, [choices[49]]);
  menu.handleInput("\x1b"); assert.deepEqual(selected, [choices[49], undefined]);
});
