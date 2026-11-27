import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as Acp from "@deepseek-ai/dsh-acp";
import * as Member from "../../dist/extension/hosts/dsh/acp-member.js";
import { dshHost } from "./dsh-host.mjs";

// Real dsh ACP, Agent loop and disk storage, with no provider adapter or credentials.
const directory = join(process.env.DSH_HOME, "sessions");
await mkdir(directory, { recursive: true });
const host = await dshHost(directory, { presets: true });
await host.ctx.plugin(Member);
await host.ctx.plugin(Acp);
let closing;
const close = () => closing ??= host.close().finally(() => { process.exitCode = 0; });
process.stdin.on("end", () => { void close(); });
process.on("SIGTERM", () => { void close(); });
process.on("SIGINT", () => { void close(); });
