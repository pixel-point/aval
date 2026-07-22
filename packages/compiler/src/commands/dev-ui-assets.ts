export const DEV_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
export const DEV_WORKER_CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'";

export const DEV_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AVAL dev</title>
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <h1>AVAL dev</h1>
  <p id="status" aria-live="polite">Waiting for a valid build…</p>
  <main>
    <section id="stage">
      <div class="preview">
        <button id="interaction" type="button">
          <aval-player id="motion" interaction-for="interaction"></aval-player>
          <span id="motion-unavailable">Compile to preview</span>
          <span>Interaction target</span>
        </button>
      </div>
      <p class="hint">Scroll this preview fully outside the viewport and back to verify suspension and seamless recovery.</p>
      <div class="controls" id="controls">
        <select id="state" aria-label="State"></select>
        <select id="event" aria-label="Event"></select>
        <button id="send" type="button">Send event</button>
        <button id="pause" type="button">Pause</button>
        <button id="resume" type="button">Resume</button>
        <button id="replace" type="button">Replace sources</button>
        <button id="stress" type="button">Run stress burst</button>
        <button id="clear-stress" type="button">Clear stress copies</button>
        <button id="capture-trace" type="button">Capture diagnostics trace</button>
        <select id="motion-policy" aria-label="Motion"><option>auto</option><option>reduce</option><option>full</option></select>
        <select id="fit" aria-label="Fit"><option>contain</option><option>cover</option><option>fill</option><option>none</option></select>
        <select id="autoplay" aria-label="Autoplay"><option>visible</option><option>manual</option></select>
        <select id="bindings" aria-label="Bindings"><option>auto</option><option>none</option></select>
        <input id="size" aria-label="Size" type="range" min="64" max="512" value="256">
      </div>
      <h2>Codec bundle</h2>
      <dl id="summary" class="summary"></dl>
      <div id="timeline" class="timeline" role="img" aria-label="No compiled codec assets yet"></div>
    </section>
    <section><h2>Compiler and public diagnostics</h2><pre id="report"></pre></section>
  </main>
  <script type="module" src="./client.js"></script>
