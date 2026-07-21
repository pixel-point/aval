#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { releasePackageDirectory } from "./release-set-model.mjs";

const config = JSON.parse(await readFile("config/release/api-classification.json", "utf8"));
const change = JSON.parse(await readFile("config/release/api-changes.json", "utf8"));
const failures = [];
if (
  change.releaseVersion !== "1.0.0" ||
  change.changeKind !== "technical-preview-reset" ||
  config.defaultClassification !== "experimental"
) failures.push("API change classification must identify the technical-preview reset");
for (const [name, packageConfig] of Object.entries(config.packages)) {
  const short = releasePackageDirectory(name);
  const reportPath = `etc/api/${short}.api.md`;
  let report;
  try { report = await readFile(reportPath, "utf8"); }
  catch { failures.push(`${name}: API report is missing`); continue; }
  if (!report.includes(`@packageDocumentation`) && !report.includes("API Report File")) failures.push(`${name}: API report is not generated output`);
  for (const item of [...(packageConfig.experimental ?? []), ...(packageConfig.deprecated ?? [])]) if (!report.includes(item)) failures.push(`${name}: classified item ${item} is absent from report`);
  if (/\b(?:internal|private)\//u.test(report)) failures.push(`${name}: internal path leaks into API report`);
}
if (failures.length > 0) throw new Error(failures.join("\n"));
process.stdout.write(`${JSON.stringify({ status: "passed", packages: Object.keys(config.packages).length, defaultClassification: config.defaultClassification })}\n`);
