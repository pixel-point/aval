import { dirname, join, resolve } from "node:path";

import { readBoundedRegularFile } from "../bounded-file.js";
import { resolveExistingLocalFile } from "../local-path.js";
import { parseSourceProject } from "../source-project-schema.js";

/** Resolve the project plus every exact local source file it declares. */
export async function resolveProjectWatchPaths(
  projectPath: string
): Promise<readonly string[]> {
  const root = dirname(projectPath);
  const project = parseSourceProject(await readBoundedRegularFile({
    path: projectPath,
    maxBytes: 1024 * 1024,
    label: "project JSON",
    limitCode: "SOURCE_LIMIT"
  }));
  const paths = new Set<string>([resolve(projectPath)]);
  for (const source of project.sources) {
    if (source.type === "video") {
      paths.add(await resolveExistingLocalFile(root, source.path, true));
      continue;
    }
    for (let index = 0; index < source.frameCount; index += 1) {
      const number = source.firstNumber + index;
      const file = join(
        source.directory,
        `${source.prefix}${String(number).padStart(source.digits, "0")}${source.suffix}`
      );
      paths.add(await resolveExistingLocalFile(root, file, true));
    }
  }
  return Object.freeze([...paths].sort());
}
