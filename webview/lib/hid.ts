/**
 * HID Usage encoding/decoding and key display name lookup.
 * Usage encoding: ZMK_HID_USAGE(page, id) = (page << 16) | id
 */

export const HID_PAGE_KEYBOARD = 0x07;
export const HID_PAGE_CONSUMER = 0x0c;

export const encodeUsage = (page: number, id: number): number =>
  (page << 16) | id;

export const decodeUsage = (usage: number): { page: number; id: number } => ({
  page: (usage >> 16) & 0xff,
  id: usage & 0xffff,
});

/** Modifier flags packed into bits 31–24 of a key usage */
export interface ModifierFlags {
  lctrl: boolean;
  lshift: boolean;
  lalt: boolean;
  lgui: boolean;
  rctrl: boolean;
  rshift: boolean;
  ralt: boolean;
  rgui: boolean;
}

export const decodeModifiers = (usage: number): ModifierFlags => {
  const mods = (usage >> 24) & 0xff;
  return {
    lctrl:  !!(mods & 0x01),
    lshift: !!(mods & 0x02),
    lalt:   !!(mods & 0x04),
    lgui:   !!(mods & 0x08),
    rctrl:  !!(mods & 0x10),
    rshift: !!(mods & 0x20),
    ralt:   !!(mods & 0x40),
    rgui:   !!(mods & 0x80),
  };
};

/** Strip modifier bits and return base usage */
export const baseUsage = (usage: number): number => usage & 0x00ffffff;

// ── Key name lookup ───────────────────────────────────────────────────────
// Maps encoded usage (page << 16 | id) → short display name

const K = (id: number, name: string): [number, string] => [
  encodeUsage(HID_PAGE_KEYBOARD, id),
  name,
];
const C = (id: number, name: string): [number, string] => [
  encodeUsage(HID_PAGE_CONSUMER, id),
  name,
];

const KEY_NAME_ENTRIES: [number, string][] = [
  // ── Letters ──────────────────────────────────────────────────────────────
  K(4, "A"),  K(5, "B"),  K(6, "C"),  K(7, "D"),  K(8, "E"),  K(9, "F"),
  K(10, "G"), K(11, "H"), K(12, "I"), K(13, "J"), K(14, "K"), K(15, "L"),
  K(16, "M"), K(17, "N"), K(18, "O"), K(19, "P"), K(20, "Q"), K(21, "R"),
  K(22, "S"), K(23, "T"), K(24, "U"), K(25, "V"), K(26, "W"), K(27, "X"),
  K(28, "Y"), K(29, "Z"),

  // ── Numbers ──────────────────────────────────────────────────────────────
  K(30, "1"), K(31, "2"), K(32, "3"), K(33, "4"), K(34, "5"),
  K(35, "6"), K(36, "7"), K(37, "8"), K(38, "9"), K(39, "0"),

  // ── Special keys ─────────────────────────────────────────────────────────
  K(40, "↵"),   K(41, "Esc"),  K(42, "⌫"),   K(43, "↹"),
  K(44, "␣"),   K(45, "-"),    K(46, "="),    K(47, "["),
  K(48, "]"),   K(49, "\\"),   K(50, "#"),    K(51, ";"),
  K(52, "'"),   K(53, "`"),    K(54, ","),    K(55, "."),
  K(56, "/"),   K(57, "Caps"),

  // ── Function keys ─────────────────────────────────────────────────────────
  K(58, "F1"),  K(59, "F2"),  K(60, "F3"),  K(61, "F4"),
  K(62, "F5"),  K(63, "F6"),  K(64, "F7"),  K(65, "F8"),
  K(66, "F9"),  K(67, "F10"), K(68, "F11"), K(69, "F12"),
  K(104, "F13"), K(105, "F14"), K(106, "F15"), K(107, "F16"),
  K(108, "F17"), K(109, "F18"), K(110, "F19"), K(111, "F20"),
  K(112, "F21"), K(113, "F22"), K(114, "F23"), K(115, "F24"),

  // ── Navigation ────────────────────────────────────────────────────────────
  K(70, "PrSc"), K(71, "ScrLk"), K(72, "Pause"),
  K(73, "Ins"),  K(74, "Home"),  K(75, "PgUp"),
  K(76, "Del"),  K(77, "End"),   K(78, "PgDn"),
  K(79, "→"),    K(80, "←"),    K(81, "↓"),    K(82, "↑"),

  // ── Numpad ────────────────────────────────────────────────────────────────
  K(83, "NLk"), K(84, "KP/"), K(85, "KP*"), K(86, "KP-"),
  K(87, "KP+"), K(88, "KP↵"),
  K(89, "KP1"), K(90, "KP2"), K(91, "KP3"), K(92, "KP4"),
  K(93, "KP5"), K(94, "KP6"), K(95, "KP7"), K(96, "KP8"),
  K(97, "KP9"), K(98, "KP0"), K(99, "KP."),

  // ── Modifiers ─────────────────────────────────────────────────────────────
  K(224, "LCtrl"), K(225, "LShift"), K(226, "LAlt"),  K(227, "LGUI"),
  K(228, "RCtrl"), K(229, "RShift"), K(230, "RAlt"),  K(231, "RGUI"),

  // ── Consumer (page 0x0C) ─────────────────────────────────────────────────
  C(176, "⏮Prev"), C(177, "⏭Next"), C(178, "🔁"),   C(179, "🔀"),
  C(180, "⏹Stop"), C(181, "⏭"),    C(205, "⏯"),
  C(226, "🔇Mute"),C(233, "🔊"),    C(234, "🔉"),
  C(111, "🔆"),    C(112, "🔅"),
];

const KEY_NAMES = new Map<number, string>(KEY_NAME_ENTRIES);

/**
 * Returns a short display name for a HID usage value.
 * Handles modifier-encoded usages (e.g. LS(A) → "⇧A").
 */
export function getKeyLabel(usage: number): string {
  const mods = decodeModifiers(usage);
  const base = baseUsage(usage);
  const name = KEY_NAMES.get(base) ?? `0x${base.toString(16).toUpperCase()}`;

  const prefixes: string[] = [];
  if (mods.lctrl || mods.rctrl)   prefixes.push("^");
  if (mods.lshift || mods.rshift) prefixes.push("⇧");
  if (mods.lalt || mods.ralt)     prefixes.push("⌥");
  if (mods.lgui || mods.rgui)     prefixes.push("⌘");

  return prefixes.join("") + name;
}

/** Pack a modifier byte + base usage into a single value */
export const buildUsage = (base: number, modByte: number): number =>
  ((modByte & 0xff) << 24) | (base & 0x00ffffff);

/** All searchable key entries — used by the HID key picker */
export const ALL_KEY_OPTIONS: Array<{ usage: number; label: string }> =
  KEY_NAME_ENTRIES.map(([usage, label]) => ({ usage, label }));
