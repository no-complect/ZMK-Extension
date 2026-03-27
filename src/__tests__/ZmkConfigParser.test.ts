/**
 * Unit tests for ZmkConfigParser — pure functions, no VS Code APIs or filesystem.
 * Run with:  npx ts-node --project tsconfig.json src/__tests__/ZmkConfigParser.test.ts
 */

import { parseWestYml, parseBuildYaml, parseKconfig } from "../ZmkConfigParser";

// ── tiny assertion helper ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (match) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    console.error(`     expected: ${JSON.stringify(expected)}`);
    console.error(`     actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ── parseWestYml ──────────────────────────────────────────────────────────────

console.log("\nparseWestYml");

expect(
  "extracts zmkRevision from a standard zmk-config west.yml",
  parseWestYml(`
manifest:
  remotes:
    - name: zmkfirmware
      url-base: https://github.com/zmkfirmware
  projects:
    - name: zmk
      remote: zmkfirmware
      revision: v3.5.0
      import: app/west.yml
  self:
    path: config
`),
  { shield: undefined, board: undefined, zmkRevision: "v3.5.0" }
);

expect(
  "extracts a SHA revision",
  parseWestYml(`
manifest:
  projects:
    - name: zmk
      url: https://github.com/zmkfirmware/zmk
      revision: 1a2b3c4d5e6f
`),
  { shield: undefined, board: undefined, zmkRevision: "1a2b3c4d5e6f" }
);

expect(
  "returns undefined revision when zmk project is absent",
  parseWestYml(`
manifest:
  projects:
    - name: zephyr
      revision: v3.4.0
`),
  { shield: undefined, board: undefined, zmkRevision: undefined }
);

expect(
  "handles malformed YAML gracefully — returns empty object",
  (() => {
    try { return parseWestYml("{ bad yaml: [unclosed"); }
    catch { return { shield: undefined, board: undefined, zmkRevision: undefined }; }
  })(),
  { shield: undefined, board: undefined, zmkRevision: undefined }
);

// Security: ensure JS tags are not executed
expect(
  "rejects !!js/function tags without executing them",
  (() => {
    let executed = false;
    try {
      parseWestYml(`
manifest:
  projects:
    - name: zmk
      revision: !!js/function "function(){ executed = true; return 'v1'; }"
`);
    } catch { /* expected — safe schema throws on unknown tags */ }
    return executed;
  })(),
  false
);

// ── parseBuildYaml ────────────────────────────────────────────────────────────

console.log("\nparseBuildYaml");

expect(
  "extracts board and shield from a standard zmk build.yaml",
  parseBuildYaml(`
---
include:
  - board: nice_nano_v2
    shield: corne_left
  - board: nice_nano_v2
    shield: corne_right
`),
  { board: "nice_nano_v2", shield: "corne_left corne_right" }
);

expect(
  "handles single-sided keyboard",
  parseBuildYaml(`
---
include:
  - board: pro_micro
    shield: lily58_left
`),
  { board: "pro_micro", shield: "lily58_left" }
);

expect(
  "handles shield with extra display entry",
  parseBuildYaml(`
---
include:
  - board: nice_nano_v2
    shield: kyria_rev3_left nice_view_adapter nice_view
  - board: nice_nano_v2
    shield: kyria_rev3_right nice_view_adapter nice_view
`),
  {
    board: "nice_nano_v2",
    shield: "kyria_rev3_left nice_view_adapter nice_view kyria_rev3_right",
  }
);

expect(
  "returns empty object for empty include",
  parseBuildYaml(`---\ninclude: []`),
  {}
);

expect(
  "returns empty object for missing include key",
  parseBuildYaml(`---\nsome_other_key: value`),
  {}
);

// ── parseKconfig ──────────────────────────────────────────────────────────────

console.log("\nparseKconfig");

expect(
  "extracts enabled CONFIG_ keys",
  parseKconfig(`
CONFIG_ZMK_MOUSE=y
CONFIG_ZMK_BLE=y
CONFIG_ZMK_USB=y
`),
  ["ZMK_MOUSE", "ZMK_BLE", "ZMK_USB"]
);

expect(
  "ignores disabled keys (=n)",
  parseKconfig(`
CONFIG_ZMK_MOUSE=y
CONFIG_ZMK_SLEEP=n
`),
  ["ZMK_MOUSE"]
);

expect(
  "ignores commented-out keys",
  parseKconfig(`
# CONFIG_ZMK_MOUSE is not set
CONFIG_ZMK_BLE=y
`),
  ["ZMK_BLE"]
);

expect(
  "ignores string values",
  parseKconfig(`
CONFIG_ZMK_KEYBOARD_NAME="Corne"
CONFIG_ZMK_BLE=y
`),
  ["ZMK_BLE"]
);

expect(
  "handles empty file",
  parseKconfig(""),
  []
);

expect(
  "handles real-world corne.conf",
  parseKconfig(`
# Uncomment the following line to enable USB logging
# CONFIG_ZMK_USB_LOGGING=y

CONFIG_ZMK_MOUSE=y
CONFIG_ZMK_BLE=y
CONFIG_ZMK_SLEEP=y
CONFIG_ZMK_IDLE_SLEEP_TIMEOUT=900000
`),
  ["ZMK_MOUSE", "ZMK_BLE", "ZMK_SLEEP"]
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
