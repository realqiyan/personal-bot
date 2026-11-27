import { object } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";

export type ParsedHistoryCommand =
  | { kind: "status" }
  | { kind: "list" }
  | { kind: "migrate"; dryRun: boolean }
  | { kind: "summary"; dimensions?: string[]; force: boolean; backend?: string; model?: string; thinking?: string }
  | { kind: "query"; input: Record<string, unknown> };

export const historyCommandUsage =
  '用法：/pbot history summary [维度...] [--force] [--backend <acp>] [--model <model>] [--thinking <level>] | migrate [--dry-run] | status | list | {"action":"search"|"read",...}';

export function parseHistoryCommand(raw: string): ParsedHistoryCommand {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "status") return { kind: "status" };
  if (trimmed === "list") return { kind: "list" };
  if (trimmed.startsWith("{")) {
    const parsed: unknown = JSON.parse(trimmed);
    requireThat(object(parsed), "历史查询参数必须是 JSON 对象。");
    return { kind: "query", input: parsed };
  }
  const tokens = trimmed.split(/\s+/);
  const sub = tokens[0];
  if (sub === "migrate") {
    let dryRun = false;
    for (const token of tokens.slice(1)) {
      if (token === "--dry-run") dryRun = true;
      else throw new Error(`未知参数：${token}\n${historyCommandUsage}`);
    }
    return { kind: "migrate", dryRun };
  }
  if (sub === "summary") {
    let force = false;
    let backend: string | undefined;
    let model: string | undefined;
    let thinking: string | undefined;
    const dimensions: string[] = [];
    const rest = tokens.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i]!;
      if (token === "--force" || token === "-f") {
        force = true;
      } else if (token === "--backend") {
        backend = rest[++i];
        requireThat(backend && !backend.startsWith("-"), "--backend 需要指定 ACP 后端名称（如 pi、dsh、claude）。");
      } else if (token === "--model") {
        model = rest[++i];
        requireThat(model && !model.startsWith("-"), "--model 需要指定模型标识。");
      } else if (token === "--thinking") {
        thinking = rest[++i];
        requireThat(thinking && !thinking.startsWith("-"), "--thinking 需要指定思考深度。");
      } else if (token.startsWith("-")) {
        throw new Error(`未知参数：${token}\n${historyCommandUsage}`);
      } else {
        dimensions.push(token);
      }
    }
    return {
      kind: "summary",
      ...(dimensions.length ? { dimensions } : {}),
      force,
      ...(backend ? { backend } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
    };
  }
  throw new Error(historyCommandUsage);
}
