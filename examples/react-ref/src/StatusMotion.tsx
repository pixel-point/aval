import { useCallback, useState } from "react";
import {
  defineAvalElement,
  type AvalElement,
  type AvalErrorDetail,
  type AvalVisualStateChangeDetail
} from "@pixel-point/aval-element";

export interface StatusMotionProps {
  readonly state: string;
  readonly sources: readonly Readonly<StatusMotionSource>[];
  readonly onError?: (failure: Readonly<AvalErrorDetail>) => void;
  readonly onVisualState?: (state: string | null) => void;
}

export interface StatusMotionSource {
  readonly src: string;
  readonly type: string;
}

export function StatusMotion({
  state,
  sources,
  onError,
  onVisualState
}: StatusMotionProps) {
  const [failed, setFailed] = useState(false);

  const attachMotion = useCallback((element: AvalElement | null) => {
    if (element === null) return;
    const handleError = (event: CustomEvent<Readonly<AvalErrorDetail>>) => {
      if (!event.detail.fatal) return;
      setFailed(true);
      onError?.(event.detail);
    };
    const handleReadiness = () => {
      if (element.readiness === "interactiveReady") setFailed(false);
    };
    const handleVisualState = (
      event: CustomEvent<Readonly<AvalVisualStateChangeDetail>>
    ) => {
      onVisualState?.(event.detail.to);
    };
    const detach = () => {
      element.removeEventListener("error", handleError);
      element.removeEventListener("readinesschange", handleReadiness);
      element.removeEventListener("visualstatechange", handleVisualState);
    };
    element.addEventListener("error", handleError);
    element.addEventListener("readinesschange", handleReadiness);
    element.addEventListener("visualstatechange", handleVisualState);
    try {
      defineAvalElement();
    } catch (error) {
      detach();
      throw error;
    }
    return detach;
  }, [onError, onVisualState]);

  return <>
    <aval-player
      ref={attachMotion}
      state={state}
      width={160}
      height={160}
      aria-hidden="true"
    >
      {sources.map((source) => (
        <source key={`${source.src}:${source.type}`} {...source} />
      ))}
    </aval-player>
    {failed && (
      <span className="motion-fallback" aria-hidden="true">{state}</span>
    )}
  </>;
}
