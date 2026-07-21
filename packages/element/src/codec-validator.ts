import {
  createVideoPayloadValidator,
  FormatError,
  type VideoPayloadValidationChunk,
  type VideoPayloadValidationProfile,
  type VideoPayloadValidator
} from "@pixel-point/aval-format";

/** Runtime profile accepted by the format-owned payload validator. */
export type CodecValidationProfile = VideoPayloadValidationProfile;

/** Verified container chunk passed synchronously across the format boundary. */
export type CodecValidationChunk = VideoPayloadValidationChunk;

/** Element lifecycle view of the format-owned incremental validator. */
export type CodecValidator = VideoPayloadValidator;

/**
 * Adapts typed format admission failures to the element's intentionally opaque
 * invalid-payload boundary. Codec parsing and continuity state stay in format.
 */
export function createCodecValidator(
  profile: Readonly<CodecValidationProfile>
): Readonly<CodecValidator> {
  let validator: Readonly<VideoPayloadValidator>;
  try {
    validator = createVideoPayloadValidator(profile);
  } catch (error) {
    return payloadFailure(error);
  }
  return Object.freeze({
    validate(chunks: readonly Readonly<CodecValidationChunk>[]): void {
      try {
        validator.validate(chunks);
      } catch (error) {
        payloadFailure(error);
      }
    },
    complete(): void {
      try {
        validator.complete();
      } catch (error) {
        payloadFailure(error);
      }
    }
  });
}

function payloadFailure(error: unknown): never {
  if (error instanceof FormatError) {
    throw new Error("Invalid AVAL encoded payload");
  }
  throw error;
}
