import { createInterface } from "node:readline/promises";

export class SetupUI {
  constructor(private readonly controller: AbortController) {}
  text(value: string) { console.log(value); }
  async ask(label: string, fallback = ""): Promise<string> {
    this.controller.signal.throwIfAborted();
    const reader = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    reader.on("SIGINT", () => this.controller.abort(new Error("安装已取消。")));
    reader.on("close", () => { if (!answered) this.controller.abort(new Error("输入已关闭。")); });
    let answered = false;
    try {
      const value = await reader.question(label + (fallback ? " [" + fallback + "]" : "") + ": ", { signal: this.controller.signal });
      answered = true;
      return value.trim() || fallback;
    } finally { answered = true; reader.close(); }
  }
  async confirm(label: string, fallback = true): Promise<boolean> {
    while (true) {
      const answer = (await this.ask(label + (fallback ? " [Y/n]" : " [y/N]"))).toLowerCase();
      if (!answer) return fallback;
      if (["y", "yes", "是"].includes(answer)) return true;
      if (["n", "no", "否"].includes(answer)) return false;
      this.text("请输入 y 或 n。");
    }
  }
  async selectMany(labels: string[], defaults: number[]): Promise<number[]> {
    labels.forEach((label, index) => this.text("  " + (defaults.includes(index) ? "[x] " : "[ ] ") + (index + 1) + ". " + label));
    while (true) {
      const answer = await this.ask("选择插件编号（逗号分隔，回车保留默认，0 不选）");
      if (!answer) return defaults;
      if (answer === "0") return [];
      const parts = answer.split(/[,，\s]+/);
      if (parts.every(part => /^\d+$/.test(part) && Number(part) >= 1 && Number(part) <= labels.length)) {
        return [...new Set(parts.map(part => Number(part) - 1))];
      }
      this.text("请输入列表中的编号。");
    }
  }
}
