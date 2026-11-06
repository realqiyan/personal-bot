import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, Text, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** A read-only page; input stays in Pi's native editor. */
export class Reader implements Component {
  private readonly content: Text;
  private readonly scroll: ScrollView;
  constructor(private readonly title: string, body: string, private readonly theme: Theme, private readonly keys: KeybindingsManager,
    private readonly rows: () => number, private readonly redraw: () => void, private readonly done: () => void) {
    this.content = new Text(body, 0, 0); this.scroll = new ScrollView(this.content, { overscroll: "contain", scrollbar: "hidden" });
  }
  invalidate() { this.content.invalidate(); }
  render(width: number) {
    const height = Math.max(1, Math.floor(this.rows() * 0.8)), inner = Math.max(1, width - 2);
    const content = this.scroll.render(inner), viewport = Math.max(1, height - 4);
    this.scroll.updateLayout(content.length, viewport, this.redraw);
    const start = this.scroll.scrollTop;
    return [this.theme.fg("accent", this.theme.bold(this.title)), "",
      ...content.slice(start, start + viewport), "",
      this.theme.fg("dim", `${start + 1}–${Math.min(start + viewport, content.length)}/${content.length} · ↑↓滚动 PgUp/PgDn翻页 Esc返回`)]
      .slice(0, height).map(line => truncateToWidth(line, Math.max(1, width)));
  }
  handleInput(data: string) {
    if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) { this.done(); return; }
    if (this.keys.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
    else if (this.keys.matches(data, "tui.select.down")) this.scroll.scrollBy(1);
    else if (matchesKey(data, "pageUp")) this.scroll.scrollBy(-this.scroll.viewportHeight);
    else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.scroll.scrollBy(this.scroll.viewportHeight);
    else if (matchesKey(data, "home")) this.scroll.scrollToStart();
    else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
    this.redraw();
  }
}

export async function readPage(ctx: ExtensionContext, title: string, body: string) {
  if (ctx.mode !== "tui") { ctx.ui.notify(body, "info"); return; }
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    let finished = false;
    const finish = () => { if (!finished) { finished = true; done(); } };
    const reader = new Reader(title, body, theme, keys, () => tui.terminal.rows, () => tui.requestRender(), finish);
    ctx.signal?.addEventListener("abort", finish, { once: true });
    if (ctx.signal?.aborted) queueMicrotask(finish);
    return { render: width => reader.render(width), invalidate: () => reader.invalidate(), handleInput: data => reader.handleInput(data),
      dispose: () => ctx.signal?.removeEventListener("abort", finish) };
  });
}
