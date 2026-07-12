import { resolve } from "node:path";

import type { InspectCliArguments } from "../cli-args.js";
import { inspectAssetFile, type AssetInspection } from "./asset.js";

export function runInspectCommand(
  arguments_: InspectCliArguments,
  cwd: string,
  signal?: AbortSignal
): Promise<AssetInspection> {
  return inspectAssetFile(resolve(cwd, arguments_.input), signal);
}
