/**
 * Parses ZMK West config artifacts:
 *   west.yml  — YAML manifest (board, shield, zmk revision)
 *   *.conf    — Kconfig ini (enabled features)
 *   *.keymap  — locate path only, not parsed here
 *
 * Security notes:
 *   - Uses js-yaml DEFAULT_SCHEMA (v4 default) — never evaluates JS tags
 *   - All returned paths are validated by the caller
 *     before being stored; this module only parses, never reads arbitrary paths
 */

import * as yaml from "js-yaml";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedWestConfig {
  /** Shield name(s) extracted from build targets e.g. "corne_left corne_right" */
  shield?: string;
  /** Board name e.g. "nice_nano_v2" */
  board?: string;
  /** ZMK git revision (tag or SHA) from the zmk dependency entry */
  zmkRevision?: string;
}

// ── west.yml parser ───────────────────────────────────────────────────────────

/**
 * Extracts board, shield and ZMK revision from a west.yml manifest.
 *
 * West manifests vary in structure. We handle the two most common patterns:
 *
 * Pattern A — build.yaml (preferred by zmk-config template):
 *   The west.yml itself only lists the zmk dep; board/shield live in build.yaml.
 *   We return only zmkRevision here; ZmkConfigDetector reads build.yaml separately.
 *
 * Pattern B — projects with "zmk" as a dep, board/shield in zmk-config style:
 *   Same as A; shield/board come from build.yaml or user-provided info.
 */
export function parseWestYml(content: string): ParsedWestConfig {
  // SAFE_SCHEMA prevents !!js/function and similar code-execution tags
  const doc = yaml.load(content, { schema: yaml.DEFAULT_SCHEMA }) as any;

  let zmkRevision: string | undefined;
  let board: string | undefined;
  let shield: string | undefined;

  const allProjects: any[] = Array.isArray(doc?.manifest?.projects)
    ? doc.manifest.projects
    : [];

  for (const project of allProjects) {
    if (
      typeof project?.name === "string" &&
      project.name.toLowerCase() === "zmk"
    ) {
      if (typeof project.revision === "string") {
        zmkRevision = project.revision.trim();
      }
    }
  }

  return { shield, board, zmkRevision };
}

/**
 * Extracts board and shield from a build.yaml file.
 *
 * The zmk-config template generates build.yaml like:
 *
 *   ---
 *   include:
 *     - board: nice_nano_v2
 *       shield: corne_left
 *     - board: nice_nano_v2
 *       shield: corne_right
 */
export function parseBuildYaml(content: string): Pick<ParsedWestConfig, "board" | "shield"> {
  const doc = yaml.load(content, { schema: yaml.DEFAULT_SCHEMA }) as any;

  const include: any[] = Array.isArray(doc?.include) ? doc.include : [];
  if (include.length === 0) return {};

  // Collect unique boards and shields across all build targets
  const boards = new Set<string>();
  const shields = new Set<string>();

  for (const entry of include) {
    if (typeof entry?.board === "string") boards.add(entry.board.trim());
    if (typeof entry?.shield === "string") {
      // Shield may be "corne_left" or "corne_left corne_right" (split build)
      for (const s of entry.shield.trim().split(/\s+/)) {
        // Normalise: strip _left / _right suffixes to get the base shield name
        shields.add(s);
      }
    }
  }

  return {
    board: boards.size > 0 ? [...boards][0] : undefined,
    shield: shields.size > 0 ? [...shields].join(" ") : undefined,
  };
}

/**
 * Parses a Kconfig .conf file and returns enabled CONFIG_ keys (without the
 * CONFIG_ prefix, e.g. "ZMK_MOUSE", "ZMK_BLE").
 *
 * Format:  KEY=y  (enabled)  |  # KEY is not set  (disabled)
 *
 * Security: this is plain line-by-line text parsing — no eval, no shell.
 */
export function parseKconfig(content: string): string[] {
  const enabled: string[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^CONFIG_([A-Z0-9_]+)=y$/i);
    if (match) enabled.push(match[1].toUpperCase());
  }
  return enabled;
}
