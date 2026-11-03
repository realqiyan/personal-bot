#!/usr/bin/env node
import { main } from "../lib/extension/setup-cli.js";
process.exitCode = await main(process.argv.slice(2));
