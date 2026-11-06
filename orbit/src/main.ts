// Phase 1 placeholder: the 2D shell (§6) replaces this in phase 3.
import "./ui/style.css";
import { h } from "./ui/dom";

const app = document.getElementById("app");
if (app) app.replaceChildren(h("main", { class: "boot" }, h("h1", null, "Orbit")));
