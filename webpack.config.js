//@ts-check
"use strict";

const path = require("path");

/** @type {import('webpack').Configuration} */
const extensionConfig = {
  target: "node",
  mode: "none",
  entry: "./src/extension.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
  },
  externals: {
    // VS Code API is provided at runtime — never bundle it
    vscode: "commonjs vscode",
    // Native modules — must be required at runtime, not bundled
    serialport: "commonjs serialport",
    "@serialport/bindings-cpp": "commonjs @serialport/bindings-cpp",
    "@abandonware/noble": "commonjs @abandonware/noble",
  },
  resolve: {
    extensions: [".ts", ".js"],
    // Allow webpack to resolve extensionless imports from strict ESM packages
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: "ts-loader" }],
      },
      {
        // Allow extensionless imports from ESM packages (e.g. zmk-studio-ts-client)
        test: /\.js$/,
        resolve: { fullySpecified: false },
      },
    ],
  },
  devtool: "nosources-source-map",
  infrastructureLogging: { level: "log" },
};

/** @type {import('webpack').Configuration} */
const webviewConfig = {
  target: "web",
  mode: "none",
  entry: "./webview/index.tsx",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "webview.js",
  },
  externals: {
    // VS Code webview API injected by VS Code at runtime
    vscode: "commonjs vscode",
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
    },
    fallback: {
      // Node built-ins not available in WebView
      buffer: false,
      stream: false,
      path: false,
    },
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: [
          {
            loader: "ts-loader",
            options: { configFile: "tsconfig.webview.json" },
          },
        ],
      },
      {
        test: /\.css$/,
        use: [
          "style-loader",
          "css-loader",
          {
            loader: "postcss-loader",
            options: { postcssOptions: { config: "./postcss.config.cjs" } },
          },
        ],
      },
      {
        test: /\.js$/,
        resolve: { fullySpecified: false },
      },
    ],
  },
  devtool: "nosources-source-map",
};

module.exports = [extensionConfig, webviewConfig];
