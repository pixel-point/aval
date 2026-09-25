<script lang="ts">
  import { untrack } from "svelte";
  import { createAlphaConfiguration } from "@pixel-point/aval-alpha/adapter";
  import { getControllerRecord } from "./controller.js";
  import type { AvalAlphaComponentProps } from "./types.js";

  let { alpha, width, height, style, ...attributes }: AvalAlphaComponentProps = $props();
  getControllerRecord(untrack(() => alpha));
  const record = $derived(getControllerRecord(alpha));
  const configuration = $derived(createAlphaConfiguration(record.readOptions()));
  const canvasStyle = $derived(`display:block;max-width:100%;object-fit:contain;${style ?? ""};` +
    (width === undefined ? "" : `width:${width}px;`) + (height === undefined ? "" : `height:${height}px;`));

  $effect(() => {
    const { binding } = record;
    const next = configuration;
    untrack(() => binding.commit(next));
  });

  function attach(node: HTMLCanvasElement) {
    $effect(() => {
      const { binding } = record;
      return untrack(() => binding.mount(node));
    });
  }
</script>

<canvas {...attributes} style={canvasStyle} use:attach></canvas>
