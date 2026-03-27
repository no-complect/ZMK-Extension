import React, { createContext, useContext } from "react";
import {
  DISCONNECTED_STATE,
  type ConnectionState,
  type ConnectionContextValue,
  type ConnectionStatus,
} from "./connection.types";
import { useConnectionContext } from "../hooks/useConnectionContext";

// Re-export types so consumers only need to import from this file
export type { ConnectionStatus, ConnectionState, ConnectionContextValue };

// ── Context ────────────────────────────────────────────────────────────────────

const ConnectionContext = createContext<ConnectionContextValue>({
  ...DISCONNECTED_STATE,
  unlock: async () => {},
  disconnect: () => {},
  connectBLE: async () => {},
  bleError: undefined,
  onNotification: () => () => {},
});

// ── Consumer hook ──────────────────────────────────────────────────────────────

export function useConnection(): ConnectionContextValue {
  return useContext(ConnectionContext);
}

// ── Provider ───────────────────────────────────────────────────────────────────

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const connection = useConnectionContext();
  return (
    <ConnectionContext.Provider value={connection}>
      {children}
    </ConnectionContext.Provider>
  );
}
