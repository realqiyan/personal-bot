import { relative, isAbsolute } from "node:path";
import { mutationTarget } from "../../common/files.js";
import { requireThat } from "../../common/validation.js";

export function mutationScope(root: string, target: string): "outside" | "inside" {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return "outside";
  return "inside";
}
export async function authorizeMutation(root: string, path: string, change: unknown,
  confirm: (value: unknown) => Promise<boolean>, signal: AbortSignal) {
  signal.throwIfAborted();
  const target = await mutationTarget(path), scope = mutationScope(root, target);
  if (scope === "outside") requireThat(await confirm({ path: target, change }), "用户未确认文件修改。");
  signal.throwIfAborted();
  requireThat(await mutationTarget(path) === target, "确认期间文件路径已变化。");
}
