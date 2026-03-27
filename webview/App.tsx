import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requestDeviceList, requestUSBConnect, postKeymapExportData, postImportKeymapResult, postSavedToFlash, postBuildFirmware, postOpenKeymapsFolder, requestExportConfig } from "./transport/BridgeTransport";
import { generateKeymapSource } from "./lib/keymapGenerator";
import type { ExportedKeymap } from "../shared/messages";
import type { HostToWebview } from "../shared/messages";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Badge } from "./ui/badge";
import { useVSCodeTheme } from "./hooks/useVSCodeTheme";
import { useContainerSize, useKeyboardScale } from "./hooks/useContainerSize";
import { ConnectionProvider, useConnection } from "./contexts/ConnectionContext";
import { KeymapProvider, useKeymapContext } from "./contexts/KeymapContext";
import { ConfigProvider } from "./contexts/ConfigContext";
import { SelectedKeyProvider, useSelectedKey } from "./contexts/SelectedKeyContext";
import { KeyboardLayout, layoutNaturalWidth } from "./components/KeyboardLayout";
import { BindingEditor } from "./components/BindingEditor";
import { LayerOptionsPanel } from "./components/LayerOptionsPanel";

const DIVIDER = "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 15%, transparent)";

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <ConnectionProvider>
      <AppShell />
    </ConnectionProvider>
  );
}

// ── Shell — routes between connect screen and editor ──────────────────────────

function AppShell() {
  const { status, deviceName } = useConnection();
  const theme = useVSCodeTheme();

  if (status === "connected") {
    return (
      <KeymapProvider>
        <ConfigProvider>
          <SelectedKeyProvider>
            <KeyboardEditor deviceName={deviceName ?? "Keyboard"} />
          </SelectedKeyProvider>
        </ConfigProvider>
      </KeymapProvider>
    );
  }

  if (status === "locked") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-4 bg-background text-foreground">
        <p className="text-sm text-muted-foreground text-center">
          Press the unlock combo on <strong>{deviceName}</strong> to continue.
        </p>
        <Badge variant="outline">Waiting for unlock…</Badge>
      </div>
    );
  }

  return <ConnectScreen theme={theme.kind} />;
}

// ── Connect screen ────────────────────────────────────────────────────────────

type AvailablePort = { label: string; path: string };

