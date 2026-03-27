import React, { createContext, useContext, useEffect, useState } from "react";
import type { BehaviorBinding, Keymap, PhysicalLayout, Layer } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { useKeymap } from "../hooks/useKeymap";
import { useBehaviors, type BehaviorMap } from "../hooks/useBehaviors";
import { useLayers } from "../hooks/useLayers";
import type { UndoableAction } from "../hooks/useUndoRedo";

// ── Context shape ─────────────────────────────────────────────────────────────

interface KeymapContextValue {
  /** The keymap as loaded from the keyboard (flash state). Read-only — mutated only on fetch or batchSave. */
  keymap: Keymap | undefined;
  physicalLayouts: PhysicalLayout[];
  activeLayoutIndex: number;
  loading: boolean;
  error: string | undefined;
  behaviors: BehaviorMap;
  selectedLayerIndex: number;
  setSelectedLayerIndex: (i: number) => void;
  /** Convenience: keymap.layers[selectedLayerIndex] — the original bindings from flash */
  activeLayer: Layer | undefined;
  refetchKeymap: () => void;
  /**
   * Batch-apply all pending binding changes to the keyboard, save to flash,
   * and update the local keymap snapshot. After calling this, also call
   * clearPendingChanges() from the SelectedKey context.
   */
  batchSave: (changes: Map<string, BehaviorBinding>) => Promise<void>;
  // ── Layer structural operations ──────────────────────────────────────────
  addLayer: () => Promise<UndoableAction | undefined>;
  removeLayer: (layerIndex: number) => Promise<UndoableAction | undefined>;
  moveLayer: (fromIndex: number, toIndex: number) => Promise<UndoableAction | undefined>;
  renameLayer: (layerId: number, name: string) => Promise<void>;
  setActivePhysicalLayout: (layoutIndex: number) => Promise<void>;
}

// ── Context ───────────────────────────────────────────────────────────────────

const KeymapContext = createContext<KeymapContextValue | undefined>(undefined);

// ── Provider ──────────────────────────────────────────────────────────────────

export function KeymapProvider({ children }: { children: React.ReactNode }) {
  const {
    keymap,
    physicalLayouts,
    activeLayoutIndex,
    loading,
    error,
    refetch,
    batchSave,
  } = useKeymap();

  const { behaviors, loading: behaviorsLoading } = useBehaviors();
  const [selectedLayerIndex, setSelectedLayerIndex] = useState(0);

  // Clamp selectedLayerIndex when layers are added or removed
  useEffect(() => {
    if (!keymap || keymap.layers.length === 0) return;
    const max = keymap.layers.length - 1;
    setSelectedLayerIndex((prev) => (prev > max ? max : prev));
  }, [keymap?.layers.length]);

  const layers = useLayers(refetch);

  const activeLayer = keymap?.layers[selectedLayerIndex];

  return (
    <KeymapContext.Provider
      value={{
        keymap,
        physicalLayouts,
        activeLayoutIndex,
        loading: loading || behaviorsLoading,
        error,
        behaviors,
        selectedLayerIndex,
        setSelectedLayerIndex,
        activeLayer,
        refetchKeymap: refetch,
        batchSave,
        addLayer: layers.addLayer,
        removeLayer: layers.removeLayer,
        moveLayer: layers.moveLayer,
        renameLayer: layers.renameLayer,
        setActivePhysicalLayout: layers.setActivePhysicalLayout,
      }}
    >
      {children}
    </KeymapContext.Provider>
  );
}

// ── Consumer hook ─────────────────────────────────────────────────────────────

export function useKeymapContext(): KeymapContextValue {
  const ctx = useContext(KeymapContext);
  if (!ctx) throw new Error("useKeymapContext must be used within <KeymapProvider>");
  return ctx;
}
