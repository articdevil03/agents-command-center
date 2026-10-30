// Command Center page script, part 1 of 12: model text markdown, constants and page state. Ordered classic scripts (index.html loads public/app/*.js in name order) share one scope.
  "use strict";

  const $ = (id) => document.getElementById(id);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  // ---------- model text: a small markdown renderer ----------
  // Every piece of text is escaped FIRST; only the fixed tags below are ever made, never raw html from the model. Links: http(s) only.
  // ponytail: one list level, no tables or images; add when a reply really needs them.
  // One alternation read left to right, so a code span and a link never fight: whichever starts first wins, and the URL is taken exactly as written (the class stops at brackets, so a failed match is bounded).
  const MD_TOKEN = /(`[^`\n]+`)|\[([^\[\]\n]+)\]\((https?:\/\/[^\s()\[\]]+)\)/gi;
  const mdSpace = (char) => /\s/.test(char), mdWord = (char) => /\w/.test(char), mdPath = (char) => char === "/" || char === "\\";
  // Emphasis in one pass (linear, no regex backtracking): every run of * or _ may open or close by its neighbours, a closer takes the nearest opener of the same mark and length.
  // A run touching / or \ (a path, a glob) never opens or closes, none opens after a dot, none closes before ".word" (test*.ts), though one may open before a dot (**.env**); a single * or any _ also needs a non-word side (snake_case stays).
  function mdEmphasis(text, plain) {
    const runs = [];
    for (let i = 0; i < text.length;) {
      const mark = text[i];
      if (mark !== "*" && mark !== "_") { i += 1; continue; }
      let end = i; while (text[end] === mark) end += 1;
      const len = end - i, prev = text[i - 1] ?? " ", next = text[end] ?? " ", loose = mark === "*" && len > 1, clear = len <= 3 && !mdPath(prev) && !mdPath(next);
      const dotted = next === "." && mdWord(text[end + 1] ?? " ");
      runs.push({ at: i, len, rem: len, mark, key: mark + len, open: clear && !mdSpace(next) && prev !== "." && (loose || !mdWord(prev)), close: clear && !mdSpace(prev) && !dotted && (loose || !mdWord(next)) });
      i = end;
    }
    const stack = [], waiting = new Map(), wait = (key, by) => waiting.set(key, (waiting.get(key) ?? 0) + by);
    for (const run of runs) {
      if (run.close) {
        if (waiting.get(run.key)) { take(reach(run.key), run, run.len); continue; }
        if (run.len === 3 && splitClose(run)) continue;
        if (partialClose(run)) continue;
      }
      if (run.open) { stack.push(run); wait(run.key, 1); }
    }
    // An opener taken only in part and never finished would leave a lone closing tag: its closers go back to plain text.
    for (const run of runs) if (run.closers && !run.role) for (const closer of run.closers) closer.role = undefined;
    // The unmatched openers above the first one of this key show as typed; returns that opener.
    function reach(key) { while (stack.at(-1).key !== key) wait(stack.pop().key, -1); return stack.at(-1); }
    // A closer takes `used` of the opener on top; an opener of 3 can be taken in two steps and gets its tags only when all three are taken.
    function take(top, run, used) {
      run.role = "close"; run.used = used; (top.closers ??= []).push(run);
      wait(top.key, -1); top.rem -= used;
      if (top.rem) { top.key = top.mark + top.rem; wait(top.key, 1); return; }
      stack.pop(); top.role = "open"; top.parts = top.closers.map((closer) => closer.used);
    }
    // A closer of 1 or 2 takes part of the nearest opener of 3 ("***bold** italic*"); a closer of 3 takes the nearest opener of 2 or 1 and leaves the rest as typed ("**bold***").
    function partialClose(run) {
      const key = (run.len === 3 ? [run.mark + 2, run.mark + 1] : [run.mark + 3]).find((name) => waiting.get(name));
      if (!key) return false;
      take(reach(key), run, run.len === 3 ? Number(key.slice(1)) : run.len);
      return true;
    }
    // A run of 3 with no opener of 3 closes the two nested openers right under it, a 1 and a 2 of its own mark, innermost first ("**bold *italic***").
    function splitClose(run) {
      const [low, top] = stack.slice(-2);
      if (!top || low.mark !== run.mark || top.mark !== run.mark || low.len + top.len !== 3 || waiting.get(run.key)) return false;
      stack.length -= 2; wait(low.key, -1); wait(top.key, -1);
      low.role = top.role = "open"; run.role = "close"; run.split = [top.len, low.len];
      return true;
    }
    // Tags for a list of lengths, each 1 (em) or 2 (strong), outermost first when opening and innermost first when closing; a 3 is a 2 around a 1.
    const seq = (lens, open) => lens.map((len) => len === 1 ? (open ? "<em>" : "</em>") : (open ? "<strong>" : "</strong>")).join("");
    const tag = (run) => plain ? "" : run.role === "open" ? seq(run.parts?.length > 1 ? run.parts.slice().reverse() : run.len === 3 ? [2, 1] : [run.len], true) : seq(run.split ?? ((run.used ?? run.len) === 3 ? [1, 2] : [run.used ?? run.len]), false);
    let out = "", from = 0;
    for (const run of runs) { out += text.slice(from, run.at) + (run.role ? tag(run) + run.mark.repeat(run.len - (run.used ?? run.len)) : text.slice(run.at, run.at + run.len)); from = run.at + run.len; }
    return out + text.slice(from);
  }
  // Code spans and links are set aside first (a link label is parsed on its own: code and emphasis allowed, never a link), emphasis runs on what is left, then they go back in.
  function mdSpans(text, plain) {
    const stash = [], keep = (value) => `\u0000${stash.push(value) - 1}\u0000`;
    const spliced = text.replace(MD_TOKEN, (_, code, label, url) => keep(code ? (plain ? code.slice(1, -1) : `<code>${code.slice(1, -1)}</code>`) : plain ? mdSpans(label, true) : `<a href="${url}" target="_blank" rel="noopener noreferrer">${mdSpans(label, false)}</a>`));
    return mdEmphasis(spliced, plain).replace(/\u0000(\d+)\u0000/g, (_, index) => stash[index]);
  }
  function mdInline(raw) {
    return mdSpans(esc(String(raw ?? "").replace(/\u0000/g, "")), false);
  }
  // One-line labels keep no formatting: the markers go, the words stay.
  function mdPlain(raw) {
    return mdSpans(String(raw ?? "").replace(/\u0000/g, ""), true).replace(/^\s*#{1,6}\s+/, "");
  }
  // The next line after each line that is only a ``` fence (or -1), from one backward pass, so looking for a fence's end never rescans.
  function fenceCloses(lines) {
    const next = new Array(lines.length).fill(-1); let found = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) { next[i] = found; if (/^\s*```\s*$/.test(lines[i])) found = i; }
    return next;
  }
  // The heading text without its closing hashes; they count only after a space ("## C#" keeps its #), and a title of only hashes stays as typed.
  function mdHeadingText(text) {
    let title = text.trim(), end = title.length;
    while (end > 0 && title[end - 1] === "#") end -= 1;
    if (end > 0 && end < title.length && mdSpace(title[end - 1])) title = title.slice(0, end).trimEnd();
    return title;
  }
  const plainMd = (raw) => esc(mdPlain(raw));
  function mdHtml(raw) {
    const lines = String(raw ?? "").replace(/\r\n?/g, "\n").split("\n"), closes = fenceCloses(lines);
    const out = [], itemRe = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
      const close = fence ? closes[i] : -1;
      if (fence && close > i) { out.push(`<pre class="md-code"><code>${esc(lines.slice(i + 1, close).join("\n"))}</code></pre>`); i = close + 1; continue; }
      if (!line.trim()) { i += 1; continue; }
      const heading = /^\s{0,3}(#{1,3})\s+(.+)$/.exec(line), title = heading ? mdHeadingText(heading[2]) : "";
      if (title) { out.push(`<div class="md-h md-h${heading[1].length}">${mdInline(title)}</div>`); i += 1; continue; }
      if (/^\s{0,3}>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) { quote.push(mdInline(lines[i].replace(/^\s{0,3}>\s?/, ""))); i += 1; }
        out.push(`<blockquote>${quote.join("<br>")}</blockquote>`); continue;
      }
      if (itemRe.test(line)) {
        const items = [];
        while (i < lines.length && itemRe.test(lines[i])) {
          const [, indent, marker, body] = itemRe.exec(lines[i]); i += 1;
          const entry = { ordered: /\d/.test(marker), num: parseInt(marker, 10), html: mdInline(body) };
          if (indent.length >= 2 && items.length) (items.at(-1).kids ??= []).push(entry); else items.push(entry);
        }
        const group = (list) => list.reduce((html, entry, index) => {
          const tag = entry.ordered ? "ol" : "ul", open = index === 0 || list[index - 1].ordered !== entry.ordered;
          const kids = entry.kids ? group(entry.kids) : "";
          const start = open && entry.ordered && Number.isSafeInteger(entry.num) && entry.num !== 1 && entry.num < 1e9 ? ` start="${entry.num}"` : "";
          return `${html}${open ? `<${tag}${start}>` : ""}<li>${entry.html}${kids}</li>${index === list.length - 1 || list[index + 1].ordered !== entry.ordered ? `</${tag}>` : ""}`;
        }, "");
        out.push(group(items)); continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^\s{0,3}(#{1,3}\s|>)/.test(lines[i]) && !itemRe.test(lines[i]) && !/^\s*```/.test(lines[i])) { para.push(mdInline(lines[i])); i += 1; }
      if (!para.length) { para.push(mdInline(line)); i += 1; }
      out.push(`<p>${para.join("<br>")}</p>`);
    }
    return out.join("");
  }
  const ICONS = {
    dots: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="3" cy="7" r="1.2" fill="currentColor"/><circle cx="7" cy="7" r="1.2" fill="currentColor"/><circle cx="11" cy="7" r="1.2" fill="currentColor"/></svg>',
    crown: '<svg width="11" height="11" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 10.5 1.5 4l3.2 2.4L7 2.5l2.3 3.9L12.5 4 12 10.5Z" fill="currentColor"/></svg>',
    tick: '<svg class="tick" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.5 6 10.5 11.5 4" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg width="16" height="16" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7 4v3.5M7 9.6v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    ok: '<svg width="16" height="16" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.4 7.2 6.2 9 9.7 5.2" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    pencil: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M8.2 1.8 10.2 3.8 4 10H2V8L8.2 1.8Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    picture: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="7" r="1.3" stroke="currentColor" stroke-width="1.2"/><path d="m3 12 3.5-3 2.5 2 2-1.5 3 2.5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    chev: '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>',
    rchev: '<svg class="chev" width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3 7.5 6 4.5 9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>',
    back: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3 5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x: '<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    save: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 2.5h8l2.5 2.5v8.5H3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M5.5 2.5v3h4.5v-3M5.5 13.5v-4h5v4" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    crew: '<svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="6.5" cy="6.5" r="2.5" stroke="currentColor" stroke-width="1.4"/><circle cx="12.5" cy="7.5" r="2" stroke="currentColor" stroke-width="1.4"/><path d="M2 15c.6-2.6 2.3-4 4.5-4s3.9 1.4 4.5 4M11 11.3c.5-.2 1-.3 1.5-.3 1.8 0 3 1.1 3.5 3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    stop: '<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><rect width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
  };
  const KINDS = [
    { id: "dev", name: "Development", desc: "Code: build, review rounds, ship" },
    { id: "design", name: "Design", desc: "Mockups, images and assets" },
    { id: "mkt", name: "Marketing", desc: "Posts, captions, images and video" },
  ];
  // The 20 flat presets that ship in public/avatars, in picker order.
  const AVATAR_PRESETS = ["atlas", "sonny", "vera", "sol", "nova", "terra", "pip", "momo", "juno", "ziggy", "rumi", "kiki", "bo", "fig", "dune", "sage", "mel", "ollie", "taro", "ash"];
  // A picture that already wears a crown: the leader badge would only repeat it.
  const CROWNED_PRESETS = new Set(["atlas"]);
  // A picture fallback only: a seat's own saved picture (seat.pic) always wins, and a template's seats bring their own.
  const SLOT_PRESET = { leader: "atlas", planner: "sage", coder: "sonny", reviewer1: "vera", reviewer2: "sol", fixer: "nova", fixer1: "juno", fixer2: "nova", final: "terra", finalReviewer: "terra", designer: "terra", imageAndAssets: "bo", designReviewer: "sol", secondOpinion: "ziggy", socialMedia: "vera", image: "bo", videoAndMotion: "terra" };
  const NAME_PRESET = { atlas: "atlas", sonny: "sonny", vera: "vera", sol: "sol", nova: "nova", terra: "terra", astra: "ziggy", x: "bo" };
  const ME_DEFAULT = "ash.svg";
  const AVATAR_MAX_CHARS = 512 * 1024; // the server refuses a bigger uploaded picture (server/config.ts AVATAR_MAX_CHARS)
  // Only the Settings install, sign-in and MCP lines use this (each tool's own name, Gemini included); every seat label comes from state.clis (cliLabel).
  const CLI_LABEL = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", gemini: "Gemini CLI" };
  const MAX_IMAGES = 8; // server/main/uploads.ts validateImages refuses more
  const MAX_FILES = 8; // server/main/uploads.ts validateFiles refuses more
  const FILE_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".pdf", ".csv", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".css", ".scss", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".c", ".h", ".cc", ".cpp", ".cs", ".swift", ".kt", ".sql", ".sh", ".ps1", ".bat", ".log", ".diff", ".patch"]);
  const MODEL_LABEL = {
    "gpt-6.1-sol": "Sol 6.1", "gpt-6-sol": "Sol 6", "gpt-6-luna": "Luna 6", "gpt-6-astra": "Astra 6",
    "deepseek/deepseek-flash": "DeepSeek Flash", "deepseek/deepseek-pro": "DeepSeek Pro",
    "opencode/mimo-v2.6-flash-free": "MiMo Flash (free)", "opencode/muse-spark-1.3-contributor-free": "Muse Spark (free)",
    "opencode-go/gpt-5.6-luna": "GPT 5.6 Luna (Go)", "google/gemini-3-pro": "Gemini 3 Pro",
    "google/gemini-3-flash": "Gemini 3 Flash", "moonshot/kimi-k3": "Kimi K3", "qwen/qwen4-coder": "Qwen 4 Coder",
    "zai/glm-5": "GLM 5", "xai/grok-5": "Grok 5", "mistral/devstral-3": "Devstral 3", "openrouter/llama-5-405b": "Llama 5 405B",
  };
  // The logo art we ship per tool; any other CLI (an ACP one) falls back to the first letter of its name in logo().
  const MODEL_BRAND = { claude: ["claude", "#D97757"], codex: ["openai", "var(--logo-ink)"], opencode: ["opencode", "var(--logo-ink)"], gemini: ["googlegemini", "#8ea6ff"], obsidian: ["obsidian", "#9b8cff"], github: ["github", "var(--logo-ink)"] };
  const STOP_CONFIRM = "release may leave a process running and editing files";
  const UNBLOCK_CONFIRM = "allow this seat to launch again";
  const STALL_MINUTES = 5; // server/stall.ts STALL_THRESHOLD_MS
  const MAX_MESSAGE_BYTES = 2 * 1024 * 1024; // the server's WebSocket maxPayload (server/index.ts)
  const MAX_OUTPUT_CHARS = 200 * 1024; // the server keeps the tail of a run's output up to this much (server/main/state.ts MAX_RUN_OUTPUT), and so does the page
  const REQUEST_BODY_BYTES = 24 * 1024; // server/requests.ts MAX_BODY_BYTES
  const REFRESH_WAIT_MS = 30_000; // Settings "Check again" gives up waiting for the server's answer after this long
  const HISTORY_WAIT_MS = 15_000; // a saved-runs list or saved run the server never answers stops spinning after this long
  const PROCESS_PENDING_MS = 5_000; // a step button the server never acted on is usable again after this long

  let serverState = null;
  let socket = null;
  let reconnectDelay = 1000;
  let reconnectTimer = 0;
  let connState = "connecting";
  let retryAt = 0;
  let selectedSeatByTab = new Map();
  let transcripts = new Map();
  let chatMeta = new Map();
  let savePending = new Set();
  // Per tab: a Save the server refused ("failed") or whose answer the connection lost ("unknown"); settled by the server's own revisions.
  const saveStates = new Map();
  let clearUndos = new Map();
  let attachmentsByTab = new Map();
  let attachmentTargetTab = null;
  let settingsSection = "crew";
  let settingsFocusKey = null;
  let lowerSection = "activity";
  let pendingSettingsActions = new Map();
  let pendingPermissionAction = new Map();
  // Per tab: a Requests send in one tab must not show its status, or lock Send, in another.
  const pendingRequestActions = new Map();
  const requestFormCleared = new Map(); // Last cleared send per existing tab.
  // One terminal result per control, not a history of every request id.
  const settingsActionResults = new Map();
  const permissionActionResults = new Map();
  const requestActionResults = new Map();
  // Ids the server has listed while still pending here, and ids pending when the socket closed. The server never evicts a running action, so a pending id seen listed and now gone (or lost at a reconnect) is finished, not running.
  const seenListedActions = new Set();
  let lostActions = new Set();
  const pendingActionIds = () => new Set([pendingSettingsActions, pendingPermissionAction, pendingRequestActions].flatMap((map) => [...map.values()]));
  function retireAction(result) {
    if (!result || !["done", "failed", "unknown"].includes(result.status)) return;
    for (const [pending, results] of [[pendingSettingsActions, settingsActionResults], [pendingPermissionAction, permissionActionResults], [pendingRequestActions, requestActionResults]]) {
      // A real result arriving after the id was retired as unknown replaces it.
      if (result.status !== "unknown") for (const [key, old] of results) if (old.requestId === result.requestId && old.status === "unknown") results.set(key, result);
      for (const [key, id] of pending) if (id === result.requestId) {
        results.set(key, result);
        pending.delete(key);
      }
    }
  }
  function settingsActionId(key) { return pendingSettingsActions.get(key) ?? settingsActionResults.get(key)?.requestId; }
  let avatarUploadRequestId = null;
  let avatarPending = null; // a preset picture sent with updateSeat, shown as Saving until the server's seat carries it
  let clientPrefOverrides = new Map();
  let streamingByTab = new Map();
  const outputByRun = new Map(); // runId -> the tail of a live run's output, capped like the server's; the server's state output is its base
  const stallActions = new Map(); // runId -> what the server did about a stalled run ("relaunch" or "escalate")
  const seenNotices = new Map(); // launch notice id -> the Activity text it was last shown with
  let killOrder = []; // runIds of the killRun messages the server has not answered yet, in send order
  let historyBySeat = new Map();
  let historyDetails = new Map();
  let historyRequested = new Set();
  let historyInFlight = new Set();
  const historyFailed = new Set(); // seat keys whose saved-runs list the server never answered
  const historyTickets = new Map(); // seat key -> the latest list request, so an old request's timer never ends a newer one
  let historyRefreshAfterFlight = new Set();
  let historyRunRequested = new Map();
  const historyRunTokens = new Map(); // seatKey -> token of the newest saved-run request, so an older request's timeout cannot cancel it
  let historyRunToken = 0;
  let historyFullRequested = new Map(); // detailKey -> token of that fuller-log request
  let transcriptRequests = new Set();
  let pendingChatByTab = new Map(); // tabId -> requestId; this is the client's send lock
  let chatRequestsById = new Map(); // requestId -> the sent draft, retained for echo or reconnect history
  // Messages typed while the leader replies, per tab, in order: { id, text, items (their own attachments), held (never goes out on its own), state: waiting | sending | unknown, requestId }.
  // ponytail: kept in the page only, like a draft: a reload loses them. The server never sees one until it is sent or steered.
  let queueByTab = new Map();
  let flushArmed = new Set(); // tabs whose reply ended normally: the first waiting queued message goes out once the state says the leader is idle
  let queuingTabs = new Set();
  let replyEnds = new Map(); // tabId -> { kind: "done" | "stopped" | "cleared" }, a new object at every end: a message whose file finished loading after a reply ended reads how it ended
  let textVersionByTab = new Map();
  let stepByTab = new Map(); // tabId -> what the running reply is doing right now, in plain words from the server; gone when the reply ends (never the "Step N of M" workflow bar)
  let lastSelectRequest = null;
  let userTabSelectionVersion = 0;
  let draftsByTab = new Map();
  let composerTabId = null;
  let composerGeneration = 0;
  let rateWindowsByRun = new Map();
  let activity = [];
  let pendingActions = new Map();
  let nextActionId = 1;
  let toastTimer = 0;
  let currentLayer = null;
  let layerStack = [];
  let avatarTarget = null;
  let runTarget = null;
  let runUnknown = false; // the open Run dialog lost its answer: starting again could launch twice
  let pendingRun = null; // { tabId, slot }: the Run dialog waits for runAccepted or the refusal
  let pendingCreate = null; // { kind, projectId, id, knownTabIds }: Add tab / New project wait for the server's state
  let selectedView = "live";
  let historyViewKey = null;
  let selectedRunBySeat = new Map();
  let activeTheme = "light";
  const unreadProjects = new Set(); // projectIds with a finished reply that landed while another project was shown
  let me = { av: ME_DEFAULT }; // theme, picture and dismissed runs come from the server's client prefs (see applyServerLooks)
  let tabKind = "dev";
  let tabTemplate = ""; // template id picked in the Add tab dialog
  let projectTemplate = ""; // template id picked in the New project dialog
  let projectKind = "dev";
  let stepsOpen = false;
  let railWide = true;
  let sideOpen = false;
  let sideWidthDraft = null;
  const projectLastTab = new Map(); // projectId -> the tab last shown in it
  const processPending = new Map(); // tabId -> process action waiting for the server
  const processPendingSince = new Map(); // tabId -> when that action was sent
  const stepClickGuard = new Map(); // tabId -> time before which step-action clicks are ignored
  const tabStepSignature = new Map(); // tabId -> current step index, look approval state, phase and round of the last state
  const stepActionSent = new Set(); // tabIds with a step action sent whose step change has not arrived yet
  const STEP_CLICK_GUARD_MS = 600;
  const stopStates = new Map(); // runId -> "requested" | "accepted"
  let stopAllTrack = null; // { runIds, tabIds, accepted }: reported when every run has exited or is unconfirmed
  let refreshState = null; // { status, at }: the read-only Settings refresh
  const phraseDrafts = new Map(); // typed launch-safety phrases survive re-renders until sent
  let dismissedRuns = new Set();
  let viewerState = null; // { tabId, index, actual }
  let confirmCallback = null;
  let confirmCancelled = null;
  let renameCallback = null;
  let tickerTimer = 0;

  // An old portrait (me-N.jpg or any other old preset) falls back to the default; an uploaded picture is kept.
  function meFrom(av) {
    const preset = typeof av === "string" ? av.match(/^([a-z]+)\.svg$/)?.[1] : undefined;
    return { av: typeof av === "string" && (/^data:image\//.test(av) || AVATAR_PRESETS.includes(preset)) ? av : ME_DEFAULT };
  }
  // The window opens on a new random port every launch, so localStorage would be empty each time: the theme, picture, dismissed runs and
  // the layout (crew rail and Details open or closed) live in the server's client prefs.
  function saveClientPref(key, value) {
    // The choice is shown before the send, so a state that answers inside it (a local server echo) is compared against it, not before it.
    const had = clientPrefOverrides.has(key), before = clientPrefOverrides.get(key);
    clientPrefOverrides.set(key, value);
    const sent = send({ type: "updateClientPref", key, value });
    if (!sent) { if (had) clientPrefOverrides.set(key, before); else clientPrefOverrides.delete(key); }
    return sent;
  }
  function saveMe() { saveClientPref("avatar", me.av); }
  // Only runs that still exist can come back as a failure card, so a dismissal for a run the server no longer lists is dropped
  // before the cap the server keeps (server/config.ts DISMISSED_RUNS_MAX): 50 finished runs a tab, so 2000 holds 40 tabs of them all.
  const DISMISSED_RUNS_MAX = 2000;
  function saveDismissed() {
    const known = new Set(allTabs().flatMap(({ tab }) => (tab.runs ?? []).map((run) => run.runId)));
    saveClientPref("dismissedRuns", [...dismissedRuns].filter((id) => known.has(id)).slice(-DISMISSED_RUNS_MAX));
  }
  // Applied from every state message: the server's value, or the choice just made until the server confirms it.
  function applyServerLooks() {
    const theme = pref("theme", "light"); if (theme !== activeTheme) applyTheme(theme);
    const picture = meFrom(pref("avatar", ME_DEFAULT)).av; if (picture !== me.av) me = { av: picture };
    dismissedRuns = new Set(pref("dismissedRuns", []));
    railWide = pref("crewRailOpen", true) !== false;
    sideOpen = pref("detailsOpen", false) === true;
    showApp();
  }
  // The page stays unpainted (body.boot) until the server's theme has arrived, or for 3 s at most when the server never answers.
  function showApp() { document.body?.classList.remove("boot"); }
  function resolvedTheme() { return activeTheme === "dark" || (activeTheme === "system" && !matchMedia("(prefers-color-scheme: light)").matches) ? "dark" : "light"; }
  function applyTheme(theme = activeTheme) {
    activeTheme = ["dark", "light", "system"].includes(theme) ? theme : "light";
    const light = resolvedTheme() === "light";
    document.body.classList.toggle("light", light);
    $$("[data-theme-toggle]").forEach((button) => button.setAttribute("aria-checked", String(button.dataset.themeToggle === (light ? "light" : "dark"))));
    fixRadios($("themeTg"));
  }
  function setTheme(theme) { activeTheme = theme; saveClientPref("theme", theme); applyTheme(activeTheme); }
  // The dark pop-up sits 12px above the message box (or the approval panel over it), centred on it; with no composer on screen CSS keeps its old place.
  function placeToast() {
    const el = $("toast"), anchor = $("approvalPanel").hidden ? $("cbox") : $("approvalPanel"), box = anchor.getBoundingClientRect?.();
    if (!box) return; // a page stub without layout
    if (!box.height) { el.style.bottom = el.style.left = el.style.maxWidth = ""; return; }
    const centre = box.left + box.width / 2;
    el.style.bottom = `${Math.round(window.innerHeight - box.top + 12)}px`;
    el.style.left = `${Math.round(centre)}px`;
    el.style.maxWidth = `${Math.max(120, Math.min(640, 2 * Math.min(centre, window.innerWidth - centre) - 24))}px`;
  }
  function showToast(message) {
    const el = $("toast");
    el.textContent = message;
    placeToast();
    el.hidden = false; el.inert = false; el.setAttribute("aria-hidden", "false"); el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove("on"); el.hidden = true; el.inert = true; el.setAttribute("aria-hidden", "true"); }, 3200);
  }
  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) { showToast("Not connected to the Command Center server"); return false; }
    const raw = JSON.stringify(message);
    // The server closes the connection on a message over 2 MiB (maxPayload), and the same draft would fail again: refuse it here and say why.
    if (raw.length > MAX_MESSAGE_BYTES / 3 && new Blob([raw]).size > MAX_MESSAGE_BYTES) { showToast("That is too large to send (2 MiB at most). Shorten it and try again"); return false; }
    const transcriptTab = message.type === "selectTab" ? message.tabId : null;
    if (transcriptTab) { transcriptRequests.add(transcriptTab); lastSelectRequest = transcriptTab; }
    try {
      socket.send(raw);
      return true;
    } catch {
      if (transcriptTab) transcriptRequests.delete(transcriptTab);
      showToast("Not connected to the Command Center server");
      return false;
    }
  }
