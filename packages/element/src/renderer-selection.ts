/**
 * Internal discriminator for the one safe same-canvas backend transition.
 * It is emitted only when WebGL2 context acquisition returns exactly null,
 * which leaves the canvas context mode unbound.
 */
export class WebGlUnavailableError extends Error {
  public constructor() {
    super("WebGL2 returned null without binding the canvas");
    this.name = "WebGlUnavailableError";
  }
}

export function selectRendererBackend<T>(
  createWebGl2: () => T,
  createCanvas2d: () => T
): T {
  try {
    return createWebGl2();
  } catch (reason) {
    if (!(reason instanceof WebGlUnavailableError)) throw reason;
    return createCanvas2d();
  }
}
