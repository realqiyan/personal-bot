import { basename, extname } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage, type FileBlock, type ImageBlock } from "@deepseek-ai/dsh-llm";
import type { AttachmentAdmissionPart, ImageMediaType } from "@deepseek-ai/dsh-attachment";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import type { AgentDescriptor, AgentMessage } from "../../model/agent.js";
import { requireThat } from "../../common/validation.js";
import "./messages.js";

const imageTypes: Record<string, ImageMediaType> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

/** Native file attachments remain verbatim; image admission uses the host's policy. */
async function contentFor(ctx: Context, cwd: string, message: string, files: readonly string[], signal: AbortSignal) {
  const content: AttachmentAdmissionPart[] = [];
  let imageCount = 0, imageBytes = 0;
  for (const path of files) {
    signal.throwIfAborted();
    const target = await ctx.fs.resolve(path, { cwd, signal });
    const before = await ctx.fs.stat(target, signal);
    requireThat(before?.type === "file", "附件必须是普通文件：" + path);
    const name = basename(path), mediaType = imageTypes[extname(path).toLowerCase()];
    if (mediaType) {
      const limits = ctx.attachments.imageLimits;
      requireThat(++imageCount <= limits.maxImagesPerMessage &&
        (before.size === undefined || imageBytes + before.size <= limits.maxMessageImageBytes), "图片附件超过宿主消息准入上限。");
      const data = await ctx.fs.readBytes(target, signal, limits.maxImageBytes);
      imageBytes += data.byteLength;
      requireThat(imageBytes <= limits.maxMessageImageBytes, "图片附件超过宿主消息准入上限。");
      content.push({ type: "image", mediaType, name, data: Buffer.from(data).toString("base64") });
    } else {
      async function* bytes(file: FsTarget) {
        let offset = 0;
        for (;;) {
          signal.throwIfAborted();
          const chunk = await ctx.fs.readByteRange(file, { offset, length: 256 * 1024 }, signal);
          if (!chunk.length) break;
          yield chunk; offset += chunk.length;
        }
        requireThat((await ctx.fs.stat(file, signal))?.version === before?.version, "读取期间附件已变化：" + path);
      }
      content.push({ type: "file", attachment: await ctx.attachments.saveFileStream({ data: bytes(target), name, signal }) });
    }
    requireThat((await ctx.fs.stat(target, signal))?.version === before.version, "读取期间附件已变化：" + path);
    content.push({ type: "text", text: "附件原始路径：" + JSON.stringify(path) + "。原生附件保留本次文件内容；需要查看时使用宿主提供的附件路径。" });
  }
  content.push({ type: "text", text: message || "请处理所附文件。" });
  const admitted = await ctx.attachments.admitPromptContent(content);
  signal.throwIfAborted(); return admitted;
}

export async function dshInput(ctx: Context, d: AgentDescriptor, request: AgentMessage, signal: AbortSignal) {
  const content = await contentFor(ctx, d.cwd, request.message, request.files, signal);
  return createUserMessage({ content, source: { kind: "pbot-input", form: "relay",
    requestId: request.requestId, generation: request.generation, parentSessionId: d.parentSessionId } });
}

/** Command attachments have already passed native upload admission; the caller never supplies arbitrary references. */
export async function dshHumanInput(ctx: Context, cwd: string, text: string, files: readonly string[],
  attachments: readonly (ImageBlock | FileBlock)[], signal: AbortSignal) {
  requireThat(files.length + attachments.length <= 32, "一次最多附加 32 个文件。");
  requireThat(!files.length || !attachments.length, "一次对话请选择服务器文件或输入框附件，不能同时使用。");
  signal.throwIfAborted();
  const content = attachments.length ? [...attachments, { type: "text" as const, text: text || "请处理所附文件。" }] :
    await contentFor(ctx, cwd, text, files, signal);
  signal.throwIfAborted(); return createUserMessage({ content, source: { kind: "user" } });
}
