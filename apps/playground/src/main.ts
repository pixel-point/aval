import "./style.css";

const app = document.querySelector<HTMLElement>("#app");

if (app === null) {
  throw new Error("Missing #app root");
}

app.innerHTML = `
  <section class="shell">
    <p class="eyebrow">Web-only experiment</p>
    <h1>Continuous rendered motion</h1>
    <p>M0 workspace is ready. The WebCodecs loop experiment is being connected.</p>
  </section>
`;
