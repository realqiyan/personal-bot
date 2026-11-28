import { resolve } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { bundleNode, root } from "./compile-project.mjs";

export const workspaceCliShim = `import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
export { main, updateForCommand, updateForWorkspace } from "./cli.js";
import { main } from "./cli.js";

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
`;

if (process.argv[1] && resolve(process.argv[1]) === resolve(root, "scripts/build-cli.mjs")) {
  await rm(new URL("../lib/", import.meta.url), { recursive: true, force: true });
  await bundleNode("src/extension/cli/index.ts", resolve(root, "lib/extension/cli.js"));
  await writeFile(resolve(root, "lib/extension/workspace-cli.js"), workspaceCliShim);
}
