import { useCallback, useEffect, useRef, useState } from "react";
import {
  create_rpc_connection,
  call_rpc,
  type RpcConnection,
} from "@zmkfirmware/zmk-studio-ts-client";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import type { Notification } from "@zmkfirmware/zmk-studio-ts-client/studio";
import { createBridgeTransport, requestBLEConnect, requestDisconnect } from "../transport/BridgeTransport";
import {
  DISCONNECTED_STATE,
  type ConnectionState,
  type ConnectionContextValue,
} from "../contexts/connection.types";
import type { HostToWebview } from "../../shared/messages";

// ── Notification bus ───────────────────────────────────────────────────────────

/**
 * Manages a set of notification subscribers.
 * Returns a stable subscribe function and a broadcast function.
 */
function useNotificationBus() {
  const listenersRef = useRef<Set<(n: Notification) => void>>(new Set());

  const onNotification = useCallback((cb: (n: Notification) => void) => {
    listenersRef.current.add(cb);
    return () => listenersRef.current.delete(cb);
  }, []);

  const broadcast = useCallback((n: Notification) => {
    listenersRef.current.forEach((cb) => cb(n));
  }, []);

  return { onNotification, broadcast };
}

// ── Device name fetcher ────────────────────────────────────────────────────────

/**
 * Returns a stable function that queries the keyboard's display name via RPC
 * and calls onResolved when it succeeds.
 */
function useFetchDeviceName(onResolved: (name: string) => void) {
  return useCallback(
    async (conn: RpcConnection) => {
      const resp = await call_rpc(conn, { core: { getDeviceInfo: true } }).catch(() => null);
      const name = (resp as any)?.core?.getDeviceInfo?.name as string | undefined;
      if (name) onResolved(name);
    },
    [onResolved]
  );
}

// ── Notification pump ──────────────────────────────────────────────────────────

/**
 * Returns a stable async function that reads from the connection's notification
 * stream until the signal is aborted or the stream ends naturally.
 * Delegates each notification type to the appropriate single-responsibility handler.
 */
function usePumpNotifications(
  onLockStateChanged: (ls: LockState, conn: RpcConnection) => void,
  onBroadcast: (n: Notification) => void,
  onDisconnected: () => void
) {
  return useCallback(
    async (conn: RpcConnection, signal: AbortSignal) => {
      const reader = conn.notification_readable.getReader();
      signal.addEventListener("abort", () => reader.cancel(), { once: true });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || signal.aborted) break;
          if (!value) continue;

          if (value.core?.lockStateChanged !== undefined) {
            onLockStateChanged(value.core.lockStateChanged, conn);
          }
          onBroadcast(value);
        }
      } catch {
        // Connection dropped — fall through to finally
      } finally {
        reader.releaseLock();
        onDisconnected();
      }
    },
    [onLockStateChanged, onBroadcast, onDisconnected]
  );
}

// ── Main hook ──────────────────────────────────────────────────────────────────

/**
 * Manages the full connection lifecycle for the ZMK Studio extension.
 *
 * Sub-hooks handle individual responsibilities:
 *   useNotificationBus   — subscriber set + broadcast
 *   useFetchDeviceName   — device name RPC after unlock
 *   usePumpNotifications — async notification stream reader
 *
 * The "connected" message handler is inlined here as a useCallback because
 * it is not a reusable hook — it closes over setState, fetchDeviceName, and
 * pumpNotifications and has no independent lifecycle of its own.
 */
