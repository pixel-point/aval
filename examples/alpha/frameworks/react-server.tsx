import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { ReactApp } from "./ReactApp.js";
export function render() { return renderToString(createElement(StrictMode, null, createElement(ReactApp))); }
