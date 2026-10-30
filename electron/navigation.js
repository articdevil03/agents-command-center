import { shell } from "electron";

// `serverOrigin` is this run's own server (a fresh ephemeral port each
// launch), so only an exact match stays in-window; every other URL, local or
// remote, is treated as external.
export function classifyNavigation(url, serverOrigin) {
  return typeof url === "string" && (url === serverOrigin || url.startsWith(`${serverOrigin}/`)) ? "in-window" : "external";
}

// Only the "open" action: obsidian:// also has new, daily-note and other actions that write into a vault.
export function isAllowedObsidianUrl(value) {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "obsidian:" && url.hostname === "open"; }
  catch { return false; }
}

// What may be handed to the operating system's shell. file:, javascript:, custom app schemes and anything unparseable never are.
export function isSafeExternalUrl(value) {
  if (typeof value !== "string") return false;
  try { return ["http:", "https:", "mailto:"].includes(new URL(value).protocol); }
  catch { return false; }
}

// will-navigate and will-redirect also fire for sub-frames; the event's `isMainFrame` flag (see node_modules/electron/electron.d.ts,
// WebContentsWillNavigateEventParams) lets onNavigate police only the MAIN frame and leave a sub-frame alone. The app page has no
// sub-frames today. setWindowOpenHandler cannot tell which frame asked, so every window.open / target=_blank goes through
// handleExternal and is denied: only a web or mail link is passed on to the shell.
export function wireNavigationPolicy(win, serverOrigin) {
  // The main window never leaves the app's own page: anything else (a dropped file, a link, a redirect) is cancelled, and only a
  // web or mail link is passed on to the shell.
  const handleExternal = (url) => {
    if (classifyNavigation(url, serverOrigin) === "external") {
      if (isSafeExternalUrl(url)) Promise.resolve(shell.openExternal(url)).catch(() => {});
      return true;
    }
    return false;
  };
  const onNavigate = (event, url) => {
    if (!event.isMainFrame) return;
    if (handleExternal(url)) event.preventDefault();
  };
  win.webContents.on("will-navigate", onNavigate);
  win.webContents.on("will-redirect", onNavigate);
  win.webContents.setWindowOpenHandler(({ url }) => {
    handleExternal(url);
    return { action: "deny" };
  });
}
