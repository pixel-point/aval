import type { AlphaOptions, AlphaSource, AvalAlphaError } from "./types.js";

export interface AlphaAdapterOptions extends AlphaOptions {
  readonly onReady?: (source: AlphaSource) => void;
}

export interface AlphaStatus {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly playing: boolean;
  readonly source: AlphaSource | undefined;
  readonly error: AvalAlphaError | undefined;
}

export interface AlphaCommands {
  ready(): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): Promise<void>;
  getVideo(): HTMLVideoElement | undefined;
}

export interface AlphaConfiguration {
  readonly options: AlphaAdapterOptions;
  /** Only settings that require replacing the native player. */
  readonly key: string;
}

export interface AlphaBinding {
  readonly commands: AlphaCommands;
  getStatus(): AlphaStatus;
  getServerStatus(): AlphaStatus;
  subscribe(listener: () => void): () => void;
  commit(configuration: AlphaConfiguration): void;
  /** One controller owns one canvas. Returns the mount's resource cleanup. */
  mount(canvas: HTMLCanvasElement): () => void;
}
