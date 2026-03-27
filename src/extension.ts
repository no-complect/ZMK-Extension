import * as vscode from "vscode";
import { KeyboardPanelProvider } from "./KeyboardPanelProvider";
import { initLogger, log, logError, getLogFilePath } from "./logger";

export function activate(context: vscode.ExtensionContext) {
  // Logger must be the very first thing — it needs to capture any subsequent error
  initLogger(context);
  log(`Activating ZMK Studio v${context.extension.packageJSON.version}`);

  try {
    activateExtension(context);
    log("Activation complete — all commands registered");
  } catch (err: unknown) {
    logError("activate() threw — extension will not function", err);
    vscode.window.showErrorMessage(
      `ZMK Studio failed to activate: ${err instanceof Error ? err.message : String(err)}\n` +
      `See Output → ZMK Studio for details.${getLogFilePath() ? `\nLog: ${getLogFilePath()}` : ""}`
    );
    throw err;
  }
}

function activateExtension(context: vscode.ExtensionContext) {
  const provider = new KeyboardPanelProvider(context);

  log("Registering WebView provider");
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      KeyboardPanelProvider.viewId,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  log("Registering command: zmk-studio.openPanel");
  context.subscriptions.push(
    vscode.commands.registerCommand("zmk-studio.openPanel", async () => {
      await vscode.commands.executeCommand("workbench.action.focusSideBar");
      await new Promise(r => setTimeout(r, 100));
      await vscode.commands.executeCommand("workbench.view.extension.zmk-studio");
      await new Promise(r => setTimeout(r, 100));
      await vscode.commands.executeCommand(`${KeyboardPanelProvider.viewId}.focus`);
    })
  );

  log("Registering command: zmk-studio.connectUSB");
  context.subscriptions.push(
    vscode.commands.registerCommand("zmk-studio.connectUSB", async () => {
      log("Command invoked: zmk-studio.connectUSB");
      try {
        await provider.connectViaUSB();
      } catch (err) {
        logError("connectViaUSB threw", err);
      }
    })
  );

  log("Registering command: zmk-studio.showLog");
  context.subscriptions.push(
    vscode.commands.registerCommand("zmk-studio.showLog", () => {
      const logPath = getLogFilePath();
      if (logPath) {
        vscode.window.showInformationMessage(`ZMK Studio log: ${logPath}`);
        vscode.commands.executeCommand("workbench.action.output.toggleOutput");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("zmk-studio.selectConfigFile", async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "ZMK Config": ["conf"] },
        title: "Select ZMK .conf file",
        defaultUri: await provider.getDefaultDir(),
      });
      if (!uris || uris.length === 0) return;
      await provider.configStore.linkFile(uris[0].fsPath);
      provider.pushConfigSnapshot();
      vscode.window.showInformationMessage(`Config file linked: ${uris[0].fsPath}`);
    })
  );

  log("Registering command: zmk-studio.exportConfigFile");
  context.subscriptions.push(
    vscode.commands.registerCommand("zmk-studio.exportConfigFile", async () => {
      const uri = await vscode.window.showSaveDialog({
        filters: { "ZMK Config": ["conf"] },
        title: "Export ZMK .conf file",
        defaultUri: vscode.Uri.joinPath(await provider.getDefaultDir(), "keyboard.conf"),
      });
      if (!uri) return;
      await provider.configStore.exportToFile(uri.fsPath);
      vscode.window.showInformationMessage(`Config exported to ${uri.fsPath}`);
    })
  );

  log("Registering command: zmk-studio.importKeymap");
  context.subscriptions.push(
    vscode.commands.registerCommand("zmk-studio.importKeymap", async () => {
      await provider.importKeymapFromFile();
    })
  );

  log("Registering command: zmk-studio.buildFirmware");
  context.subscriptions.push(
    vscode.commands.registerCommand("zmk-studio.buildFirmware", async () => {
      log("Command invoked: zmk-studio.buildFirmware");
      try {
        await provider.triggerBuildFirmware();
      } catch (err) {
        logError("triggerBuildFirmware threw", err);
      }
    })
  );

  log("Registering command: zmk-studio.setWestWorkspace");
  context.subscriptions.push(
    vscode.commands.registerCommand("zmk-studio.setWestWorkspace", async () => {
      await provider.setWestWorkspace();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("zmk-studio.clearCachedBoard", async () => {
      await provider.clearCachedBoard();
    })
  );
}

export function deactivate() {
  log("ZMK Studio deactivated");
}
