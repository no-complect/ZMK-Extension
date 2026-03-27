import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log, logError } from "./logger";

type ConfigValues = Record<string, string | number | boolean>;

interface StoreData {
  configFilePath?: string;
  values: ConfigValues;
}

/**
 * Persists ZMK config values to a human-readable JSON file at:
 *   <globalStorageUri>/zmk-config.json
 *
 * Structure:
 * {
 *   "configFilePath": "/path/to/agar_ble.conf",   // optional linked .conf file
 *   "values": {
 *     "CONFIG_ZMK_HID_MOUSE_MOVE_MAX": 200,
 *     "CONFIG_ZMK_HID_MOUSE_SCROLL_MAX": 10
 *   }
 * }
 *
 * The values block maps directly to ZMK .conf syntax: KEY=value
 */
export class ZmkConfigStore {
  private readonly storePath: string;

  constructor(globalStorageUri: vscode.Uri) {
    fs.mkdirSync(globalStorageUri.fsPath, { recursive: true });
    this.storePath = path.join(globalStorageUri.fsPath, "zmk-config.json");
  }

  private read(): StoreData {
    try {
      return JSON.parse(fs.readFileSync(this.storePath, "utf-8")) as StoreData;
    } catch {
      return { values: {} };
    }
  }

  private write(data: StoreData): void {
    fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }

  getAll(): ConfigValues {
    return this.read().values;
  }

  getFilePath(): string | undefined {
    return this.read().configFilePath;
  }

  getStorePath(): string {
    return this.storePath;
  }

  async set(key: string, value: string | number | boolean): Promise<void> {
    const data = this.read();
    data.values[key] = value;
    this.write(data);
    await this.syncToFile(data.values, data.configFilePath);
  }

  /** Read a .conf file, merge its values as baseline, remember the path. */
  async linkFile(filePath: string): Promise<void> {
    const data = this.read();
    data.configFilePath = filePath;
    try {
      const fileValues = parseConfFile(fs.readFileSync(filePath, "utf-8"));
      // Existing store values win over file values
      data.values = { ...fileValues, ...data.values };
      log(`Config file linked: ${filePath} (${Object.keys(fileValues).length} values read)`);
    } catch (err) {
      logError("Failed to read config file", err);
    }
    this.write(data);
  }

  /** Write all stored values to a new file (creates or overwrites). */
  async exportToFile(filePath: string): Promise<void> {
    const values = this.getAll();
    const lines = Object.entries(values).map(([k, v]) => formatLine(k, v));
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
    log(`Config exported to ${filePath}`);
  }

  /** Update matching lines in the linked .conf file; append new ones. */
  private async syncToFile(values: ConfigValues, filePath: string | undefined): Promise<void> {
    if (!filePath) return;
    try {
      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
      const written = new Set<string>();
      const updated = existing.split("\n").map((line) => {
        const m = line.match(/^(CONFIG_\w+)=(.*)$/);
        if (m && m[1] in values) {
          written.add(m[1]);
          return formatLine(m[1], values[m[1]]);
        }
        return line;
      });
      for (const [k, v] of Object.entries(values)) {
        if (!written.has(k)) updated.push(formatLine(k, v));
      }
      fs.writeFileSync(filePath, updated.join("\n"), "utf-8");
    } catch (err) {
      logError("Failed to sync config to linked file", err);
    }
  }
}

function formatLine(key: string, value: string | number | boolean): string {
  if (value === true) return `${key}=y`;
  if (value === false) return `${key}=n`;
  return `${key}=${value}`;
}

function parseConfFile(content: string): ConfigValues {
  const result: ConfigValues = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^(CONFIG_\w+)=(.+)$/);
    if (!m) continue;
    const val = m[2].trim();
    if (val === "y" || val === "yes") result[m[1]] = true;
    else if (val === "n" || val === "no") result[m[1]] = false;
    else if (/^\d+$/.test(val)) result[m[1]] = parseInt(val, 10);
    else result[m[1]] = val;
  }
  return result;
}