export function useConnectionContext(): ConnectionContextValue {
  const [state, setState] = useState<ConnectionState>(DISCONNECTED_STATE);
  const [bleError, setBleError] = useState<string | undefined>();

  // ── Notification bus ─────────────────────────────────────────────────────────
  const { onNotification, broadcast } = useNotificationBus();

  // ── Device name ──────────────────────────────────────────────────────────────
  const handleDeviceNameResolved = useCallback((name: string) => {
    setState((s) => ({ ...s, deviceName: name }));
  }, []);

  const fetchDeviceName = useFetchDeviceName(handleDeviceNameResolved);

  // ── Lock state change ────────────────────────────────────────────────────────
  const handleLockStateChanged = useCallback(
    (ls: LockState, conn: RpcConnection) => {
      setState((s) => ({
        ...s,
        lockState: ls,
        status:
          ls === LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED
            ? "connected"
            : "locked",
      }));
      if (ls === LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED) {
        fetchDeviceName(conn);
      }
    },
    [fetchDeviceName]
  );

  // ── Disconnected ─────────────────────────────────────────────────────────────
  const handleDisconnected = useCallback(() => {
    setState(DISCONNECTED_STATE);
  }, []);

  // ── Notification pump ────────────────────────────────────────────────────────
  const pumpNotifications = usePumpNotifications(
    handleLockStateChanged,
    broadcast,
    handleDisconnected
  );

  // ── Shared connect-with-transport logic ──────────────────────────────────
  const doConnect = useCallback(
    async (
      transport: import("@zmkfirmware/zmk-studio-ts-client/transport/index").RpcTransport,
      label: string,
      signal: AbortSignal
    ) => {
      const conn = create_rpc_connection(transport, { signal });
      try {
        const resp = await Promise.race([
          call_rpc(conn, { core: { getLockState: true } }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("getLockState timeout")), 5000)
          ),
        ]);
        const ls =
          resp.core?.getLockState ?? LockState.ZMK_STUDIO_CORE_LOCK_STATE_LOCKED;
        setState({
          status: ls === LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED ? "connected" : "locked",
          conn,
          lockState: ls,
          deviceName: label,
        });
        if (ls === LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED) {
          fetchDeviceName(conn);
        }
      } catch (err) {
        console.error("[ZMK] getLockState failed:", err);
        setState((s) => ({ ...s, status: "locked", conn }));
      }
      pumpNotifications(conn, signal);
    },
    [fetchDeviceName, pumpNotifications]
  );

  // ── Bridge connected handler (USB / CoreBluetooth BLE) ───────────────────
  const handleConnected = useCallback(
    async (
      msg: Extract<HostToWebview, { type: "connected" }>,
      signal: AbortSignal
    ) => {
      setState((s) => ({
        ...s,
        status: "connecting",
        deviceName: msg.deviceName ?? msg.label,
      }));
      const transport = createBridgeTransport(msg.label);
      await doConnect(transport, msg.label, signal);
    },
    [doConnect]
  );

  // ── BLE connect ─────────────────────────────────────────────────────────
  // Delegates entirely to the extension host's CoreBluetooth helper, which
  // can find bonded keyboards via retrieveConnectedPeripherals().
  const connectBLE = useCallback(async () => {
    setBleError(undefined);
    setState((s) => ({ ...s, status: "connecting", deviceName: undefined }));
    requestBLEConnect();
  }, []);

  // ── Bridge message effect ────────────────────────────────────────────────────
  useEffect(() => {
    let abortController: AbortController | null = null;

    const handleBridgeMessage = async (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;

      if (msg.type === "connected") {
        abortController?.abort();
        abortController = new AbortController();
        await handleConnected(msg, abortController.signal);
      }

      if (msg.type === "disconnected") {
        abortController?.abort();
        setState(DISCONNECTED_STATE);
      }
    };

    window.addEventListener("message", handleBridgeMessage);
    return () => {
      window.removeEventListener("message", handleBridgeMessage);
      abortController?.abort();
    };
  }, [handleConnected]);

  // ── User actions ─────────────────────────────────────────────────────────────

  // Unlock is triggered by the user pressing a key combo on the keyboard.
  // The firmware sends a lockStateChanged notification automatically — no RPC needed.
  const unlock = useCallback(async () => {}, []);

  const disconnect = useCallback(() => {
    requestDisconnect();
  }, []);

  return { ...state, unlock, disconnect, connectBLE, bleError, onNotification };
}
