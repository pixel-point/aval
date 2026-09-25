import { createElement, useState } from "react";
import { useAvalAlpha } from "@pixel-point/aval-alpha-react";
import { sources } from "./fixture.js";

export function ReactApp() {
  const [revision, setRevision] = useState(0);
  const [visible, setVisible] = useState(true);
  const [loop, setLoop] = useState(false);
  const [label, setLabel] = useState("initial");
  const [renders, setRenders] = useState(0);
  const [readies, setReadies] = useState(0);
  const [callback, setCallback] = useState("");
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState("");
  const [sized, setSized] = useState(true);
  const { alpha, AvalAlphaComponent } = useAvalAlpha({
    sources: failed ? [] : sources(revision), loop,
    onReady() { setReadies((count) => count + 1); setCallback(label); },
    onError(cause) { setError(`${label}:${cause.code}`); }
  });
  const run = (promise: Promise<void>) => { void promise.catch((cause: Error) => setError(cause.message)); };
  return <main>
    <h1>aval-alpha · React</h1>
    <section id="stage">{visible ? <AvalAlphaComponent width={sized ? 256 : undefined} height={sized ? 192 : undefined} aria-label="Transparent calibration" /> : null}</section>
    <output id="status" data-playing={String(alpha.playing)} data-readies={readies} data-callback={callback} data-renders={renders}>{alpha.status}</output>
    <output id="error">{error}</output>
    <button onClick={() => run(alpha.play())}>Play</button>
    <button onClick={() => alpha.pause()}>Pause</button>
    <button onClick={() => run(alpha.seek(0.5))}>Seek</button>
    <button onClick={() => setLoop(!loop)}>Toggle loop</button>
    <button onClick={() => setRenders(renders + 1)}>Equivalent sources</button>
    <button onClick={() => setLabel("updated")}>Change callbacks</button>
    <button onClick={() => { setFailed(false); setRevision(revision + 1); }}>Replace source</button>
    <button onClick={() => setFailed(true)}>Fail</button>
    <button onClick={() => setVisible(!visible)}>{visible ? "Unmount" : "Remount"}</button>
    <button onClick={() => setSized(false)}>Remove dimensions</button>
  </main>;
}
