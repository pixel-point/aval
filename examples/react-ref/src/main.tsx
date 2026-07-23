import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AvalSources } from "@pixel-point/aval-react";

import { StatusMotion } from "./StatusMotion.js";
import "./styles.css";

const STATES = ["idle", "loading", "done"] as const;
const SOURCES = Object.freeze({
  av1: "/status/av1.avl",
  vp9: "/status/vp9.avl",
  h265: "/status/h265.avl",
  h264: "/status/h264.avl"
}) satisfies AvalSources;

function App() {
  const [requestedState, setRequestedState] = useState<string>("idle");
  const [status, setStatus] = useState("Waiting for AVAL…");
  const handleVisualState = useCallback((state: string | null) => {
    setStatus(state === null ? "Waiting for a visual state…" : `Visual state: ${state}`);
  }, []);
  const handleError = useCallback(() => {
    setStatus("Animation unavailable; React rendered the alternate status.");
  }, []);

  return (
    <main>
      <h1>AVAL React example</h1>
      <p>
        Replace <code>public/status/</code> with a codec bundle that defines
        the states used by these controls.
      </p>
      <StatusMotion
        sources={SOURCES}
        state={requestedState}
        onVisual={handleVisualState}
        onError={handleError}
      />
      <div className="controls" aria-label="Requested motion state">
        {STATES.map((state) => (
          <button key={state} type="button" onClick={() => setRequestedState(state)}>
            {state}
          </button>
        ))}
      </div>
      <output aria-live="polite">{status}</output>
    </main>
  );
}

const root = document.querySelector<HTMLElement>("#root");
if (root === null) throw new Error("React example root is missing");
createRoot(root).render(<App />);
