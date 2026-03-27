import { useCallback, useRef, useState } from "react";
import type { BehaviorBinding } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { useKeymapContext } from "../contexts/KeymapContext";
import { useConfigContext } from "../contexts/ConfigContext";
import { useUndoRedo } from "./useUndoRedo";
import type { SelectedKeyContextValue } from "../contexts/SelectedKeyContext";
import type { ConfigChangeset } from "../components/BindingEditor";

// ── Flash indicator ────────────────────────────────────────────────────────────

function useFlash(duration = 1500): [boolean, () => void] {
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trigger = useCallback(() => {
    setActive(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setActive(false), duration);
  }, [duration]);

  return [active, trigger];
}

// ── Binding equality ───────────────────────────────────────────────────────────

function bindingsEqual(a: BehaviorBinding, b: BehaviorBinding): boolean {
  return a.behaviorId === b.behaviorId && a.param1 === b.param1 && a.param2 === b.param2;
}

// ── Main hook ──────────────────────────────────────────────────────────────────

/**
 * Manages the selected-key state and all pending changes (binding + config).
 *
 * Architecture:
 * - Binding changes are stored in pendingChanges (React state) and only sent
 *   to the keyboard when the user clicks "Save to Flash".
 * - Config changes (from BindingEditor's config section) are tracked in
 *   pendingConfigChanges. The values are already auto-saved to the .conf file
 *   by useConfigContext, but the pending flag enables Save to Flash / Discard /
 *   Undo / Redo to be aware of them.
 * - Undo/Redo covers both binding AND config changes via a single shared stack.
 * - hasUnsavedChanges = pendingChanges.size > 0 || pendingConfigChanges.size > 0
 * - clearPendingChanges() resets everything after a successful Save to Flash.
 *
 * Reads activeLayer from KeymapContext and setConfig from ConfigContext as
 * READ-ONLY access. Does NOT call any mutating functions on those contexts
 * during normal binding edits — only setConfig is called during undo/redo/discard
 * of config changes (which is an explicit revert, not an upward chain).
 */
