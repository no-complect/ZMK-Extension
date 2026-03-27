/**
 * Generates a ZMK .keymap devicetree source file from an ExportedKeymap.
 * The BehaviorMap (from the live keyboard connection) is required to resolve
 * behavior IDs to their ZMK binding names.
 */

import type { ExportedKeymap } from "../../shared/messages";
import type { BehaviorMap } from "../hooks/useBehaviors";

const HID_PAGE_KEYBOARD = 0x07;
const HID_PAGE_CONSUMER = 0x0c;

// ── HID keyboard usage ID → ZMK key name ──────────────────────────────────────

const KEYBOARD_KEY_NAMES: Record<number, string> = {
  // Letters
  4: "A",  5: "B",  6: "C",  7: "D",  8: "E",  9: "F",
  10: "G", 11: "H", 12: "I", 13: "J", 14: "K", 15: "L",
  16: "M", 17: "N", 18: "O", 19: "P", 20: "Q", 21: "R",
  22: "S", 23: "T", 24: "U", 25: "V", 26: "W", 27: "X",
  28: "Y", 29: "Z",
  // Numbers
  30: "N1", 31: "N2", 32: "N3", 33: "N4", 34: "N5",
  35: "N6", 36: "N7", 37: "N8", 38: "N9", 39: "N0",
  // Special
  40: "RET",    41: "ESC",    42: "BSPC",   43: "TAB",   44: "SPACE",
  45: "MINUS",  46: "EQUAL",  47: "LBKT",   48: "RBKT",  49: "BSLH",
  50: "NON_US_HASH", 51: "SEMI", 52: "SQT", 53: "GRAVE",
  54: "COMMA",  55: "DOT",    56: "FSLH",   57: "CLCK",
  // Function keys
  58: "F1",  59: "F2",  60: "F3",  61: "F4",
  62: "F5",  63: "F6",  64: "F7",  65: "F8",
  66: "F9",  67: "F10", 68: "F11", 69: "F12",
  104: "F13", 105: "F14", 106: "F15", 107: "F16",
  108: "F17", 109: "F18", 110: "F19", 111: "F20",
  112: "F21", 113: "F22", 114: "F23", 115: "F24",
  // Navigation
  70: "PSCRN",       71: "SLCK",       72: "PAUSE_BREAK",
  73: "INS",         74: "HOME",       75: "PG_UP",
  76: "DEL",         77: "END",        78: "PG_DN",
  79: "RIGHT",       80: "LEFT",       81: "DOWN",  82: "UP",
  // Numpad
  83: "KP_NUM",    84: "KP_SLASH", 85: "KP_MULTIPLY", 86: "KP_MINUS",
  87: "KP_PLUS",   88: "KP_ENTER",
  89: "KP_N1", 90: "KP_N2", 91: "KP_N3", 92: "KP_N4", 93: "KP_N5",
  94: "KP_N6", 95: "KP_N7", 96: "KP_N8", 97: "KP_N9", 98: "KP_N0",
  99: "KP_DOT",
  // Modifiers
  224: "LCTRL", 225: "LSHFT", 226: "LALT", 227: "LGUI",
  228: "RCTRL", 229: "RSHFT", 230: "RALT", 231: "RGUI",
};

// ── HID consumer usage ID → ZMK key name ─────────────────────────────────────

const CONSUMER_KEY_NAMES: Record<number, string> = {
  176: "C_PREV", 177: "C_NEXT", 178: "C_STOP", 179: "C_FF",
  181: "C_NEXT", 205: "C_PP",   226: "C_MUTE",
  233: "C_VOL_UP", 234: "C_VOL_DN",
  111: "C_BRI_UP",  112: "C_BRI_DN",
};

// ── Mouse button constants → ZMK mkp names ───────────────────────────────────

