/**
 * Messages flowing between the VS Code extension host and the WebView.
 * This file is imported by both sides — keep it dependency-free.
 */

// ── Keymap export/import format ───────────────────────────────────────────────

/** Portable keymap snapshot. Behaviour IDs are from the connected keyboard's
 *  behaviour catalogue, so imports work reliably only against the same firmware. */
export interface ExportedKeymap {
  version: 1;
  exportedAt: string;        // ISO-8601
  deviceName?: string;
  /** ZMK .keymap devicetree source generated at export time (requires live keyboard connection) */
  keymapSource?: string;
  layers: Array<{
    name: string;
    bindings: Array<{ behaviorId: number; param1: number; param2: number }>;
  }>;
}

// ── Message unions ────────────────────────────────────────────────────────────

export type HostToWebview =
  | { type: "connected"; label: string; deviceName?: string }
  | { type: "disconnected" }
  | { type: "data"; bytes: number[] }
  | { type: "error"; message: string }
  | { type: "deviceList"; devices: Array<{ label: string; path: string }> }
  | { type: "configSnapshot"; values: Record<string, string | number | boolean>; hasFile: boolean }
  | { type: "requestKeymapExport" }
  | { type: "importKeymap"; data: ExportedKeymap };

export type WebviewToHost =
  | { type: "send"; bytes: number[] }
  | { type: "disconnect" }
  | { type: "connectUSB"; path: string }
  | { type: "connectBLE" }
  | { type: "requestDeviceList" }
  | { type: "getConfig" }
  | { type: "setConfigValue"; key: string; value: string | number | boolean }
  | { type: "keymapExportData"; data: ExportedKeymap }
  | { type: "importKeymapResult"; success: boolean; error?: string }
  | { type: "requestImportKeymap" }
  | { type: "savedToFlash" }
  | { type: "buildFirmware" }
  | { type: "openKeymapsFolder" }
  | { type: "requestExportConfig" };
