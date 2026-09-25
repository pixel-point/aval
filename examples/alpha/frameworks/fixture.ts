import type { AlphaSource } from "@pixel-point/aval-alpha";

// Matches scripts/alpha/generate-fixtures.mjs; authored alternatives stay ordered.
export function sources(revision: number): AlphaSource[] {
  const source: AlphaSource = { src: `/vp9.webm?revision=${revision}`, type: "video/webm", width: 128, height: 200,
    colorRect: [0, 0, 128, 96], alphaRect: [0, 104, 128, 96] };
  return [{ ...source, src: "/unsupported.mp4", type: "video/unsupported" }, source,
    { ...source, src: "/unused.mp4", type: "video/mp4" }];
}
