import { Canvas2dRenderer } from "./canvas2d-renderer.js";
import { selectRendererBackend } from "./renderer-selection.js";
import { WebGl2Renderer } from "./webgl2-renderer.js";
import type {
  RendererFrameInspector,
  RendererRuntime,
  RendererSnapshot
} from "./renderer-contract.js";
import type { RenderLayout } from "./renderer-geometry.js";
import type { RendererLimits } from "./renderer-limits.js";

export type { RenderLayout } from "./renderer-geometry.js";
export type { RendererLimits } from "./renderer-limits.js";
export type {
  RendererBackendDetails,
  RendererContextChange,
  RendererFrameInspector,
  RendererSnapshot,
  RendererUploadMode
} from "./renderer-contract.js";

/** Stable public renderer; backend selection remains exact-null only. */
export class Renderer implements RendererRuntime {
  readonly #runtime: RendererRuntime;

  public constructor(
    canvas: HTMLCanvasElement,
    layout: Readonly<RenderLayout>,
    limits: Readonly<RendererLimits> = {}
  ) {
    this.#runtime = selectRendererBackend<RendererRuntime>(
      () => new WebGl2Renderer(canvas, layout, limits),
      () => new Canvas2dRenderer(canvas, layout, limits)
    );
  }

  public resize(
    cssWidth: number,
    cssHeight: number,
    devicePixelRatio: number,
    fit: string
  ): void {
    this.#runtime.resize(cssWidth, cssHeight, devicePixelRatio, fit);
  }

  public draw(frame: VideoFrame, newDecoderRun: boolean): Promise<void> {
    return this.#runtime.draw(frame, newDecoderRun);
  }

  public inspectAndPrime(
    frame: VideoFrame,
    inspect: RendererFrameInspector
  ): Promise<void> {
    return this.#runtime.inspectAndPrime(frame, inspect);
  }

  public store(
    group: string,
    index: number,
    frame: VideoFrame,
    newDecoderRun: boolean
  ): Promise<void> {
    return this.#runtime.store(group, index, frame, newDecoderRun);
  }

  public drawStored(group: string, index: number): Promise<void> {
    return this.#runtime.drawStored(group, index);
  }

  public settled(): Promise<void> { return this.#runtime.settled(); }

  public admit(residentCount: number): Readonly<{
    textureBytes: number;
    runtimeBytes: number;
  }> { return this.#runtime.admit(residentCount); }

  public snapshot(): Readonly<RendererSnapshot> { return this.#runtime.snapshot(); }

  public dispose(): void { this.#runtime.dispose(); }
}
