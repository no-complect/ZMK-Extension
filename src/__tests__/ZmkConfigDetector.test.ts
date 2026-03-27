/**
 * Integration test for ZmkConfigLoader filesystem logic.
 *
 * Uses the fixture at src/__tests__/fixtures/zmk-config-west/ to exercise
 * the local detection path without a VS Code window or a real keyboard.
 *
 * Run with:  npm run test:detector
 */

import * as path from "path";
import {
  scanForWestWorkspace,
  walkUpForWest,
  parseWestConfigIni,
  parseGitHubUrl,
  safeJoin,
} from "../ZmkConfigLoader";

const FIXTURE_ROOT = path.resolve(__dirname, "fixtures", "zmk-config-west");
const FIXTURE_WORKSPACE = FIXTURE_ROOT; // treat fixture root as the workspace folder

// ── Tiny assertion helper ─────────────────────────────────────────────────────

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

// ── Tests ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log("\nZmkConfigLoader — west workspace detection\n");
  console.log(`  fixture: ${FIXTURE_ROOT}\n`);

  // ── walkUpForWest ──────────────────────────────────────────────────────────

  console.log("walkUpForWest");

  const foundRoot = await walkUpForWest(FIXTURE_ROOT);
  expect("finds west root from the fixture directory", foundRoot, FIXTURE_ROOT);

  const foundFromChild = await walkUpForWest(
    path.join(FIXTURE_ROOT, "config", "config")
  );
  expect("finds west root walking up from a nested directory", foundFromChild, FIXTURE_ROOT);

  const notFound = await walkUpForWest(os.tmpdir());
  expect("returns undefined when no .west/config exists", notFound, undefined);

  // ── parseWestConfigIni ─────────────────────────────────────────────────────

  console.log("\nparseWestConfigIni");

  expect(
    "extracts manifest path",
    parseWestConfigIni("[manifest]\npath = config\nfile = west.yml\n"),
    "config"
  );

  expect(
    "handles whitespace around =",
    parseWestConfigIni("[manifest]\npath   =   my-config\n"),
    "my-config"
  );

  expect(
    "returns undefined when no manifest section",
    parseWestConfigIni("[zephyr]\nbase = zephyr\n"),
    undefined
  );

  expect(
    "stops reading after next section header",
    parseWestConfigIni("[manifest]\npath = config\n[other]\npath = other\n"),
    "config"
  );

  // ── safeJoin ───────────────────────────────────────────────────────────────

  console.log("\nsafeJoin (path traversal guard)");

  expect(
    "allows a normal sub-path",
    safeJoin("/home/user/zmk-config", "config"),
    "/home/user/zmk-config/config"
  );

  expect(
    "blocks traversal with ..",
    safeJoin("/home/user/zmk-config", "../../etc/passwd"),
    undefined
  );

  expect(
    "blocks traversal with absolute path",
    safeJoin("/home/user/zmk-config", "/etc/passwd"),
    undefined
  );

  // ── parseGitHubUrl ─────────────────────────────────────────────────────────

  console.log("\nparseGitHubUrl");

  expect(
    "parses a bare repo URL",
    parseGitHubUrl("https://github.com/owner/repo"),
    { owner: "owner", repo: "repo", ref: "main" }
  );

  expect(
    "parses a URL with a branch",
    parseGitHubUrl("https://github.com/owner/repo/tree/develop"),
    { owner: "owner", repo: "repo", ref: "develop" }
  );

  expect(
    "strips .git suffix",
    parseGitHubUrl("https://github.com/owner/repo.git"),
    { owner: "owner", repo: "repo", ref: "main" }
  );

  expect(
    "rejects non-github URLs",
    parseGitHubUrl("https://gitlab.com/owner/repo"),
    undefined
  );

  expect(
    "rejects internal network URLs",
    parseGitHubUrl("http://192.168.1.1/evil"),
    undefined
  );

  expect(
    "rejects malformed input",
    parseGitHubUrl("not a url"),
    undefined
  );

  // ── Full scan — end-to-end fixture detection ───────────────────────────────

  console.log("\nscanForWestWorkspace (full fixture scan)");

  const result = await scanForWestWorkspace(
    [FIXTURE_WORKSPACE],
    [FIXTURE_WORKSPACE]
  );

  if (!result) {
    console.error("  ✗  scanForWestWorkspace returned undefined — detection failed");
    failed++;
  } else {
    expect("configSource.kind is 'local'", result.configSource.kind, "local");
    expect(
      "configSource.root is the fixture root",
      (result.configSource as any).root,
      FIXTURE_ROOT
    );
    expect("board detected as nice_nano_v2", result.board, "nice_nano_v2");
    expect("shield detected (both halves)", result.shield, "corne_left corne_right");
    expect("zmkRevision detected as v3.5.0", result.zmkRevision, "v3.5.0");
    expect("ZMK_MOUSE feature detected", result.enabledFeatures.includes("ZMK_MOUSE"), true);
    expect("ZMK_BLE feature detected", result.enabledFeatures.includes("ZMK_BLE"), true);
    expect("ZMK_SLEEP feature detected", result.enabledFeatures.includes("ZMK_SLEEP"), true);
    expect("keymapPath is defined", result.keymapPath !== undefined, true);
    if (result.keymapPath) {
      expect(
        "keymapPath ends with corne.keymap",
        result.keymapPath.endsWith("corne.keymap"),
        true
      );
      expect(
        "keymapPath is inside the allowed root",
        result.keymapPath.startsWith(FIXTURE_ROOT),
        true
      );
    }
  }

  // Security: a path outside the allowed roots must not be returned as keymapPath
  console.log("\nSecurity: keymapPath boundary check");

  const resultOutsideRoot = await scanForWestWorkspace(
    [FIXTURE_WORKSPACE],
    ["/some/other/workspace"] // fixture is NOT in this allowed list
  );

  expect(
    "keymapPath is undefined when fixture is outside allowed roots",
    resultOutsideRoot?.keymapPath,
    undefined
  );
}

import * as os from "os";

run().then(() => {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}).catch((err) => {
  console.error("\nUnhandled error:", err);
  process.exit(1);
});
