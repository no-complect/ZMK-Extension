import React, { useId } from "react";
import type { BehaviorParameterValueDescription } from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import type { Layer } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { Input } from "../ui/input";
import { ALL_KEY_OPTIONS, baseUsage, buildUsage, decodeModifiers } from "../lib/hid";

const INPUT_BORDER = "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 28%, transparent)";
const INPUT_BG = "var(--vscode-input-background)";

interface ParameterInputProps {
  label: string;
  descriptions: BehaviorParameterValueDescription[];
  value: number | undefined;
  layers: Layer[];
  onChange: (value: number | undefined) => void;
}

export function ParameterInput({
  label,
  descriptions,
  value,
  layers,
  onChange,
}: ParameterInputProps) {
  const id = useId();

  if (descriptions.length === 0) return null;
  if (descriptions.every((d) => d.nil !== undefined)) return null;

  // All constants — select dropdown
  if (descriptions.every((d) => d.constant !== undefined)) {
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-xs text-muted-foreground">{label}</label>
        <select
          id={id}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value ? parseInt(e.target.value) : undefined)}
          className="h-8 w-full rounded px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          style={{ border: INPUT_BORDER, background: INPUT_BG }}
        >
          <option value="">— select —</option>
          {descriptions.map((d) => (
            <option key={d.constant} value={d.constant}>{d.name}</option>
          ))}
        </select>
      </div>
    );
  }

  // Range — number input
  if (descriptions.length === 1 && descriptions[0].range !== undefined) {
    const { min, max } = descriptions[0].range;
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-xs text-muted-foreground">
          {label} ({min}–{max})
        </label>
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value ? parseInt(e.target.value) : undefined)}
          style={{ border: INPUT_BORDER, background: INPUT_BG }}
        />
      </div>
    );
  }

  // HID usage — key picker + modifier toggles
  if (descriptions.length === 1 && descriptions[0].hidUsage !== undefined) {
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-xs text-muted-foreground">{label}</label>
        <HidKeyPicker id={id} value={value} onChange={onChange} />
      </div>
    );
  }

  // Layer ID — select from available layers
  if (descriptions.length === 1 && descriptions[0].layerId !== undefined) {
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-xs text-muted-foreground">{label}</label>
        <select
          id={id}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value !== "" ? parseInt(e.target.value) : undefined)}
          className="h-8 w-full rounded px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          style={{ border: INPUT_BORDER, background: INPUT_BG }}
        >
          <option value="">— select layer —</option>
          {layers.map((layer, i) => (
            <option key={layer.id} value={layer.id}>{layer.name || `Layer ${i}`}</option>
          ))}
        </select>
      </div>
    );
  }

  // Fallback — raw number input
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">{label}</label>
      <Input
        id={id}
        type="number"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? parseInt(e.target.value) : undefined)}
        style={{ border: INPUT_BORDER, background: INPUT_BG }}
      />
    </div>
  );
}

// ── HID key picker ─────────────────────────────────────────────────────────────

const MODIFIER_BUTTONS = [
  { label: "L Ctrl",  bit: 0x01 },
  { label: "L Shift", bit: 0x02 },
  { label: "L Alt",   bit: 0x04 },
  { label: "L GUI",   bit: 0x08 },
  { label: "R Ctrl",  bit: 0x10 },
  { label: "R Shift", bit: 0x20 },
  { label: "R Alt",   bit: 0x40 },
  { label: "R GUI",   bit: 0x80 },
] as const;

function HidKeyPicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  const base = value !== undefined ? baseUsage(value) : 0;
  const modByte = value !== undefined ? (value >> 24) & 0xff : 0;
  const mods = decodeModifiers(value ?? 0);

  const handleKeyChange = (newBase: number) => {
    onChange(newBase === 0 ? undefined : buildUsage(newBase, modByte));
  };

  const toggleMod = (bit: number) => {
    const newModByte = modByte ^ bit;
    onChange(base === 0 && newModByte === 0 ? undefined : buildUsage(base, newModByte));
  };

  const modActive: Record<number, boolean> = {
    0x01: mods.lctrl,  0x02: mods.lshift, 0x04: mods.lalt,  0x08: mods.lgui,
    0x10: mods.rctrl,  0x20: mods.rshift, 0x40: mods.ralt,  0x80: mods.rgui,
  };

  return (
    <div className="flex flex-col gap-2">
      <select
        id={id}
        value={base || ""}
        onChange={(e) => handleKeyChange(e.target.value ? parseInt(e.target.value) : 0)}
        className="h-8 w-full rounded px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        style={{ border: INPUT_BORDER, background: INPUT_BG }}
      >
        <option value="">— select key —</option>
        {ALL_KEY_OPTIONS.map((o) => (
          <option key={o.usage} value={o.usage}>{o.label}</option>
        ))}
      </select>

      <div className="flex gap-1 flex-wrap">
        {MODIFIER_BUTTONS.map(({ label, bit }) => (
          <button
            key={label}
            type="button"
            onClick={() => toggleMod(bit)}
            className="px-2 py-0.5 rounded text-xs transition-colors cursor-pointer focus:outline-none"
            style={modActive[bit] ? {
              background: "var(--vscode-button-background)",
              color: "var(--vscode-button-foreground)",
              border: "1px solid transparent",
            } : {
              border: "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent)",
              background: "transparent",
              color: "inherit",
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
