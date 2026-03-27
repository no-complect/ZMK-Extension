import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { connectSerial, listZMKSerialPorts } from "./transport/SerialTransport";
import { connectCoreBluetooth } from "./transport/CoreBluetoothTransport";
import { MessageBridge } from "./transport/MessageBridge";
import { ZmkConfigStore } from "./ZmkConfigStore";
import { walkUpForWest, loadLocalConfig } from "./ZmkConfigLoader";
import { log, logError } from "./logger";
import type { ExportedKeymap } from "../shared/messages";

const WEST_WORKSPACE_KEY = "zmkWestWorkspacePath";
const CACHED_BOARD_KEY = "zmkCachedBoard";
const CACHED_SHIELD_KEY = "zmkCachedShield";

export class KeyboardPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "zmk-studio.keyboardPanel";

  private view?: vscode.WebviewView;
  private bridge?: MessageBridge;
  readonly configStore: ZmkConfigStore;

  /** Resolves when resolveWebviewView has been called for the first time */
  private _viewReady: Promise<void>;
  private _resolveViewReady!: () => void;

  /** Pending keymap export — resolved when the webview responds with keymapExportData */
  private _exportResolve?: (data: ExportedKeymap | undefined) => void;
  private _exportTimeout?: ReturnType<typeof setTimeout>;

  /** True when config values have changed since the last Save to Flash */
  private _configChangedSinceLastSave = false;

  /** Output channel for firmware rebuild instructions */
  private _rebuildOutput?: vscode.OutputChannel;

  /** Last known device name — populated from keymap export data */
  private _lastDeviceName?: string;

  constructor(
    private readonly context: vscode.ExtensionContext
  ) {
    this.configStore = new ZmkConfigStore(context.globalStorageUri);
    this._viewReady = new Promise<void>((resolve) => {
      this._resolveViewReady = resolve;
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    log("resolveWebviewView called — WebView panel is opening");
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);
    this.bridge = new MessageBridge(webviewView.webview);
    this._resolveViewReady();

    // Handle messages originating from the WebView UI
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "requestDeviceList") {
        const ports = await listZMKSerialPorts();
        webviewView.webview.postMessage({
          type: "deviceList",
          devices: ports.map((p) => ({ label: p.path, path: p.path })),
        });
      }
      if (msg.type === "connectUSB") {
        await this.connectViaUSB(msg.path);
      }
      if (msg.type === "connectBLE") {
        await this.connectViaBLE();
      }
      if (msg.type === "getConfig") {
        webviewView.webview.postMessage({
          type: "configSnapshot",
          values: this.configStore.getAll(),
          hasFile: !!this.configStore.getFilePath(),
        });
      }
      if (msg.type === "setConfigValue") {
        await this.configStore.set(msg.key, msg.value);
        this._configChangedSinceLastSave = true;
      }
      if (msg.type === "savedToFlash") {
        if (this._configChangedSinceLastSave) {
          this._configChangedSinceLastSave = false;
          await this.showRebuildNotification();
        }
      }
      if (msg.type === "buildFirmware") {
        try {
          await this.triggerBuildFirmware();
        } catch (err) {
          logError("triggerBuildFirmware (webview button) threw", err);
        }
      }
      if (msg.type === "openKeymapsFolder") {
        const deviceName = this._lastDeviceName ?? "keyboard";
        const dir = await this.getKeymapsDir(deviceName);
        if (dir) {
          fs.mkdirSync(dir, { recursive: true });
          vscode.env.openExternal(vscode.Uri.file(dir));
        } else {
          const fallback = await this.getDefaultDir();
          vscode.env.openExternal(fallback);
        }
      }
      if (msg.type === "keymapExportData") {
        if (this._exportResolve) {
          // Host-initiated export (via VS Code command) — hand data back to caller
          clearTimeout(this._exportTimeout);
          this._exportResolve(msg.data);
          this._exportResolve = undefined;
        } else {
          // Webview-initiated export (toolbar button) — show save dialog directly
          this.saveExportedKeymap(msg.data);
        }
      }
      if (msg.type === "requestExportConfig") {
        await this.exportConfigAuto();
      }
      if (msg.type === "importKeymapResult") {
        if (msg.success) {
          vscode.window.showInformationMessage("Keymap imported successfully.");
        } else {
          vscode.window.showErrorMessage(`Keymap import failed: ${msg.error ?? "unknown error"}`);
        }
      }
      if (msg.type === "requestImportKeymap") {
        await this.importKeymapFromFile();
      }
    });
  }

  /** Focus the sidebar panel and wait for the webview to initialize. Returns false if it failed. */
  private async ensureViewReady(): Promise<boolean> {
    await vscode.commands.executeCommand("workbench.action.focusSideBar");
    await vscode.commands.executeCommand("workbench.view.extension.zmk-studio");
    await vscode.commands.executeCommand(`${KeyboardPanelProvider.viewId}.focus`);
    await this._viewReady;
    if (!this.view || !this.bridge) {
      vscode.window.showErrorMessage("ZMK Studio panel failed to initialize.");
      return false;
    }
    return true;
  }

  /** Ask the webview to serialise its current keymap and return it. Times out after 8 s. */
  async requestKeymapExport(): Promise<ExportedKeymap | undefined> {
    if (!this.view) {
      vscode.window.showErrorMessage("Open the ZMK Studio panel and connect a keyboard first.");
      return undefined;
    }
    return new Promise<ExportedKeymap | undefined>((resolve) => {
      if (this._exportResolve) {
        clearTimeout(this._exportTimeout);
        this._exportResolve(undefined);
      }
      this._exportResolve = resolve;
      this._exportTimeout = setTimeout(() => {
        this._exportResolve?.(undefined);
        this._exportResolve = undefined;
      }, 8_000);
      this.view!.webview.postMessage({ type: "requestKeymapExport" });
    });
  }

  /** Send an imported keymap to the webview to be applied to the keyboard. */
  sendImportKeymap(data: ExportedKeymap): void {
    if (!this.view) {
      vscode.window.showErrorMessage("Open the ZMK Studio panel and connect a keyboard first.");
      return;
    }
    this.view.webview.postMessage({ type: "importKeymap", data });
  }

  /**
   * Returns the `keymaps/<device>/` directory, resolved via:
   *   1. Linked .conf file → <zmk-config-root>/keymaps/<device>/
   *   2. West workspace detected keymap path → <zmk-config-root>/keymaps/<device>/
   *   3. First VS Code workspace folder → <folder>/keymaps/<device>/
   */
  private async getKeymapsDir(deviceName: string): Promise<string | undefined> {
    const safeName = deviceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "keyboard";

    const linked = this.configStore.getFilePath();
    if (linked) {
      const zmkConfigRoot = path.dirname(path.dirname(linked));
      return path.join(zmkConfigRoot, "keymaps", safeName);
    }

    const westRoot = this.context.globalState.get<string>(WEST_WORKSPACE_KEY);
    if (westRoot && fs.existsSync(path.join(westRoot, ".west", "config"))) {
      const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const detected = await loadLocalConfig(westRoot, workspacePaths);
      if (detected?.keymapPath) {
        // keymapPath = <zmk-config-root>/config/<name>.keymap  →  two levels up = root
        const zmkConfigRoot = path.dirname(path.dirname(detected.keymapPath));
        return path.join(zmkConfigRoot, "keymaps", safeName);
      }
    }

    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return path.join(folders[0].uri.fsPath, "keymaps", safeName);
    }

    return undefined;
  }

  /** Save an exported keymap — auto-saves to keymaps/<device>/ when config root is known. */
  async saveExportedKeymap(data: ExportedKeymap): Promise<void> {
    if (data.deviceName) this._lastDeviceName = data.deviceName;

    const deviceName = data.deviceName ?? "keyboard";
    const keymapsDir = await this.getKeymapsDir(deviceName);

    if (keymapsDir) {
      fs.mkdirSync(keymapsDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const safeName = deviceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

      // Save .zmkmap snapshot
      const zmkmapPath = path.join(keymapsDir, `${safeName}-${date}.zmkmap`);
      fs.writeFileSync(zmkmapPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
      log(`Keymap snapshot exported to ${zmkmapPath}`);

      // Save .keymap devicetree source if generated
      let keymapFilePath: string | undefined;
      if (data.keymapSource) {
        keymapFilePath = path.join(keymapsDir, `${safeName}.keymap`);
        fs.writeFileSync(keymapFilePath, data.keymapSource, "utf-8");
        log(`ZMK keymap source exported to ${keymapFilePath}`);
      }

      const displayFile = keymapFilePath
        ? `${path.basename(keymapFilePath)} + ${path.basename(zmkmapPath)}`
        : path.basename(zmkmapPath);

      const action = await vscode.window.showInformationMessage(
        `Keymap saved to keymaps/${path.basename(keymapsDir)}/${displayFile}`,
        "Show in Finder"
      );
      if (action === "Show in Finder") {
        vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(keymapFilePath ?? zmkmapPath));
      }
      return;
    }

    // Fallback: show save dialog when config root is unknown
    const defaultName = deviceName.toLowerCase().replace(/\s+/g, "-");
    const uri = await vscode.window.showSaveDialog({
      filters: { "ZMK Studio Keymap": ["zmkmap"] },
      title: "Export Keymap",
      defaultUri: vscode.Uri.joinPath(await this.getDefaultDir(), `${defaultName}.zmkmap`),
    });
    if (!uri) return;
    fs.writeFileSync(uri.fsPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    log(`Keymap exported to ${uri.fsPath}`);
    vscode.window.showInformationMessage(`Keymap exported to ${uri.fsPath}`);
  }

  /** Show a file picker and send the chosen keymap to the webview. */
  async importKeymapFromFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "ZMK Studio Keymap": ["zmkmap"] },
      title: "Import Keymap",
      defaultUri: await this.getDefaultDir(),
    });
    if (!uris || uris.length === 0) return;

    let data: ExportedKeymap;
    try {
      data = JSON.parse(fs.readFileSync(uris[0].fsPath, "utf-8")) as ExportedKeymap;
    } catch {
      vscode.window.showErrorMessage("Failed to read keymap file. Make sure it is a valid .zmkmap file.");
      return;
    }
    if (data.version !== 1 || !Array.isArray(data.layers)) {
      vscode.window.showErrorMessage("Unrecognised keymap format.");
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Import "${uris[0].fsPath.split("/").pop()}" and overwrite the current keymap? This cannot be undone.`,
      { modal: true },
      "Import"
    );
    if (confirm !== "Import") return;

    this.sendImportKeymap(data);
  }

  /**
   * After a Save to Flash that included config changes, find (or prompt for) the
   * west workspace, construct the `west build` command, and offer to run it.
   */
  private async showRebuildNotification(): Promise<void> {
    const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

    const westRoot = await this.resolveWestWorkspace();

    // Load board/shield from the workspace manifest (best-effort)
    const detected = westRoot ? await loadLocalConfig(westRoot, workspacePaths) : undefined;

    const linkedConf = this.configStore.getFilePath();
    let configDir: string | undefined;
    if (linkedConf) {
      configDir = path.dirname(linkedConf);
    } else if (detected?.keymapPath) {
      configDir = path.dirname(detected.keymapPath);
    }

    // Build the west build command
    const parts: string[] = ["west build"];
    if (detected?.board) parts.push(`-b ${detected.board}`);
    parts.push("zmk/app");
    const cmakeArgs: string[] = [];
    if (detected?.shield) cmakeArgs.push(`-DSHIELD=${detected.shield}`);
    if (configDir) cmakeArgs.push(`-DZMK_CONFIG=${configDir}`);
    if (cmakeArgs.length > 0) parts.push("--", ...cmakeArgs);
    const command = parts.join(" ");

    // Write to output channel
    if (!this._rebuildOutput) {
      this._rebuildOutput = vscode.window.createOutputChannel("ZMK Studio — Rebuild");
    }
    const out = this._rebuildOutput;
    out.clear();
    out.appendLine("─────────────────────────────────────────────────────────────");
    out.appendLine("  Config changes saved. Rebuild firmware to apply them.");
    out.appendLine("─────────────────────────────────────────────────────────────");
    out.appendLine("");
    out.appendLine(westRoot ? `  cd ${westRoot}` : "  # cd to your west workspace root first");
    out.appendLine(`  ${command}`);
    out.appendLine("");
    if (detected?.board) {
      const uf2Base = detected.shield?.split(/\s+/)[0] ?? detected.board;
      out.appendLine(`  Output: build/zephyr/${uf2Base}-${detected.board}-zmk.uf2`);
    } else {
      out.appendLine("  Output: build/zephyr/<shield>-<board>-zmk.uf2");
    }
    out.appendLine("");
    out.show(true);

    // Toast — offer "Build Firmware" when we have a workspace
    const toastMsg = linkedConf
      ? `Config saved to ${path.basename(linkedConf)}. Rebuild firmware to apply.`
      : "Config saved. Rebuild firmware to apply changes.";

    const actions = westRoot
      ? (["Build Firmware", "Copy command", "Dismiss"] as const)
      : (["Copy command", "Dismiss"] as const);

    const action = await vscode.window.showInformationMessage(toastMsg, ...actions);

    if (action === "Build Firmware" && westRoot) {
      await this.buildFirmware(westRoot, command, detected?.board, detected?.shield, configDir);
    } else if (action === "Copy command") {
      const full = westRoot ? `cd "${westRoot}" && ${command}` : command;
      await vscode.env.clipboard.writeText(full);
      vscode.window.showInformationMessage("Command copied to clipboard.");
    }
  }

  /**
   * Runs pre-flight checks, writes results to the output channel, then either
   * opens the build terminal (all clear / user confirms warnings) or aborts.
   */
  private async buildFirmware(
    westRoot: string,
    command: string,
    board: string | undefined,
    shield: string | undefined,
    configDir: string | undefined,
  ): Promise<void> {
    const out = this._rebuildOutput!;

    out.appendLine("── Pre-flight checks ────────────────────────────────────────");
    out.appendLine("");

    type CheckStatus = "ok" | "warn" | "error";
    const checks: Array<{ label: string; status: CheckStatus; detail?: string }> = [];

    const check = (label: string, status: CheckStatus, detail?: string) => {
      checks.push({ label, status, detail });
      const icon = status === "ok" ? "✓" : status === "warn" ? "⚠" : "✗";
      out.appendLine(`  ${icon}  ${label}${detail ? `\n       ${detail}` : ""}`);
    };

    // 1. ZMK source present
    const zmkApp = path.join(westRoot, "zmk", "app");
    if (fs.existsSync(path.join(zmkApp, "CMakeLists.txt"))) {
      check("ZMK source", "ok", zmkApp);
    } else {
      check("ZMK source", "error",
        `${zmkApp} not found — run "west update" in the workspace first`);
    }

    // 2. Zephyr present
    const zephyrDir = path.join(westRoot, "zephyr");
    if (fs.existsSync(path.join(zephyrDir, "CMakeLists.txt"))) {
      check("Zephyr source", "ok", zephyrDir);
    } else {
      check("Zephyr source", "error",
        `${zephyrDir} not found — run "west update" in the workspace first`);
    }

    // 3. Board specified
    if (board) {
      check("Board", "ok", board);
    } else {
      check("Board", "warn",
        "No board specified — the build command will be missing -b <board>");
    }

    // 4. Unlinked config values — these won't make it into the build
    const storeValues = this.configStore.getAll();
    const hasStoredValues = Object.keys(storeValues).length > 0;
    if (hasStoredValues && !this.configStore.getFilePath()) {
      check("Config values",  "warn",
        "Config values are saved internally but not linked to a .conf file. " +
        "Run \"ZMK: Export Configuration File\" then \"ZMK: Select Configuration File\" " +
        "so these values are included in the firmware build.");
    }

    // 5. Config directory
    if (configDir) {
      if (fs.existsSync(configDir)) {
        check("Config directory", "ok", configDir);
      } else {
        check("Config directory", "error",
          `${configDir} does not exist — check your linked .conf file path`);
      }
    } else {
      check("Config directory", "warn",
        "No -DZMK_CONFIG path detected; ZMK will use its built-in defaults");
    }

    // 5. Keymap file
    if (configDir && fs.existsSync(configDir)) {
      const shieldBase = shield?.split(/\s+/)[0]?.replace(/_left|_right|_central|_peripheral/, "");
      const keymapCandidates = [
        shieldBase && path.join(configDir, `${shieldBase}.keymap`),
        shield && path.join(configDir, `${shield.split(/\s+/)[0]}.keymap`),
      ].filter(Boolean) as string[];

      // Also scan directory for any .keymap file
      let foundKeymap: string | undefined;
      for (const p of keymapCandidates) {
        if (fs.existsSync(p)) { foundKeymap = p; break; }
      }
      if (!foundKeymap) {
        try {
          const entry = fs.readdirSync(configDir).find((f) => f.endsWith(".keymap"));
          if (entry) foundKeymap = path.join(configDir, entry);
        } catch { /* ignore */ }
      }

      if (foundKeymap) {
        check("Keymap file", "ok", foundKeymap);
      } else {
        check("Keymap file", "error",
          `No .keymap file found in ${configDir}`);
      }

      // 6. Conf file (warning only — ZMK can build without it)
      const shieldConf = shieldBase && path.join(configDir, `${shieldBase}.conf`);
      const hasConf = (shieldConf && fs.existsSync(shieldConf))
        || fs.readdirSync(configDir).some((f) => f.endsWith(".conf"));
      if (hasConf) {
        const confFile = (shieldConf && fs.existsSync(shieldConf))
          ? shieldConf
          : path.join(configDir, fs.readdirSync(configDir).find((f) => f.endsWith(".conf"))!);
        check("Config (.conf) file", "ok", confFile);
      } else {
        check("Config (.conf) file", "warn",
          "No .conf file found — ZMK will use firmware defaults for all config values");
      }
    }

    out.appendLine("");

    const hasErrors = checks.some((c) => c.status === "error");
    const hasWarnings = checks.some((c) => c.status === "warn");

    if (hasErrors) {
      out.appendLine("  Build blocked: fix the errors above, then Save to Flash again.");
      out.appendLine("");
      vscode.window.showErrorMessage(
        "Pre-flight checks failed. See ZMK Studio — Rebuild for details.",
        "Show Output"
      ).then((a) => { if (a === "Show Output") out.show(true); });
      return;
    }

    if (hasWarnings) {
      const proceed = await vscode.window.showWarningMessage(
        "Some pre-flight checks have warnings. Build anyway?",
        "Build Anyway",
        "Cancel"
      );
      if (proceed !== "Build Anyway") return;
    }

    out.appendLine("── Running build ─────────────────────────────────────────────");
    out.appendLine("");
    out.appendLine(`  cd "${westRoot}"`);
    out.appendLine(`  ${command}`);
    out.appendLine("");

    const terminal = vscode.window.createTerminal("ZMK Firmware Build");
    terminal.show();
    terminal.sendText(`cd "${westRoot}"`);
    terminal.sendText(command);

    // After the terminal build completes, copy the .uf2 to keymaps/<device>/
    const uf2Source = path.join(westRoot, "build", "zephyr", "zmk.uf2");
    const deviceName = this._lastDeviceName ?? board ?? "keyboard";
    const keymapsDir = await this.getKeymapsDir(deviceName);

    if (keymapsDir) {
      const uf2Dest = path.join(keymapsDir, "zmk.uf2");
      const POLL_MS = 5_000;
      const TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
      let elapsed = 0;

      const poll = setInterval(() => {
        elapsed += POLL_MS;
        if (fs.existsSync(uf2Source)) {
          clearInterval(poll);
          try {
            fs.mkdirSync(keymapsDir, { recursive: true });
            fs.copyFileSync(uf2Source, uf2Dest);
            log(`Firmware copied to ${uf2Dest}`);
            vscode.window.showInformationMessage(
              `Firmware built and saved to keymaps/${path.basename(keymapsDir)}/zmk.uf2`,
              "Show in Finder"
            ).then((action) => {
              if (action === "Show in Finder") {
                vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(uf2Dest));
              }
            });
          } catch (err) {
            logError("Failed to copy firmware", err);
          }
        } else if (elapsed >= TIMEOUT_MS) {
          clearInterval(poll);
          log("Firmware poll timed out — build may have failed or taken too long");
        }
      }, POLL_MS);
    }
  }

  /**
   * Returns the west workspace path, using (in order):
   *   1. Cached globalState value
   *   2. Auto-search of common filesystem locations
   *   3. User prompt (select existing or initialize new)
   */
  private async resolveWestWorkspace(): Promise<string | undefined> {
    const cached = this.context.globalState.get<string>(WEST_WORKSPACE_KEY);
    if (cached && fs.existsSync(path.join(cached, ".west", "config"))) {
      log(`West workspace (cached): ${cached}`);
      return cached;
    }

    const found = await this.searchForWestWorkspace();
    if (found) {
      log(`West workspace (auto-detected): ${found}`);
      await this.context.globalState.update(WEST_WORKSPACE_KEY, found);
      return found;
    }

    return this.promptForWestWorkspace();
  }

  /** Searches common filesystem locations for a west workspace (.west/config). */
  private async searchForWestWorkspace(): Promise<string | undefined> {
    const home = os.homedir();
    const vscodeRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

    // Named candidates: check directly and walk up (catches workspace-inside-workspace)
    // Also check well-known subdirectory names inside each VS Code workspace folder
    // (e.g. a "west-workspace/" folder created by `npm run setup:west` inside the repo)
    const westSubdirNames = ["west-workspace", "zmk-workspace", "workspace"];
    const vscodeSubdirs = vscodeRoots.flatMap((r) =>
      westSubdirNames.map((s) => path.join(r, s))
    );

    const named = [
      ...vscodeRoots,
      ...vscodeSubdirs,
      path.join(home, "zephyr-workspace"),
      path.join(home, "zmk-workspace"),
      path.join(home, "zmk"),
      path.join(home, "west"),
      path.join(home, "zephyr"),
      path.join(home, "projects", "zmk"),
      path.join(home, "projects", "zephyr"),
      path.join(home, "dev", "zmk"),
    ];

    for (const candidate of named) {
      if (fs.existsSync(path.join(candidate, ".west", "config"))) return candidate;
      const found = await walkUpForWest(candidate);
      if (found) return found;
    }

    // Broad search: any direct subdirectory of home that has .west/config
    try {
      const entries = await fs.promises.readdir(home, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(home, entry.name);
        if (fs.existsSync(path.join(dir, ".west", "config"))) return dir;
      }
    } catch { /* ignore */ }

    return undefined;
  }

  /** Returns the path to the `west` executable, or undefined if not found. */
  private westPath(): string | undefined {
    try {
      const result = execSync("which west", { encoding: "utf8" }).trim();
      return result || undefined;
    } catch {
      return undefined;
    }
  }

  /** Prompts the user to select an existing workspace or initialize a new one. */
  private async promptForWestWorkspace(): Promise<string | undefined> {
    const westAvailable = !!this.westPath();
    const defaultAutoDir = path.join(os.homedir(), "zmk-workspace");

    type ChoiceValue = "auto" | "select" | "init";
    const items: { label: string; description: string; value: ChoiceValue }[] = [];

    if (westAvailable) {
      items.push({
        label: "$(rocket) Auto-setup ZMK workspace",
        description: `Runs west init + west update at ~/zmk-workspace (~2 GB download)`,
        value: "auto",
      });
    }
    items.push({
      label: "$(folder-opened) Select existing west workspace",
      description: "Point to a folder that already has .west/config",
      value: "select",
    });
    items.push({
      label: "$(terminal) Initialize manually",
      description: westAvailable
        ? "Choose a custom location and run west in a terminal"
        : "west not found in PATH — install west first, then re-run",
      value: "init",
    });

    const choice = await vscode.window.showQuickPick(items, {
      placeHolder: "No west workspace found. How would you like to set one up?",
    });

    if (!choice) return undefined;

    // Auto-setup: use ~/zmk-workspace, no folder picker needed
    if (choice.value === "auto") {
      const targetDir = defaultAutoDir;
      await this.context.globalState.update(WEST_WORKSPACE_KEY, targetDir);
      this.runWestInitInTerminal(targetDir);
      vscode.window.showInformationMessage(
        "Setting up ZMK workspace at ~/zmk-workspace (~2 GB). Build Firmware again once it completes."
      );
      return undefined; // not ready until west update finishes
    }

    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: choice.value === "select" ? "Use this workspace" : "Initialize workspace here",
    });
    if (!uris || uris.length === 0) return undefined;
    const targetDir = uris[0].fsPath;

    if (choice.value === "select") {
      if (!fs.existsSync(path.join(targetDir, ".west", "config"))) {
        vscode.window.showWarningMessage(
          `No .west/config found in the selected folder. ` +
          `Make sure this is the root of an initialized west workspace.`
        );
      }
      await this.context.globalState.update(WEST_WORKSPACE_KEY, targetDir);
      return targetDir;
    }

    await this.context.globalState.update(WEST_WORKSPACE_KEY, targetDir);
    this.runWestInitInTerminal(targetDir);
    vscode.window.showInformationMessage(
      "Initializing ZMK workspace in the terminal (~2 GB). Build Firmware again once it completes."
    );
    return undefined; // workspace not ready until init + update finish
  }

  /** Opens a terminal and runs west init + west update for the given target directory. */
  private async runWestInitInTerminal(targetDir: string): Promise<void> {
    const linkedConf = this.configStore.getFilePath();
    const zmkConfigDir = linkedConf ? path.dirname(path.dirname(linkedConf)) : undefined;
    const useLocalManifest = zmkConfigDir && fs.existsSync(zmkConfigDir);

    const terminal = vscode.window.createTerminal("ZMK Workspace Setup");
    terminal.show();

    const validWorkspace = await walkUpForWest(targetDir);
    const brokenWest = !validWorkspace && fs.existsSync(path.join(targetDir, ".west"));

    if (validWorkspace) {
      terminal.sendText(`cd "${targetDir}" && west update`);
    } else {
      if (brokenWest) {
        terminal.sendText(`rm -rf "${path.join(targetDir, ".west")}"`);
      }
      if (useLocalManifest) {
        terminal.sendText(`west init -l "${zmkConfigDir}" "${targetDir}" && cd "${targetDir}" && west update`);
      } else {
        terminal.sendText(`west init -m https://github.com/zmkfirmware/zmk --mr main --mf app/west.yml "${targetDir}" && cd "${targetDir}" && west update`);
      }
    }
  }

  /**
   * Build firmware now — available from the command palette at any time.
   * Resolves the west workspace, loads board/shield config, runs pre-flight checks,
   * then opens a build terminal.
   */
  public async triggerBuildFirmware(): Promise<void> {
    const westRoot = await this.resolveWestWorkspace();
    if (!westRoot) return; // user cancelled or init in progress

    const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const detected = await loadLocalConfig(westRoot, workspacePaths);

    // If build.yaml/west.yml didn't provide a board, fall back to cached value or prompt.
    let board = detected?.board;
    let shield = detected?.shield;

    if (!board) {
      const cachedBoard = this.context.globalState.get<string>(CACHED_BOARD_KEY);
      const cachedShield = this.context.globalState.get<string>(CACHED_SHIELD_KEY);

      const enteredBoard = await vscode.window.showInputBox({
        title: "ZMK Board Identifier",
        prompt: "Enter the Zephyr board identifier for your keyboard (e.g. nice_nano_v2, seeeduino_xiao_ble)",
        value: cachedBoard ?? "",
        placeHolder: "nice_nano_v2",
        ignoreFocusOut: true,
      });
      if (enteredBoard === undefined) return; // user cancelled
      board = enteredBoard.trim() || undefined;
      if (board) {
        await this.context.globalState.update(CACHED_BOARD_KEY, board);
      }

      if (!shield && cachedShield) {
        shield = cachedShield;
      } else if (!shield) {
        const enteredShield = await vscode.window.showInputBox({
          title: "ZMK Shield (optional)",
          prompt: "Enter the shield name if your keyboard uses one (leave blank for integrated boards)",
          value: cachedShield ?? "",
          placeHolder: "corne_left corne_right",
          ignoreFocusOut: true,
        });
        if (enteredShield === undefined) return; // user cancelled
        shield = enteredShield.trim() || undefined;
        await this.context.globalState.update(CACHED_SHIELD_KEY, shield ?? "");
      }
    }

    const linkedConf = this.configStore.getFilePath();
    let configDir: string | undefined;
    if (linkedConf) {
      configDir = path.dirname(linkedConf);
    } else if (detected?.keymapPath) {
      configDir = path.dirname(detected.keymapPath);
    }

    const parts: string[] = ["west build"];
    if (board) parts.push(`-b ${board}`);
    parts.push("zmk/app");
    const cmakeArgs: string[] = [];
    if (shield) cmakeArgs.push(`-DSHIELD=${shield}`);
    if (configDir) cmakeArgs.push(`-DZMK_CONFIG=${configDir}`);
    if (cmakeArgs.length > 0) parts.push("--", ...cmakeArgs);
    const command = parts.join(" ");

    if (!this._rebuildOutput) {
      this._rebuildOutput = vscode.window.createOutputChannel("ZMK Studio — Rebuild");
    }

    await this.buildFirmware(westRoot, command, board, shield, configDir);
  }

  /** Clears the cached board/shield so the next build will prompt again. */
  public async clearCachedBoard(): Promise<void> {
    await this.context.globalState.update(CACHED_BOARD_KEY, undefined);
    await this.context.globalState.update(CACHED_SHIELD_KEY, undefined);
    vscode.window.showInformationMessage("Cached board/shield cleared. You will be prompted on the next build.");
  }

  /** Clears the cached workspace path and re-runs workspace discovery. */
  public async setWestWorkspace(): Promise<void> {
    await this.context.globalState.update(WEST_WORKSPACE_KEY, undefined);
    const result = await this.resolveWestWorkspace();
    if (result) {
      vscode.window.showInformationMessage(`West workspace set to: ${result}`);
    }
  }

  /**
   * Best default directory for file open/save dialogs, resolved in priority order:
   *   1. Linked .conf file's directory (most specific)
   *   2. Config dir inside the known west workspace (covers unlinked-but-detected case)
   *   3. First VS Code workspace folder
   *   4. Home directory
   */
  public async getDefaultDir(): Promise<vscode.Uri> {
    const linked = this.configStore.getFilePath();
    if (linked) return vscode.Uri.file(path.dirname(linked));

    const westRoot = this.context.globalState.get<string>(WEST_WORKSPACE_KEY);
    if (westRoot && fs.existsSync(path.join(westRoot, ".west", "config"))) {
      const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const detected = await loadLocalConfig(westRoot, workspacePaths);
      if (detected?.keymapPath) return vscode.Uri.file(path.dirname(detected.keymapPath));
    }

    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri;
    return vscode.Uri.file(os.homedir());
  }

  /** Export config to the linked .conf file, or show a save dialog if none is linked. */
  async exportConfigAuto(): Promise<void> {
    const linked = this.configStore.getFilePath();
    if (linked) {
      await this.configStore.exportToFile(linked);
      vscode.window.showInformationMessage(`Config saved to ${path.basename(linked)}`);
      return;
    }
    const uri = await vscode.window.showSaveDialog({
      filters: { "ZMK Config": ["conf"] },
      title: "Export ZMK Configuration File",
      defaultUri: vscode.Uri.joinPath(await this.getDefaultDir(), "keyboard.conf"),
    });
    if (!uri) return;
    await this.configStore.exportToFile(uri.fsPath);
    vscode.window.showInformationMessage(`Config exported to ${uri.fsPath}`);
  }

  /** Push the current config store snapshot to the webview. */
  pushConfigSnapshot(): void {
    this.view?.webview.postMessage({
      type: "configSnapshot",
      values: this.configStore.getAll(),
      hasFile: !!this.configStore.getFilePath(),
    });
  }

  async connectViaUSB(portPath?: string): Promise<void> {
    if (!await this.ensureViewReady()) return;

    // If no port given, let user pick from detected devices
    if (!portPath) {
      const ports = await listZMKSerialPorts();
      if (ports.length === 0) {
        vscode.window.showErrorMessage(
          "No ZMK keyboards detected. Make sure your keyboard is plugged in via USB."
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(
        ports.map((p) => ({
          label: p.path,
          description: [p.manufacturer, p.serialNumber]
            .filter(Boolean)
            .join(" · "),
        })),
        { placeHolder: "Select your ZMK keyboard" }
      );
      if (!picked) return;
      portPath = picked.label;
    }

    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Connecting to ZMK keyboard…" },
      async () => {
        try {
          log(`Connecting to serial port: ${portPath}`);
          const transport = await connectSerial(portPath!);
          // Hand the transport directly to the bridge.
          // Device identity is fetched by the webview after the session unlocks.
          await this.bridge!.attach(transport);
        } catch (err: unknown) {
          logError("USB connection failed", err);
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to connect: ${message}`);
        }
      }
    );
  }

  async connectViaBLE(): Promise<void> {
    if (!await this.ensureViewReady()) return;

    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Connecting to ZMK keyboard via Bluetooth…", cancellable: false },
      async () => {
        try {
          log("[CB] Starting CoreBluetooth connection");
          const transport = await connectCoreBluetooth(async (devices) => {
            const picked = await vscode.window.showQuickPick(
              devices.map((d) => ({ label: d.name, description: d.id, id: d.id })),
              { placeHolder: "Select your ZMK keyboard (BLE)" }
            );
            if (!picked) throw new Error("cancelled");
            return picked.id;
          });
          log(`[CB] Connected: ${transport.label}`);
          await this.bridge!.attach(transport);
        } catch (err: unknown) {
          logError("[CB] Connection failed", err);
          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes("cancelled")) {
            this.view?.webview.postMessage({ type: "error", message: `BLE: ${message}` });
          }
        }
      }
    );
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js")
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';" />
  <title>ZMK Studio</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
