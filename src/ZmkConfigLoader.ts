/**
 * Pure filesystem + network logic for loading ZMK West config.
 * No VS Code API dependency — fully testable outside the extension host.
 */

import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import * as https from "https";
import { parseBuildYaml, parseKconfig, parseWestYml } from "./ZmkConfigParser";

export type ConfigSource =
  | { kind: "local"; root: string }
  | { kind: "github"; url: string; owner: string; repo: string; ref: string };

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_WALK_DEPTH = 8;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_FETCH_BYTES = 512 * 1024;

/** Only these hosts are ever contacted for remote config fetch (SSRF guard) */
const ALLOWED_GITHUB_HOSTS = new Set([
  "raw.githubusercontent.com",
  "api.github.com",
]);

// ── Public result type ────────────────────────────────────────────────────────

export interface DetectedConfig {
  shield?: string;
  board?: string;
  zmkRevision?: string;
  keymapPath?: string;
  configSource: ConfigSource;
  enabledFeatures: string[];
}

// ── Workspace root search ─────────────────────────────────────────────────────

/**
 * Walks up from each path in `searchRoots` looking for a `.west/config` file.
 * Falls back to `~/.west/config` (global west install).
 *
 * @param searchRoots  Absolute paths to start from (e.g. VS Code workspace folders)
 * @param allowedRoots Paths that a resolved keymapPath must be inside (e.g. workspace folders)
 */
export async function scanForWestWorkspace(
  searchRoots: string[],
  allowedRoots: string[]
): Promise<DetectedConfig | undefined> {
  const candidates = [...searchRoots, os.homedir()];

  for (const root of candidates) {
    const westRoot = await walkUpForWest(root);
    if (westRoot) {
      return loadLocalConfig(westRoot, allowedRoots);
    }
  }
  return undefined;
}

export async function walkUpForWest(startDir: string): Promise<string | undefined> {
  let current = path.resolve(startDir);
  const fsRoot = path.parse(current).root;

  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    if (await fileExists(path.join(current, ".west", "config"))) return current;
    const parent = path.dirname(current);
    if (parent === current || current === fsRoot) break;
    current = parent;
  }
  return undefined;
}

// ── Local config loader ───────────────────────────────────────────────────────

/**
 * Loads config from a confirmed west workspace root.
 *
 * @param westRoot    Directory containing `.west/config`
 * @param allowedRoots Paths that a resolved keymapPath must be inside
 */
export async function loadLocalConfig(
  westRoot: string,
  allowedRoots: string[]
): Promise<DetectedConfig | undefined> {
  const westConfigContent = await readFileSafe(
    path.join(westRoot, ".west", "config")
  );
  if (!westConfigContent) return undefined;

  const manifestRelPath = parseWestConfigIni(westConfigContent);
  if (!manifestRelPath) return undefined;

  // Security: clamp manifest path to westRoot (path traversal guard)
  const manifestDir = safeJoin(westRoot, manifestRelPath);
  if (!manifestDir) return undefined;

  return loadFromManifestDir(manifestDir, westRoot, allowedRoots);
}

/**
 * Loads config when we have the manifest directory directly —
 * used when the user picks a folder that IS the manifest dir.
 */
export async function loadFromManifestDir(
  manifestDir: string,
  allowedRoot: string,
  allowedRoots: string[]
): Promise<DetectedConfig | undefined> {
  const [westYmlContent, buildYamlContent] = await Promise.all([
    readFileSafe(path.join(manifestDir, "west.yml")),
    readFileSafe(path.join(manifestDir, "build.yaml")),
  ]);

  if (!westYmlContent && !buildYamlContent) return undefined;

  const westParsed = westYmlContent ? parseWestYml(westYmlContent) : {};
  const buildParsed = buildYamlContent ? parseBuildYaml(buildYamlContent) : {};

  const shield = buildParsed.shield ?? westParsed.shield;
  const configDir = path.join(manifestDir, "config");

  const { enabledFeatures } = await loadKconfig(configDir, shield);
  const keymapPath = await findKeymapPath(configDir, shield, allowedRoots);

  return {
    shield,
    board: buildParsed.board ?? westParsed.board,
    zmkRevision: westParsed.zmkRevision,
    keymapPath,
    enabledFeatures,
    configSource: { kind: "local", root: allowedRoot },
  };
}

// ── GitHub remote loader ──────────────────────────────────────────────────────

/**
 * Parses a GitHub repo URL in these forms:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/main
 */
export function parseGitHubUrl(
  input: string
): { owner: string; repo: string; ref: string } | undefined {
  try {
    const u = new URL(input.trim());
    if (u.hostname !== "github.com") return undefined;
    const parts = u.pathname.replace(/^\//, "").split("/");
    if (parts.length < 2) return undefined;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/, "");
    const ref = parts[3] ?? "main";
    return { owner, repo, ref };
  } catch {
    return undefined;
  }
}

