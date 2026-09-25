import { readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { FRAMEWORK_SOURCE_EXTENSIONS } from "./contracts.mjs";
import { moduleSpecifier, parseArchitectureSource, visitAst } from "./source-analysis.mjs";

/** Alpha has a separate video contract; its adapters share only the alpha core. */
export async function collectAlphaProvenanceViolations(root, files, violations) {
  for (const path of files) {
    const packageName = /^packages\/(alpha(?:-react|-svelte)?)\/src\//u.exec(path)?.[1];
    if (!packageName || !FRAMEWORK_SOURCE_EXTENSIONS.has(extname(path))) continue;
    const framework = packageName.slice("alpha-".length);
    const sourceRoot = resolve(root, "packages", packageName, "src");
    const ast = parseArchitectureSource(path, await readFile(join(root, path), "utf8"));
    visitAst(ast, (node) => {
      const specifier = moduleSpecifier(node);
      if (specifier === null) {
        if (node.type === "ImportExpression") violations.push(`${path}: alpha dynamic imports must have a static specifier`);
        return;
      }
      if (specifier.startsWith(".")) {
        const within = relative(sourceRoot, resolve(dirname(join(root, path)), specifier));
        if (within.startsWith("..")) violations.push(`${path}: alpha relative imports must stay inside their own package`);
        return;
      }
      if (packageName !== "alpha" && ["@pixel-point/aval-alpha", "@pixel-point/aval-alpha/adapter"].includes(specifier)) return;
      if (packageName !== "alpha" && (specifier === framework || specifier.startsWith(framework + "/"))) return;
      violations.push(`${path}: unexpected alpha dependency ${specifier}`);
    });
  }
}
