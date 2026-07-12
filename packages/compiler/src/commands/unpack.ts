import { resolve } from "node:path";

import type { UnpackCliArguments } from "../cli-args.js";
import { unpackAssetFile, type UnpackReport } from "./unpack-asset.js";

export function runUnpackCommand(
  arguments_: UnpackCliArguments,
  cwd: string,
  signal?: AbortSignal
): Promise<Readonly<UnpackReport>> {
  return unpackAssetFile(
    resolve(cwd, arguments_.input),
    resolve(cwd, arguments_.output),
    signal
  );
}
