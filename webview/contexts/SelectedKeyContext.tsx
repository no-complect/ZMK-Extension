import React, { createContext, useContext } from "react";
import type { BehaviorBinding } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { useSelectedKeyContext } from "../hooks/useSelectedKeyContext";
import type { ConfigChangeset } from "../components/BindingEditor";
import type { UndoableAction } from "../hooks/useUndoRedo";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SelectedKeyContextValue {
  selectedKeyPosition: number | undefined;
  setSelectedKeyPosition: (pos: number | undefined) => void;
  /** Effective binding: pending change if one exists, otherwise original from flash */
  currentBinding: BehaviorBinding | undefined;
  /** All pending (unsaved) binding changes keyed by "layerId-keyPosition" */
  pendingChanges: Map<string, BehaviorBinding>;
  /** Config keys that have been Applied but not yet Saved to Flash */
  pendingConfigChanges: Map<string, number | string | boolean>;
  /** True when any binding or config change is pending */
  hasUnsavedChanges: boolean;
  /** Record a binding change for the selected key (React state only, no RPC) */
  handleBindingChanged: (binding: BehaviorBinding) => void;
  /**
   * Record config (.conf) changes from BindingEditor's Apply event.
   * Enables Save to Flash / Discard / Undo / Redo to be aware of config changes.
   */
  handleConfigApplied: (changeset: ConfigChangeset) => void;
  /** Step back one change in undo history */
  handleUndo: () => Promise<void>;
  /** Step forward one change in redo history */
  handleRedo: () => Promise<void>;
  /** Revert the selected key's pending binding and all pending config changes */
  handleDiscard: () => void;
  /** Clear all pending changes and reset undo/redo stack (called after Save to Flash) */
  clearPendingChanges: () => void;
  /** Push a layer-structural action (add/remove/move) onto the shared undo/redo stack */
  pushUndoable: (action: UndoableAction) => void;
  canUndo: boolean;
  canRedo: boolean;
  undoFlash: boolean;
  redoFlash: boolean;
}

// ── Context ────────────────────────────────────────────────────────────────────

const SelectedKeyContext = createContext<SelectedKeyContextValue | undefined>(undefined);

// ── Provider ───────────────────────────────────────────────────────────────────

export function SelectedKeyProvider({ children }: { children: React.ReactNode }) {
  const value = useSelectedKeyContext();
  return (
    <SelectedKeyContext.Provider value={value}>
      {children}
    </SelectedKeyContext.Provider>
  );
}

// ── Consumer hook ──────────────────────────────────────────────────────────────

export function useSelectedKey(): SelectedKeyContextValue {
  const ctx = useContext(SelectedKeyContext);
  if (!ctx) throw new Error("useSelectedKey must be used within <SelectedKeyProvider>");
  return ctx;
}
