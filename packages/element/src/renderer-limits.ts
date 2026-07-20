import type { RendererContextChange } from "./renderer-contract.js";

/** Resource, copy, and presentation policy shared by renderer implementations. */
export interface RendererLimits {
  readonly maxTextureBytes?: number;
  readonly maxBackingBytes?: number;
  readonly maxRuntimeBytes?: number;
  readonly copyTimeoutMs?: number;
  readonly setTimeout?: (callback: () => void, delay: number) => number;
  readonly clearTimeout?: (handle: number) => void;
  /** Internal deterministic surface factory; production uses ownerDocument. */
  readonly createCanvas?: (width: number, height: number) => HTMLCanvasElement;
  readonly onContextChange?: (change: Readonly<RendererContextChange>) => void;
  readonly initialPresentation?: Readonly<{
    width: number;
    height: number;
    dpr: number;
    fit: string;
  }>;
}
