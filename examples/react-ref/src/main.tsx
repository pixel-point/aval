import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";

import { StatusMotion } from "./StatusMotion.js";
import "./styles.css";

const STATES = ["idle", "loading", "done"] as const;
const SOURCES = Object.freeze([
  Object.freeze({
    src: "/status/av1.avl",
    type: 'application/vnd.aval; codecs="av01.0.00M.10.0.110.01.01.01.0"'
  }),
  Object.freeze({
    src: "/status/vp9.avl",
    type: 'application/vnd.aval; codecs="vp09.00.10.08.01.01.01.01.00"'
  }),
  Object.freeze({
    src: "/status/h265.avl",
    type: 'application/vnd.aval; codecs="hvc1.1.6.L30.90"'
  }),
  Object.freeze({
    src: "/status/h264.avl",
    type: 'application/vnd.aval; codecs="avc1.64000A"'
  })
]);

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
      <h1>AVAL React ref example</h1>
      <p>
        Replace <code>public/status/</code> with a codec bundle that defines
        the states used by these controls.
      </p>
      <StatusMotion
        sources={SOURCES}
        state={requestedState}
        onVisualState={handleVisualState}
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
