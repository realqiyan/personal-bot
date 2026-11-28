import { rm } from "node:fs/promises";
import { compileProject } from "./compile-project.mjs";

await rm(new URL("../lib/", import.meta.url), { recursive: true, force: true });
compileProject("tsconfig.cli.json");
