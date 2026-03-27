import type { RpcConnection } from "@zmkfirmware/zmk-studio-ts-client";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import type { Notification } from "@zmkfirmware/zmk-studio-ts-client/studio";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "locked";

export interface ConnectionState {
  status: ConnectionStatus;
  conn: RpcConnection | null;
  lockState: LockState;
  deviceName: string | undefined;
}

export interface ConnectionContextValue extends ConnectionState {
  unlock: () => Promise<void>;
  disconnect: () => void;
  /** Connect to a ZMK keyboard via Web Bluetooth (GATT) */
  connectBLE: () => Promise<void>;
  /** Last BLE connection error, if any */
  bleError: string | undefined;
  /** Subscribe to notifications from the keyboard (e.g. lock state, unsaved changes) */
  onNotification: (cb: (n: Notification) => void) => () => void;
}

// ── Constants ──────────────────────────────────────────────────────────────────

export const DISCONNECTED_STATE: ConnectionState = {
  status: "disconnected",
  conn: null,
  lockState: LockState.ZMK_STUDIO_CORE_LOCK_STATE_LOCKED,
  deviceName: undefined,
};