</body>
</html>`;

export const DEV_CSS = `:root{color-scheme:light dark}body{font:14px system-ui;margin:2rem;color:#172033;background:#fff}main{display:grid;grid-template-columns:minmax(280px,40vw) 1fr;gap:1.5rem}.preview{min-height:280px;display:grid;place-items:center;border:1px solid #d4d9e3;border-radius:.75rem;background:repeating-conic-gradient(#f7f8fb 0 25%,#eef1f6 0 50%) 0/24px 24px}.preview button{background:color-mix(in srgb,Canvas 88%,transparent);border:1px solid #7d8799;border-radius:.6rem;padding:.75rem}aval-player{display:block;width:256px;max-width:100%;aspect-ratio:1;border:1px solid #aab3c5;background:#f2f4f8}.hint{color:#566176}.controls{display:flex;flex-wrap:wrap;gap:.5rem;margin:.75rem 0}button,select,input{font:inherit}.summary{display:grid;grid-template-columns:max-content 1fr;gap:.3rem 1rem}.summary dt{font-weight:600}.summary dd{margin:0;font-variant-numeric:tabular-nums}.timeline{display:flex;min-height:3.25rem;border:1px solid #aab3c5;border-radius:.4rem;overflow:hidden;background:#f2f4f8}.unit{display:grid;place-items:center;min-width:2px;padding:.3rem;border-inline-end:1px solid #fff8;text-align:center;font-size:.75rem;overflow:hidden}.unit:nth-child(3n+1){background:#c5d8ff}.unit:nth-child(3n+2){background:#ccebdc}.unit:nth-child(3n){background:#f4d5af}pre{white-space:pre-wrap;max-height:70vh;overflow:auto;background:#f2f4f8;padding:1rem;border-radius:.5rem}@media(prefers-color-scheme:dark){body{color:#e9edf5;background:#11151c}.preview{border-color:#465063;background:repeating-conic-gradient(#1c222d 0 25%,#171c25 0 50%) 0/24px 24px}.hint{color:#aeb8c8}aval-player,pre,.timeline{background:#1c222d;border-color:#566176}.unit{color:#11151c}}@media(max-width:800px){main{grid-template-columns:1fr}}`;

export const DEV_CLIENT = `import { AvalPlaybackError } from "./modules/element/index.js";
import "./modules/element/auto.js";
const byId=(id)=>document.getElementById(id);
const status=byId("status"),report=byId("report"),motion=byId("motion"),unavailable=byId("motion-unavailable"),state=byId("state"),event=byId("event"),summary=byId("summary"),timeline=byId("timeline"),send=byId("send"),pause=byId("pause"),resume=byId("resume");
const sessionBase=new URL("./",import.meta.url);
let build=null,compilerReport=null,replacement=0,capturedTrace=null,refreshSerial=0;
const motionControls=[state,event,send,pause,resume];
const setMotionControlsDisabled=(disabled)=>{for(const control of motionControls)control.disabled=disabled;};
const runMotion=(operation)=>{try{void Promise.resolve(operation()).catch(()=>undefined);}catch{}};
const fill=(select,values)=>{select.replaceChildren(...values.map(value=>{const option=document.createElement("option");option.value=value;option.textContent=value;return option;}));};
const redact=(value)=>JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==="string"?item.split(sessionBase.href).join("./"):item));
const replaceSummary=(pairs)=>{summary.replaceChildren(...pairs.flatMap(([name,value])=>{const term=document.createElement("dt"),description=document.createElement("dd");term.textContent=name;description.textContent=String(value);return[term,description];}));};
const renderAssets=()=>{const sources=build?.sources??[];timeline.replaceChildren(...sources.map(source=>{const segment=document.createElement("div");segment.className="unit";segment.style.flex=String(Math.max(1,source.bytes));segment.textContent=source.codec.toUpperCase();segment.title=source.codec+" · "+String(source.bytes)+" bytes · "+source.type;return segment;}));timeline.setAttribute("aria-label",sources.length?"Compiled codec bundle: "+sources.map(source=>source.codec).join(", "):"No compiled codec assets yet");};
const render=(capture=false)=>{const diagnostics=motion.getDiagnostics({trace:false}),presentation=diagnostics.presentation,runtime=diagnostics.runtime;if(capture)capturedTrace=redact(motion.getDiagnostics({trace:true}));const total=(build?.sources??[]).reduce((sum,source)=>sum+source.bytes,0);replaceSummary([["Generation",build?.generation??"—"],["Sources",build?build.sources.map(source=>source.codec.toUpperCase()).join(" · "):"—"],["Encoded bytes",build?total:"—"],["Build report",build?build.buildReport.sha256.slice(0,12):"—"],["State",String(diagnostics.visualState??"—")+(diagnostics.isTransitioning?" · transitioning":"")],["Readiness",diagnostics.readiness],["Visibility",diagnostics.effectivelyVisible?"visible":"suspended/offscreen"],["Presentation",presentation?presentation.backingWidth+"×"+presentation.backingHeight+" · DPR "+presentation.effectiveDprX+"×"+presentation.effectiveDprY:"—"],["Decoder",runtime?.decoderLeaseState??"—"]]);report.textContent=JSON.stringify(redact({build,compilerReport,states:motion.stateNames,events:motion.eventNames,bindings:motion.inputBindings,diagnostics,capturedTrace}),null,2);};
const installSources=(sources,suffix="")=>{const elements=sources.map(source=>{const element=document.createElement("source");element.setAttribute("src",source.src.split("#")[0]+suffix+(suffix?"":"#v="+String(build.generation)));element.setAttribute("data-codec",source.codec);element.setAttribute("integrity",source.integrity);return element;});motion.replaceChildren(...elements);};
const readCompilerReport=async(next)=>{const response=await fetch(new URL(next.buildReport.src,sessionBase));if(!response.ok)throw new Error("build report unavailable");const value=await response.json();if(value===null||typeof value!=="object"||value.reportVersion!=="1.0"||!Array.isArray(value.assets))throw new Error("build report unavailable");return value;};
const refresh=async(next)=>{const serial=++refreshSerial;let nextReport;try{nextReport=await readCompilerReport(next);}catch{if(serial!==refreshSerial)return;status.textContent="Build "+next.generation+" · build report unavailable";render();return;}if(serial!==refreshSerial)return;build=next;compilerReport=nextReport;installSources(next.sources);renderAssets();try{await motion.prepare();}catch(error){if(serial!==refreshSerial)return;const diagnostics=motion.getDiagnostics();const fatal=error instanceof AvalPlaybackError&&diagnostics.readiness==="error"&&diagnostics.lastFailure!==null&&error.failure===diagnostics.lastFailure;if(fatal){unavailable.hidden=false;setMotionControlsDisabled(true);status.textContent="Build "+next.generation+" · playback unavailable";}else{status.textContent="Build "+next.generation+" · preparation interrupted";}render();return;}if(serial!==refreshSerial)return;unavailable.hidden=motion.readiness==="interactiveReady";setMotionControlsDisabled(motion.readiness==="error");fill(state,[...motion.stateNames]);fill(event,[...motion.eventNames]);status.textContent="Build "+next.generation+" · "+motion.readiness;render();};
new EventSource(new URL("./events",import.meta.url)).addEventListener("build",message=>{void refresh(JSON.parse(message.data)).catch(()=>undefined);});
send.onclick=()=>runMotion(()=>motion.send(event.value));
state.onchange=()=>runMotion(()=>motion.setState(state.value));
pause.onclick=()=>runMotion(()=>motion.pause());
resume.onclick=()=>runMotion(()=>motion.resume());
byId("replace").onclick=()=>{if(build){replacement+=1;installSources(build.sources,"#replace-"+String(replacement));}};
byId("stress").onclick=()=>{if(!build)return;for(let index=0;index<6;index+=1){const copy=motion.cloneNode(true);copy.classList.add("stress-copy");copy.removeAttribute("id");copy.removeAttribute("interaction-for");for(const source of copy.querySelectorAll(":scope > source")){source.setAttribute("src",source.getAttribute("src").split("#")[0]+"#stress-"+String(replacement)+"-"+String(index));}motion.parentElement.after(copy);void copy.prepare().then(()=>{const names=[...copy.stateNames];if(names.length>1)runMotion(()=>copy.setState(names.at(-1)));runMotion(()=>copy.pause());runMotion(()=>copy.resume());}).catch(()=>undefined);}replacement+=1;};
byId("clear-stress").onclick=()=>{for(const copy of document.querySelectorAll("aval-player.stress-copy")){void copy.dispose();copy.remove();}};
byId("capture-trace").onclick=()=>render(true);
byId("motion-policy").onchange=e=>{motion.motion=e.target.value;};
byId("fit").onchange=e=>{motion.fit=e.target.value;};
byId("autoplay").onchange=e=>{motion.autoplay=e.target.value;};
byId("bindings").onchange=e=>{motion.bindings=e.target.value;};
byId("size").oninput=e=>{motion.style.width=e.target.value+"px";};
motion.addEventListener("error",event=>{const diagnostics=motion.getDiagnostics();if(!event.detail.fatal||diagnostics.readiness!=="error"||diagnostics.lastFailure===null||event.detail.failure!==diagnostics.lastFailure)return;unavailable.hidden=false;setMotionControlsDisabled(true);render();});
motion.addEventListener("readinesschange",()=>{const interactive=motion.readiness==="interactiveReady";unavailable.hidden=interactive;if(interactive)setMotionControlsDisabled(false);render();});
for(const name of ["requestedstatechange","visualstatechange","transitionstart","transitionend","underflow"]){motion.addEventListener(name,render);}
const timer=setInterval(render,250);addEventListener("pagehide",()=>clearInterval(timer),{once:true});`;
