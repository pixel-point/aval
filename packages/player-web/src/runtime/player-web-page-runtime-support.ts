import {
  captureRuntimeAssetRequest,
  type CapturedRuntimeAssetRequest
} from "./asset-fetch-contracts.js";
import type {
  RuntimeByteCategory,
  RuntimeAssetRequest,
  RuntimeReclamationRequest,
  RuntimeReclamationResult
} from "./model.js";
import type { RuntimeReclamationParticipant } from "./page-reclamation.js";
import type { PlayerWebRuntimeResources } from "./player-web-runtime-resources.js";
import type {
  OpenRuntimeAssetBytesOptions,
  OpenRuntimeAssetOptions
} from "./runtime-asset-session.js";
import type {
  PlayerWebOpenAssetBytesOptions,
  PlayerWebOpenAssetOptions,
  PlayerWebOwnedPlayer,
  PlayerWebReclamationParticipant,
  PlayerWebStaticSurfaceReclaimer
} from "./player-web-page-runtime.js";

export const STATIC_RECLAIMABLE_CATEGORIES = Object.freeze([
  "decoded-static-cache"
] as const satisfies readonly RuntimeByteCategory[]);
export const PLAYER_ANIMATION_RECLAIMABLE_CATEGORIES = Object.freeze([
  "worker-transfer",
  "decoder-output",
  "persistent-animation",
  "streaming-texture",
  "frame-staging"
] as const satisfies readonly RuntimeByteCategory[]);
const DECLARABLE_RECLAIMABLE_CATEGORIES: ReadonlySet<RuntimeByteCategory> =
  new Set([
    "response-body",
    "quarantine",
    "blob-assembly",
    "verified-unit",
    ...PLAYER_ANIMATION_RECLAIMABLE_CATEGORIES,
    "png-copy",
    "png-zlib",
    "png-scratch",
    ...STATIC_RECLAIMABLE_CATEGORIES
  ]);

export type CapturedReclamationHandler = (
  request: Readonly<RuntimeReclamationRequest>
) => PromiseLike<Readonly<RuntimeReclamationResult>>;

export function captureAssetOptions(
  options: Readonly<PlayerWebOpenAssetOptions>,
  resources: Readonly<PlayerWebRuntimeResources>,
  generation: number
): OpenRuntimeAssetOptions {
  const captured = capturePageAssetOptions(options, true);
  return {
    resources: resources.assetSession,
    generation,
    ...(captured.fetcher === undefined ? {} : { fetcher: captured.fetcher }),
    ...(captured.digestAdapter === undefined
      ? {}
      : { digestAdapter: captured.digestAdapter }),
    ...(captured.maximumFileBytes === undefined
      ? {}
      : { maximumFileBytes: captured.maximumFileBytes }),
    ...(captured.timers === undefined ? {} : { timers: captured.timers }),
    ...(captured.format === undefined ? {} : { format: captured.format }),
    ...(captured.validateStaticPng === undefined
      ? {}
      : { validateStaticPng: captured.validateStaticPng }),
    ...(captured.allocate === undefined ? {} : { allocate: captured.allocate })
  };
}

export function captureAssetBytesOptions(
  options: Readonly<PlayerWebOpenAssetBytesOptions>,
  resources: Readonly<PlayerWebRuntimeResources>,
  generation: number
): OpenRuntimeAssetBytesOptions {
  const captured = capturePageAssetOptions(options, false);
  return {
    resources: resources.assetSession,
    generation,
    ...(captured.digestAdapter === undefined
      ? {}
      : { digestAdapter: captured.digestAdapter }),
    ...(captured.maximumFileBytes === undefined
      ? {}
      : { maximumFileBytes: captured.maximumFileBytes }),
    ...(captured.format === undefined ? {} : { format: captured.format }),
    ...(captured.validateStaticPng === undefined
      ? {}
      : { validateStaticPng: captured.validateStaticPng }),
    ...(captured.allocate === undefined ? {} : { allocate: captured.allocate })
  };
}

