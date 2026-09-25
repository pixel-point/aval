import type { CanvasHTMLAttributes, ComponentType } from "react";
import type { AlphaAdapterOptions, AlphaCommands, AlphaStatus } from "@pixel-point/aval-alpha/adapter";

export type UseAvalAlphaOptions = AlphaAdapterOptions;
export type AvalAlphaReactInstance = AlphaStatus & AlphaCommands;

export interface AvalAlphaComponentProps extends Omit<CanvasHTMLAttributes<HTMLCanvasElement>, "children" | "dangerouslySetInnerHTML" | "width" | "height"> {
  /** CSS display dimensions in pixels. Intrinsic dimensions belong to the player. */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export interface UseAvalAlphaResult {
  readonly alpha: AvalAlphaReactInstance;
  readonly AvalAlphaComponent: ComponentType<AvalAlphaComponentProps>;
}
