import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BehaviorBinding, Layer } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type { BehaviorMap } from "../hooks/useBehaviors";
import { ParameterInput } from "./ParameterInput";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { BEHAVIOR_CONFIG_OPTIONS } from "../lib/behaviorConfigOptions";
import { useConfigContext } from "../contexts/ConfigContext";

const DIVIDER = "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 15%, transparent)";
const INPUT_BORDER = "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 28%, transparent)";

export type ConfigChangeset = {
  /** Config keys that changed, mapped to their new values */
  changes: Record<string, number | string | boolean>;
  /** The values those same keys had before the change (for undo) */
  prevValues: Record<string, number | string | boolean>;
};

interface BindingEditorProps {
  binding: BehaviorBinding;
  behaviors: BehaviorMap;
  layers: Layer[];
  onBindingChanged: (binding: BehaviorBinding) => void;
  /** Called on Apply when one or more config (.conf) values changed since the last snapshot */
  onConfigApplied?: (changeset: ConfigChangeset) => void;
  keyLabel?: string;
}

export function BindingEditor({
  binding,
  behaviors,
  layers,
  onBindingChanged,
  onConfigApplied,
  keyLabel = "Selected key",
}: BindingEditorProps) {
  const [behaviorId, setBehaviorId] = useState(binding.behaviorId);
  const [param1, setParam1] = useState<number | undefined>(binding.param1 || undefined);
  const [param2, setParam2] = useState<number | undefined>(binding.param2 || undefined);
  const [dirty, setDirty] = useState(false);
  const [applied, setApplied] = useState(false);
  const appliedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Config comes from shared context so useSelectedKeyContext can also access setConfig
  const { values: configValues, hasFile, setConfig } = useConfigContext();

  const selectedBehavior = behaviors.get(behaviorId);
  const configOptions = selectedBehavior
    ? (BEHAVIOR_CONFIG_OPTIONS[selectedBehavior.displayName] ?? [])
    : [];

  // ── Config snapshot ────────────────────────────────────────────────────────
  // Taken when a new key is selected (keyLabel changes) or the behavior changes.
  // Represents "config values at the start of this editing session" for this key/behavior.
  // Stored in a ref so it doesn't trigger re-renders and isn't reset on every config change.
  const configSnapshotRef = useRef<Record<string, number | string | boolean>>({});

  useEffect(() => {
    const snap: Record<string, number | string | boolean> = {};
    for (const opt of configOptions) {
      const v = configValues[opt.key];
      if (v !== undefined) snap[opt.key] = v as number | string | boolean;
      else if (opt.default !== undefined) snap[opt.key] = opt.default as number | string | boolean;
    }
    configSnapshotRef.current = snap;
  // We intentionally depend only on keyLabel + behaviorId (session boundaries),
  // NOT on configValues — we don't want to reset the snapshot on every keystroke.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyLabel, behaviorId]);

  // ── Sync form when binding changes externally (undo / redo / key selection) ──
  useEffect(() => {
    setBehaviorId(binding.behaviorId);
    setParam1(binding.param1 || undefined);
    setParam2(binding.param2 || undefined);
    setDirty(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding.behaviorId, binding.param1, binding.param2]);

  const sortedBehaviors = useMemo(
    () => [...behaviors.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [behaviors]
  );

  const handleBehaviorChange = useCallback((newId: number) => {
    setBehaviorId(newId);
    setParam1(undefined);
    setParam2(undefined);
    setDirty(true);
  }, []);

  const handleParam1Change = useCallback((v: number | undefined) => {
    setParam1(v);
    setParam2(undefined);
    setDirty(true);
  }, []);

  const handleParam2Change = useCallback((v: number | undefined) => {
    setParam2(v);
    setDirty(true);
  }, []);

  const metadata = selectedBehavior?.metadata ?? [];
  const activeSet = metadata.find((set) => {
    if (!set.param1 || set.param1.length === 0) return true;
    const p1 = param1 ?? 0;
    return set.param1.some(
      (d) =>
        d.constant === p1 ||
        (d.range && p1 >= d.range.min && p1 <= d.range.max) ||
        d.nil !== undefined ||
        d.hidUsage !== undefined ||
        d.layerId !== undefined
    );
  }) ?? metadata[0];

  const param1Descs = activeSet?.param1 ?? [];
  const param2Descs = activeSet?.param2 ?? [];

  // ── Apply ──────────────────────────────────────────────────────────────────

  const handleApply = useCallback(() => {
    // 1. Report binding change (may or may not differ from current)
    onBindingChanged({ behaviorId, param1: param1 ?? 0, param2: param2 ?? 0 });

    // 2. Detect config changes since the session snapshot
    if (onConfigApplied) {
      const changes: Record<string, number | string | boolean> = {};
      const prevValues: Record<string, number | string | boolean> = {};

      for (const opt of configOptions) {
        const current = configValues[opt.key] as number | string | boolean
          ?? opt.default as number | string | boolean;
        const original = configSnapshotRef.current[opt.key]
          ?? opt.default as number | string | boolean;

        if (current !== original) {
          changes[opt.key] = current;
          prevValues[opt.key] = original;
        }
      }

      if (Object.keys(changes).length > 0) {
        onConfigApplied({ changes, prevValues });
        // Advance snapshot so the next Apply only tracks NEW changes
        configSnapshotRef.current = { ...configSnapshotRef.current, ...changes };
      }
    }

    setDirty(false);
    setApplied(true);
    if (appliedTimer.current) clearTimeout(appliedTimer.current);
    appliedTimer.current = setTimeout(() => setApplied(false), 1500);
  }, [behaviorId, param1, param2, configOptions, configValues, onBindingChanged, onConfigApplied]);

  // ── Reset ──────────────────────────────────────────────────────────────────

  const handleReset = useCallback(() => {
    setBehaviorId(binding.behaviorId);
    setParam1(binding.param1 || undefined);
    setParam2(binding.param2 || undefined);
    setDirty(false);
    // Also revert any config values that changed since the session snapshot
    for (const [key, origVal] of Object.entries(configSnapshotRef.current)) {
      const current = configValues[key] as number | string | boolean
        ?? origVal;
      if (current !== origVal) {
        setConfig(key, origVal);
      }
    }
  }, [binding.behaviorId, binding.param1, binding.param2, configValues, setConfig]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col gap-3 p-3 bg-card"
      style={{ borderTop: DIVIDER }}
    >

      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">{keyLabel}</span>
        {applied ? (
          <span className="text-xs text-green-500 font-medium">Applied ✓</span>
        ) : dirty ? (
          <Badge variant="secondary" className="text-xs">unsaved</Badge>
        ) : null}
      </div>

      {/* ── Behavior selector ───────────────────────────────────────── */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">Behavior</label>
        <select
          value={behaviorId}
          onChange={(e) => handleBehaviorChange(parseInt(e.target.value))}
          className="h-8 w-full rounded px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          style={{ border: INPUT_BORDER, background: "var(--vscode-input-background)" }}
        >
          {sortedBehaviors.map((b) => (
            <option key={b.id} value={b.id}>{b.displayName}</option>
          ))}
        </select>
      </div>

      {/* ── Parameter inputs ────────────────────────────────────────── */}
      {param1Descs.length > 0 && (
        <ParameterInput
          label="Parameter 1"
          descriptions={param1Descs}
          value={param1}
          layers={layers}
          onChange={handleParam1Change}
        />
      )}

      {param2Descs.length > 0 && param1 !== undefined && (
        <ParameterInput
          label="Parameter 2"
          descriptions={param2Descs}
          value={param2}
          layers={layers}
          onChange={handleParam2Change}
        />
      )}

      {/* ── Config options ──────────────────────────────────────────── */}
      {configOptions.length > 0 && (
        <div className="flex flex-col gap-2 pt-2" style={{ borderTop: DIVIDER }}>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-medium flex-1 min-w-0">
              Config (.conf) <span style={{ opacity: 0.5 }}>· auto-saved</span>
            </span>
            {!hasFile && (
              <span className="text-xs text-yellow-500 shrink-0">No file linked</span>
            )}
          </div>
          {configOptions.map((opt) => (
            <ConfigNumberInput
              key={opt.key}
              label={opt.label}
              description={opt.description}
              min={opt.min}
              max={opt.max}
              committed={configValues[opt.key] as number ?? opt.default as number}
              onCommit={(n) => setConfig(opt.key, n)}
            />
          ))}
        </div>
      )}

      {/* ── Actions ─────────────────────────────────────────────────── */}
      <div className="flex gap-2">
        <Button
          size="sm"
          className="flex-1"
          disabled={behaviorId === undefined}
          onClick={handleApply}
        >
          Apply
        </Button>
        {dirty && (
          <Button size="sm" variant="ghost" onClick={handleReset}>
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Config number input ────────────────────────────────────────────────────────

interface ConfigNumberInputProps {
  label: string;
  description?: string;
  min?: number;
  max?: number;
  committed: number;
  onCommit: (value: number) => void;
}

function ConfigNumberInput({ label, description, min, max, committed, onCommit }: ConfigNumberInputProps) {
  const [raw, setRaw] = useState(String(committed));
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isEmpty = raw.trim() === "";
  const parsed = parseInt(raw, 10);
  const outOfRange = !isEmpty && !isNaN(parsed) &&
    ((min !== undefined && parsed < min) || (max !== undefined && parsed > max));
  const hasError = isEmpty || outOfRange;

  useEffect(() => { setRaw(String(committed)); }, [committed]);

  const flashSaved = () => {
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1500);
  };

  const handleBlur = () => {
    if (isEmpty || isNaN(parsed)) {
      setRaw(String(committed));
    } else if (outOfRange) {
      const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed));
      setRaw(String(clamped));
      onCommit(clamped);
      flashSaved();
    } else if (parsed !== committed) {
      onCommit(parsed);
      flashSaved();
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs text-muted-foreground" title={description}>{label}</label>
        {hasError ? (
          <span className="text-xs text-destructive shrink-0">
            {isEmpty ? "Cannot be empty" : `Must be ${min}–${max}`}
          </span>
        ) : saved ? (
          <span className="text-xs text-green-500 font-medium shrink-0">auto-saved ✓</span>
        ) : null}
      </div>
      <input
        type="number"
        min={min}
        max={max}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={handleBlur}
        className="h-8 w-full rounded px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        style={{
          border: hasError
            ? "1px solid var(--vscode-editorError-foreground, #f44747)"
            : INPUT_BORDER,
          background: "var(--vscode-input-background)",
        }}
      />
    </div>
  );
}
