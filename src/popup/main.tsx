import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { currentSurface } from "./views";

// Set before the first paint: the popup has a fixed size, the side panel and tab fill their frame.
document.documentElement.dataset.surface = currentSurface();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
