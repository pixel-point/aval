#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildFreshElementDistribution } from "./fresh-public-build.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
await buildFreshElementDistribution(root);
