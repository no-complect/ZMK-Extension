import { useEffect, useState } from "react";

export type VSCodeThemeKind = "dark" | "light" | "high-contrast" | "high-contrast-light";

export interface VSCodeTheme {
  kind: VSCodeThemeKind;
  /** The raw theme ID set by VS Code, e.g. "GitHub Dark", "One Dark Pro" */
  id: string;
}

function readTheme(): VSCodeTheme {
  const body = document.body;
  const id = body.dataset.vscodeThemeId ?? "";

  let kind: VSCodeThemeKind = "dark";
  if (body.classList.contains("vscode-high-contrast-light")) kind = "high-contrast-light";
  else if (body.classList.contains("vscode-high-contrast")) kind = "high-contrast";
  else if (body.classList.contains("vscode-light")) kind = "light";

  return { kind, id };
}

/**
 * Reactively tracks the user's active VS Code theme.
 *
 * VS Code updates body class and data-vscode-theme-id automatically
 * when the user changes their theme — no extension API needed.
 *
 * @example
 * const { kind, id } = useVSCodeTheme();
 * // kind: "dark" | "light" | "high-contrast" | "high-contrast-light"
 * // id:   "GitHub Dark Dimmed"
 */
export function useVSCodeTheme(): VSCodeTheme {
  const [theme, setTheme] = useState<VSCodeTheme>(readTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "data-vscode-theme-id"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}
