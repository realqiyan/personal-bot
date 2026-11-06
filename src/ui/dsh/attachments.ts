import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-file-upload/client";
import type { CommandSubmitAttachment } from "@deepseek-ai/dsh-commands/types";
import type { ImageMediaType } from "@deepseek-ai/dsh-attachment/types";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

const images = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function encodedImage(file: File, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const reader = new FileReader(), abort = () => reader.abort();
    signal.addEventListener("abort", abort, { once: true });
    reader.onloadend = () => signal.removeEventListener("abort", abort);
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败。"));
    reader.onabort = () => reject(signal.reason ?? new DOMException("图片读取已取消。", "AbortError"));
    reader.onload = () => {
      if (typeof reader.result !== "string") reject(new Error("图片读取失败。"));
      else resolve(reader.result.slice(reader.result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Native commands admit encoded images and resolve session-owned file receipts. */
export async function commandAttachments(ctx: Context, sessionId: SessionId, files: readonly File[],
  signal: AbortSignal, progress: (message: string) => void): Promise<CommandSubmitAttachment[]> {
  if (files.length > 32) throw new Error("一次最多附加 32 个文件。");
  const attachments: CommandSubmitAttachment[] = [];
  for (const file of files) {
    signal.throwIfAborted(); progress("正在准备附件：" + file.name);
    if (images.has(file.type)) {
      attachments.push({ type: "image", mediaType: file.type as ImageMediaType, name: file.name, data: await encodedImage(file, signal) });
    } else {
      const result = await ctx.fileUpload.upload(sessionId, file, file.name, signal,
        value => progress(`正在上传 ${file.name}：${value.loaded} / ${value.total ?? file.size} 字节`));
      if (!result.ok) throw new Error(result.error.message);
      attachments.push({ type: "file", receiptId: result.value.receiptId });
    }
  }
  signal.throwIfAborted(); return attachments;
}
