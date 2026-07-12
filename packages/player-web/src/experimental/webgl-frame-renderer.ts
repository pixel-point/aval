import {
  OPAQUE_STREAMING_SLOT_COUNT,
  OpaqueFrameRenderer,
  RendererDisposedError,
  RendererFrameUnavailableError,
  RendererUnavailableError,
  type BorrowedVideoFrame,
  type CopyableVideoFrame,
  type OpaqueFrameRendererBackend,
  type OpaqueFrameRendererBackendLimits,
  type OpaqueFrameRendererSnapshot,
  type OpaqueTextureKind,
  type RenderFrameHandle,
  type ResidentFrameHandle,
  type StreamingFrameHandle
} from "../runtime/opaque-frame-renderer.js";
import { BrowserOpaqueFrameBackend } from "../runtime/opaque-frame-renderer-browser.js";

export {
  RendererDisposedError,
  RendererFrameUnavailableError,
  RendererUnavailableError
};
export type {
  BorrowedVideoFrame,
  CopyableVideoFrame,
  RenderFrameHandle,
  ResidentFrameHandle,
  StreamingFrameHandle
};

export const STREAMING_SLOT_COUNT = OPAQUE_STREAMING_SLOT_COUNT;
export type FrameRendererState = OpaqueFrameRendererSnapshot["state"];
export type FrameRendererBackendLimits = OpaqueFrameRendererBackendLimits;
export type BackendTextureKind = OpaqueTextureKind;
export type WebGlFrameRendererSnapshot = OpaqueFrameRendererSnapshot;

export interface FrameTextureLayout {
  readonly width: number;
  readonly height: number;
  readonly layerCount: number;
}

export interface FrameRendererBackend {
  readonly limits: Readonly<FrameRendererBackendLimits>;
  allocate(layout: FrameTextureLayout, streamingSlots: number): void;
  upload(kind: BackendTextureKind, index: number, pixels: Uint8Array): void;
  draw(kind: BackendTextureKind, index: number): void;
  readPixels?(): Uint8Array;
  dispose(): void;
}

export interface WebGlFrameRendererOptions {
  readonly streamingSlots?: number;
}

/** M2 compatibility projection over the production opaque renderer owner. */
export class WebGlFrameRenderer {
  readonly #renderer: OpaqueFrameRenderer;

  public constructor(
    backend: FrameRendererBackend,
    layout: FrameTextureLayout,
    options: WebGlFrameRendererOptions = {}
  ) {
    this.#renderer = new OpaqueFrameRenderer(
      adaptBackend(backend),
      {
        codedWidth: layout.width,
        codedHeight: layout.height,
        logicalWidth: layout.width,
        logicalHeight: layout.height,
        residentLayerCount: layout.layerCount
      },
      {
        ...(options.streamingSlots === undefined
          ? {}
          : { streamingSlots: options.streamingSlots }),
        contextLossPolicy: "restorable"
      }
    );
  }

  public get resourceGeneration(): number {
    return this.#renderer.resourceGeneration;
  }

  public get limits(): Readonly<FrameRendererBackendLimits> {
    return this.#renderer.limits;
  }

  public uploadResident(
    layer: number,
    source: BorrowedVideoFrame,
    resourceGeneration = this.resourceGeneration
  ): Promise<ResidentFrameHandle | null> {
    return this.#renderer.uploadResident(layer, source, resourceGeneration);
  }

  public uploadStreaming(
    slot: number,
    pathGeneration: number,
    source: BorrowedVideoFrame,
    resourceGeneration = this.resourceGeneration
  ): Promise<StreamingFrameHandle | null> {
    return this.#renderer.uploadStreaming(
      slot,
      pathGeneration,
      source,
      resourceGeneration
    );
  }

  public residentHandle(layer: number): ResidentFrameHandle {
    return this.#renderer.residentHandle(layer);
  }

  public draw(handle: RenderFrameHandle): void {
    this.#renderer.draw(handle);
  }

  public readPixels(): Uint8Array {
    return this.#renderer.readPixels();
  }

  public markContextLost(): void {
    this.#renderer.markContextLost();
  }

  public restore(backend: FrameRendererBackend): void {
    this.#renderer.restore(adaptBackend(backend));
  }

  public snapshot(): WebGlFrameRendererSnapshot {
    return this.#renderer.snapshot();
  }

  public settled(): Promise<void> {
    return this.#renderer.settled();
  }

  public dispose(): void {
    this.#renderer.dispose();
  }
}

/** Legacy constructor/allocate shape over the production browser backend. */
export class BrowserWebGl2FrameBackend implements FrameRendererBackend {
  public readonly limits: Readonly<FrameRendererBackendLimits>;
  readonly #backend: BrowserOpaqueFrameBackend;

  public constructor(canvas: HTMLCanvasElement) {
    // The M2 compatibility API exposes readPixels() as part of its browser
    // conformance harness, including reads that occur after a compositor
    // swap. Production M5.5 backends keep the faster default (`false`), while
    // this explicitly testable legacy surface retains its last draw.
    this.#backend = new BrowserOpaqueFrameBackend(canvas, {
      preserveDrawingBuffer: true
    });
    this.limits = this.#backend.limits;
  }

  public allocate(layout: FrameTextureLayout, streamingSlots: number): void {
    this.#backend.allocate({
      codedWidth: layout.width,
      codedHeight: layout.height,
      logicalWidth: layout.width,
      logicalHeight: layout.height,
      residentLayerCount: layout.layerCount
    }, streamingSlots);
  }

  public upload(
    kind: BackendTextureKind,
    index: number,
    pixels: Uint8Array
  ): void {
    this.#backend.upload(kind, index, pixels);
  }

  public draw(kind: BackendTextureKind, index: number): void {
    this.#backend.draw(kind, index);
  }

  public readPixels(): Uint8Array {
    return this.#backend.readPixels();
  }

  public dispose(): void {
    this.#backend.dispose();
  }
}

function adaptBackend(backend: FrameRendererBackend): OpaqueFrameRendererBackend {
  const base = {
    limits: backend.limits,
    allocate(layout: Parameters<OpaqueFrameRendererBackend["allocate"]>[0], streamingSlots: number) {
      backend.allocate({
        width: layout.codedWidth,
        height: layout.codedHeight,
        layerCount: layout.residentLayerCount
      }, streamingSlots);
    },
    upload(kind: BackendTextureKind, index: number, pixels: Uint8Array) {
      backend.upload(kind, index, pixels);
    },
    draw(kind: BackendTextureKind, index: number) {
      backend.draw(kind, index);
    },
    dispose() {
      backend.dispose();
    }
  };
  return backend.readPixels === undefined
    ? Object.freeze(base)
    : Object.freeze({
        ...base,
        readPixels() {
          return backend.readPixels!();
        }
      });
}