function ConnectScreen({ theme }: { theme: string }) {
  const { status, connectBLE, bleError } = useConnection();
  const [ports, setPorts] = useState<AvailablePort[]>([]);
  const [connectError, setConnectError] = useState<string | undefined>();
  const { ref, width } = useContainerSize<HTMLDivElement>();

  React.useEffect(() => {
    const handler = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      if (msg.type === "deviceList") setPorts(msg.devices);
      if (msg.type === "error") setConnectError(msg.message);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const compact = width > 0 && width < 280;
  const connecting = status === "connecting";
  const displayError = connectError ?? bleError;

  return (
    <div ref={ref} className="flex flex-col gap-4 p-4 h-full bg-background text-foreground">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold truncate flex-1 min-w-0">ZMK Studio</span>
        <Badge variant="outline" className="text-xs">{theme}</Badge>
      </div>

      {displayError && (
        <p
          className="text-xs text-destructive rounded px-3 py-2"
          style={{
            border: "1px solid color-mix(in srgb, var(--vscode-editorError-foreground, #f44747) 40%, transparent)",
            background: "color-mix(in srgb, var(--vscode-editorError-foreground, #f44747) 10%, transparent)",
          }}
        >
          {displayError}
        </p>
      )}

      <div className={`flex gap-2 ${compact ? "flex-col" : ""}`}>
        <Button
          size="sm"
          className="flex-1"
          onClick={() => { setConnectError(undefined); requestDeviceList(); }}
          disabled={connecting}
        >
          Scan (USB)
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          style={{ border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)" }}
          onClick={() => { setConnectError(undefined); connectBLE(); }}
          disabled={connecting}
          title="Connect via Bluetooth (Web Bluetooth / GATT)"
        >
          {connecting ? "Connecting…" : "Connect (BLE)"}
        </Button>
      </div>

      {ports.length > 0 ? (
        <ScrollArea className="flex-1">
          <ul className="flex flex-col flex-1 gap-2">
            {ports.map((p) => (
              <li key={p.path}>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start font-mono text-xs"
                  onClick={() => requestUSBConnect(p.path)}
                  disabled={connecting}
                >
                  {connecting ? "Connecting…" : p.label}
                </Button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      ) : (
        <p className="text-xs text-muted-foreground">
          Plug your ZMK keyboard in via USB and click Scan, or connect wirelessly via BLE.
        </p>
      )}
    </div>
  );
}

// ── Keyboard editor ───────────────────────────────────────────────────────────

function KeyboardEditor({ deviceName }: { deviceName: string }) {
  const { ref, width } = useContainerSize<HTMLDivElement>();
  const [showLayerOptions, setShowLayerOptions] = useState(false);
  const { disconnect } = useConnection();

  // ── Keymap domain (read-only flash state + save operation) ────────────────
  const {
    keymap, physicalLayouts, activeLayoutIndex,
    loading, error, behaviors,
    selectedLayerIndex, setSelectedLayerIndex, activeLayer,
    batchSave,
  } = useKeymapContext();

  // ── Selected-key domain (pending changes, undo/redo, hasUnsavedChanges) ───
  const {
    selectedKeyPosition, setSelectedKeyPosition, currentBinding,
    pendingChanges, hasUnsavedChanges, clearPendingChanges,
    handleBindingChanged, handleConfigApplied, handleUndo, handleRedo, handleDiscard,
    canUndo, canRedo, undoFlash, redoFlash,
  } = useSelectedKey();

  // ── Escape key closes the binding editor ─────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedKeyPosition(undefined);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setSelectedKeyPosition]);

  // ── Save-to-flash state ───────────────────────────────────────────────────
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Export flash state ────────────────────────────────────────────────────
  const [exportDone, setExportDone] = useState(false);
  const exportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Keymap import via extension host ─────────────────────────────────────
  const keymapRef = useRef(keymap);
  useEffect(() => { keymapRef.current = keymap; }, [keymap]);

  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      const msg = event.data;

      if (msg.type === "importKeymap") {
        const imported = (msg as { type: "importKeymap"; data: ExportedKeymap }).data;
        const km = keymapRef.current;
        if (!km) {
          postImportKeymapResult(false, "No keymap loaded");
          return;
        }
        try {
          const changes = new Map<string, { behaviorId: number; param1: number; param2: number }>();
          const layerCount = Math.min(imported.layers.length, km.layers.length);
          for (let i = 0; i < layerCount; i++) {
            const importedLayer = imported.layers[i];
            const currentLayer = km.layers[i];
            const bindingCount = Math.min(importedLayer.bindings.length, currentLayer.bindings.length);
            for (let j = 0; j < bindingCount; j++) {
              changes.set(`${currentLayer.id}-${j}`, importedLayer.bindings[j]);
            }
          }
          await batchSave(changes);
          clearPendingChanges();
          postImportKeymapResult(true);
        } catch (err) {
          postImportKeymapResult(false, err instanceof Error ? err.message : String(err));
        }
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [batchSave, clearPendingChanges]);

  const handleExportSetup = useCallback(() => {
    if (!keymap) return;
    const data: ExportedKeymap = {
      version: 1,
      exportedAt: new Date().toISOString(),
      deviceName,
      layers: keymap.layers.map((layer) => ({
        name: layer.name,
        bindings: layer.bindings.map((b) => ({
          behaviorId: b.behaviorId,
          param1: b.param1,
          param2: b.param2,
        })),
      })),
    };
    data.keymapSource = generateKeymapSource(data, behaviors);
    postKeymapExportData(data);
    requestExportConfig();
    setExportDone(true);
    if (exportTimerRef.current) clearTimeout(exportTimerRef.current);
    exportTimerRef.current = setTimeout(() => setExportDone(false), 2000);
  }, [keymap, deviceName, behaviors]);

  const handleSave = useCallback(async () => {
    setSaveState("saving");
    try {
      // batchSave: sends all pending changes to keyboard RAM + saves to flash
      // + updates the local keymap snapshot. No chaining inside hooks.
      await batchSave(pendingChanges);
      // Clear pending changes and reset undo/redo stack
      clearPendingChanges();
      postSavedToFlash();
      setSaveState("saved");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveState("idle"), 2000);
    } catch {
      setSaveState("idle");
    }
  }, [batchSave, pendingChanges, clearPendingChanges]);

  // ── Effective layer: original bindings overlaid with any pending changes ──
  // This is what KeyboardLayout renders so all keys show their current state.
  const effectiveLayer = useMemo(() => {
    if (!activeLayer) return undefined;
    if (pendingChanges.size === 0) return activeLayer;
    const bindings = activeLayer.bindings.map((b, i) =>
      pendingChanges.get(`${activeLayer.id}-${i}`) ?? b,
    );
    return { ...activeLayer, bindings };
  }, [activeLayer, pendingChanges]);

  // ── Layout scaling ────────────────────────────────────────────────────────
  const activeLayout = physicalLayouts[activeLayoutIndex];
  const naturalWidth = activeLayout ? layoutNaturalWidth(activeLayout) : 900;
  const scale = useKeyboardScale({ naturalWidth, availableWidth: width, padding: 16 });

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div ref={ref} className="flex flex-col h-full bg-background text-foreground">

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className="shrink-0" style={{ borderBottom: DIVIDER }}>

        {/* Row 1 — device name + save/discard/undo/redo */}
        <div className="flex items-center px-3 py-2 gap-2">
          <span className="text-xs font-semibold truncate flex-1 min-w-0">{deviceName}</span>

          <div className="flex items-center gap-1.5 shrink-0">
            {saveState === "saved" ? (
              <span className="text-xs text-green-500 font-medium px-2">Saved to flash ✓</span>
            ) : (
              <Button
                size="sm"
                variant="default"
                onClick={handleSave}
                disabled={!hasUnsavedChanges || saveState === "saving"}
                title={hasUnsavedChanges ? "Write changes to keyboard flash memory" : "No unsaved changes"}
              >
                {saveState === "saving" ? "Saving…" : "Save to flash"}
              </Button>
            )}

            <Button
              size="sm"
              variant="outline"
              onClick={handleDiscard}
              disabled={saveState !== "idle" || !hasUnsavedChanges || selectedKeyPosition === undefined}
              style={{ border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)" }}
              title={
                selectedKeyPosition === undefined
                  ? "Select a key to discard its changes"
                  : hasUnsavedChanges
                  ? "Revert this key to its original binding"
                  : "No changes to discard"
              }
            >
              Discard
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={handleUndo}
              disabled={saveState !== "idle" || (!canUndo && !undoFlash)}
              className={undoFlash ? "text-green-500" : ""}
              style={{ border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)" }}
              title={canUndo ? "Undo last change" : "Nothing to undo"}
            >
              Undo
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRedo}
              disabled={saveState !== "idle" || (!canRedo && !redoFlash)}
              className={redoFlash ? "text-green-500" : ""}
              style={{ border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)" }}
              title={canRedo ? "Redo last undone change" : "Nothing to redo"}
            >
              Redo
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={disconnect}
              style={{ border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)" }}
              title="Disconnect from keyboard"
            >
              Disconnect
            </Button>
          </div>
        </div>

        {/* Row 2 — Layers / Export Setup */}
        <div className="flex gap-2 px-3 pb-2">
          <Button
            size="sm"
            className="flex-1"
            variant={showLayerOptions ? "default" : "outline"}
            onClick={() => setShowLayerOptions((v) => !v)}
            style={showLayerOptions ? {} : { border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)" }}
            title="Manage layers"
          >
            Layers
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={`flex-1 transition-colors duration-300 ${exportDone ? "text-green-500 border-green-500" : ""}`}
            onClick={handleExportSetup}
            disabled={!keymap}
            style={exportDone ? { border: "1px solid #22c55e" } : { border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)" }}
            title="Export keymap and configuration file"
          >
            {exportDone ? "Exported ✓" : "Export Setup"}
          </Button>
        </div>

        {/* Row 3 — Firmware actions */}
        <div className="flex gap-2 px-3 pb-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={postBuildFirmware}
            style={{ border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)" }}
            title="Run west build to compile firmware from current keymap and config"
          >
            Build Firmware
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={postOpenKeymapsFolder}
            style={{ border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)" }}
            title="Open the keymaps folder in Finder"
          >
            Open Files
          </Button>
        </div>

      </div>

      {showLayerOptions ? (
        /* ── Layer options panel ──────────────────────────────────────── */
        <LayerOptionsPanel />
      ) : (
        <>
          {/* ── Layer tabs ────────────────────────────────────────────── */}
          {keymap && (
            <div
              className="flex gap-1.5 px-3 py-1.5 overflow-x-auto shrink-0"
              style={{ borderBottom: DIVIDER }}
            >
              {keymap.layers.map((layer, i) => (
                <button
                  key={layer.id}
                  onClick={() => { setSelectedLayerIndex(i); setSelectedKeyPosition(undefined); }}
                  className="text-xs px-2.5 py-1 rounded whitespace-nowrap transition-colors cursor-pointer font-medium focus:outline-none"
                  style={i === selectedLayerIndex ? {
                    background: "var(--vscode-button-background)",
                    color: "var(--vscode-button-foreground)",
                    border: "1px solid transparent",
                  } : {
                    border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 22%, transparent)",
                    background: "color-mix(in srgb, var(--vscode-editor-foreground) 5%, transparent)",
                    color: "inherit",
                  }}
                >
                  {layer.name || `Layer ${i}`}
                </button>
              ))}
            </div>
          )}

          {/* ── Canvas ────────────────────────────────────────────────── */}
          <ScrollArea className="flex-1" onClick={() => setSelectedKeyPosition(undefined)}>
            {loading && (
              <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
                <span>Loading keymap…</span>
              </div>
            )}
            {error && <p className="m-4 text-xs text-destructive">{error}</p>}
            {effectiveLayer && activeLayout && !loading && (
              <div className="p-4 overflow-x-auto">
                <KeyboardLayout
                  physicalLayout={activeLayout}
                  layer={effectiveLayer}
                  behaviors={behaviors}
                  scale={scale}
                  selectedKeyPosition={selectedKeyPosition}
                  onKeySelected={setSelectedKeyPosition}
                />
              </div>
            )}
          </ScrollArea>

          {/* ── Binding editor panel ──────────────────────────────────── */}
          {selectedKeyPosition !== undefined && currentBinding && (
            <div className="shrink-0">
              <BindingEditor
                binding={currentBinding}
                behaviors={behaviors}
                layers={keymap?.layers ?? []}
                keyLabel={`Key ${selectedKeyPosition}`}
                onBindingChanged={handleBindingChanged}
                onConfigApplied={handleConfigApplied}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
