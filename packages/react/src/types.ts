import type {
  AvalCrossOrigin,
  AvalDiagnostics,
  AvalErrorDetail,
  AvalFit,
  AvalMotion,
  AvalPrepareOptions,
  AvalRequestedStateChangeDetail,
  AvalTransitionDetail,
  AvalVisualStateChangeDetail,
  RuntimeReadiness,
  RuntimeReadinessResult
} from "@pixel-point/aval-element";
import type {
  ComponentType,
  HTMLAttributes,
  RefObject
} from "react";

export type AvalSources = Readonly<{
  readonly av1?: string;
  readonly vp9?: string;
  readonly h265?: string;
  readonly h264?: string;
}> & (
  | Readonly<{ readonly av1: string }>
  | Readonly<{ readonly vp9: string }>
  | Readonly<{ readonly h265: string }>
  | Readonly<{ readonly h264: string }>
);

export interface UseAvalOptions {
  readonly sources: AvalSources;
  readonly state?: string;
  readonly autoplay?: boolean;
  readonly autoBind?: boolean;
  readonly motion?: AvalMotion;
  readonly fit?: AvalFit;
  readonly crossOrigin?: AvalCrossOrigin;
  readonly onReady?: (
    result: Readonly<RuntimeReadinessResult>
  ) => void;
  readonly onRequestedStateChange?: (
    detail: Readonly<AvalRequestedStateChangeDetail>
  ) => void;
  readonly onVisualStateChange?: (
    detail: Readonly<AvalVisualStateChangeDetail>
  ) => void;
  readonly onTransitionStart?: (
    detail: Readonly<AvalTransitionDetail>
  ) => void;
  readonly onTransitionEnd?: (
    detail: Readonly<AvalTransitionDetail>
  ) => void;
  readonly onError?: (detail: Readonly<AvalErrorDetail>) => void;
}

export type AvalBindingTarget =
  | Element
  | RefObject<Element | null>
  | null;

export interface AvalComponentProps
  extends Omit<
    HTMLAttributes<HTMLElement>,
    "children" | "dangerouslySetInnerHTML"
  > {
  readonly width?: number;
  readonly height?: number;
  readonly bindTo?: AvalBindingTarget;
}

export interface AvalReactInstance {
  readonly mounted: boolean;
  readonly readiness: RuntimeReadiness;
  readonly requestedState: string | null;
  readonly visualState: string | null;
  readonly isTransitioning: boolean;
  readonly paused: boolean;
  readonly effectivelyVisible: boolean;
  readonly stateNames: readonly string[];
  readonly eventNames: readonly string[];
  readonly lastError: Readonly<AvalErrorDetail> | null;

  prepare(
    options?: Readonly<AvalPrepareOptions>
  ): Promise<RuntimeReadinessResult>;
  setState(name: string): Promise<void>;
  send(event: string): boolean;
  readyFor(state: string): boolean;
  play(): Promise<void>;
  pause(): void;
  getDiagnostics(
    options?: Readonly<{ readonly trace?: boolean }>
  ): Readonly<AvalDiagnostics> | null;
}

export interface UseAvalResult {
  readonly aval: AvalReactInstance;
  readonly AvalComponent: ComponentType<AvalComponentProps>;
}
