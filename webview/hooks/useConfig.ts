import { useCallback, useEffect, useState } from "react";
import type { HostToWebview } from "../../shared/messages";
import { requestConfig, postConfigValue } from "../transport/BridgeTransport";

export type ConfigValues = Record<string, string | number | boolean>;

export interface UseConfigResult {
  values: ConfigValues;
  hasFile: boolean;
  setConfig: (key: string, value: string | number | boolean) => void;
}

/**
 * Syncs ZMK .conf config values with the extension host.
 *
 * - Requests a snapshot on mount
 * - Listens for configSnapshot messages from the host
 * - setConfig sends a setConfigValue message and optimistically updates local state
 */
export function useConfig(): UseConfigResult {
  const [values, setValues] = useState<ConfigValues>({});
  const [hasFile, setHasFile] = useState(false);

  // Request the current snapshot on mount
  useEffect(() => {
    requestConfig();
  }, []);

  // Listen for configSnapshot from the host
  useEffect(() => {
    const handler = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      if (msg.type === "configSnapshot") {
        setValues(msg.values);
        setHasFile(msg.hasFile);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const setConfig = useCallback((key: string, value: string | number | boolean) => {
    // Optimistic local update
    setValues((prev) => ({ ...prev, [key]: value }));
    // Tell the host to persist it
    postConfigValue(key, value);
  }, []);

  return { values, hasFile, setConfig };
}
