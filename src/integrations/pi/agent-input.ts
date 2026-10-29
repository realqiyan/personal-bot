import { resolve } from "node:path";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../model/agent.js";

export async function agentInput(cwd: string, request: Pick<AgentMessage, "requestId" | "files" | "message">,
  signal?: AbortSignal): Promise<(TextContent | ImageContent)[]> {
  const content: (TextContent | ImageContent)[] = [];
  const read = createReadTool(cwd);
  for (const file of request.files) {
    const path = resolve(cwd, file);
    const output = await read.execute("file-" + request.requestId, { path }, signal);
    content.push({ type: "text", text: "附件来源（绝对 path）：" + JSON.stringify(path) +
      "\n以下为原生 read 内容；如有截断，按原生提示用此 path 与 offset/limit 续读。" });
    content.push(...output.content.filter((part): part is TextContent | ImageContent => part.type === "text" || part.type === "image"));
  }
  content.push({ type: "text", text: request.message || "请处理所附文件。" });
  return content;
}
