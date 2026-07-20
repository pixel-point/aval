#!/usr/bin/env node
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

import {
  hasAvalHostSrc,
  hasAvalFallbackSlot,
  hasErrorListenerAfterDefinition,
  hasMissingInteractiveRecovery,
  hasRemovedImageApi,
  hasStaticReadyInRenderedSet,
  hasUnfilteredAvalErrorHandler
} from "./public-boundary-guards.mjs";

const required = [
  "README.md", "docs/quick-start.md", "docs/states-and-triggers.md",
  "docs/element-api.md", "docs/compiler.md",
  "docs/compiler/authoring-video-and-states.md",
  "docs/network-and-integrity.md",
  "docs/accessibility-and-motion.md", "docs/performance-and-budgets.md",
  "docs/troubleshooting.md", "docs/browser-support.md", "docs/format/1.0.md",
  "docs/format/1.1.md",
  "docs/project/1.0.md", "docs/security.md", "docs/versioning.md",
  "docs/releases/1.0.0.md",
  "docs/certification/method.md", "SECURITY.md", "THREAT-MODEL.md",
  "THIRD_PARTY_NOTICES.md"
];
const failures = [];
for (const path of required) {
  try { await access(path); } catch { failures.push(`${path}: required document is missing`); }
}
const files = [];
await collect("docs", files);
files.push("README.md", "SECURITY.md", "THREAT-MODEL.md", "THIRD_PARTY_NOTICES.md");
for (const path of files) {
  const text = await readFile(path, "utf8");
  const historical = path.startsWith("docs/superpowers/") ||
    path.startsWith("docs/evidence/");
  if (/@pixel-point\/aval-[a-z-]+\/src\/|\.\.\/src\//u.test(text)) failures.push(`${path}: source-private import in public documentation`);
  if (hasRemovedImageApi(text)) failures.push(`${path}: removed external image API is still documented`);
  if (
    !historical &&
    hasAvalFallbackSlot(text)
  ) failures.push(`${path}: AVAL-owned fallback slot is still documented`);
  if (
    !historical &&
    /addEventListener\(\s*["']fallback["']/u.test(text)
  ) failures.push(`${path}: removed AVAL fallback event is still documented`);
  if (!historical && hasAvalHostSrc(text)) failures.push(`${path}: removed aval-player src authority is still documented`);
  if (!historical && hasUnfilteredAvalErrorHandler(text)) failures.push(`${path}: AVAL error handlers must filter fatal events`);
  if (!historical && hasErrorListenerAfterDefinition(text)) failures.push(`${path}: AVAL error listeners must be installed before explicit definition`);
  if (!historical && hasMissingInteractiveRecovery(text)) failures.push(`${path}: consumer alternate UI must recover only at interactive readiness`);
  if (!historical && hasStaticReadyInRenderedSet(text)) failures.push(`${path}: static policy must not be classified as rendered playback`);
  if (!historical && /\b(?:displayed|scanout)(?:Time|Timestamp)\b/u.test(text)) failures.push(`${path}: forbidden display claim field`);
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1];
    if (target === undefined || /^(?:https?:|mailto:|#)/u.test(target)) continue;
    const withoutAnchor = target.split("#")[0];
    if (withoutAnchor.length === 0 || withoutAnchor.includes("<")) continue;
    try { await access(resolve(dirname(path), decodeURIComponent(withoutAnchor))); }
    catch { failures.push(`${path}: broken relative link ${target}`); }
  }
}
const publicBoundaryFiles = [];
const intentionalNegativeHostSrcFixtures = new Set([
  "examples/react-ref/src/type-contract.tsx"
]);
for (const root of [
  "apps/playground",
  "examples",
  "fixtures/starter",
  "packages/compiler/src/commands"
]) await collectPublicBoundaryFiles(root, publicBoundaryFiles);
publicBoundaryFiles.push("packages/element/README.md");
for (const path of publicBoundaryFiles) {
  const text = await readFile(path, "utf8");
  if (hasRemovedImageApi(text)) {
    failures.push(`${path}: removed external image API is still exposed at the public boundary`);
  }
  if (hasAvalFallbackSlot(text)) {
    failures.push(`${path}: public UI must keep alternate content outside aval-player`);
  }
  if (/addEventListener\(\s*["']fallback["']/u.test(text)) {
    failures.push(`${path}: public UI must not recreate the removed fallback event`);
  }
  if (
    !intentionalNegativeHostSrcFixtures.has(path) &&
    hasAvalHostSrc(text)
  ) failures.push(`${path}: public UI must not use removed aval-player src authority`);
  if (hasUnfilteredAvalErrorHandler(text)) failures.push(`${path}: AVAL error handlers must filter fatal events`);
  if (hasErrorListenerAfterDefinition(text)) failures.push(`${path}: AVAL error listeners must be installed before explicit definition`);
  if (hasMissingInteractiveRecovery(text)) failures.push(`${path}: consumer alternate UI must recover only at interactive readiness`);
  if (hasStaticReadyInRenderedSet(text)) failures.push(`${path}: static policy must not be classified as rendered playback`);
}
const expectedInstallSequence = [
  "npm install @pixel-point/aval-element@1.0.0",
  "npm install --save-dev @pixel-point/aval-compiler@1.0.0",
  "npx avl init my-motion",
  "cd my-motion",
  "npm install",
  "npm run dev"
].join("\n");
for (const path of ["README.md", "docs/quick-start.md"]) {
  const text = await readFile(path, "utf8");
  if (!text.includes(expectedInstallSequence)) failures.push(`${path}: exact public install sequence is missing`);
  if (!text.includes("resolves the `avl` executable from the compiler package")) failures.push(`${path}: npx avl local-binary context is missing`);
}
const elementReadme = await readFile("packages/element/README.md", "utf8");
if (!elementReadme.includes("npm install @pixel-point/aval-element@1.0.0")) failures.push("packages/element/README.md: exact public install is missing");
const compilerReadme = await readFile("packages/compiler/README.md", "utf8");
if (!compilerReadme.includes("npm install --save-dev @pixel-point/aval-compiler@1.0.0\nnpx avl init my-motion")) failures.push("packages/compiler/README.md: local compiler install sequence is missing");
const hosting = await readFile("docs/element/hosting-cors-csp-integrity.md", "utf8");
if (hosting.includes(["unsafe", "inline"].join("-"))) failures.push("docs/element/hosting-cors-csp-integrity.md: CSP must not require inline authority");
if (!hosting.includes("style-src 'self'") || !hosting.includes("worker-src 'self'")) failures.push("docs/element/hosting-cors-csp-integrity.md: strict self-hosted CSP baseline is incomplete");
const budgets = await readFile("docs/performance-and-budgets.md", "utf8");
for (const claim of [
  "@pixel-point/aval-element/auto",
  "at most **60,000 bytes with Brotli quality 11**",
  "complete working player: **54,922 Brotli bytes**",
  "5,078 bytes of headroom"
]) {
  if (!budgets.includes(claim)) failures.push(`docs/performance-and-budgets.md: missing size decision: ${claim}`);
}
const authoring = await readFile(
  "docs/compiler/authoring-video-and-states.md",
  "utf8"
);
const compilerOverview = await readFile("docs/compiler.md", "utf8");
if (!compilerOverview.includes("AVAL contains no embedded poster, static image, or host fallback bytes")) {
  failures.push("docs/compiler.md: missing motion-only container contract");
}
if (/emits?\s+(?:strict\s+)?per-state\s+PNGs?/iu.test(compilerOverview)) {
  failures.push("docs/compiler.md: still claims embedded per-state PNG output");
}
for (const claim of [
  ".mov`, `.mp4`, and `.m4v",
  "numbered RGBA PNG sequences",
  "progressive frames",
  "square pixels",
  "rotation metadata cleared",
  "half-open",
  '"states"',
  '"edges"',
  '"bindings"',
  "does not downscale",
  "npm run avl -- compile",
  "npm run avl -- dev",
  "npm run avl -- inspect",
  "npm run avl -- validate",
  'from "@pixel-point/aval-element"'
]) {
  if (!authoring.includes(claim)) {
    failures.push(`docs/compiler/authoring-video-and-states.md: missing authoring contract: ${claim}`);
  }
}
const support = await readFile("docs/browser-support.md", "utf8");
for (const claim of [
  "Firefox 130 is the candidate desktop playback floor",
  "pending recorded AVAL",
  "BrowserStack qualification",
  "Firefox 129 is a one-release feature-floor exception",
  "literal 24-month promise",
  "`unsupported-profile`",
  "Firefox for Android remains uncertified"
]) {
  if (!support.includes(claim)) {
    failures.push(`docs/browser-support.md: missing Firefox support contract: ${claim}`);
  }
}
const index = JSON.parse(await readFile("docs/certification/1.0.0/index.json", "utf8"));
const generated = renderSupport(index);
const captured = support.match(/<!-- BEGIN GENERATED SUPPORT -->\n([\s\S]*?)\n<!-- END GENERATED SUPPORT -->/u)?.[1];
if (captured !== generated) failures.push("docs/browser-support.md: generated support table is stale");
for (const directory of ["examples/zero-config-loop", "examples/idle-hover-states", "examples/network-integrity"]) {
  const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (packageJson.dependencies?.["@pixel-point/aval-element"] !== "1.0.0") failures.push(`${directory}: example must use exact element 1.0.0`);
  const source = await readFile(join(directory, "src/main.ts"), "utf8");
  if (!source.includes('from "@pixel-point/aval-element"')) failures.push(`${directory}: example must use the public package root`);
  const exampleReadme = await readFile(join(directory, "README.md"), "utf8");
  if (!exampleReadme.includes("illustrative")) failures.push(`${directory}: placeholder assets must be labeled illustrative`);
  const html = await readFile(join(directory, "index.html"), "utf8");
  if (hasAvalFallbackSlot(html)) failures.push(`${directory}: example must keep consumer error UI outside aval-player`);
}
const reactDirectory = "examples/react-ref";
const reactPackage = JSON.parse(await readFile(join(reactDirectory, "package.json"), "utf8"));
const reactLock = JSON.parse(await readFile(join(reactDirectory, "package-lock.json"), "utf8"));
if (reactPackage.peerDependencies?.["@pixel-point/aval-element"] !== "1.0.0") failures.push(`${reactDirectory}: example must target exact element 1.0.0`);
if (reactPackage.peerDependenciesMeta?.["@pixel-point/aval-element"]?.optional !== true) failures.push(`${reactDirectory}: unpublished element peer must remain optional until packed verification`);
for (const [name, version] of Object.entries({
  react: "19.2.7",
  "react-dom": "19.2.7"
})) {
  if (reactPackage.dependencies?.[name] !== version) failures.push(`${reactDirectory}: ${name} must be exactly ${version}`);
}
for (const [name, version] of Object.entries({
  "@types/react": "19.2.17",
  "@types/react-dom": "19.2.3",
  typescript: "7.0.2",
  vite: "8.1.4"
})) {
  if (reactPackage.devDependencies?.[name] !== version) failures.push(`${reactDirectory}: ${name} must be exactly ${version}`);
}
if (JSON.stringify(reactLock.packages?.[""] ?? {}) !== JSON.stringify({
  name: reactPackage.name,
  version: reactPackage.version,
  dependencies: reactPackage.dependencies,
  devDependencies: reactPackage.devDependencies,
  peerDependencies: reactPackage.peerDependencies,
  peerDependenciesMeta: reactPackage.peerDependenciesMeta
})) failures.push(`${reactDirectory}: isolated package lock root is stale`);
const reactSource = await readFile(join(reactDirectory, "src/StatusMotion.tsx"), "utf8");
const reactAugmentation = await readFile(join(reactDirectory, "src/aval-player-jsx.d.ts"), "utf8");
if (!reactSource.includes('from "@pixel-point/aval-element"') || /@pixel-point\/aval-element\//u.test(reactSource)) failures.push(`${reactDirectory}: component must use only the public element package root`);
if (hasAvalFallbackSlot(reactSource)) failures.push(`${reactDirectory}: component must not give AVAL ownership of alternate UI`);
if (!reactSource.includes('addEventListener("error"') || !reactSource.includes("setFailed(true)")) failures.push(`${reactDirectory}: component must handle terminal playback failure in React-owned UI`);
if (!reactAugmentation.includes('declare module "react"') || !reactAugmentation.includes("AvalElementAttributes")) failures.push(`${reactDirectory}: copyable React JSX augmentation is missing`);
const plainDirectory = "examples/plain-html";
const plainPackage = JSON.parse(await readFile(join(plainDirectory, "package.json"), "utf8"));
const plainHtml = await readFile(join(plainDirectory, "index.html"), "utf8");
const plainSource = await readFile(join(plainDirectory, "main.js"), "utf8");
const plainReadme = await readFile(join(plainDirectory, "README.md"), "utf8");
if (plainPackage.dependencies?.["@pixel-point/aval-element"] !== "1.0.0") failures.push(`${plainDirectory}: example must use exact element 1.0.0`);
if (plainPackage.devDependencies?.vite !== "8.1.4") failures.push(`${plainDirectory}: example must pin the package-aware web tool`);
if (!plainSource.includes('from "@pixel-point/aval-element"')) failures.push(`${plainDirectory}: example must use the public package root`);
if (hasAvalFallbackSlot(plainHtml)) failures.push(`${plainDirectory}: alternate UI must remain outside aval-player`);
if (/<(?:script|style)[^>]*>[^<]/u.test(plainHtml)) failures.push(`${plainDirectory}: example must not require inline script or style authority`);
if (!plainReadme.includes("illustrative") || !plainReadme.includes("placeholders")) failures.push(`${plainDirectory}: absent assets must be labeled illustrative placeholders`);
const starterHtml = await readFile("fixtures/starter/v1-idle-hover/index.html", "utf8");
const starterSource = await readFile("fixtures/starter/v1-idle-hover/main.js", "utf8");
if (/<(?:script|style)[^>]*>[^<]/u.test(starterHtml)) failures.push("generated starter must not require inline script or style authority");
if (!starterSource.includes('"@pixel-point/aval-element/auto"')) failures.push("generated starter must use the public auto entry");
if (hasAvalFallbackSlot(starterHtml)) failures.push("generated starter must keep alternate UI outside aval-player");
for (const path of [
  "packages/compiler/src/commands/init.ts",
  "packages/compiler/src/commands/dev-ui-assets.ts"
]) {
  const source = await readFile(path, "utf8");
  if (hasAvalFallbackSlot(source)) {
    failures.push(`${path}: generated UI must not give AVAL ownership of alternate content`);
  }
  if (/addEventListener\(\s*["']fallback["']/u.test(source)) {
    failures.push(`${path}: generated UI must not recreate the removed fallback event`);
  }
}
if (failures.length > 0) throw new Error(failures.join("\n"));
process.stdout.write(`${JSON.stringify({ status: "passed", documents: files.length, examples: 5 })}\n`);

function renderSupport(index) {
  if (!Array.isArray(index.profiles) || index.profiles.length === 0) return [
    "| Profile | Fatal error boundary | Runtime scheduling | Observed display |",
    "| --- | --- | --- | --- |",
    "| No named profiles | not run | not run | not measured |"
  ].join("\n");
  return [
    "| Profile | Fatal error boundary | Runtime scheduling | Observed display |",
    "| --- | --- | --- | --- |",
    ...index.profiles.map((profile) => `| ${profile.profileId} | ${label(profile.fatalErrorBoundary)} | ${label(profile.runtimeScheduling)} | ${profile.observedDisplay === "not-run" ? "not measured" : label(profile.observedDisplay)} |`)
  ].join("\n");
}
function label(value) { return String(value).replaceAll("-", " "); }
async function collect(directory, output) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path, output);
    else if (entry.isFile() && extname(entry.name) === ".md") output.push(path);
  }
}
async function collectPublicBoundaryFiles(directory, output) {
  const allowed = new Set([".html", ".js", ".md", ".ts", ".tsx"]);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules" || entry.name === "public") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectPublicBoundaryFiles(path, output);
    else if (entry.isFile() && allowed.has(extname(entry.name))) output.push(path);
  }
}