export function linkGenerationSignal(
  request: Readonly<RuntimeAssetRequest>,
  generationSignal: AbortSignal
): Readonly<{ readonly request: RuntimeAssetRequest; release(): void }> {
  const captured = captureRuntimeAssetRequest(request);
  const callerSignal = captured.signal;
  if (callerSignal === undefined || callerSignal === generationSignal) {
    return Object.freeze({
      request: copyRequest(captured, generationSignal),
      release: () => undefined
    });
  }
  const controller = new AbortController();
  let linked = true;
  let generationListenerInstalled = false;
  let callerListenerInstalled = false;
  const abort = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  const onGenerationAbort = (): void => { abort(generationSignal); };
  const onCallerAbort = (): void => { abort(callerSignal); };
  const release = (): void => {
    if (!linked) return;
    linked = false;
    if (generationListenerInstalled) {
      try {
        generationSignal.removeEventListener("abort", onGenerationAbort);
      } catch {}
      generationListenerInstalled = false;
    }
    if (callerListenerInstalled) {
      try { callerSignal.removeEventListener("abort", onCallerAbort); } catch {}
      callerListenerInstalled = false;
    }
  };
  try {
    if (generationSignal.aborted) abort(generationSignal);
    else {
      generationListenerInstalled = true;
      generationSignal.addEventListener("abort", onGenerationAbort, { once: true });
    }
    if (callerSignal.aborted) abort(callerSignal);
    else {
      callerListenerInstalled = true;
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  } catch (error) {
    release();
    throw error;
  }
  return Object.freeze({
    request: copyRequest(captured, controller.signal),
    release
  });
}

interface CapturedPageAssetOptions {
  readonly fetcher: OpenRuntimeAssetOptions["fetcher"];
  readonly timers: OpenRuntimeAssetOptions["timers"];
  readonly digestAdapter: OpenRuntimeAssetOptions["digestAdapter"];
  readonly maximumFileBytes: OpenRuntimeAssetOptions["maximumFileBytes"];
  readonly format: OpenRuntimeAssetOptions["format"];
  readonly validateStaticPng: OpenRuntimeAssetOptions["validateStaticPng"];
  readonly allocate: OpenRuntimeAssetOptions["allocate"];
}

const PAGE_ASSET_OPTION_FIELDS = new Set([
  "fetcher", "timers", "digestAdapter", "maximumFileBytes", "format",
  "validateStaticPng", "allocate"
]);
const PAGE_ASSET_BYTES_OPTION_FIELDS = new Set([
  "digestAdapter", "maximumFileBytes", "format", "validateStaticPng", "allocate"
]);

function capturePageAssetOptions(
  value: object,
  transport: boolean
): Readonly<CapturedPageAssetOptions> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("asset options must be an object");
  }
  const fields = transport
    ? PAGE_ASSET_OPTION_FIELDS
    : PAGE_ASSET_BYTES_OPTION_FIELDS;
  let keys: string[];
  try { keys = Object.keys(value); } catch {
    throw new TypeError("asset option fields are inaccessible");
  }
  for (const key of keys) {
    if (!fields.has(key)) throw new TypeError("asset options have an unknown field");
  }
  try {
    return Object.freeze({
      fetcher: transport
        ? Reflect.get(value, "fetcher") as OpenRuntimeAssetOptions["fetcher"]
        : undefined,
      timers: transport
        ? Reflect.get(value, "timers") as OpenRuntimeAssetOptions["timers"]
        : undefined,
      digestAdapter: Reflect.get(value, "digestAdapter") as
        OpenRuntimeAssetOptions["digestAdapter"],
      maximumFileBytes: Reflect.get(value, "maximumFileBytes") as
        OpenRuntimeAssetOptions["maximumFileBytes"],
      format: Reflect.get(value, "format") as OpenRuntimeAssetOptions["format"],
      validateStaticPng: Reflect.get(value, "validateStaticPng") as
        OpenRuntimeAssetOptions["validateStaticPng"],
      allocate: Reflect.get(value, "allocate") as
        OpenRuntimeAssetOptions["allocate"]
    });
  } catch {
    throw new TypeError("asset option values are inaccessible");
  }
}

