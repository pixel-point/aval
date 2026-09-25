"use client";

import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createAlphaBinding, createAlphaConfiguration, type AlphaBinding } from "@pixel-point/aval-alpha/adapter";
import type { AvalAlphaComponentProps, UseAvalAlphaOptions, UseAvalAlphaResult } from "./types.js";

const useCommitEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

export function useAvalAlpha(options: UseAvalAlphaOptions): UseAvalAlphaResult {
  const configuration = createAlphaConfiguration(options);
  const [binding] = useState(() => createAlphaBinding(configuration));
  useCommitEffect(() => { binding.commit(configuration); });
  const status = useSyncExternalStore(binding.subscribe, binding.getStatus, binding.getServerStatus);
  const AvalAlphaComponent = useMemo(() => {
    function BoundAlphaComponent(props: AvalAlphaComponentProps) {
      return createElement(AlphaCanvas, { ...props, binding });
    }
    BoundAlphaComponent.displayName = "AvalAlphaComponent";
    return BoundAlphaComponent;
  }, [binding]);
  const alpha = useMemo(() => Object.freeze({ ...status, ...binding.commands }), [binding, status]);
  return useMemo(() => ({ alpha, AvalAlphaComponent }), [alpha, AvalAlphaComponent]);
}

function AlphaCanvas({ binding, width, height, style, ...attributes }: AvalAlphaComponentProps & { binding: AlphaBinding }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Effects (not ref side effects) own cleanup in both React 18 and 19 Strict Mode.
  useCommitEffect(() => binding.mount(canvas.current!), [binding]);
  return createElement("canvas", {
    ...attributes, ref: canvas,
    style: { display: "block", maxWidth: "100%", objectFit: "contain", ...style,
      ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) }
  });
}
