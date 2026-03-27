import React, { useEffect, useRef, useState } from "react";
import { useKeymapContext } from "../contexts/KeymapContext";
import { useSelectedKey } from "../contexts/SelectedKeyContext";
import { Button } from "../ui/button";

const DIVIDER = "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 15%, transparent)";

export function LayerOptionsPanel() {
  const {
    keymap,
    physicalLayouts,
    activeLayoutIndex,
    selectedLayerIndex,
    setSelectedLayerIndex,
    addLayer,
    removeLayer,
    moveLayer,
    renameLayer,
    setActivePhysicalLayout,
  } = useKeymapContext();

  const { pushUndoable } = useSelectedKey();

  const layers = keymap?.layers ?? [];
  const currentLayer = layers[selectedLayerIndex];

  // ── Saved flash indicator ───────────────────────────────────────────────────

  const [savedMsg, setSavedMsg] = useState<string | undefined>();
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashSaved = (msg: string) => {
    setSavedMsg(msg);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedMsg(undefined), 2000);
  };

  // ── Rename state ────────────────────────────────────────────────────────────

  const [nameInput, setNameInput] = useState(currentLayer?.name ?? "");

  // Sync input when the selected layer changes
  useEffect(() => {
    setNameInput(currentLayer?.name ?? "");
  }, [currentLayer?.id]);

  const handleRename = async () => {
    if (!currentLayer) return;
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === currentLayer.name) return;
    await renameLayer(currentLayer.id, trimmed);
    flashSaved("Layer renamed");
  };

  // ── Layer structural actions ────────────────────────────────────────────────

  const handleAdd = async () => {
    const action = await addLayer();
    if (action) { pushUndoable(action); flashSaved("Layer added"); }
  };

  const handleRemove = async () => {
    const action = await removeLayer(selectedLayerIndex);
    if (action) { pushUndoable(action); flashSaved("Layer removed"); }
  };

  const handleMoveUp = async () => {
    if (selectedLayerIndex === 0) return;
    const action = await moveLayer(selectedLayerIndex, selectedLayerIndex - 1);
    if (action) {
      pushUndoable(action);
      setSelectedLayerIndex(selectedLayerIndex - 1);
      flashSaved("Layer moved");
    }
  };

  const handleMoveDown = async () => {
    if (selectedLayerIndex >= layers.length - 1) return;
    const action = await moveLayer(selectedLayerIndex, selectedLayerIndex + 1);
    if (action) {
      pushUndoable(action);
      setSelectedLayerIndex(selectedLayerIndex + 1);
      flashSaved("Layer moved");
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-background text-foreground text-sm">

      {/* Saved flash indicator */}
      {savedMsg && (
        <div
          className="px-4 py-2 text-xs font-medium shrink-0"
          style={{
            borderBottom: DIVIDER,
            color: "var(--vscode-terminal-ansiGreen, #4ec9b0)",
          }}
        >
          {savedMsg} — saved to flash ✓
        </div>
      )}

      {/* Layer selector */}
      <section className="px-4 py-3" style={{ borderBottom: DIVIDER }}>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Layer</p>
        <select
          value={selectedLayerIndex}
          onChange={(e) => setSelectedLayerIndex(Number(e.target.value))}
          className="w-full px-2 py-1.5 rounded text-xs"
          style={{
            background: "var(--vscode-dropdown-background, color-mix(in srgb, var(--vscode-editor-foreground) 8%, transparent))",
            color: "var(--vscode-dropdown-foreground, inherit)",
            border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)",
            outline: "none",
          }}
        >
          {layers.map((layer, i) => (
            <option key={layer.id} value={i}>
              {layer.name || `Layer ${i}`}
            </option>
          ))}
        </select>
      </section>

      {/* Rename */}
      <section className="px-4 py-3" style={{ borderBottom: DIVIDER }}>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Rename</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleRename(); }}
            placeholder={currentLayer?.name || "Layer name"}
            className="flex-1 px-2 py-1.5 rounded text-xs min-w-0"
            style={{
              background: "var(--vscode-input-background, color-mix(in srgb, var(--vscode-editor-foreground) 5%, transparent))",
              color: "var(--vscode-input-foreground, inherit)",
              border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)",
              outline: "none",
            }}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={handleRename}
            disabled={!nameInput.trim() || nameInput.trim() === currentLayer?.name}
            style={{ border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)" }}
          >
            Rename
          </Button>
        </div>
      </section>

      {/* Reorder */}
      <section className="px-4 py-3" style={{ borderBottom: DIVIDER }}>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Reorder</p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={handleMoveUp}
            disabled={selectedLayerIndex === 0}
            style={{ border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)" }}
            title="Move this layer up"
          >
            ↑ Move Up
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={handleMoveDown}
            disabled={selectedLayerIndex >= layers.length - 1}
            style={{ border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)" }}
            title="Move this layer down"
          >
            ↓ Move Down
          </Button>
        </div>
      </section>

      {/* Add / Remove */}
      <section className="px-4 py-3" style={{ borderBottom: physicalLayouts.length > 1 ? DIVIDER : undefined }}>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Manage</p>
        <div className="flex flex-col gap-2">
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={handleAdd}
            style={{ border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)" }}
          >
            + Add Layer
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={handleRemove}
            disabled={layers.length <= 1}
            style={{ border: "1px solid color-mix(in srgb, var(--vscode-editorError-foreground, #f44747) 50%, transparent)" }}
            title={layers.length <= 1 ? "Cannot remove the only layer" : `Remove "${currentLayer?.name || `Layer ${selectedLayerIndex}`}"`}
          >
            Remove Layer
          </Button>
        </div>
      </section>

      {/* Physical Layout — only when firmware supports multiple layouts */}
      {physicalLayouts.length > 1 && (
        <section className="px-4 py-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Physical Layout</p>
          <select
            value={activeLayoutIndex}
            onChange={async (e) => { await setActivePhysicalLayout(Number(e.target.value)); flashSaved("Layout changed"); }}
            className="w-full px-2 py-1.5 rounded text-xs"
            style={{
              background: "var(--vscode-dropdown-background, color-mix(in srgb, var(--vscode-editor-foreground) 8%, transparent))",
              color: "var(--vscode-dropdown-foreground, inherit)",
              border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)",
              outline: "none",
            }}
          >
            {physicalLayouts.map((layout, i) => (
              <option key={i} value={i}>
                {layout.name || `Layout ${i}`}
              </option>
            ))}
          </select>
        </section>
      )}
    </div>
  );
}
