/** Maps an unbounded logical body offset to its authored local frame. */
export function graphBodyFrameAt(
  body: { readonly kind: "loop" | "finite" | "held"; readonly frameCount: number },
  logicalFrame: number
): number {
  return body.kind === "loop"
    ? logicalFrame % body.frameCount
    : Math.min(logicalFrame, body.frameCount - 1);
}

/** Manifest bodies encode held bodies as a one-frame finite unit. */
export function manifestBodyFrameAt(
  body: { readonly playback: "loop" | "finite"; readonly frameCount: number },
  logicalFrame: number
): number {
  return body.playback === "loop"
    ? logicalFrame % body.frameCount
    : Math.min(logicalFrame, body.frameCount - 1);
}
