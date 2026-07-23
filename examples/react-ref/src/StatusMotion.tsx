import {
  useAval,
  type AvalBindingTarget,
  type AvalErrorDetail,
  type AvalSources
} from "@pixel-point/aval-react";

export interface StatusMotionProps {
  readonly state: string;
  readonly sources: AvalSources;
  readonly bindTo?: AvalBindingTarget;
  readonly onError?: (failure: Readonly<AvalErrorDetail>) => void;
  readonly onVisual?: (state: string | null) => void;
}

export function StatusMotion({
  state,
  sources,
  bindTo,
  onError,
  onVisual
}: StatusMotionProps) {
  const { aval, AvalComponent } = useAval({
    sources,
    state,
    autoplay: true,
    autoBind: true,
    onVisualStateChange: ({ to }) => onVisual?.(to),
    onError: (detail) => {
      if (!detail.fatal) return;
      onError?.(detail);
    }
  });

  return <>
    <AvalComponent
      width={160}
      height={160}
      bindTo={bindTo}
      data-mounted={aval.mounted ? "true" : "false"}
      aria-hidden
    />
    {aval.lastError?.fatal === true && (
      <span className="motion-fallback" aria-hidden="true">{state}</span>
    )}
  </>;
}
