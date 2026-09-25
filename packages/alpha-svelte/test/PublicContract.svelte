<script lang="ts">
  import { AvalAlphaComponent, createAvalAlpha, type AlphaSource } from "../src/index.js";
  let { sources }: { sources: readonly AlphaSource[] } = $props();
  const alpha = createAvalAlpha(() => ({ sources, loop: true, onReady(source) { source.alphaRect; }, onError(error) { error.code; } }));
</script>
<AvalAlphaComponent {alpha} width={128} height={96} aria-label="Motion" onclick={() => void alpha.play()} />
<span>{$alpha.status}</span>
