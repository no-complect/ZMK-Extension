import { useCallback, useRef, useState } from "react";

export interface UndoableAction {
  undo: () => Promise<void> | void;
  redo: () => Promise<void> | void;
  /** Optional label shown in UI e.g. "Set key A → &kp B" */
  label?: string;
}

/**
 * Simple undo/redo stack.
 * Push an action after performing it; the stack keeps undo/redo symmetry.
 *
 * @example
 * const { push, undo, redo, canUndo, canRedo } = useUndoRedo();
 *
 * async function handleBindingChange(newBinding) {
 *   const prev = currentBinding;
 *   await applyBinding(newBinding);
 *   push({
 *     label: "Change binding",
 *     undo: () => applyBinding(prev),
 *     redo: () => applyBinding(newBinding),
 *   });
 * }
 */
export function useUndoRedo() {
  const past = useRef<UndoableAction[]>([]);
  const future = useRef<UndoableAction[]>([]);
  // Version counter drives re-renders when stack changes
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const push = useCallback((action: UndoableAction) => {
    past.current.push(action);
    future.current = [];
    bump();
  }, []);

  const undo = useCallback(async () => {
    const action = past.current.pop();
    if (!action) return;
    await action.undo();
    future.current.push(action);
    bump();
  }, []);

  const redo = useCallback(async () => {
    const action = future.current.pop();
    if (!action) return;
    await action.redo();
    past.current.push(action);
    bump();
  }, []);

  const reset = useCallback(() => {
    past.current = [];
    future.current = [];
    bump();
  }, []);

  return {
    push,
    undo,
    redo,
    reset,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
