import { useEffect, useState } from "react";
import { call_rpc } from "@zmkfirmware/zmk-studio-ts-client";
import type { GetBehaviorDetailsResponse } from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import { useConnection } from "../contexts/ConnectionContext";

export type BehaviorMap = Map<number, GetBehaviorDetailsResponse>;

export interface UseBehaviorsResult {
  behaviors: BehaviorMap;
  loading: boolean;
  error: string | undefined;
}

/**
 * Fetches the full behavior catalogue from the connected keyboard.
 *
 * 1. Lists all behavior IDs via `behaviors.listAllBehaviors`
 * 2. Fetches details for each ID (display name + parameter metadata)
 *
 * Re-fetches automatically when the connection changes.
 * Returns a stable Map<id, GetBehaviorDetailsResponse> for O(1) lookup.
 */
export function useBehaviors(): UseBehaviorsResult {
  const { conn, lockState } = useConnection();
  const [behaviors, setBehaviors] = useState<BehaviorMap>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!conn || lockState !== LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED) {
      setBehaviors(new Map());
      return;
    }

    let cancelled = false;

    async function fetch() {
      setLoading(true);
      setError(undefined);

      try {
        // Step 1: get the list of all behavior IDs
        const listResp = await call_rpc(conn!, {
          behaviors: { listAllBehaviors: true },
        });

        const ids = listResp.behaviors?.listAllBehaviors?.behaviors ?? [];
        if (cancelled) return;

        // Step 2: fetch details for each ID in parallel
        const details = await Promise.all(
          ids.map((id) =>
            call_rpc(conn!, {
              behaviors: { getBehaviorDetails: { behaviorId: id } },
            }).then((r) => r.behaviors?.getBehaviorDetails)
          )
        );
        if (cancelled) return;

        const map: BehaviorMap = new Map();
        for (const detail of details) {
          if (detail) map.set(detail.id, detail);
        }
        setBehaviors(map);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetch();
    return () => { cancelled = true; };
  }, [conn, lockState]);

  return { behaviors, loading, error };
}
