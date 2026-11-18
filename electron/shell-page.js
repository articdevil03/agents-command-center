const PAGE_BG_COLOR = "#0a0a0c";

// The window has no native title bar or buttons: the loading and error pages are dragged by their body and end in the same minimize,
// maximize/restore and close buttons as the app's top bar (its dark look), wired to the same cc:window-* handlers in main.js.
export function shellPage(content) {
  return `data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>
html{height:100%}body{margin:0;box-sizing:border-box;min-height:100%;padding:2rem;background:${PAGE_BG_COLOR};color:#f0f0f0;font-family:system-ui,sans-serif;-webkit-app-region:drag}
.winbtns{position:fixed;top:11px;right:14px;display:flex;gap:6px;-webkit-app-region:no-drag}
.winbtns button{width:36px;height:36px;padding:0;border:0;border-radius:10px;display:grid;place-items:center;background:#19191c;box-shadow:0 1px 2px 0 #00000066,0 0 0 1px #ffffff12;color:#b4b4ba;cursor:pointer}
.winbtns button:hover{background:#222226;color:#ededef}#winClose:hover{background:#e5484d;box-shadow:none;color:#fff}
.winbtns button:focus-visible{outline:2px solid #6aa8ff;outline-offset:2px}
#winMax[data-maximized="true"] .wmax,#winMax:not([data-maximized="true"]) .wrestore{display:none}
</style><body>${content}<div class="winbtns">
<button id="winMin" type="button" aria-label="Minimize" title="Minimize" onclick="cc.minimizeWindow()"><svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M4.5 9h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
<button id="winMax" type="button" aria-label="Maximize" title="Maximize" data-maximized="false" onclick="cc.toggleMaximizeWindow()"><svg class="wmax" width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="4.5" y="4.5" width="9" height="9" rx="2" stroke="currentColor" stroke-width="1.5"/></svg><svg class="wrestore" width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="3.75" y="6.25" width="8" height="8" rx="1.8" stroke="currentColor" stroke-width="1.5"/><path d="M6.25 3.75h6.2a1.8 1.8 0 0 1 1.8 1.8v6.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
<button id="winClose" type="button" aria-label="Close" title="Close" onclick="cc.closeWindow()"><svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="m5 5 8 8M13 5l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
</div><script>
const max = document.getElementById("winMax");
const show = (maximized) => { const label = maximized === true ? "Restore" : "Maximize"; max.dataset.maximized = String(maximized === true); max.setAttribute("aria-label", label); max.title = label; };
if (window.cc) { cc.onWindowMaximized(show); cc.isWindowMaximized().then(show); }
</script></body>`)}`;
}

export let showingFailure = false;
export function errorPage(reason, stopped = false) {
  showingFailure = true;
  const escaped = String(reason)
    .replace(/(?:[a-z]:[\\/]+|file:\/\/\/|\/)(?:Users|home)[\\/]+[^\\/\r\n<>"]+/gi, "[user folder]")
    .replace(/\b(?:sk|ghp|github_pat|AIza)[-_]?[a-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\bBearer\s+[a-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|token|secret|password|authorization|key)["']?\s*[=:]\s*)(["'])[^]*?\2/gi, "$1$2[redacted]$2")
    .replace(/((?:api[_-]?key|access[_-]?token|token|secret|password|authorization|key)\s*[=:]\s*)(?:Bearer\s+)?[^\s,;<>]+/gi, "$1[redacted]")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return shellPage(`<h2>${stopped ? "Command Center stopped." : "Command Center could not start."}</h2><p>Close Command Center and open it again.</p><details style="-webkit-app-region:no-drag"><summary>Details</summary><pre style="white-space:pre-wrap">${escaped}</pre></details>`);
}

