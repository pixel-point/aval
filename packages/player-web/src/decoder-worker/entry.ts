import { installDecoderWorker } from "./host.js";
import { type DecoderWorkerMessagePort } from "./protocol.js";

/** Module-worker entry point. It is intentionally not re-exported on main. */
installDecoderWorker(globalThis as unknown as DecoderWorkerMessagePort);
