import { useAvalAlpha, type AlphaSource } from "../src/index.js";

export function Consumer({ sources }: { sources: readonly AlphaSource[] }) {
  const { alpha, AvalAlphaComponent } = useAvalAlpha({ sources, loop: true, onReady(source) { source.alphaRect; }, onError(error) { error.code; } });
  void alpha.ready(); void alpha.seek(0.5); alpha.getVideo();
  // @ts-expect-error The runtime owns intrinsic dimensions and children.
  const invalid = <AvalAlphaComponent>child</AvalAlphaComponent>;
  void invalid;
  return <AvalAlphaComponent width={128} height={96} style={{ opacity: 0.8 }} aria-label="Motion" onClick={() => void alpha.play()} />;
}
