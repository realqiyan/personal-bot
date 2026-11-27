import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Native extension commands run before input handlers. Reaching this handler for
// /pbot init means it was not dispatched; never let the setup input reach a model.
export default function setupGuard(pi: ExtensionAPI) {
  pi.on("input", (event, ctx) => {
    if (event.text.trim() !== "/pbot init") return { action: "continue" };
    ctx.ui.notify("pbot 未加载或命令存在冲突。请检查项目信任和 pi config --local 后重新运行 setup。", "error");
    ctx.shutdown();
    return { action: "handled" };
  });
}
