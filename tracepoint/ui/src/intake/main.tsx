import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { IntakeApp } from "./App";
import { ThemeProvider } from "../lib/theme";
import { ToastProvider } from "../components/ui";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <IntakeApp />
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
