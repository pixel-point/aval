import { render as renderSvelte } from "svelte/server";
import SvelteApp from "./SvelteApp.svelte";
export function render() { return renderSvelte(SvelteApp).body; }
