import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { bundleNode, compileProject, root } from "./compile-project.mjs";

await rm(new URL("../lib/", import.meta.url), { recursive: true, force: true });
compileProject("tsconfig.cli.json");
await bundleNode("src/extension/setup/workspace-cli.ts", resolve(root, "lib/extension/workspace-cli.js"));
