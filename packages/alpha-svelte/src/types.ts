import type { Readable } from "svelte/store";
import type { HTMLCanvasAttributes } from "svelte/elements";
import type { AlphaAdapterOptions, AlphaCommands, AlphaStatus } from "@pixel-point/aval-alpha/adapter";

export type CreateAvalAlphaOptions = AlphaAdapterOptions;
export type AvalAlphaSvelteInstance = Readable<AlphaStatus> & AlphaCommands;
export interface AvalAlphaComponentProps extends Omit<HTMLCanvasAttributes, "children" | "width" | "height"> {
  readonly alpha: AvalAlphaSvelteInstance;
  /** CSS display dimensions in pixels. Intrinsic dimensions belong to the player. */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}
