import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AgentMessage } from "../../model/agent.js";
import { requireThat } from "../../common/validation.js";

/** Local ACP agents can continue reading each absolute source with their native tools. */
export async function acpContent(request: AgentMessage, images: boolean, signal: AbortSignal): Promise<ContentBlock[]> {
  const content: ContentBlock[] = [{ type: "text", text: request.message }];
  for (const file of request.files) {
    signal.throwIfAborted();
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat(); requireThat(info.isFile(), "附件必须是普通文件：" + file);
      const prefix = Buffer.alloc(Math.min(info.size, 60000)), read = await handle.read(prefix, 0, prefix.length, 0);
      const bytes = prefix.subarray(0, read.bytesRead);
      const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
        : /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6)) ? "image/gif"
        : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
      if (mimeType) {
        requireThat(images, "目标 ACP 会话不支持图片附件。");
        const data = await handle.readFile();
        signal.throwIfAborted();
        content.push({ type: "text", text: "附件来源：" + file }, { type: "image", data: data.toString("base64"), mimeType });
        continue;
      }
      let text: string | undefined;
      try { if (!bytes.includes(0)) text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: info.size > bytes.length }); }
      catch { /* Native tools handle non-text attachments through their source link. */ }
      if (text === undefined) content.push({ type: "resource_link", uri: pathToFileURL(file).href, name: basename(file) });
      else content.push({ type: "text", text: "附件来源：" + file + "\n\n" + text.slice(0, 20000) +
        (info.size > bytes.length || text.length > 20000 ? "\n\n附件已截断，请沿上述路径续读。" : "") });
    } finally { await handle.close(); }
  }
  return content;
}