export async function loadGitHubConfig(
  owner: string,
  repo: string,
  ref: string
): Promise<DetectedConfig | undefined> {
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}`;

  const [westYml, buildYaml] = await Promise.all([
    fetchText(`${base}/west.yml`),
    fetchText(`${base}/build.yaml`),
  ]);

  if (!westYml && !buildYaml) return undefined;

  const westParsed = westYml ? parseWestYml(westYml) : {};
  const buildParsed = buildYaml ? parseBuildYaml(buildYaml) : {};

  const shield = buildParsed.shield ?? westParsed.shield;
  const base2 = shield?.split(/\s+/)[0]
    .replace(/_left|_right|_central|_peripheral/, "");

  const confContent = base2
    ? await fetchText(`${base}/config/${base2}.conf`)
    : undefined;

  return {
    shield,
    board: buildParsed.board ?? westParsed.board,
    zmkRevision: westParsed.zmkRevision,
    keymapPath: undefined,
    enabledFeatures: confContent ? parseKconfig(confContent) : [],
    configSource: { kind: "github", url: `https://github.com/${owner}/${repo}`, owner, repo, ref },
  };
}

// ── Kconfig + keymap helpers ──────────────────────────────────────────────────

async function loadKconfig(
  configDir: string,
  shield?: string
): Promise<{ enabledFeatures: string[] }> {
  const candidates: string[] = [];

  if (shield) {
    const base = shield.split(/\s+/)[0]
      .replace(/_left|_right|_central|_peripheral/, "");
    candidates.push(path.join(configDir, `${base}.conf`));
    candidates.push(path.join(configDir, `${shield.split(/\s+/)[0]}.conf`));
  }

  try {
    const entries = await fs.readdir(configDir);
    for (const entry of entries) {
      if (entry.endsWith(".conf")) candidates.push(path.join(configDir, entry));
    }
  } catch { /* configDir may not exist */ }

  for (const p of candidates) {
    const content = await readFileSafe(p);
    if (content) return { enabledFeatures: parseKconfig(content) };
  }
  return { enabledFeatures: [] };
}

async function findKeymapPath(
  configDir: string,
  shield: string | undefined,
  allowedRoots: string[]
): Promise<string | undefined> {
  const candidates: string[] = [];

  if (shield) {
    const base = shield.split(/\s+/)[0]
      .replace(/_left|_right|_central|_peripheral/, "");
    candidates.push(path.join(configDir, `${base}.keymap`));
    candidates.push(path.join(configDir, `${shield.split(/\s+/)[0]}.keymap`));
  }

  try {
    const entries = await fs.readdir(configDir);
    for (const entry of entries) {
      if (entry.endsWith(".keymap")) candidates.push(path.join(configDir, entry));
    }
  } catch { /* configDir may not exist */ }

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      // Security: only return paths that are inside an allowed root
      return isInsideRoots(candidate, allowedRoots) ? candidate : undefined;
    }
  }
  return undefined;
}

// ── INI parser ────────────────────────────────────────────────────────────────

export function parseWestConfigIni(content: string): string | undefined {
  let inManifest = false;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "[manifest]") { inManifest = true; continue; }
    if (line.startsWith("[")) { inManifest = false; continue; }
    if (inManifest) {
      const match = line.match(/^path\s*=\s*(.+)$/);
      if (match) return match[1].trim();
    }
  }
  return undefined;
}

// ── Security helpers ──────────────────────────────────────────────────────────

/**
 * Safely joins `root` and `rel`, returning `undefined` if the result escapes
 * `root` (path traversal guard).
 */
export function safeJoin(root: string, rel: string): string | undefined {
  const resolved = path.resolve(root, rel);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return undefined;
  return resolved;
}

function isInsideRoots(filePath: string, roots: string[]): boolean {
  return roots.some((r) => filePath.startsWith(r + path.sep) || filePath === r);
}

// ── Low-level I/O ─────────────────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readFileSafe(p: string): Promise<string | undefined> {
  try { return await fs.readFile(p, "utf8"); } catch { return undefined; }
}

/**
 * Fetches text from a whitelisted GitHub host.
 * Enforces: HTTPS only, host whitelist, timeout, max response size.
 */
export function fetchText(url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { resolve(undefined); return; }

    if (!ALLOWED_GITHUB_HOSTS.has(parsed.hostname) || parsed.protocol !== "https:") {
      resolve(undefined);
      return;
    }

    const req = https.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(undefined); return; }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      res.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_FETCH_BYTES) { req.destroy(); resolve(undefined); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", () => resolve(undefined));
    });

    req.on("timeout", () => { req.destroy(); resolve(undefined); });
    req.on("error", () => resolve(undefined));
  });
}
