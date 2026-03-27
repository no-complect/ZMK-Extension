import React, { CSSProperties } from "react";
import type { PhysicalLayout, Layer } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type { BehaviorMap } from "../hooks/useBehaviors";
import { getKeyLabel } from "../lib/hid";

const ONE_U = 48;

// ── Behavior short-name map ────────────────────────────────────────────────────

const BEHAVIOR_SHORT: Record<string, string> = {
  "Key Press":         "",
  "Transparent":       "▽",
  "None":              "✕",
  "Bootloader":        "Boot",
  "Momentary Layer":   "MO",
  "Toggle Layer":      "TG",
  "Sticky Key":        "SK",
  "Layer Tap":         "LT",
  "Mod-Tap":           "MT",
  "Grave/Escape":      "Grv/Esc",
  "Key Repeat":        "Rep",
  "Key Toggle":        "KT",
  "External Power":    "ExtPwr",
  "Output Selection":  "Out",
  "Studio Unlock":     "Unlock",
  "Mouse Key Press":   "MKP",
};

function shortBehaviorName(displayName: string): string {
  if (displayName in BEHAVIOR_SHORT) return BEHAVIOR_SHORT[displayName];
  const words = displayName.split(/[\s,-]+/);
  if (words.length === 1) return displayName.slice(0, 8);
  return words.map((w) => w[0]?.toUpperCase() ?? "").join("");
}

// ── Key label logic ────────────────────────────────────────────────────────────

function bindingLabel(
  behaviorId: number,
  param1: number,
  behaviors: BehaviorMap
): { header: string; body: string } {
  const behavior = behaviors.get(behaviorId);
  if (!behavior) {
    if (behaviorId !== 0) console.warn(`[ZMK] Unknown behavior ID: ${behaviorId}`);
    return { header: "", body: behaviorId === 0 ? "—" : "?" };
  }

  const name = behavior.displayName;
  const short = shortBehaviorName(name);

  if (name === "Key Press") return { header: "", body: param1 ? getKeyLabel(param1) : "—" };
  if (name === "Transparent" || name === "None") return { header: "", body: short };
  if (name === "Momentary Layer" || name === "Toggle Layer" || name === "Sticky Key") {
    return { header: short, body: String(param1) };
  }
  if (name === "Layer Tap") return { header: `LT${param1}`, body: getKeyLabel(param1) };
  if (name === "Mod-Tap") return { header: "MT", body: getKeyLabel(param1) };

  return { header: short, body: param1 ? `(${param1})` : "" };
}

// ── CSS position from PhysicalAttrs ───────────────────────────────────────────

function keyPositionStyle(
  x: number, y: number, r: number, rx: number, ry: number, oneU: number
): CSSProperties {
  const style: CSSProperties = {
    position: "absolute",
    top: (y / 100) * oneU,
    left: (x / 100) * oneU,
  };

  if (r) {
    const originX = ((rx || x) - x) / 100 * oneU;
    const originY = ((ry || y) - y) / 100 * oneU;
    style.transformOrigin = `${originX}px ${originY}px`;
    style.transform = `rotate(${r / 100}deg)`;
    style.transformStyle = "preserve-3d";
  }

  return style;
}

// ── Key cap ────────────────────────────────────────────────────────────────────

interface KeyCapProps {
  width: number;
  height: number;
  header: string;
  body: string;
  selected: boolean;
  onClick: () => void;
}

const KeyCap = ({ width, height, header, body, selected, onClick }: KeyCapProps) => {
  const w = (width / 100) * ONE_U - 2;
  const h = (height / 100) * ONE_U - 2;

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={[
        "relative flex flex-col items-center justify-center rounded cursor-pointer",
        "transition-all duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "hover:shadow-md hover:scale-110 hover:z-10",
        selected
          ? "bg-primary text-primary-foreground shadow-md scale-110 z-10"
          : "bg-key text-key-foreground hover:bg-accent hover:text-accent-foreground",
      ].join(" ")}
      style={{
        width: w,
        height: h,
        border: selected
          ? "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 80%, transparent)"
          : "1px solid color-mix(in srgb, var(--vscode-editor-foreground) 40%, transparent)",
      }}
    >
      {header && (
        <span
          className="absolute top-0.5 left-0 right-0 text-center leading-none opacity-70 truncate px-0.5"
          style={{ fontSize: 9 }}
        >
          {header}
        </span>
      )}
      <span
        className="leading-tight font-medium text-center px-0.5 truncate max-w-full"
        style={{ fontSize: 11 }}
      >
        {body || " "}
      </span>
    </button>
  );
};

// ── Keyboard layout ────────────────────────────────────────────────────────────

export interface KeyboardLayoutProps {
  physicalLayout: PhysicalLayout;
  layer: Layer;
  behaviors: BehaviorMap;
  scale: number;
  selectedKeyPosition: number | undefined;
  onKeySelected: (position: number) => void;
}

export function KeyboardLayout({
  physicalLayout,
  layer,
  behaviors,
  scale,
  selectedKeyPosition,
  onKeySelected,
}: KeyboardLayoutProps) {
  const keys = physicalLayout.keys;

  const rightMost  = keys.reduce((m, k) => Math.max(m, k.x + k.width), 0);
  const bottomMost = keys.reduce((m, k) => Math.max(m, k.y + k.height), 0);
  const containerW = (rightMost  / 100) * ONE_U;
  const containerH = (bottomMost / 100) * ONE_U;

  return (
    <div
      style={{ transform: `scale(${scale})`, width: containerW, height: containerH, transformOrigin: "top left" }}
    >
      <div style={{ position: "relative", width: containerW, height: containerH }}>
        {keys.map((key, i) => {
          const binding = layer.bindings[i];
          const { header, body } = binding
            ? bindingLabel(binding.behaviorId, binding.param1, behaviors)
            : { header: "", body: "—" };

          return (
            <div key={i} style={keyPositionStyle(key.x, key.y, key.r, key.rx, key.ry, ONE_U)}>
              <KeyCap
                width={key.width}
                height={key.height}
                header={header}
                body={body}
                selected={selectedKeyPosition === i}
                onClick={() => onKeySelected(i)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function layoutNaturalWidth(layout: PhysicalLayout): number {
  return layout.keys.reduce((m, k) => Math.max(m, k.x + k.width), 0) / 100 * ONE_U;
}
