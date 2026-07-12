import { resolve } from "node:path";

import type { ValidateCliArguments } from "../cli-args.js";
import {
  validateAssetReport,
  type AssetValidationReport
} from "./asset.js";

export function runValidateCommand(
  arguments_: ValidateCliArguments,
  cwd: string,
  signal?: AbortSignal
): Promise<Readonly<AssetValidationReport>> {
  return validateAssetReport(resolve(cwd, arguments_.input), signal);
}
