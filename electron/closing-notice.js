import { BrowserWindow } from "electron";
import { smokeReadyFile, smokeStopFile } from "./config.js";

const CLOSING_NOTICE_DELAY_MS = 1_500;
const CLOSING_NOTICE_PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8">
<title>Command Center</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>:root{color-scheme:light dark}body{margin:0;padding:20px;background:#f5f5f5;color:#222;font:13px system-ui,sans-serif}h1{margin:0 0 10px;font-size:17px;font-weight:600}p{margin:0;line-height:1.5}@media(prefers-color-scheme:dark){body{background:#242424;color:#eee}}</style>
<h1>Closing Command Center...</h1><p>Finishing work in progress. This can take around 2 minutes.</p>`)}`;

// Best effort only: the server's stop promise is the sole quit prerequisite.
export function showClosingNoticeUntil(stopped) {
  if (smokeReadyFile || smokeStopFile || process.env.NODE_TEST_CONTEXT) return;
  let pending = true;
  let win;
  const dispose = () => {
    try {
      if (!win || win.isDestroyed()) return;
      win.destroy();
    }
    catch {
      try { win.hide(); } catch { /* A broken notice must never hold up quitting. */ }
    }
  };
  const timer = setTimeout(() => {
    if (!pending) return;
    try {
      win = new BrowserWindow({
        width: 440, height: 150, frame: true, show: false, alwaysOnTop: true,
        resizable: false, minimizable: false, maximizable: false, title: "Command Center",
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      Promise.resolve(win.loadURL(CLOSING_NOTICE_PAGE)).then(() => {
        if (!pending || win.isDestroyed()) return;
        win.showInactive();
      }).catch(dispose);
    } catch { dispose(); }
  }, CLOSING_NOTICE_DELAY_MS);
  timer.unref?.();
  const finish = () => {
    pending = false;
    clearTimeout(timer);
    dispose();
  };
  stopped.then(finish, finish);
}
