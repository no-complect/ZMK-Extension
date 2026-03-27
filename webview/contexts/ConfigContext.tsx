import React, { createContext, useContext } from "react";
import { useConfig } from "../hooks/useConfig";
import type { ConfigValues } from "../hooks/useConfig";

// ── Context shape ─────────────────────────────────────────────────────────────

interface ConfigContextValue {
  values: ConfigValues;
  hasFile: boolean;
  setConfig: (key: string, value: string | number | boolean) => void;
}

// ── Context ───────────────────────────────────────────────────────────────────

const ConfigContext = createContext<ConfigContextValue | undefined>(undefined);

// ── Provider ──────────────────────────────────────────────────────────────────

/**
 * Provides the ZMK .conf config state to the component tree.
 * Must be placed above any component or hook that reads or writes config values,
 * including BindingEditor and useSelectedKeyContext (for config undo/redo).
 */
export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const config = useConfig();
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

// ── Consumer hook ─────────────────────────────────────────────────────────────

export function useConfigContext(): ConfigContextValue {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error("useConfigContext must be used within <ConfigProvider>");
  return ctx;
}
