/**
 * Extension-wide logger.
 * Writes to three places simultaneously:
 *   1. VS Code Output Channel "ZMK Studio" (visible in Output panel)
 *   2. A log file at <extensionStoragePath>/zmk-studio.log (readable from disk)
 *   3. console.log / console.error (visible in Extension Dev Host developer tools)
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

let outputChannel: vscode.OutputChannel | undefined;
let logFilePath: string | undefined;

export function initLogger(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("ZMK Studio");
  context.subscriptions.push(outputChannel);

  // storageUri is a per-extension writable directory VS Code manages
  const storageDir = context.storageUri?.fsPath ?? context.extensionPath;
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    logFilePath = path.join(storageDir, "zmk-studio.log");
    // Truncate on each activation so the file stays small
    fs.writeFileSync(logFilePath, `--- ZMK Studio log started ${new Date().toISOString()} ---\n`);
  } catch {
    // Storage dir unavailable — file logging silently disabled
  }

  log("Logger initialised");
  if (logFilePath) log(`Log file: ${logFilePath}`);
}

export function log(msg: string) {
  const line = `[${timestamp()}] ${msg}`;
  outputChannel?.appendLine(line);
  console.log(line);
  appendToFile(line);
}

export function logError(msg: string, err?: unknown) {
  const detail = err instanceof Error
    ? `${err.message}\n${err.stack ?? ""}`
    : err !== undefined ? String(err) : "";
  const line = `[${timestamp()}] ERROR: ${msg}${detail ? `\n${detail}` : ""}`;
  outputChannel?.appendLine(line);
  // Show the output panel automatically on errors
  outputChannel?.show(true);
  console.error(line);
  appendToFile(line);
}

export function getLogFilePath(): string | undefined {
  return logFilePath;
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function appendToFile(line: string) {
  if (!logFilePath) return;
  try {
    fs.appendFileSync(logFilePath, line + "\n");
  } catch {
    // Ignore write errors
  }
}
