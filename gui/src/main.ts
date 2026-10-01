import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";

const target = document.getElementById("app");
if (target === null) {
  // index.html owns this element. If it is gone the build is broken, and failing loudly beats a
  // blank window that looks like a hung engine.
  throw new Error('mount target #app is missing from index.html');
}

export default mount(App, { target });
