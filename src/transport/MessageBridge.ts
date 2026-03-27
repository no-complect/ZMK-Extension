import type * as vscode from "vscode";
import type { RpcTransport } from "@zmkfirmware/zmk-studio-ts-client/transport/index";
import type { HostToWebview, WebviewToHost } from "../../shared/messages";
import { log, logError } from "../logger";

/**
 * Extension-host side of the bridge.
 * Owns the RpcTransport, pipes bytes to/from the WebView via postMessage.
 */
export class MessageBridge {
  private transport: RpcTransport | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

  constructor(private readonly webview: vscode.Webview) {
    this.webview.onDidReceiveMessage((msg: WebviewToHost) =>
      this.handleWebviewMessage(msg)
    );
  }

  async attach(transport: RpcTransport, deviceName?: string): Promise<void> {
    log(`MessageBridge: attaching transport "${transport.label}"`);
    this.transport = transport;
    this.reader = transport.readable.getReader();
    this.writer = transport.writable.getWriter();

    this.post({ type: "connected", label: transport.label, deviceName });
    this.pumpReadable();
  }

  detach(): void {
    this.writer?.releaseLock();
    this.writer = null;
    this.transport?.abortController.abort();
    this.transport = null;
    this.reader = null;
    this.post({ type: "disconnected" });
  }

  private async pumpReadable(): Promise<void> {
    if (!this.reader) return;
    let bytesReceived = 0;
    try {
      while (true) {
        const { done, value } = await this.reader.read();
        if (done) break;
        bytesReceived += value.length;
        log(`MessageBridge: rx ${value.length} bytes (total ${bytesReceived})`);
        this.post({ type: "data", bytes: Array.from(value) });
      }
      log("MessageBridge: readable ended cleanly");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logError("MessageBridge: readable error", err);
      this.post({ type: "error", message });
    } finally {
      log("MessageBridge: disconnecting");
      this.writer?.releaseLock();
      this.writer = null;
      this.transport = null;
      this.reader = null;
      this.post({ type: "disconnected" });
    }
  }

  private async handleWebviewMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case "send": {
        if (!this.writer) return;
        log(`MessageBridge: tx ${msg.bytes.length} bytes`);
        await this.writer.write(new Uint8Array(msg.bytes));
        break;
      }
      case "disconnect": {
        log("MessageBridge: disconnect requested by webview");
        this.detach();
        break;
      }
    }
  }

  private post(msg: HostToWebview): void {
    this.webview.postMessage(msg);
  }
}
