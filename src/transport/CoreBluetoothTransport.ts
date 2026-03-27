/**
 * CoreBluetoothTransport — spawns the native zmk-ble-helper subprocess and
 * wraps its stdin/stdout as an RpcTransport.
 *
 * The helper uses CoreBluetooth's retrieveConnectedPeripherals() which can
 * find bonded keyboards that are connected to macOS but not advertising,
 * solving the fundamental limitation of noble's HCI scan approach.
 *
 * Protocol: newline-delimited JSON in both directions.
 *   Helper → Host: {type:"devices"|"connected"|"data"|"error"|"disconnected", …}
 *   Host → Helper: {cmd:"connect"|"write"|"disconnect", …}
 */

import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import type { RpcTransport } from "@zmkfirmware/zmk-studio-ts-client/transport/index";
import { log, logError } from "../logger";

type HelperMessage =
  | { type: "devices"; list: Array<{ id: string; name: string }> }
  | { type: "connected"; name: string }
  | { type: "data"; bytes: number[] }
  | { type: "error"; message: string }
  | { type: "disconnected" };

/** Absolute path to the bundled zmk-ble-helper binary. */
function helperBinaryPath(): string {
  // At runtime dist/extension.js lives in <root>/dist — binary is in <root>/bin.
  return path.join(__dirname, "..", "bin", "zmk-ble-helper");
}

/**
 * Spawn the CoreBluetooth helper and handle discovery + device selection.
 *
 * @param onDeviceFound  Optional callback to present a picker when > 1 device
 *                       is found. Resolves with the selected device's UUID.
 *                       If omitted, the first discovered device is used.
 */
export async function connectCoreBluetooth(
  onDeviceFound?: (
    devices: Array<{ id: string; name: string }>
  ) => Promise<string>
): Promise<RpcTransport> {
  const helperPath = helperBinaryPath();
  if (!fs.existsSync(helperPath)) {
    throw new Error(
      `zmk-ble-helper binary not found at ${helperPath}.\n` +
        `Run: clang -fobjc-arc -framework CoreBluetooth -framework Foundation ` +
        `-o bin/zmk-ble-helper native/zmk-ble-helper.m`
    );
  }

  return new Promise<RpcTransport>((resolve, reject) => {
    log(`[CB] Spawning helper: ${helperPath}`);
    const proc = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });

    let lineBuffer = "";
    let settled = false;
    let disconnectSent = false;
    let readableController!: ReadableStreamDefaultController<Uint8Array>;
    const abortController = new AbortController();

    proc.stderr?.on("data", (d: Buffer) =>
      log(`[CB helper stderr] ${d.toString().trim()}`)
    );

    proc.on("error", (err) => {
      logError("[CB] helper spawn error", err);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    proc.on("exit", (code) => {
      log(`[CB] helper exited (code ${code})`);
      try {
        readableController?.close();
      } catch {
        /* already closed */
      }
    });

    function sendCmd(cmd: Record<string, unknown>): void {
      proc.stdin!.write(JSON.stringify(cmd) + "\n");
    }

    function sendDisconnect(): void {
      if (disconnectSent) return;
      disconnectSent = true;
      sendCmd({ cmd: "disconnect" });
    }

    function handleMessage(msg: HelperMessage): void {
      if (msg.type === "devices") {
        if (settled) return; // ignore repeated device lists after connection
        const devices = msg.list;
        log(`[CB] Devices found: ${devices.map((d) => d.name).join(", ")}`);

        const pickAndConnect = async () => {
          try {
            let selectedId: string;
            if (!onDeviceFound || devices.length === 1) {
              selectedId = devices[0].id;
            } else {
              selectedId = await onDeviceFound(devices);
            }
            log(`[CB] Connecting to: ${selectedId}`);
            sendCmd({ cmd: "connect", id: selectedId });
          } catch (err) {
            if (!settled) {
              settled = true;
              proc.kill();
              reject(err);
            }
          }
        };
        pickAndConnect();
      } else if (msg.type === "connected") {
        if (settled) return;
        settled = true;
        log(`[CB] Connected: ${msg.name}`);

        const readable = new ReadableStream<Uint8Array>({
          start(ctrl) {
            readableController = ctrl;
          },
          cancel() {
            sendDisconnect();
            abortController.abort();
          },
        });

        const writable = new WritableStream<Uint8Array>({
          write(chunk) {
            sendCmd({ cmd: "write", bytes: Array.from(chunk) });
          },
          close() {
            sendDisconnect();
          },
        });

        abortController.signal.addEventListener("abort", () => {
          sendDisconnect();
        });

        resolve({
          label: msg.name,
          abortController,
          readable,
          writable,
        });
      } else if (msg.type === "data") {
        readableController?.enqueue(new Uint8Array(msg.bytes));
      } else if (msg.type === "error") {
        logError("[CB helper]", new Error(msg.message));
        if (!settled) {
          settled = true;
          proc.kill();
          reject(new Error(msg.message));
        } else {
          try {
            readableController?.error(new Error(msg.message));
          } catch {
            /* already errored */
          }
        }
      } else if (msg.type === "disconnected") {
        try {
          readableController?.close();
        } catch {
          /* already closed */
        }
      }
    }

    proc.stdout!.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as HelperMessage;
          handleMessage(msg);
        } catch {
          log(`[CB helper] invalid JSON: ${line}`);
        }
      }
    });
  });
}