export function useSelectedKeyContext(): SelectedKeyContextValue {
  // ── Read-only references ──────────────────────────────────────────────────
  const { activeLayer } = useKeymapContext();
  const { setConfig } = useConfigContext();

  // ── Key selection ─────────────────────────────────────────────────────────
  const [selectedKeyPosition, setSelectedKeyPosition] = useState<number | undefined>();

  // ── Pending binding changes ───────────────────────────────────────────────
  // State drives re-renders; ref provides stable access inside callbacks.
  const [pendingChanges, setPendingChanges] = useState<Map<string, BehaviorBinding>>(
    () => new Map(),
  );
  const pendingRef = useRef<Map<string, BehaviorBinding>>(new Map());

  const setPending = useCallback((next: Map<string, BehaviorBinding>) => {
    pendingRef.current = next;
    setPendingChanges(next);
  }, []);

  // ── Pending config changes ────────────────────────────────────────────────
  // Tracks config key/value pairs that have been Applied but not yet Saved to Flash.
  // Values are already in the .conf file (auto-saved), but this state enables
  // the toolbar buttons and Discard to be aware of them.
  const [pendingConfigChanges, setPendingConfigChanges] = useState<
    Map<string, number | string | boolean>
  >(() => new Map());
  const pendingConfigRef = useRef<Map<string, number | string | boolean>>(new Map());

  // Original config values captured at the start of each editing session (per key-select).
  // Used by Discard to revert config to the state it was in when the key was selected.
  const configOriginalsRef = useRef<Map<string, number | string | boolean>>(new Map());

  const setPendingConfig = useCallback((next: Map<string, number | string | boolean>) => {
    pendingConfigRef.current = next;
    setPendingConfigChanges(next);
  }, []);

  // ── Undo/Redo ─────────────────────────────────────────────────────────────
  const undoRedo = useUndoRedo();
  const [undoFlash, triggerUndoFlash] = useFlash();
  const [redoFlash, triggerRedoFlash] = useFlash();

  // ── Binding change handler ────────────────────────────────────────────────

  const handleBindingChanged = useCallback(
    (newBinding: BehaviorBinding) => {
      const layerId = activeLayer?.id;
      const keyPos = selectedKeyPosition;
      if (layerId === undefined || keyPos === undefined) return;

      const key = `${layerId}-${keyPos}`;
      const originalBinding = activeLayer!.bindings[keyPos];
      const prevEffective = pendingRef.current.get(key) ?? originalBinding;

      if (bindingsEqual(prevEffective, newBinding)) return;

      const withChange = (binding: BehaviorBinding): Map<string, BehaviorBinding> => {
        const next = new Map(pendingRef.current);
        if (bindingsEqual(binding, originalBinding)) {
          next.delete(key);
        } else {
          next.set(key, binding);
        }
        return next;
      };

      const prevBinding = prevEffective;
      setPending(withChange(newBinding));

      undoRedo.push({
        label: `Change key ${keyPos} binding`,
        undo: () => { setPending(withChange(prevBinding)); },
        redo: () => { setPending(withChange(newBinding)); },
      });
    },
    [activeLayer, selectedKeyPosition, setPending, undoRedo.push],
  );

  // ── Config change handler ─────────────────────────────────────────────────

  /**
   * Called by BindingEditor's Apply button when config (.conf) values changed
   * since the last snapshot. Merges changes into pendingConfigChanges and
   * pushes a single undo/redo action covering all changed keys in this Apply.
   */
  const handleConfigApplied = useCallback(
    ({ changes, prevValues }: ConfigChangeset) => {
      // Merge new changes into pending
      const nextPending = new Map(pendingConfigRef.current);
      for (const [k, v] of Object.entries(changes)) {
        nextPending.set(k, v);
        // Record the original value for Discard (first-change-wins)
        if (!configOriginalsRef.current.has(k)) {
          configOriginalsRef.current.set(
            k,
            prevValues[k] ?? (pendingConfigRef.current.get(k) as number | string | boolean),
          );
        }
      }
      setPendingConfig(nextPending);

      // Undo: revert these config keys to prevValues, remove from pending if reverted to original
      // Redo: re-apply changes, re-add to pending
      undoRedo.push({
        label: "Config change",
        undo: () => {
          for (const [k, v] of Object.entries(prevValues)) {
            setConfig(k, v);
          }
          const reverted = new Map(pendingConfigRef.current);
          for (const [k, v] of Object.entries(prevValues)) {
            const original = configOriginalsRef.current.get(k);
            if (original !== undefined && v === original) {
              reverted.delete(k);
            } else {
              reverted.set(k, v);
            }
          }
          setPendingConfig(reverted);
        },
        redo: () => {
          for (const [k, v] of Object.entries(changes)) {
            setConfig(k, v);
          }
          const reapplied = new Map(pendingConfigRef.current);
          for (const [k, v] of Object.entries(changes)) {
            reapplied.set(k, v);
          }
          setPendingConfig(reapplied);
        },
      });
    },
    [setConfig, setPendingConfig, undoRedo.push],
  );

  // ── Undo / Redo ───────────────────────────────────────────────────────────

  const handleUndo = useCallback(async () => {
    await undoRedo.undo();
    triggerUndoFlash();
  }, [undoRedo.undo, triggerUndoFlash]);

  const handleRedo = useCallback(async () => {
    await undoRedo.redo();
    triggerRedoFlash();
  }, [undoRedo.redo, triggerRedoFlash]);

  // ── Discard (per-key) ─────────────────────────────────────────────────────

  const handleDiscard = useCallback(() => {
    const layerId = activeLayer?.id;
    const keyPos = selectedKeyPosition;
    if (layerId === undefined || keyPos === undefined) return;

    const key = `${layerId}-${keyPos}`;
    const pendingBinding = pendingRef.current.get(key);
    const hasPendingConfig = pendingConfigRef.current.size > 0;

    if (!pendingBinding && !hasPendingConfig) return;

    // Capture current pending state for undo
    const discardedBinding = pendingBinding;
    const discardedConfigChanges = new Map(pendingConfigRef.current);
    const configOriginalsSnapshot = new Map(configOriginalsRef.current);

    // 1. Revert binding
    if (pendingBinding) {
      const afterDiscard = new Map(pendingRef.current);
      afterDiscard.delete(key);
      setPending(afterDiscard);
    }

    // 2. Revert config values to session originals
    if (hasPendingConfig) {
      for (const [k, origVal] of configOriginalsRef.current) {
        setConfig(k, origVal);
      }
      setPendingConfig(new Map());
      configOriginalsRef.current = new Map();
    }

    // Push to undo stack so discard can be undone
    undoRedo.push({
      label: `Discard key ${keyPos} changes`,
      undo: () => {
        if (discardedBinding) {
          const restored = new Map(pendingRef.current);
          restored.set(key, discardedBinding);
          setPending(restored);
        }
        if (discardedConfigChanges.size > 0) {
          for (const [k, v] of discardedConfigChanges) {
            setConfig(k, v);
          }
          setPendingConfig(new Map(discardedConfigChanges));
          configOriginalsRef.current = new Map(configOriginalsSnapshot);
        }
      },
      redo: () => {
        if (discardedBinding) {
          const reverted = new Map(pendingRef.current);
          reverted.delete(key);
          setPending(reverted);
        }
        if (discardedConfigChanges.size > 0) {
          for (const [k] of discardedConfigChanges) {
            const orig = configOriginalsSnapshot.get(k);
            if (orig !== undefined) setConfig(k, orig);
          }
          setPendingConfig(new Map());
          configOriginalsRef.current = new Map();
        }
      },
    });
  }, [activeLayer, selectedKeyPosition, setPending, setConfig, setPendingConfig, undoRedo.push]);

  // ── Clear all pending (called after Save to Flash) ───────────────────────

  const clearPendingChanges = useCallback(() => {
    setPending(new Map());
    setPendingConfig(new Map());
    configOriginalsRef.current = new Map();
    undoRedo.reset();
  }, [setPending, setPendingConfig, undoRedo.reset]);

  // ── Current binding for the selected key ──────────────────────────────────

  const currentBinding =
    selectedKeyPosition !== undefined && activeLayer
      ? (pendingChanges.get(`${activeLayer.id}-${selectedKeyPosition}`) ??
          activeLayer.bindings[selectedKeyPosition])
      : undefined;

  // ── Return ────────────────────────────────────────────────────────────────

  return {
    selectedKeyPosition,
    setSelectedKeyPosition,
    currentBinding,
    pendingChanges,
    pendingConfigChanges,
    hasUnsavedChanges: pendingChanges.size > 0 || pendingConfigChanges.size > 0,
    handleBindingChanged,
    handleConfigApplied,
    handleUndo,
    handleRedo,
    handleDiscard,
    clearPendingChanges,
    pushUndoable: undoRedo.push,
    canUndo: undoRedo.canUndo,
    canRedo: undoRedo.canRedo,
    undoFlash,
    redoFlash,
  };
}