const MOUSE_BUTTON_NAMES: Record<number, string> = {
  1: "LCLK", 2: "RCLK", 4: "MCLK", 8: "MB4", 16: "MB5",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function wrapModifiers(key: string, modByte: number): string {
  const mods: string[] = [];
  if (modByte & 0x01) mods.push("LC");
  if (modByte & 0x02) mods.push("LS");
  if (modByte & 0x04) mods.push("LA");
  if (modByte & 0x08) mods.push("LG");
  if (modByte & 0x10) mods.push("RC");
  if (modByte & 0x20) mods.push("RS");
  if (modByte & 0x40) mods.push("RA");
  if (modByte & 0x80) mods.push("RG");
  // Nest from outermost to innermost: LS(LA(key))
  return mods.reduceRight((inner, mod) => `${mod}(${inner})`, key);
}

function usageToZmk(usage: number): string {
  const modByte = (usage >> 24) & 0xff;
  const base    = usage & 0x00ffffff;
  const page    = (base >> 16) & 0xff;
  const id      = base & 0xffff;

  let keyName: string;
  if (page === HID_PAGE_KEYBOARD) {
    keyName = KEYBOARD_KEY_NAMES[id] ?? `0x${id.toString(16).toUpperCase()}`;
  } else if (page === HID_PAGE_CONSUMER) {
    keyName = CONSUMER_KEY_NAMES[id] ?? `0x${id.toString(16).toUpperCase()}`;
  } else {
    keyName = `0x${base.toString(16).toUpperCase()}`;
  }

  return modByte ? wrapModifiers(keyName, modByte) : keyName;
}

/** Convert a human-readable param name from behavior metadata to a ZMK symbol.
 *  e.g. "Move Up" → "MOVE_UP", "Scroll Down" → "SCRL_DOWN" */
function metaNameToSymbol(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// ── Core binding converter ────────────────────────────────────────────────────

function bindingToZmk(
  behaviorId: number,
  param1: number,
  param2: number,
  behaviors: BehaviorMap,
  unknownLog: string[],
  position: number,
): string {
  // ZMK sentinel: no binding assigned
  if (behaviorId === 0) return "&trans";

  const behavior = behaviors.get(behaviorId);
  if (!behavior) {
    unknownLog.push(`  pos ${position}: unknown behavior ID ${behaviorId}`);
    return "&trans";
  }

  const name = behavior.displayName;

  switch (name) {
    case "Key Press":
      return `&kp ${param1 ? usageToZmk(param1) : "NONE"}`;
    case "Transparent":
      return "&trans";
    case "None":
      return "&none";
    case "Bootloader":
      return "&bootloader";
    case "Reset":
      return "&sys_reset";
    case "Soft Off":
      return "&soft_off";
    case "Studio Unlock":
      return "&studio_unlock";
    case "Grave/Escape":
      return "&gresc";
    case "Key Repeat":
      return "&key_repeat";
    case "Momentary Layer":
      return `&mo ${param1}`;
    case "Toggle Layer":
      return `&tog ${param1}`;
    case "Sticky Key":
      return `&sk ${usageToZmk(param1)}`;
    case "Layer Tap":
      return `&lt ${param1} ${usageToZmk(param2)}`;
    case "Mod-Tap":
      return `&mt ${usageToZmk(param1)} ${usageToZmk(param2)}`;
    case "Key Toggle":
      return `&kt ${usageToZmk(param1)}`;
    case "External Power":
      return "&ext_power EP_TOG";
    case "Output Selection":
      return "&out OUT_TOG";
    case "Mouse Key Press":
      return `&mkp ${MOUSE_BUTTON_NAMES[param1] ?? param1}`;
    case "Mouse Move":
    case "Mouse Scroll": {
      const node = name === "Mouse Move" ? "mmv" : "msc";
      // Look up param1 constant name from behavior metadata
      const meta0 = behavior.metadata?.[0];
      const constEntry = meta0?.param1?.find((p) => p.constant === param1);
      const sym = constEntry ? metaNameToSymbol(constEntry.name) : `${param1}`;
      return `&${node} ${sym}`;
    }
    default: {
      // Try to generate from metadata:
      // If all params are nil → no-param behavior
      const meta0 = behavior.metadata?.[0];
      const p1Nil  = !meta0 || meta0.param1.length === 0 || meta0.param1.every((p) => p.nil !== undefined);
      const p2Nil  = !meta0 || meta0.param2.length === 0 || meta0.param2.every((p) => p.nil !== undefined);

      if (p1Nil && p2Nil) {
        // Best-effort: generate a node name from the display name
        const node = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        return `&${node}`;
      }

      // Has params — look up constants in metadata
      const p1Entry = meta0?.param1?.find((p) => p.constant === param1);
      const p2Entry = meta0?.param2?.find((p) => p.constant === param2);
      if (p1Entry || p2Entry) {
        const node = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        const p1Sym = p1Entry ? metaNameToSymbol(p1Entry.name) : (param1 ? usageToZmk(param1) : "");
        const p2Sym = p2Entry ? metaNameToSymbol(p2Entry.name) : (param2 ? usageToZmk(param2) : "");
        const args = [p1Sym, p2Sym].filter(Boolean).join(" ");
        return args ? `&${node} ${args}` : `&${node}`;
      }

      // Unknown — log and use trans as placeholder
      unknownLog.push(`  pos ${position}: "${name}" (id=${behaviorId}, p1=${param1}, p2=${param2}) — substituted &trans`);
      return "&trans";
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generates a ZMK .keymap devicetree source string from an ExportedKeymap.
 * Requires the live BehaviorMap to resolve behavior IDs to binding names.
 */
export function generateKeymapSource(
  data: ExportedKeymap,
  behaviors: BehaviorMap,
): string {
  const unknownLog: string[] = [];
  const lines: string[] = [];

  lines.push(`// Generated by ZMK Studio VSCode Extension`);
  lines.push(`// Device:   ${data.deviceName ?? "Unknown"}`);
  lines.push(`// Exported: ${data.exportedAt}`);
  lines.push(`//`);
  lines.push(`// Verify these #includes match your keyboard's actual config.`);
  lines.push(`// Behaviors substituted with &trans are marked at the bottom of this file.`);
  lines.push(``);
  lines.push(`#include <behaviors.dtsi>`);
  lines.push(`#include <dt-bindings/zmk/keys.h>`);
  lines.push(`#include <dt-bindings/zmk/bt.h>`);
  lines.push(`#include <dt-bindings/zmk/mouse.h>`);
  lines.push(`#include <dt-bindings/zmk/outputs.h>`);
  lines.push(`#include <dt-bindings/zmk/ext_power.h>`);
  lines.push(``);
  lines.push(`/ {`);
  lines.push(`    keymap {`);
  lines.push(`        compatible = "zmk,keymap";`);
  lines.push(``);

  data.layers.forEach((layer, layerIdx) => {
    const safeName = (layer.name || `layer_${layerIdx}`)
      .replace(/[^a-zA-Z0-9_]/g, "_");
    const nodeLabel = `layer_${layerIdx}_${safeName}`;

    lines.push(`        ${nodeLabel} {`);
    lines.push(`            display-name = "${layer.name || `Layer ${layerIdx}`}";`);
    lines.push(`            bindings = <`);

    // Convert all bindings, then wrap to ~10 per row
    const bindingStrings = layer.bindings.map((b, i) =>
      bindingToZmk(b.behaviorId, b.param1, b.param2, behaviors, unknownLog, i)
    );

    const COLS = 10;
    for (let i = 0; i < bindingStrings.length; i += COLS) {
      const row = bindingStrings.slice(i, i + COLS).join("  ");
      lines.push(`                ${row}`);
    }

    lines.push(`            >;`);
    lines.push(`        };`);
    lines.push(``);
  });

  lines.push(`    };`);
  lines.push(`};`);

  if (unknownLog.length > 0) {
    lines.push(``);
    lines.push(`// ── Unknown behaviors (substituted with &trans) ─────────────────`);
    for (const entry of unknownLog) {
      lines.push(`//${entry}`);
    }
  }

  return lines.join("\n") + "\n";
}
