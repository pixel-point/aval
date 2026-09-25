import { hydrate } from "svelte";
import SvelteApp from "./SvelteApp.svelte";
Object.assign(window, { serverCanvas: document.querySelector("canvas") });
hydrate(SvelteApp, { target: document.querySelector("#app")! });
