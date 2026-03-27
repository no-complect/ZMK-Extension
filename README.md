# ZMK Studio — VS Code Extension

A [VS Code](https://code.visualstudio.com/) and [Cursor](https://cursor.sh/) extension that brings the [ZMK Studio](https://zmk.dev/docs/features/studio) keyboard configuration interface directly into your editor. Edit your ZMK keyboard's keymaps live — without leaving your development environment — over USB or Bluetooth.

---

## Features

- **Live keymap editing** via the ZMK Studio UI, embedded in the VS Code sidebar
- **USB connection** — plug in your ZMK keyboard and connect with one click
- **Bluetooth connection** — connects to bonded keyboards using CoreBluetooth, including devices that are connected to macOS but not actively advertising
- **Firmware building** — runs `west build` from inside VS Code with pre-flight checks, auto-detects board/shield from your config, and copies the resulting `.uf2` to your keymaps folder
- **Export Setup** — exports both your keymap (`.zmkmap` snapshot + `.keymap` devicetree source) and your configuration file (`.conf`) in one click
- **Config file management** — link, export, and inspect your `.conf` files from the editor
- **Persistent settings** — keyboard configuration is stored across sessions
- **Extension log** — a built-in output channel for debugging connection issues

---

## Requirements

| Requirement | Details |
|-------------|---------|
| **Operating system** | macOS (Apple Silicon or Intel) |
| **VS Code / Cursor** | Version 1.94.0 or later |
| **ZMK firmware** | Built with `CONFIG_ZMK_STUDIO=y` |
| **Bluetooth permission** | Granted to VS Code/Cursor on first BLE connect (macOS prompts automatically) |
| **`west`** _(firmware builds only)_ | [Install west](https://docs.zephyrproject.org/latest/develop/west/install.html) — the extension will set up the ZMK workspace automatically |

> **Windows / Linux:** Bluetooth support uses a native macOS CoreBluetooth binary and is currently macOS-only. USB (serial) connection works on any platform where serialport is supported.

---

## Installation

### From a `.vsix` file

1. Download the latest `.vsix` release
2. In VS Code: `Extensions` → `···` menu → `Install from VSIX…`
3. Select the downloaded file

### From source

See [Contributing / Development Setup](#contributing--development-setup) below.

---

## Usage

### Opening the panel

- Click the **ZMK Studio icon** in the Activity Bar (left sidebar)
- Or run the command `ZMK: Open Keyboard Editor` from the Command Palette (`Cmd+Shift+P`)

### Connecting via USB

1. Plug your ZMK keyboard into your Mac
2. Click **Scan (USB)** in the ZMK Studio panel, or run `ZMK: Connect via USB`
3. Select your keyboard from the port picker if prompted
4. The panel will show your keyboard's layout once connected and unlocked

### Connecting via Bluetooth

1. Make sure your keyboard is paired and connected to your Mac (it will appear in System Settings → Bluetooth)
2. Click **Connect (BLE)** in the ZMK Studio panel
3. If multiple ZMK keyboards are connected, a picker will appear — select yours
4. On first use, macOS will ask for Bluetooth permission — click **Allow**

> **How Bluetooth works:** The extension uses a native CoreBluetooth subprocess (`bin/zmk-ble-helper`) that calls `retrieveConnectedPeripherals` — the same CoreBluetooth API used by the ZMK Studio desktop app. This finds bonded keyboards that are connected to macOS but not broadcasting advertisements, which is the normal state for a paired keyboard.

### Unlocking

ZMK Studio keyboards are locked by default to prevent accidental changes. Unlock your keyboard using the key combination defined in your firmware (typically a dedicated Studio Unlock key or combo). The panel will update automatically when unlocked.

### Building firmware

1. Click **Build Firmware** in the ZMK Studio panel (or run `ZMK: Build Firmware` from the Command Palette)
2. If no west workspace is found, the extension will prompt you to set one up:
   - **Auto-setup** _(requires `west` in PATH)_ — initializes a workspace at `~/zmk-workspace` automatically
   - **Select existing** — point to a folder that already has `.west/config`
   - **Initialize manually** — choose a location and run `west init` + `west update` in a terminal
3. Pre-flight checks run automatically — board, Zephyr source, config directory, keymap file
4. If the board can't be detected from `build.yaml`/`west.yml`, you'll be prompted to enter it once; it's cached for subsequent builds
5. The build runs in a terminal; the resulting `.uf2` is copied to `keymaps/<device>/` when complete

> **Tip:** To reset the cached board/shield (e.g. when switching keyboards), run `ZMK: Clear Cached Board/Shield` from the Command Palette.

---

## Commands

All commands are accessible from the Command Palette (`Cmd+Shift+P`) under the `ZMK` category.

| Command | Description |
|---------|-------------|
| `ZMK: Open Keyboard Editor` | Opens and focuses the ZMK Studio sidebar panel |
| `ZMK: Connect via USB` | Scans for ZMK keyboards on serial ports and connects |
| `ZMK: Build Firmware` | Runs pre-flight checks and launches a `west build` terminal |
| `ZMK: Set West Workspace` | Clears the cached workspace path and re-runs workspace discovery |
| `ZMK: Clear Cached Board/Shield` | Resets the saved board/shield so the next build will prompt again |
| `ZMK: Show Extension Log` | Opens the ZMK Studio output channel for diagnostics |
| `ZMK: Select Configuration File` | Links an existing `.conf` file to the config store |
| `ZMK: Export Configuration File` | Saves the current config to a `.conf` file (always prompts for save location) |
| `ZMK: Import Keymap` | Imports a `.zmkmap` file and applies it to the connected keyboard |

---

## Architecture

The extension is split into two processes that communicate via `postMessage`:

```
┌─────────────────────────────────────────┐
│  Extension Host (Node.js)               │
│                                         │
│  KeyboardPanelProvider                  │
│    ├── SerialTransport   (USB)          │
│    ├── CoreBluetoothTransport  (BLE)    │
│    │     └── bin/zmk-ble-helper         │
│    │           (ObjC subprocess,        │
│    │            CoreBluetooth API)      │
│    └── MessageBridge                    │
│          (proxies bytes ↕ WebView)      │
└──────────────────┬──────────────────────┘
                   │  postMessage (bytes / events)
┌──────────────────▼──────────────────────┐
│  WebView (Chromium renderer)            │
│                                         │
│  React UI  (ZMK Studio web interface)   │
│    └── zmk-studio-ts-client             │
│          (ZMK RPC protocol over         │
│           ReadableStream/WritableStream) │
└─────────────────────────────────────────┘
```

### Key design decisions

**Why a native subprocess for Bluetooth?**
VS Code's WebView has a Permissions-Policy that blocks `navigator.bluetooth`, and the extension host cannot access Electron's session APIs. The only path to CoreBluetooth is a native subprocess. The `bin/zmk-ble-helper` binary communicates with the extension host over `stdin`/`stdout` using newline-delimited JSON.

**Why CoreBluetooth instead of noble?**
ZMK keyboards that are bonded to macOS are connected to the OS as HID devices and stop advertising. Noble's raw HCI scan cannot find them. CoreBluetooth's `retrieveConnectedPeripherals(withServices:)` returns bonded+connected peripherals regardless of whether they are advertising — the same API used by the ZMK Studio desktop app (via Tauri/btleplug).

**Why is the UI a WebView instead of native VS Code panels?**
The ZMK Studio UI is a React application already maintained by the ZMK project (`@zmkfirmware/zmk-studio-ts-client`). Embedding it as a WebView reuses that work directly rather than reimplementing the keyboard layout editor in VS Code's native UI primitives.

---

## Project Structure

```
zmk-extension/
├── src/                        # Extension host (Node.js, TypeScript)
│   ├── extension.ts            # Entry point, command registration
│   ├── KeyboardPanelProvider.ts # WebView provider, connection orchestration
│   ├── logger.ts               # Output channel logging
│   ├── ZmkConfigStore.ts       # Persistent config key-value store
│   ├── ZmkConfigLoader.ts      # West workspace + config file loader
│   ├── ZmkConfigParser.ts      # Parse build.yaml / west.yml / .conf files
│   └── transport/
│       ├── SerialTransport.ts  # USB serial RpcTransport
│       ├── CoreBluetoothTransport.ts  # BLE RpcTransport (via subprocess)
│       └── MessageBridge.ts    # Byte proxy between host and WebView
│
├── webview/                    # WebView UI (React, TypeScript)
│   ├── index.tsx               # React entry point
│   ├── App.tsx                 # Root component
│   ├── contexts/               # React context definitions
│   ├── hooks/
│   │   └── useConnectionContext.ts  # Connection state machine
│   └── transport/
│       └── BridgeTransport.ts  # WebView-side RpcTransport (postMessage)
│
├── shared/
│   └── messages.ts             # Shared message types (host ↔ WebView)
│
├── native/
│   └── zmk-ble-helper.m       # Objective-C CoreBluetooth subprocess source
│
├── bin/
│   └── zmk-ble-helper         # Compiled binary (built by build:native, git-ignored)
│
├── media/
│   └── zmk-icon.svg           # Activity bar icon
│
└── dist/                       # Webpack output (git-ignored)
    ├── extension.js
    └── webview.js
```

---

## Contributing / Development Setup

### Prerequisites

- macOS (required for native Bluetooth build)
- [Node.js](https://nodejs.org/) 20+
- [VS Code](https://code.visualstudio.com/) 1.94.0+
- Xcode Command Line Tools: `xcode-select --install`

### First-time setup

```bash
git clone <repo-url>
cd zmk-extension
npm run setup
```

`npm run setup` installs dependencies, compiles the native BLE helper, and produces a production webpack build — everything needed to run or package the extension.

### Running the extension

1. Open the project folder in VS Code
2. Press `F5` (or `Run → Start Debugging`) to launch the **Extension Development Host** — a separate VS Code window with your extension loaded
3. In that window, click the ZMK Studio icon in the Activity Bar

For day-to-day development, use `npm run dev:full` instead — it compiles the native binary once then starts webpack in watch mode. After editing source files, press `Ctrl+Shift+P` → `Developer: Reload Window` in the Extension Development Host.

### Rebuilding the native binary

Only needed when you edit `native/zmk-ble-helper.m`:

```bash
npm run build:native
```

### Running tests

```bash
npm test
```

Tests cover the ZMK config file parser and workspace config detector. They run directly with `tsx` — no separate build step needed.

### Cleaning generated files

```bash
npm run clean
```

Removes `node_modules`, `dist`, `bin/zmk-ble-helper`, `keymaps`, and any `.vsix` files. Run `npm run setup` afterwards to rebuild from scratch.

---

## Scripts Reference

| Script | Description |
|--------|-------------|
| `setup` | Full first-time setup: `npm install` + compile native binary + production webpack build |
| `clean` | Remove all generated files (node_modules, dist, bin, keymaps, .vsix) |
| `setup:west` | Initialize a ZMK west workspace at `./west-workspace/` (requires `west` in PATH) |
| `dev` | Start webpack in watch mode (native binary must already be built) |
| `dev:full` | Compile native binary then start webpack in watch mode |
| `build` | Production webpack build |
| `build:native` | Compile `native/zmk-ble-helper.m` to `bin/zmk-ble-helper` |
| `build:ext` | Webpack — extension host only |
| `build:webview` | Webpack — WebView UI only |
| `test` | Run all tests |
| `test:parser` | Test the config file parser |
| `test:detector` | Test workspace config detection |
| `vscode:prepublish` | Run automatically by `vsce package` (compile native + production build) |
| `package` | Build everything and produce a `.vsix` file |
| `install:vscode` | Package and install directly into VS Code |
| `install:cursor` | Package and install directly into Cursor |

---

## Packaging a `.vsix`

```bash
npm run package
```

This compiles the native binary, runs a production webpack build, and bundles everything into a `.vsix` file ready for distribution.

> **Universal binary:** The `bin/zmk-ble-helper` binary compiled by `build:native` targets only the current machine's architecture. For a distributable release that works on both Apple Silicon and Intel Macs, build a universal binary first:
>
> ```bash
> clang -fobjc-arc -framework CoreBluetooth -framework Foundation \
>   -target arm64-apple-macos11 -o bin/zmk-ble-helper-arm64 native/zmk-ble-helper.m
> clang -fobjc-arc -framework CoreBluetooth -framework Foundation \
>   -target x86_64-apple-macos10.15 -o bin/zmk-ble-helper-x86 native/zmk-ble-helper.m
> lipo -create bin/zmk-ble-helper-arm64 bin/zmk-ble-helper-x86 -output bin/zmk-ble-helper
> rm bin/zmk-ble-helper-arm64 bin/zmk-ble-helper-x86
> npm run package
> ```

---

## Troubleshooting

**"Bluetooth is powered off" / "Bluetooth access denied"**
Open System Settings → Privacy & Security → Bluetooth and ensure VS Code (or Cursor) is listed and enabled.

**Keyboard not found over BLE**
Make sure the keyboard appears as connected in System Settings → Bluetooth (not just paired). The extension finds already-connected peripherals — if macOS shows it as disconnected, reconnect it first.

**"zmk-ble-helper binary not found"**
The native binary needs to be compiled. Run `npm run build:native`.

**Extension not activating / blank panel**
Run `ZMK: Show Extension Log` from the Command Palette to see detailed diagnostic output.

**Keyboard is locked after connecting**
ZMK Studio keyboards lock themselves to prevent accidental changes. Press the unlock key combination defined in your firmware to unlock. The UI will update automatically when unlocked.

**Board not detected during firmware build**
The extension reads the board identifier from `build.yaml` or `west.yml` in your ZMK config. If those files don't specify a board, you'll be prompted to enter it manually — it's saved for future builds. Run `ZMK: Clear Cached Board/Shield` to reset it.

---

## Related Projects

- [ZMK Firmware](https://github.com/zmkfirmware/zmk) — the keyboard firmware this extension communicates with
- [ZMK Studio](https://github.com/zmkfirmware/zmk-studio) — the official standalone ZMK Studio desktop/web app (Tauri + React)
- [zmk-studio-ts-client](https://github.com/zmkfirmware/zmk-studio-ts-client) — the TypeScript RPC client library used by both this extension and the official web app

---

## License

MIT
