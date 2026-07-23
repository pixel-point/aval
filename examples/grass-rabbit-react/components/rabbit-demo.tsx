"use client";

import Image from "next/image";
import { useCallback, useState } from "react";
import {
  useAval,
  type AvalSources,
  type AvalVisualStateChangeDetail,
  type RuntimeReadiness
} from "@pixel-point/aval-react";

const RABBIT_SOURCES = {
  av1: "/grass-rabbit/av1.avl",
  vp9: "/grass-rabbit/vp9.avl",
  h265: "/grass-rabbit/h265.avl",
  h264: "/grass-rabbit/h264.avl"
} satisfies AvalSources;

const READINESS_LABELS: Readonly<Record<RuntimeReadiness, string>> = {
  unready: "Loading",
  metadataReady: "Loading media",
  visualReady: "Visual ready",
  interactiveReady: "Interactive",
  staticReady: "Static",
  disposed: "Unavailable",
  error: "Error"
};

const EXPERIENCE_LABELS: Readonly<Record<RuntimeReadiness, string>> = {
  unready: "Preparing",
  metadataReady: "Preparing",
  visualReady: "Starting",
  interactiveReady: "Live",
  staticReady: "Motion inactive",
  disposed: "Unavailable",
  error: "Unavailable"
};

function stateLabel(state: string | null): string {
  if (state === null) return "Waiting";
  const words = state.replaceAll(/([a-z])([A-Z])/g, "$1 $2").replaceAll(/[-_]/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export function RabbitDemo() {
  const [showHint, setShowHint] = useState(true);
  const handleVisualStateChange = useCallback(
    ({ to }: Readonly<AvalVisualStateChangeDetail>) => {
      if (to !== "idle") setShowHint(false);
    },
    []
  );
  const { aval, AvalComponent } = useAval({
    sources: RABBIT_SOURCES,
    autoplay: true,
    autoBind: true,
    onVisualStateChange: handleVisualStateChange
  });

  const fatalFailure = aval.lastError?.fatal === true
    ? aval.lastError.failure
    : null;
  const presented = aval.readiness === "visualReady" ||
    aval.readiness === "interactiveReady";
  const interactive = aval.readiness === "interactiveReady";
  const staticReady = aval.readiness === "staticReady";
  const unavailable = fatalFailure !== null ||
    aval.readiness === "disposed" ||
    aval.readiness === "error";
  const failureMessage = fatalFailure?.message ??
    "The runtime is unavailable. Refresh the page to try again.";
  const instruction = unavailable
    ? "Motion is unavailable for this preview."
    : staticReady
      ? "Motion is inactive for this preview."
      : interactive
        ? "Hover or focus the rabbit to run its authored interaction."
        : "Preparing the animation.";
  const statusLabel = unavailable
    ? "Unavailable"
    : EXPERIENCE_LABELS[aval.readiness];

  return (
    <section className="overflow-hidden rounded-3xl bg-stage shadow-2xl shadow-forest/10 ring-1 ring-black/10" aria-labelledby="demo-title">
      <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 text-white sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="grid gap-0.5">
          <h2 id="demo-title" className="text-base font-medium sm:text-sm">Grass Rabbit</h2>
          <p id="rabbit-instructions" className="text-base leading-6 text-white/45 sm:text-sm sm:leading-5">
            {instruction}
          </p>
        </div>
        <span
          className="inline-flex w-fit items-center gap-2 rounded-full bg-white/8 px-3 py-1.5 text-base font-medium text-white/75 ring-1 ring-white/10 sm:text-sm"
          data-testid="rabbit-experience-status"
        >
          <span className={`size-1.5 rounded-full ${interactive ? "bg-moss-light" : "bg-white/30"}`} aria-hidden="true" />
          {statusLabel}
        </span>
      </div>

      <div
        className="rabbit-stage relative aspect-video w-full overflow-hidden"
        data-ready={presented ? "true" : "false"}
        data-failed={unavailable ? "true" : "false"}
      >
        {showHint && interactive && !unavailable ? (
          <span className="rabbit-interaction-hint pointer-events-none absolute top-[48%] left-[76%] z-10 size-11 -translate-x-1/2 -translate-y-1/2" aria-hidden="true">
            <Image
              className="relative z-10 block size-full"
              src="/interaction-hotspot.svg"
              alt=""
              width={44}
              height={44}
              draggable={false}
              unoptimized
            />
          </span>
        ) : null}
        <AvalComponent
          className="rabbit-player size-full"
          width={640}
          height={360}
          tabIndex={interactive ? 0 : -1}
          role="img"
          aria-label="Grass rabbit animation"
          aria-describedby="rabbit-instructions"
          aria-hidden={unavailable || staticReady}
          data-testid="grass-rabbit-player"
        />
        {staticReady && !unavailable ? (
          <div className="absolute inset-0 grid place-items-center bg-stage px-8 text-center">
            <div className="grid max-w-sm gap-2">
              <p className="text-base font-medium text-white">Motion is inactive.</p>
              <p className="text-base leading-6 text-white/50 sm:text-sm">
                This animation is inactive under the current runtime policy.
              </p>
            </div>
          </div>
        ) : null}
        {unavailable ? (
          <div className="absolute inset-0 grid place-items-center bg-stage px-8 text-center" role="alert">
            <div className="grid max-w-sm gap-2">
              <p className="text-base font-medium text-white">The motion could not load.</p>
              <p className="text-base leading-6 text-white/50 sm:text-sm">
                {failureMessage}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <dl className="grid divide-y divide-white/10 border-t border-white/10 text-white sm:grid-cols-3 sm:divide-x sm:divide-y-0" aria-live="polite">
        <div className="grid min-w-0 gap-1 px-5 py-4">
          <dt className="text-base font-medium text-white/45 sm:text-sm">Readiness</dt>
          <dd className="text-base font-medium" data-testid="rabbit-readiness">
            {READINESS_LABELS[aval.readiness]}
          </dd>
        </div>
        <div className="grid min-w-0 gap-1 px-5 py-4">
          <dt className="text-base font-medium text-white/45 sm:text-sm">Visual state</dt>
          <dd className="text-base font-medium" data-testid="rabbit-visual-state">
            {stateLabel(aval.visualState)}
          </dd>
        </div>
        <div className="grid min-w-0 gap-1 px-5 py-4">
          <dt className="text-base font-medium text-white/45 sm:text-sm">Transition</dt>
          <dd className="text-base font-medium" data-testid="rabbit-transition">
            {aval.isTransitioning ? "Transitioning" : "At rest"}
          </dd>
        </div>
      </dl>
    </section>
  );
}
