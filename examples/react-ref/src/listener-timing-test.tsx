import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { defineAvalElement } from "@pixel-point/aval-element";

import { StatusMotion } from "./StatusMotion.js";

declare global {
  interface Window {
    remountStatusMotion(): Promise<Readonly<{
      detachedElementHandledFatal: boolean;
    }>>;
  }
}

const rootElement = document.querySelector<HTMLElement>("#root");
const fatalCountElement = document.querySelector<HTMLOutputElement>("#fatal-count");
if (rootElement === null || fatalCountElement === null) {
  throw new Error("listener timing test markup is incomplete");
}
const fatalCountOutput = fatalCountElement;

defineAvalElement();

const root = createRoot(rootElement);
let fatalCount = 0;
let instance = 0;

function handleFatal(): void {
  fatalCount += 1;
  fatalCountOutput.value = String(fatalCount);
}

function renderInstance(): void {
  root.render(
    <StatusMotion
      key={instance}
      sources={[]}
      state={`instance-${String(instance)}`}
      onError={handleFatal}
    />
  );
}

window.remountStatusMotion = async () => {
  const detachedElement = rootElement.querySelector("aval-player");
  flushSync(() => root.render(null));
  const beforeDetachedDispatch = fatalCount;
  detachedElement?.dispatchEvent(new CustomEvent("error", {
    detail: {
      fatal: true,
      failure: { code: "detached-fatal" }
    }
  }));
  const detachedElementHandledFatal = fatalCount !== beforeDetachedDispatch;
  instance += 1;
  renderInstance();
  return { detachedElementHandledFatal };
};

renderInstance();
