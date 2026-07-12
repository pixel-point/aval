import type { PresentableFrameBackend } from "./browser-presentation-planes.js";
import type { FrameTextureKind } from "./frame-renderer.js";
import type { PresentationGeometry } from "./presentation-geometry.js";

export class FakePresentableBackend implements PresentableFrameBackend {
  public readonly limits = Object.freeze({
    maxTextureSize: 2_048,
    maxArrayTextureLayers: 128
  });
  public readonly geometries: Readonly<PresentationGeometry>[] = [];
  public disposals = 0;
  public failGeometry = false;
  public failGeometryOnce = false;
  public failGeometryAfterMutationOnce = false;
  public failGeometryAfterEveryMutation = false;
  public failDispose = false;
  public observeGeometry: (() => void) | null = null;

  public setPresentationGeometry(
    geometry: Readonly<PresentationGeometry>
  ): boolean {
    if (this.failGeometry) throw new Error("deliberate geometry failure");
    if (this.failGeometryOnce) {
      this.failGeometryOnce = false;
      throw new Error("deliberate geometry failure");
    }
    const previous = this.geometries.at(-1);
    if (previous === geometry) return false;
    this.geometries.push(geometry);
    this.observeGeometry?.();
    if (this.failGeometryAfterMutationOnce) {
      this.failGeometryAfterMutationOnce = false;
      throw new Error("deliberate post-mutation geometry failure");
    }
    if (this.failGeometryAfterEveryMutation) {
      throw new Error("deliberate persistent geometry failure");
    }
    return true;
  }

  public allocate(): void {}
  public upload(
    _kind: FrameTextureKind,
    _index: number,
    _pixels: Uint8Array
  ): void {}
  public draw(): void {}
  public dispose(): void {
    this.disposals += 1;
    if (this.failDispose) throw new Error("deliberate backend dispose failure");
  }
}

export class CanvasOwningFakeBackend extends FakePresentableBackend {
  public lastRedrawBackingSetCount = 0;

  public constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly backingSets: readonly string[]
  ) {
    super();
  }

  public override setPresentationGeometry(
    geometry: Readonly<PresentationGeometry>
  ): boolean {
    const changed = super.setPresentationGeometry(geometry);
    if (!changed) return false;
    this.canvas.width = geometry.backing.width;
    this.canvas.height = geometry.backing.height;
    // This point stands for the backend's synchronous redraw barrier.
    this.lastRedrawBackingSetCount = this.backingSets.length;
    return true;
  }
}

export class MutatingInitialFailureBackend extends FakePresentableBackend {
  public constructor(private readonly canvas: HTMLCanvasElement) {
    super();
  }

  public override setPresentationGeometry(
    _geometry: Readonly<PresentationGeometry>
  ): boolean {
    this.canvas.width = 1_999;
    this.canvas.height = 1_777;
    throw new Error("injected initial geometry failure");
  }
}

export function fakeCanvas() {
  const drawCalls: unknown[][] = [];
  const backingSets: string[] = [];
  let failingDraws = 0;
  let width = 0;
  let height = 0;
  let widthFailureCountdown = 0;
  let heightFailureCountdown = 0;
  let failWidthArmed = false;
  let failHeightArmed = false;
  const listeners = new Map<string, Set<EventListener>>();
  const context = {
    clearRect() {},
    drawImage(...args: unknown[]) {
      if (failingDraws > 0) {
        failingDraws -= 1;
        throw new Error("deliberate static redraw failure");
      }
      drawCalls.push(args);
    }
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    get width() {
      return width;
    },
    set width(value: number) {
      if (widthFailureCountdown > 0) {
        widthFailureCountdown -= 1;
      }
      if (widthFailureCountdown === 0 && failWidthArmed) {
        failWidthArmed = false;
        throw new Error("deliberate canvas width setter failure");
      }
      width = value;
      backingSets.push(`width:${String(value)}`);
    },
    get height() {
      return height;
    },
    set height(value: number) {
      if (heightFailureCountdown > 0) {
        heightFailureCountdown -= 1;
      }
      if (heightFailureCountdown === 0 && failHeightArmed) {
        failHeightArmed = false;
        throw new Error("deliberate canvas height setter failure");
      }
      height = value;
      backingSets.push(`height:${String(value)}`);
    },
    getContext(kind: string) {
      return kind === "2d" ? context : null;
    },
    addEventListener(type: string, listener: EventListener) {
      const values = listeners.get(type) ?? new Set<EventListener>();
      values.add(listener);
      listeners.set(type, values);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    }
  } as unknown as HTMLCanvasElement;
  return {
    canvas,
    drawCalls,
    backingSets,
    listenerCount(): number {
      return [...listeners.values()].reduce(
        (total, values) => total + values.size,
        0
      );
    },
    dispatchContext(type: "webglcontextlost" | "webglcontextrestored") {
      let prevented = false;
      const event = {
        preventDefault() { prevented = true; }
      } as unknown as Event;
      for (const listener of listeners.get(type) ?? []) listener(event);
      return { get prevented() { return prevented; } };
    },
    failNextDraw(): void {
      failingDraws = 1;
    },
    failDraws(count: number): void {
      failingDraws = count;
    },
    failNextWidthSet(): void {
      failWidthArmed = true;
      widthFailureCountdown = 1;
    },
    failNextHeightSet(): void {
      failHeightArmed = true;
      heightFailureCountdown = 1;
    },
    failWidthSetIn(calls: number): void {
      failWidthArmed = true;
      widthFailureCountdown = calls;
    }
  };
}

export function logicalCanvas() {
  return {
    width: 100,
    height: 50,
    fit: "contain" as const,
    pixelAspect: [1, 1] as const,
    colorSpace: "srgb" as const
  };
}
