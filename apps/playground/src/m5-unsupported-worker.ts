import {
  installDecoderWorker,
  type DecoderWorkerMessagePort
} from "@rendered-motion/player-web";

installDecoderWorker(self as unknown as DecoderWorkerMessagePort, {
  supportProbe: async (config) => ({ supported: false, config })
});
