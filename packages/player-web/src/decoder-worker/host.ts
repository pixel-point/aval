import {
  DecoderWorkerCore,
  type WorkerEncodedVideoChunkFactory,
  type WorkerVideoDecoderFactory,
  type WorkerVideoDecoderSupportProbe
} from "./core.js";
import { type WorkerAvcInspectorFactory } from "./avc-inspector-adapter.js";
import { isDecoderWorkerCommand } from "./protocol-validation.js";
import { type DecoderWorkerMessagePort } from "./protocol.js";

export interface DecoderWorkerHostOptions {
  readonly decoderFactory?: WorkerVideoDecoderFactory;
  readonly chunkFactory?: WorkerEncodedVideoChunkFactory;
  readonly supportProbe?: WorkerVideoDecoderSupportProbe;
  readonly inspectorFactory?: WorkerAvcInspectorFactory;
}

/** Binds the worker-local decoder core to a WorkerGlobalScope-like port. */
export class DecoderWorkerHost {
  readonly #port: DecoderWorkerMessagePort;
  readonly #core: DecoderWorkerCore;
  readonly #messageListener: (event: MessageEvent<unknown>) => void;
  readonly #messageErrorListener: (event: MessageEvent<unknown>) => void;
  #commandTail = Promise.resolve();
  #detached = false;

  public constructor(
    port: DecoderWorkerMessagePort,
    options: DecoderWorkerHostOptions = {}
  ) {
    this.#port = port;
    this.#core = new DecoderWorkerCore({
      emit: (event, transfer) => {
        this.#port.postMessage(event, transfer);
      },
      ...(options.decoderFactory === undefined
        ? {}
        : { decoderFactory: options.decoderFactory }),
      ...(options.chunkFactory === undefined
        ? {}
        : { chunkFactory: options.chunkFactory }),
      ...(options.supportProbe === undefined
        ? {}
        : { supportProbe: options.supportProbe }),
      ...(options.inspectorFactory === undefined
        ? {}
        : { inspectorFactory: options.inspectorFactory })
    });
    this.#messageListener = (event) => {
      this.#commandTail = this.#commandTail.then(async () => {
        if (this.#detached) {
          return;
        }
        if (!isDecoderWorkerCommand(event.data)) {
          this.#core.rejectMalformedCommand(readRequestId(event.data));
          return;
        }
        await this.#core.handle(event.data);
      });
    };
    this.#messageErrorListener = () => {
      this.#core.rejectMalformedCommand(null);
    };
    this.#port.addEventListener("message", this.#messageListener);
    this.#port.addEventListener("messageerror", this.#messageErrorListener);
  }

  public get core(): DecoderWorkerCore {
    return this.#core;
  }

  /** Detaches the transport listener. Protocol disposal remains explicit. */
  public detach(): void {
    if (this.#detached) {
      return;
    }
    this.#detached = true;
    this.#port.removeEventListener("message", this.#messageListener);
    this.#port.removeEventListener("messageerror", this.#messageErrorListener);
  }
}

export function installDecoderWorker(
  scope: DecoderWorkerMessagePort,
  options: DecoderWorkerHostOptions = {}
): DecoderWorkerHost {
  return new DecoderWorkerHost(scope, options);
}

function readRequestId(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const requestId = (value as { readonly requestId?: unknown }).requestId;
  return Number.isSafeInteger(requestId) && (requestId as number) > 0
    ? (requestId as number)
    : null;
}
