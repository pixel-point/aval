import { FormatError } from "../errors.js";

export function avcInvalid(
  path: string,
  message: string,
  offset?: number
): never {
  throw new FormatError("PROFILE_INVALID", message, {
    path,
    ...(offset === undefined ? {} : { offset })
  });
}
export function requireAvc(
  condition: boolean,
  path: string,
  message: string,
  offset?: number
): asserts condition {
  if (!condition) {
    avcInvalid(path, message, offset);
  }
}