export function captureOwnedPlayer(value: PlayerWebOwnedPlayer): Readonly<{
  readonly dispose: () => void | PromiseLike<void>;
  readonly reclaim: RuntimeReclamationParticipant["reclaim"] | null;
}> {
  if (value === null || typeof value !== "object") {
    throw new TypeError("owned player must be an object");
  }
  let dispose: unknown;
  let setVisibility: unknown;
  let reclaimForPagePressure: unknown;
  try {
    dispose = Reflect.get(value, "dispose");
    setVisibility = Reflect.get(value, "setVisibility");
    reclaimForPagePressure = Reflect.get(value, "reclaimForPagePressure");
  } catch {
    throw new TypeError("owned player capabilities are inaccessible");
  }
  if (typeof dispose !== "function") {
    throw new TypeError("owned player dispose capability is unavailable");
  }
  if (setVisibility !== undefined && typeof setVisibility !== "function") {
    throw new TypeError("owned player visibility capability is invalid");
  }
  if (reclaimForPagePressure !== undefined &&
    typeof reclaimForPagePressure !== "function") {
    throw new TypeError("owned player pressure capability is invalid");
  }
  const reclaim = setVisibility === undefined &&
      reclaimForPagePressure === undefined
    ? null
    : async (request: Readonly<RuntimeReclamationRequest>) => {
        let covered = false;
        if (typeof reclaimForPagePressure === "function") {
          covered = await Promise.resolve(Reflect.apply(
            reclaimForPagePressure, value, []
          )) === true;
        } else if (request.reason === "hidden-animation" &&
          typeof setVisibility === "function") {
          await Promise.resolve(Reflect.apply(setVisibility, value, ["hidden"]));
          covered = true;
        }
        return Object.freeze({
          token: request.token,
          releasedBytes: 0,
          covered
        });
      };
  return Object.freeze({
    dispose: () => Reflect.apply(dispose, value, []) as
      void | PromiseLike<void>,
    reclaim
  });
}

export function captureStaticReclaimer(
  value: PlayerWebStaticSurfaceReclaimer
): () => Readonly<{ readonly byteLength: number }> | null {
  if (value === null || typeof value !== "object") {
    throw new TypeError("static surface reclaimer must be an object");
  }
  const reclaim = value.reclaimOldest;
  if (typeof reclaim !== "function") {
    throw new TypeError("static surface reclaim capability is unavailable");
  }
  return () => {
    const result = Reflect.apply(reclaim, value, []) as
      Readonly<{ readonly byteLength: number }> | null;
    if (result === null) return null;
    if (typeof result !== "object") {
      throw new TypeError("static surface eviction result is invalid");
    }
    let byteLength: unknown;
    try { byteLength = Reflect.get(result, "byteLength"); } catch {
      throw new TypeError("static surface eviction byte length is inaccessible");
    }
    if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 1) {
      throw new TypeError("static surface eviction byte length is invalid");
    }
    return Object.freeze({ byteLength: byteLength as number });
  };
}

export function captureReclamationHandler(
  value: RuntimeReclamationParticipant
): CapturedReclamationHandler {
  if (value === null || typeof value !== "object") {
    throw new TypeError("reclamation participant must be an object");
  }
  let reclaim: unknown;
  try { reclaim = Reflect.get(value, "reclaim"); } catch {
    throw new TypeError("reclamation callback is inaccessible");
  }
  if (typeof reclaim !== "function") {
    throw new TypeError("reclamation callback is unavailable");
  }
  return (request) => Reflect.apply(reclaim, value, [request]) as
    PromiseLike<Readonly<RuntimeReclamationResult>>;
}

export function capturePlayerReclamationCategories(
  value: PlayerWebReclamationParticipant
): readonly RuntimeByteCategory[] {
  let raw: unknown;
  try { raw = Reflect.get(value, "categories"); } catch {
    throw new TypeError("reclamation categories are inaccessible");
  }
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) {
    throw new TypeError("reclamation categories must be an array");
  }
  const seen = new Set<RuntimeByteCategory>();
  const captured: RuntimeByteCategory[] = [];
  for (const category of raw) {
    if (typeof category !== "string" ||
      !DECLARABLE_RECLAIMABLE_CATEGORIES.has(category as RuntimeByteCategory)) {
      throw new TypeError("reclamation category is not optional");
    }
    const checked = category as RuntimeByteCategory;
    if (seen.has(checked)) {
      throw new TypeError("reclamation categories contain a duplicate");
    }
    seen.add(checked);
    captured.push(checked);
  }
  return Object.freeze(captured);
}

export function checkedSum(left: number, right: number, label: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < 0) {
    throw new RangeError(`${label} exceeded the safe-integer range`);
  }
  return sum;
}

export function staleError(): DOMException {
  return new DOMException("page runtime generation is stale", "AbortError");
}

export function unsafeReplacementError(): DOMException {
  return new DOMException(
    "page runtime generation could not retire every old resource owner",
    "AbortError"
  );
}

export function disposedError(): DOMException {
  return new DOMException("page runtime is disposed", "AbortError");
}

function copyRequest(
  request: Readonly<CapturedRuntimeAssetRequest>,
  signal: AbortSignal
): RuntimeAssetRequest {
  return Object.freeze({
    url: request.url,
    signal,
    ...(request.integrity === undefined ? {} : { integrity: request.integrity }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.credentials === undefined
      ? {}
      : { credentials: request.credentials })
  });
}
