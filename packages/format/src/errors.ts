export type FormatErrorCode =
  | "INPUT_INVALID"
  | "BUDGET_EXCEEDED"
  | "INTEGER_UNSAFE"
  | "HEADER_INVALID"
  | "VERSION_UNSUPPORTED"
  | "FEATURE_UNSUPPORTED"
  | "JSON_INVALID"
  | "JSON_DUPLICATE_KEY"
  | "JSON_DANGEROUS_KEY"
  | "JSON_NONCANONICAL"
  | "MANIFEST_INVALID"
  | "GRAPH_INVALID"
  | "INDEX_INVALID"
  | "LAYOUT_INVALID"
  | "PROFILE_INVALID"
  | "PNG_ENVELOPE_INVALID"
  | "PNG_DEFLATE_INVALID"
  | "PNG_SCANLINE_INVALID"
  | "WRITER_INVALID";

export interface FormatErrorDetails {
  readonly path?: string;
  readonly offset?: number;
}

/** A stable, immutable rejection surfaced by the format package. */
export class FormatError extends Error {
  public declare readonly code: FormatErrorCode;
  public declare readonly path?: string;
  public declare readonly offset?: number;

  public constructor(
    code: FormatErrorCode,
    message: string,
    details?: FormatErrorDetails
  ) {
    super(message);

    Object.defineProperties(this, {
      name: {
        value: "FormatError",
        enumerable: false,
        configurable: false,
        writable: false
      },
      code: {
        value: code,
        enumerable: true,
        configurable: false,
        writable: false
      }
    });

    if (details?.path !== undefined) {
      Object.defineProperty(this, "path", {
        value: details.path,
        enumerable: true,
        configurable: false,
        writable: false
      });
    }

    if (details?.offset !== undefined) {
      Object.defineProperty(this, "offset", {
        value: details.offset,
        enumerable: true,
        configurable: false,
        writable: false
      });
    }

    Object.freeze(this);
  }
}

export function isFormatError(error: unknown): error is FormatError {
  return error instanceof FormatError;
}
