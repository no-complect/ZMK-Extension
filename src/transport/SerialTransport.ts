import type { SerialPort as SerialPortType } from "serialport";
import type { RpcTransport } from "@zmkfirmware/zmk-studio-ts-client/transport/index";

export interface SerialTransport extends RpcTransport {
  close(): Promise<void>;
}

/** Lazy-load serialport so a native ABI mismatch doesn't prevent extension activation */
function requireSerialPort(): typeof import("serialport") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("serialport");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `serialport native module failed to load (${msg}).\n` +
      `Rebuild it for Cursor/VS Code by running:\n` +
      `  npx electron-rebuild -v $(cursor --version | head -1) -m node_modules\n` +
      `or check https://aka.ms/vscode-nativemodule for instructions.`
    );
  }
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

/** ZMK keyboards enumerate as USB CDC-ACM serial devices */
const ZMK_VENDOR_IDS = new Set([
  "1d50", // OpenMoko (common ZMK VID)
  "2341", // Arduino (some ZMK boards)
]);

export async function listZMKSerialPorts(): Promise<SerialPortInfo[]> {
  const { SerialPort } = requireSerialPort();
  const ports = await SerialPort.list();
  // Filter to likely ZMK devices — vendor ID match or fallback to all CDC-ACM
  const zmk = ports.filter(
    (p) => p.vendorId && ZMK_VENDOR_IDS.has(p.vendorId.toLowerCase())
  );
  // If no known VID matches, return all detected ports so user can pick
  return zmk.length > 0 ? zmk : ports;
}

export async function connectSerial(portPath: string): Promise<SerialTransport> {
  const { SerialPort } = requireSerialPort();
  const port = new SerialPort({ path: portPath, baudRate: 115200 }) as InstanceType<typeof SerialPortType>;

  await new Promise<void>((resolve, reject) => {
    port.once("open", resolve);
    port.once("error", reject);
  });

  const abortController = new AbortController();

  // Writable stream: consumer writes bytes → forwarded to serial port
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        port.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    },
    close() {
      return new Promise<void>((resolve) => port.close(() => resolve()));
    },
  });

  // Readable stream: bytes from serial port pushed to consumer
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      port.close();
    },
  });

  port.on("data", (chunk: Buffer) => {
    controller.enqueue(new Uint8Array(chunk));
  });

  port.on("close", () => {
    try {
      controller.close();
    } catch {
      // Already closed
    }
  });

  port.on("error", (err) => {
    try {
      controller.error(err);
    } catch {
      // Already errored
    }
  });

  let resolveClose!: () => void;
  const closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });

  abortController.signal.addEventListener("abort", () => {
    port.close(() => resolveClose());
  });

  return {
    label: portPath,
    abortController,
    readable,
    writable,
    close: () => { abortController.abort(); return closePromise; },
  };
}
