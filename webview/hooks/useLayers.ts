import { useCallback } from "react";
import { call_rpc } from "@zmkfirmware/zmk-studio-ts-client";
import { useConnection } from "../contexts/ConnectionContext";
import type { UndoableAction } from "./useUndoRedo";

export interface UseLayersResult {
  addLayer: () => Promise<UndoableAction | undefined>;
  removeLayer: (layerIndex: number) => Promise<UndoableAction | undefined>;
  moveLayer: (fromIndex: number, toIndex: number) => Promise<UndoableAction | undefined>;
  renameLayer: (layerId: number, name: string) => Promise<void>;
  setActivePhysicalLayout: (layoutIndex: number) => Promise<void>;
}

/**
 * Layer management operations.
 *
 * Every structural change (add / remove / move / rename / layout switch) is
 * immediately persisted to flash via saveChanges. Undo and redo actions do the
 * same, so every step stays in sync between keyboard RAM and flash.
 *
 * The caller is responsible for pushing the returned UndoableAction onto the
 * shared undo/redo stack (via pushUndoable from SelectedKeyContext).
 *
 * @example
 * const { addLayer } = useLayers(refetchKeymap);
 * const action = await addLayer();
 * if (action) pushUndoable(action);
 */
export function useLayers(onChanged: () => void): UseLayersResult {
  const { conn } = useConnection();

  /** Persist keyboard RAM → flash after every structural operation. */
  const persist = useCallback(async (): Promise<void> => {
    if (!conn) return;
    await call_rpc(conn, { keymap: { saveChanges: true } });
  }, [conn]);

  // ── Add ────────────────────────────────────────────────────────────────────

  const addLayer = useCallback(async (): Promise<UndoableAction | undefined> => {
    if (!conn) return;
    const resp = await call_rpc(conn, { keymap: { addLayer: {} } });
    const result = resp.keymap?.addLayer;
    if (!result?.ok) return;

    const { index } = result.ok;

    // Fetch the new layer's ID so redo can restore the exact layer (not create a blank one).
    const keymapResp = await call_rpc(conn, { keymap: { getKeymap: true } });
    const newLayer = keymapResp.keymap?.getKeymap?.layers[index];
    if (!newLayer) return;

    await persist();
    onChanged();

    return {
      label: "Add layer",
      undo: async () => {
        await call_rpc(conn, { keymap: { removeLayer: { layerIndex: index } } });
        await persist();
        onChanged();
      },
      redo: async () => {
        await call_rpc(conn, { keymap: { restoreLayer: { layerId: newLayer.id, atIndex: index } } });
        await persist();
        onChanged();
      },
    };
  }, [conn, onChanged, persist]);

  // ── Remove ─────────────────────────────────────────────────────────────────

  const removeLayer = useCallback(
    async (layerIndex: number): Promise<UndoableAction | undefined> => {
      if (!conn) return;

      // Snapshot the layer before removing so undo can restore it.
      const keymapResp = await call_rpc(conn, { keymap: { getKeymap: true } });
      const layer = keymapResp.keymap?.getKeymap?.layers[layerIndex];
      if (!layer) return;

      const resp = await call_rpc(conn, { keymap: { removeLayer: { layerIndex } } });
      if (!resp.keymap?.removeLayer?.ok) return;
      await persist();
      onChanged();

      return {
        label: `Remove layer "${layer.name}"`,
        undo: async () => {
          await call_rpc(conn, {
            keymap: { restoreLayer: { layerId: layer.id, atIndex: layerIndex } },
          });
          await persist();
          onChanged();
        },
        redo: async () => {
          await call_rpc(conn, { keymap: { removeLayer: { layerIndex } } });
          await persist();
          onChanged();
        },
      };
    },
    [conn, onChanged, persist]
  );

  // ── Move ───────────────────────────────────────────────────────────────────

  const moveLayer = useCallback(
    async (fromIndex: number, toIndex: number): Promise<UndoableAction | undefined> => {
      if (!conn) return;
      await call_rpc(conn, {
        keymap: { moveLayer: { startIndex: fromIndex, destIndex: toIndex } },
      });
      await persist();
      onChanged();

      return {
        label: `Move layer ${fromIndex} → ${toIndex}`,
        undo: async () => {
          await call_rpc(conn, {
            keymap: { moveLayer: { startIndex: toIndex, destIndex: fromIndex } },
          });
          await persist();
          onChanged();
        },
        redo: async () => {
          await call_rpc(conn, {
            keymap: { moveLayer: { startIndex: fromIndex, destIndex: toIndex } },
          });
          await persist();
          onChanged();
        },
      };
    },
    [conn, onChanged, persist]
  );

  // ── Rename ─────────────────────────────────────────────────────────────────

  const renameLayer = useCallback(
    async (layerId: number, name: string): Promise<void> => {
      if (!conn) return;
      await call_rpc(conn, { keymap: { setLayerProps: { layerId, name } } });
      await persist();
      onChanged();
    },
    [conn, onChanged, persist]
  );

  // ── Physical layout ────────────────────────────────────────────────────────

  const setActivePhysicalLayout = useCallback(
    async (layoutIndex: number): Promise<void> => {
      if (!conn) return;
      await call_rpc(conn, { keymap: { setActivePhysicalLayout: layoutIndex } });
      await persist();
      onChanged();
    },
    [conn, onChanged, persist]
  );

  return { addLayer, removeLayer, moveLayer, renameLayer, setActivePhysicalLayout };
}
