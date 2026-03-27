import type { RpcTransport } from "@zmkfirmware/zmk-studio-ts-client/transport/index";
import type { ExportedKeymap, HostToWebview, WebviewToHost } from "../../shared/messages";

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToHost): void;
};

const vscode = acquireVsCodeApi();

/**
 * WebView-side RpcTransport implementation.
 *
 * Bytes written to `writable` are posted to the extension host via postMessage.
 * Bytes received from the extension host arrive as "data" messages and are
 * pushed into `readable`.
 */
export function createBridgeTransport(label: string): RpcTransport {
  const abortController = new AbortController();

  let readableController: ReadableStreamDefaultController<Uint8Array>;

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
    cancel() {
      abortController.abort();
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      vscode.postMessage({ type: "send", bytes: Array.from(chunk) });
    },
    close() {
      vscode.postMessage({ type: "disconnect" });
    },
  });

  // Route messages from extension host into the readable stream
  const onMessage = (event: MessageEvent<HostToWebview>) => {
    const msg = event.data;
    switch (msg.type) {
      case "data":
        readableController.enqueue(new Uint8Array(msg.bytes));
        break;
      case "disconnected":
        try {
          readableController.close();
        } catch {
          // Already closed
        }
        break;
      case "error":
        try {
          readableController.error(new Error(msg.message));
        } catch {
          // Already errored
        }
        break;
    }
  };

  window.addEventListener("message", onMessage);

  abortController.signal.addEventListener("abort", () => {
    vscode.postMessage({ type: "disconnect" });
    window.removeEventListener("message", onMessage);
  }, { once: true });

  return { label, abortController, readable, writable };
}

/** Tell the extension host to disconnect the current transport */
export function requestDisconnect(): void {
  vscode.postMessage({ type: "disconnect" });
}

/** Tell the extension host to export the config store to a .conf file */
export function requestExportConfig(): void {
  vscode.postMessage({ type: "requestExportConfig" });
}

/** Ask the extension host for available serial ports */
export function requestDeviceList(): void {
  vscode.postMessage({ type: "requestDeviceList" });
}

/** Tell extension host to connect to a specific USB port */
export function requestUSBConnect(path: string): void {
  vscode.postMessage({ type: "connectUSB", path });
}

/** Tell extension host to scan and connect via BLE */
export function requestBLEConnect(): void {
  vscode.postMessage({ type: "connectBLE" });
}

/** Ask the extension host for the current config snapshot */
export function requestConfig(): void {
  vscode.postMessage({ type: "getConfig" });
}

/** Tell the extension host to persist a config value */
export function postConfigValue(key: string, value: string | number | boolean): void {
  vscode.postMessage({ type: "setConfigValue", key, value });
}

/** Send the serialised keymap back to the extension host after a requestKeymapExport */
export function postKeymapExportData(data: ExportedKeymap): void {
  vscode.postMessage({ type: "keymapExportData", data });
}

/** Report the result of an importKeymap operation back to the extension host */
export function postImportKeymapResult(success: boolean, error?: string): void {
  vscode.postMessage({ type: "importKeymapResult", success, error });
}

/** Ask the extension host to show a file picker and import a keymap */
export function requestImportKeymap(): void {
  vscode.postMessage({ type: "requestImportKeymap" });
}

/** Notify the extension host that bindings were saved to keyboard flash */
export function postSavedToFlash(): void {
  vscode.postMessage({ type: "savedToFlash" });
}

/** Ask the extension host to run the firmware build pipeline */
export function postBuildFirmware(): void {
  vscode.postMessage({ type: "buildFirmware" });
}

/** Ask the extension host to open the keymaps folder in the OS file browser */
export function postOpenKeymapsFolder(): void {
  vscode.postMessage({ type: "openKeymapsFolder" });
}
