import {
  createDecoderWorkerClient,
  type CreateDecoderWorkerClientOptions
} from "../decoder-worker/factory.js";
import type {
  DecoderWorkerProbeConfig
} from "../decoder-worker/protocol.js";
import type {
  DecoderWorkerProbeOptions
} from "../decoder-worker/client-support.js";

export interface SourceSupportProbeClient {
  probeConfig(
    config: Readonly<DecoderWorkerProbeConfig>,
    options?: DecoderWorkerProbeOptions
  ): Promise<boolean>;
  dispose(): Promise<void>;
}

export type SourceSupportProbeCreationOptions = CreateDecoderWorkerClientOptions;

/** Sole lifecycle owner for pre-configuration module-worker support probes. */
export class SourceSupportProbe {
  readonly #client: SourceSupportProbeClient;
  #active = false;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  public constructor(client: SourceSupportProbeClient) {
    if (
      client === null ||
      typeof client !== "object" ||
      typeof client.probeConfig !== "function" ||
      typeof client.dispose !== "function"
    ) {
      throw new TypeError("source support probe requires a worker client owner");
    }
    this.#client = client;
  }

  public async probe(
    config: Readonly<DecoderWorkerProbeConfig>,
    options: DecoderWorkerProbeOptions = {}
  ): Promise<boolean> {
    if (this.#disposed) {
      throw new DOMException("source support probe is disposed", "AbortError");
    }
    if (this.#active) {
      throw new TypeError("source support probes must run sequentially");
    }
    this.#active = true;
    try {
      const supported = await this.#client.probeConfig(config, options);
      if (typeof supported !== "boolean") {
        throw new TypeError("source support probe returned a malformed result");
      }
      return supported;
    } catch (error) {
      // A probe exception is terminal for this source attempt. Retire its
      // module worker without delaying propagation of the original failure.
      void this.dispose().catch(() => undefined);
      throw error;
    } finally {
      this.#active = false;
    }
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = this.#client.dispose();
    return this.#disposePromise;
  }
}

/** Create the production probe in the packaged decoder module-worker realm. */
export function createSourceSupportProbe(
  options: SourceSupportProbeCreationOptions = {}
): SourceSupportProbe {
  if (
    options.workerFactory === undefined &&
    options.entryUrl === undefined &&
    typeof Worker === "undefined"
  ) {
    return new SourceSupportProbe(UNAVAILABLE_WORKER_SUPPORT_CLIENT);
  }
  return new SourceSupportProbe(createDecoderWorkerClient(options));
}

/**
 * Without a decoder worker there is no qualified animated source. Returning
 * false lets source selection exhaust authored candidates and publish its
 * normal terminal error; alternate presentation remains consumer-owned.
 */
const UNAVAILABLE_WORKER_SUPPORT_CLIENT: SourceSupportProbeClient = Object.freeze({
  async probeConfig(): Promise<boolean> { return false; },
  async dispose(): Promise<void> {}
});
