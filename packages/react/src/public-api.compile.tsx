import { useRef } from "react";
import {
  useAval,
  type AvalErrorDetail,
  type AvalSources
} from "@pixel-point/aval-react";

const sources = {
  av1: "/motion/av1.avl",
  h264: "/motion/h264.avl"
} satisfies AvalSources;

export function PublicContract() {
  const target = useRef<HTMLButtonElement>(null);
  const { aval, AvalComponent } = useAval({
    sources,
    state: "idle",
    autoplay: true,
    autoBind: true,
    onError: (detail: Readonly<AvalErrorDetail>) => {
      void detail.failure.code;
    }
  });
  const requested: string | null = aval.requestedState;
  const visual: string | null = aval.visualState;
  void [requested, visual];

  return (
    <button ref={target} type="button">
      <AvalComponent
        bindTo={target}
        width={160}
        height={160}
        className="motion"
        aria-hidden
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

export function InvalidDescriptorSource() {
  useAval({
    sources: {
      // @ts-expect-error React source values are URL strings only
      h264: { src: "/motion.avl" }
    }
  });
  return null;
}

export function InvalidCodecSource() {
  useAval({
    sources: {
      h264: "/motion.avl",
      // @ts-expect-error only the four public codec keys are accepted
      gif: "/motion.gif"
    }
  });
  return null;
}

export function InvalidOwnedHostContent() {
  const { AvalComponent } = useAval({ sources });
  return <AvalComponent
    // @ts-expect-error the adapter exclusively owns direct source children
    dangerouslySetInnerHTML={{ __html: "<source src='/other.avl'>" }}
  />;
}
