export interface ConfigOption {
  key: string;
  label: string;
  type: "number" | "boolean";
  default: number | boolean;
  min?: number;
  max?: number;
  description?: string;
}

const MOUSE_MOVE_OPTIONS: ConfigOption[] = [
  {
    key: "CONFIG_ZMK_HID_MOUSE_MOVE_MAX",
    label: "Max Move Speed",
    type: "number",
    default: 600,
    min: 1,
    max: 32767,
    description: "Maximum mouse movement delta per HID report",
  },
  {
    key: "CONFIG_ZMK_HID_MOUSE_MOVE_TIME_TO_MAX_SPEED_MS",
    label: "Ramp-up Time (ms)",
    type: "number",
    default: 0,
    min: 0,
    max: 10000,
    description: "Time (ms) to accelerate from 0 to max speed",
  },
  {
    key: "CONFIG_ZMK_HID_MOUSE_MOVE_INITIAL_DELAY_MS",
    label: "Initial Delay (ms)",
    type: "number",
    default: 0,
    min: 0,
    max: 10000,
    description: "Delay before movement begins",
  },
];

const MOUSE_SCROLL_OPTIONS: ConfigOption[] = [
  {
    key: "CONFIG_ZMK_HID_MOUSE_SCROLL_MAX",
    label: "Max Scroll Speed",
    type: "number",
    default: 10,
    min: 1,
    max: 32767,
    description: "Maximum scroll delta per HID report",
  },
  {
    key: "CONFIG_ZMK_HID_MOUSE_SCROLL_TIME_TO_MAX_SPEED_MS",
    label: "Ramp-up Time (ms)",
    type: "number",
    default: 0,
    min: 0,
    max: 10000,
    description: "Time (ms) to accelerate from 0 to max scroll speed",
  },
  {
    key: "CONFIG_ZMK_HID_MOUSE_SCROLL_INITIAL_DELAY_MS",
    label: "Initial Delay (ms)",
    type: "number",
    default: 0,
    min: 0,
    max: 10000,
    description: "Delay before scrolling begins",
  },
];

/**
 * Maps a behavior's displayName to the ZMK config options that affect it.
 * Used by BindingEditor to show relevant .conf knobs alongside a binding.
 */
export const BEHAVIOR_CONFIG_OPTIONS: Record<string, ConfigOption[]> = {
  "Mouse Move Up": MOUSE_MOVE_OPTIONS,
  "Mouse Move Down": MOUSE_MOVE_OPTIONS,
  "Mouse Move Left": MOUSE_MOVE_OPTIONS,
  "Mouse Move Right": MOUSE_MOVE_OPTIONS,
  "Mouse Scroll Up": MOUSE_SCROLL_OPTIONS,
  "Mouse Scroll Down": MOUSE_SCROLL_OPTIONS,
  "Mouse Scroll Left": MOUSE_SCROLL_OPTIONS,
  "Mouse Scroll Right": MOUSE_SCROLL_OPTIONS,
};
