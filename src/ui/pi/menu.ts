import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** A bounded native list, including when the terminal is resized. */
export class Menu implements Component {
  private list: SelectList | undefined;
  private visible = 0;
  constructor(private readonly title: string, private readonly choices: string[], private readonly theme: Theme,
    private readonly rows: () => number, private readonly redraw: () => void, private readonly done: (value: string | undefined) => void) {}
  invalidate() { this.list?.invalidate(); }
  render(width: number) {
    const height = Math.max(1, Math.floor(this.rows() * 0.8)), visible = Math.max(1, height - 5);
    if (visible !== this.visible) {
      const selected = Number(this.list?.getSelectedItem()?.value ?? 0); this.visible = visible;
      this.list = new SelectList(this.choices.map((label, index) => ({ value: String(index), label })), visible, {
        selectedPrefix: value => this.theme.fg("accent", value), selectedText: value => this.theme.fg("accent", value),
        description: value => this.theme.fg("muted", value), scrollInfo: value => this.theme.fg("dim", value), noMatch: value => this.theme.fg("dim", value),
      });
      this.list.setSelectedIndex(selected); this.list.onSelect = item => this.done(this.choices[Number(item.value)]); this.list.onCancel = () => this.done(undefined);
    }
    return [this.theme.fg("accent", this.theme.bold(this.title)), "", ...this.list!.render(Math.max(1, width)), "",
      this.theme.fg("dim", "↑↓选择 Enter打开 Esc返回")].slice(0, height).map(line => truncateToWidth(line, Math.max(1, width)));
  }
  handleInput(data: string) { this.list?.handleInput(data); this.redraw(); }
}

export function choose(ctx: ExtensionContext, title: string, choices: string[]) {
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    let finished = false;
    const finish = (value?: string) => { if (!finished) { finished = true; done(value); } };
    const abort = () => finish();
    const menu = new Menu(title, choices, theme, () => tui.terminal.rows, () => tui.requestRender(), finish);
    ctx.signal?.addEventListener("abort", abort, { once: true }); if (ctx.signal?.aborted) queueMicrotask(abort);
    return { render: width => menu.render(width), invalidate: () => menu.invalidate(), handleInput: data => menu.handleInput(data),
      dispose: () => ctx.signal?.removeEventListener("abort", abort) };
  });
}
