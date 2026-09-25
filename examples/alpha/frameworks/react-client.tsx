import { createElement, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { ReactApp } from "./ReactApp.js";

Object.assign(window, { serverCanvas: document.querySelector("canvas") });
hydrateRoot(document.querySelector("#app")!, createElement(StrictMode, null, createElement(ReactApp)));
