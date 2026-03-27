import { useCallback, useEffect, useRef, useState } from "react";
import { call_rpc } from "@zmkfirmware/zmk-studio-ts-client";
import type { BehaviorBinding, Keymap, PhysicalLayout } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import { useConnection } from "../contexts/ConnectionContext";

export interface UseKeymapResult {
  keymap: Keymap | undefined;
  physicalLayouts: PhysicalLayout[];
  activeLayoutIndex: number;
  loading: boolean;
  error: string | undefined;
  refetch: () => void;
  /**
   * Batch-apply all pending binding changes to keyboard RAM, save to flash,
   * then update the local keymap snapshot to reflect the saved state.
   * Call clearPendingChanges() on the SelectedKey context after this resolves.
   */
  batchSave: (changes: Map<string, BehaviorBinding>) => Promise<void>;
}

function buildEffectiveKeymap(
  keymap: Keymap,
  changes: Map<string, BehaviorBinding>,
): Keymap {
  if (changes.size === 0) return keymap;
  return {
    ...keymap,
    layers: keymap.layers.map((layer) => ({
      ...layer,
      bindings: layer.bindings.map((b, i) => changes.get(`${layer.id}-${i}`) ?? b),
    })),
  };
}

/**
 * Fetches and owns the keymap loaded from the connected keyboard.
 *
 * Responsibilities:
 * - Load keymap + physical layouts on connect/unlock
 * - Expose the keymap as READ-ONLY state for rendering
 * - Provide batchSave() to atomically apply all pending changes and save to flash
 *
 * NOT responsible for:
 * - Tracking per-binding pending changes (that's useSelectedKeyContext)
 * - hasUnsavedChanges (derived from pendingChanges in useSelectedKeyContext)
 * - Undo/Redo (handled in useSelectedKeyContext)
 */
export function useKeymap(): UseKeymapResult {
  const { conn, lockState } = useConnection();
  const [keymap, setKeymap] = useState<Keymap | undefined>();
  const [physicalLayouts, setPhysicalLayouts] = useState<PhysicalLayout[]>([]);
  const [activeLayoutIndex, setActiveLayoutIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [fetchTick, setFetchTick] = useState(0);

  // Stable ref for async access inside batchSave without stale closures
  const keymapRef = useRef<Keymap | undefined>(undefined);

  const refetch = useCallback(() => setFetchTick((t) => t + 1), []);

  useEffect(() => {
    if (!conn || lockState !== LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED) {
      setKeymap(undefined);
      keymapRef.current = undefined;
      setPhysicalLayouts([]);
      return;
    }

    let cancelled = false;

    async function fetch() {
      setLoading(true);
      setError(undefined);
      try {
        const [keymapResp, layoutsResp] = await Promise.all([
          call_rpc(conn!, { keymap: { getKeymap: true } }),
          call_rpc(conn!, { keymap: { getPhysicalLayouts: true } }),
        ]);
        if (cancelled) return;

        const km = keymapResp.keymap?.getKeymap;
        keymapRef.current = km;
        setKeymap(km);

        const pl = layoutsResp.keymap?.getPhysicalLayouts;
        setPhysicalLayouts(pl?.layouts ?? []);
        setActiveLayoutIndex(pl?.activeLayoutIndex ?? 0);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetch();
    return () => {
      cancelled = true;
    };
  }, [conn, lockState, fetchTick]);

  const batchSave = useCallback(
    async (changes: Map<string, BehaviorBinding>) => {
      if (!conn) return;

      // 1. Write each pending change to keyboard RAM
      for (const [key, binding] of changes) {
        const parts = key.split("-");
        const layerId = Number(parts[0]);
        const keyPosition = Number(parts[1]);
        await call_rpc(conn, {
          keymap: { setLayerBinding: { layerId, keyPosition, binding } },
        });
      }

      // 2. Persist keyboard RAM → flash
      await call_rpc(conn, { keymap: { saveChanges: true } });

      // 3. Update local snapshot so it reflects what was just saved
      const current = keymapRef.current;
      if (current) {
        const saved = buildEffectiveKeymap(current, changes);
        keymapRef.current = saved;
        setKeymap(saved);
      }
    },
    [conn],
  );

  return {
    keymap,
    physicalLayouts,
    activeLayoutIndex,
    loading,
    error,
    refetch,
    batchSave,
  };
}
