import { vi } from "vitest";

export function installSafariZeroDurationDecoder(): Readonly<{
  repairedDurations: number[];
  missingDurationFrames: Array<{ readonly closed: boolean }>;
}> {
  const repairedDurations: number[] = [];
  const missingDurationFrames: Array<{ readonly closed: boolean }> = [];

  class SafariVideoFrame {
    public readonly timestamp: number;
    public readonly duration: number | null;
    public readonly codedWidth: number;
    public readonly codedHeight: number;
    public readonly displayWidth: number;
    public readonly displayHeight: number;
    public readonly visibleRect: Readonly<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
    public readonly colorSpace: Readonly<{
      fullRange: boolean | null;
      matrix: VideoMatrixCoefficients | null;
      primaries: VideoColorPrimaries | null;
      transfer: VideoTransferCharacteristics | null;
    }>;
    public closed = false;

    public constructor(
      source: SafariVideoFrame | Readonly<{
        timestamp: number;
        duration: number | null;
        codedWidth: number;
        codedHeight: number;
        displayWidth: number;
        displayHeight: number;
        colorSpace: Readonly<{
          fullRange: boolean | null;
          matrix: VideoMatrixCoefficients | null;
          primaries: VideoColorPrimaries | null;
          transfer: VideoTransferCharacteristics | null;
        }>;
      }>,
      init: Readonly<{ duration?: number }> = {}
    ) {
      this.timestamp = source.timestamp;
      this.duration = init.duration ?? source.duration;
      this.codedWidth = source.codedWidth;
      this.codedHeight = source.codedHeight;
      this.displayWidth = source.displayWidth;
      this.displayHeight = source.displayHeight;
      this.visibleRect = Object.freeze({
        x: 0,
        y: 0,
        width: source.displayWidth,
        height: source.displayHeight
      });
      this.colorSpace = source.colorSpace;
      if (source instanceof SafariVideoFrame && init.duration !== undefined) {
        repairedDurations.push(init.duration);
      }
    }

    public close(): void { this.closed = true; }
  }

  class SafariWorker {
    readonly #messageListeners = new Set<
      (event: Readonly<{ data: unknown }>) => void
    >();
    #config: Readonly<VideoDecoderConfig> | null = null;

    public addEventListener(
      type: string,
      listener: (event: Readonly<{ data: unknown }>) => void
    ): void {
      if (type === "message") this.#messageListeners.add(listener);
    }

    public postMessage(message: unknown): void {
      const command = message as Readonly<{
        t: string;
        config?: Readonly<VideoDecoderConfig>;
        run?: number;
        chunks?: readonly Readonly<{
          timestamp: number;
          duration: number;
        }>[];
      }>;
      if (command.t === "configure") {
        if (command.config === undefined) throw new Error("missing decoder config");
        this.#config = command.config;
        queueMicrotask(() => this.#emit({ t: "configured", supported: true }));
        return;
      }
      if (command.t === "start") {
        queueMicrotask(() => this.#emit({ t: "started", run: command.run }));
        return;
      }
      if (command.t === "decode") {
        const config = this.#config;
        if (
          config === null ||
          command.run === undefined ||
          command.chunks === undefined
        ) throw new Error("invalid synthetic decoder command");
        queueMicrotask(() => {
          for (const chunk of command.chunks ?? []) {
            const frame = new SafariVideoFrame({
              timestamp: chunk.timestamp,
              duration: 0,
              codedWidth: config.codedWidth ?? 1,
              codedHeight: config.codedHeight ?? 1,
              displayWidth: config.displayAspectWidth ?? config.codedWidth ?? 1,
              displayHeight: config.displayAspectHeight ?? config.codedHeight ?? 1,
              colorSpace: Object.freeze({
                fullRange: config.colorSpace?.fullRange ?? null,
                matrix: config.colorSpace?.matrix ?? null,
                primaries: config.colorSpace?.primaries ?? null,
                transfer: config.colorSpace?.transfer ?? null
              })
            });
            missingDurationFrames.push(frame);
            this.#emit({
              t: "frame",
              run: command.run,
              timestamp: chunk.timestamp,
              frame
            });
          }
          this.#emit({ t: "accepted", run: command.run });
        });
        return;
      }
      if (command.t === "flush") {
        queueMicrotask(() => this.#emit({ t: "flushed", run: command.run }));
        return;
      }
      if (command.t === "close") {
        queueMicrotask(() => this.#emit({ t: "closed", run: command.run }));
      }
    }

    public terminate(): void {}

    #emit(data: unknown): void {
      for (const listener of this.#messageListeners) listener({ data });
    }
  }

  vi.stubGlobal(
    "VideoFrame",
    SafariVideoFrame as unknown as typeof globalThis.VideoFrame
  );
  vi.stubGlobal("Worker", SafariWorker as unknown as typeof globalThis.Worker);
  return { repairedDurations, missingDurationFrames };
}
