import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { registerServiceWorker } from "./features/pwa/pwa";
import { installExpectedBrowserErrorHandlers } from "./lib/browser-errors";

installExpectedBrowserErrorHandlers();

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

registerServiceWorker();
