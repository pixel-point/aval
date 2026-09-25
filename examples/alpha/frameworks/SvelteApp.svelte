<script lang="ts">
  import { AvalAlphaComponent, createAvalAlpha } from "@pixel-point/aval-alpha-svelte";
  import { sources } from "./fixture.js";

  let revision = $state(0), visible = $state(true), loop = $state(false), label = $state("initial");
  let renders = $state(0), readies = $state(0), callback = $state(""), failed = $state(false), error = $state("");
  let sized = $state(true);
  const readOptions = () => {
    void renders; void label;
    return {
    sources: failed ? [] : sources(revision), loop,
    onReady() { readies++; callback = label; },
    onError(cause: { code: string }) { error = `${label}:${cause.code}`; }
    };
  };
  let alpha = $state(createAvalAlpha(readOptions));
  const run = (promise: Promise<void>) => { void promise.catch((cause: Error) => { error = cause.message; }); };
</script>

<main>
  <h1>aval-alpha · Svelte</h1>
  <section id="stage">{#if visible}<AvalAlphaComponent {alpha} width={sized ? 256 : undefined} height={sized ? 192 : undefined} aria-label="Transparent calibration" />{/if}</section>
  <output id="status" data-playing={String($alpha.playing)} data-readies={readies} data-callback={callback} data-renders={renders}>{$alpha.status}</output>
  <output id="error">{error}</output>
  <button onclick={() => run(alpha.play())}>Play</button>
  <button onclick={() => alpha.pause()}>Pause</button>
  <button onclick={() => run(alpha.seek(0.5))}>Seek</button>
  <button onclick={() => { loop = !loop; }}>Toggle loop</button>
  <button onclick={() => { renders++; }}>Equivalent sources</button>
  <button onclick={() => { label = "updated"; }}>Change callbacks</button>
  <button onclick={() => { failed = false; revision++; }}>Replace source</button>
  <button onclick={() => { failed = true; }}>Fail</button>
  <button onclick={() => { visible = !visible; }}>{visible ? "Unmount" : "Remount"}</button>
  <button onclick={() => { sized = false; }}>Remove dimensions</button>
  <button onclick={() => { alpha = createAvalAlpha(readOptions); }}>Replace controller</button>
</main>
