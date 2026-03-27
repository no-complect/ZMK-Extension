import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import App from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found in WebView HTML");

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
