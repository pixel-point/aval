import { DecoderWorkerClient } from "./client.js";

/** Compile-only proof that native browser worker endpoints satisfy the ports. */
function acceptsNativeWorker(worker: Worker): DecoderWorkerClient {
  return new DecoderWorkerClient(worker);
}

void acceptsNativeWorker;
