import { useRef } from "react";
import { useAval, type AvalSources } from "@pixel-point/aval-react";

const sources = {
  av1: "/status/av1.avl",
  h264: "/status/h264.avl"
} satisfies AvalSources;

export function TypeContract() {
  const button = useRef<HTMLButtonElement>(null);
  const { aval, AvalComponent } = useAval({
    sources,
    state: "loading",
    autoplay: false,
    autoBind: true,
    motion: "reduce",
    fit: "contain"
  });

  const readyFor: (state: string) => boolean = aval.readyFor;
  const setState: (state: string) => Promise<void> = aval.setState;
  const send: (event: string) => boolean = aval.send;
  const pause: () => void = aval.pause;
  const play: () => Promise<void> = aval.play;
  void [readyFor, setState, send, pause, play];

  return (
    <button ref={button} type="button">
      <AvalComponent
        bindTo={button}
        width={160}
        height={160}
        className="status-motion"
        aria-label="Decorative status motion"
      />
    </button>
  );
}

export function InvalidEmptySources() {
  useAval({
    // @ts-expect-error at least one codec URL is required
    sources: {}
  });
  return null;
}

export function InvalidSourceValue() {
  useAval({
    sources: {
      // @ts-expect-error React sources are URL strings, not descriptors
      h264: { src: "/status/h264.avl" }
    }
  });
  return null;
}
