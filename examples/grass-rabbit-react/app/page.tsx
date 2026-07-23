import { RabbitDemo } from "../components/rabbit-demo";

const HOOK_EXAMPLE = `"use client";

import { useAval } from "@pixel-point/aval-react";

export function Rabbit() {
  const { aval, AvalComponent } = useAval({
    sources: {
      av1: "/grass-rabbit/av1.avl",
      vp9: "/grass-rabbit/vp9.avl",
      h265: "/grass-rabbit/h265.avl",
      h264: "/grass-rabbit/h264.avl",
    },
    autoplay: true,
    autoBind: true,
  });
  const interactive = aval.readiness === "interactiveReady";
  const inactive = aval.readiness === "staticReady" ||
    aval.readiness === "disposed" ||
    aval.readiness === "error";

  return (
    <>
      <AvalComponent
        width={640}
        height={360}
        tabIndex={interactive ? 0 : -1}
        role="img"
        aria-label="Grass rabbit animation"
        aria-hidden={inactive}
      />
      <p>{aval.visualState ?? aval.readiness}</p>
    </>
  );
}`;

const REACTIVE_FIELDS = [
  {
    name: "Readiness",
    description: "Know when the asset can paint, respond, or present a static frame."
  },
  {
    name: "Visual state",
    description: "Reflect the authored state that viewers actually see right now."
  },
  {
    name: "Transitions",
    description: "Respond to graph movement without subscribing to DOM events yourself."
  }
] as const;

export default function HomePage() {
  return (
    <div className="isolate min-h-svh bg-canvas text-ink">
      <header className="border-b border-line/80">
        <div className="mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between gap-4 px-5 py-3 sm:px-8 lg:px-10">
          <div className="flex items-baseline gap-2.5">
            <span className="text-base font-semibold tracking-tight">AVAL</span>
            <span className="text-base text-ink-muted sm:text-sm">React example</span>
          </div>
          <a
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-forest px-4 text-base font-medium text-white hover:bg-forest-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest sm:text-sm"
            href="https://github.com/pixel-point/aval"
            target="_blank"
            rel="noreferrer"
          >
            View repository
          </a>
        </div>
      </header>

      <main id="main-content">
        <section className="mx-auto grid w-full max-w-7xl gap-12 px-5 py-14 sm:px-8 sm:py-20 lg:grid-cols-[minmax(0,0.78fr)_minmax(32rem,1.22fr)] lg:items-center lg:gap-16 lg:px-10 lg:py-24">
          <div className="flex flex-col items-start gap-7">
            <p className="inline-flex rounded-full border border-forest/20 bg-forest/5 px-3 py-1 text-base font-medium text-forest sm:text-sm">
              Next.js + Tailwind CSS
            </p>
            <div className="grid gap-5">
              <h1 className="max-w-[12ch] text-balance text-5xl font-semibold tracking-tight sm:text-6xl lg:text-5xl xl:text-6xl">
                AVAL, at home in React.
              </h1>
              <p className="max-w-xl text-pretty text-lg leading-8 text-ink-muted">
                Load one authored motion, render its bound component, and let React
                observe state changes without owning the animation loop.
              </p>
            </div>
            <dl className="grid w-full gap-4 border-t border-line pt-6 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <div className="grid gap-1">
                <dt className="text-base font-medium text-ink sm:text-sm">One hook</dt>
                <dd className="text-base leading-6 text-ink-muted sm:text-sm">
                  The controller and component arrive together.
                </dd>
              </div>
              <div className="grid gap-1">
                <dt className="text-base font-medium text-ink sm:text-sm">Authored input</dt>
                <dd className="text-base leading-6 text-ink-muted sm:text-sm">
                  Hover and focus behavior stays inside the asset.
                </dd>
              </div>
            </dl>
          </div>

          <RabbitDemo />
        </section>

        <section className="border-y border-line bg-paper" aria-labelledby="recipe-title">
          <div className="mx-auto grid w-full max-w-7xl gap-10 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[minmax(15rem,0.55fr)_minmax(0,1.45fr)] lg:gap-16 lg:px-10">
            <div className="flex flex-col items-start gap-4">
              <p className="text-base font-medium text-forest sm:text-sm">The whole recipe</p>
              <h2 id="recipe-title" className="max-w-sm text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
                Sources in. Component out.
              </h2>
              <p className="max-w-md text-pretty text-base leading-7 text-ink-muted">
                A codec-keyed source map is enough. AVAL chooses a compatible
                rendition, runs the authored graph, and exposes a reactive controller.
              </p>
            </div>
            <div className="min-w-0 overflow-hidden rounded-2xl bg-code text-code-foreground shadow-sm ring-1 ring-black/10">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
                <span className="text-base font-medium text-white/55 sm:text-sm">rabbit-demo.tsx</span>
                <span className="text-base text-white/55 sm:text-sm">React</span>
              </div>
              <pre className="overflow-x-auto p-5 text-base leading-7 sm:p-6 sm:text-sm sm:leading-6">
                <code>{HOOK_EXAMPLE}</code>
              </pre>
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8 sm:py-20 lg:px-10" aria-labelledby="ownership-title">
          <div className="grid gap-10 lg:grid-cols-[minmax(15rem,0.55fr)_minmax(0,1.45fr)] lg:gap-16">
            <div className="grid content-start gap-4">
              <p className="text-base font-medium text-forest sm:text-sm">Clear ownership</p>
              <h2 id="ownership-title" className="max-w-sm text-balance text-3xl font-semibold tracking-tight">
                React observes. AVAL performs.
              </h2>
            </div>
            <dl className="grid gap-8 sm:grid-cols-3 sm:gap-6">
              {REACTIVE_FIELDS.map((field) => (
                <div className="grid content-start gap-2 border-t border-line pt-4" key={field.name}>
                  <dt className="text-base font-medium text-ink">{field.name}</dt>
                  <dd className="text-pretty text-base leading-6 text-ink-muted sm:text-sm">
                    {field.description}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </main>

      <footer className="border-t border-line/80">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-5 py-8 text-base text-ink-muted sm:flex-row sm:items-center sm:justify-between sm:px-8 sm:text-sm lg:px-10">
          <p>Built with Next.js, Tailwind CSS, and the public AVAL React package.</p>
          <p>Grass Rabbit · Technical preview</p>
        </div>
      </footer>
    </div>
  );
}
