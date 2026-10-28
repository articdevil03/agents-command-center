(() => {
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
  const PROCESSES = [
    { id: "main", name: "The Main Crew", desc: "The full crew and review rounds" },
    { id: "duo", name: "The Duo", desc: "Leader and coder. The leader does the reviews" },
    { id: "solo", name: "Stand-alone", desc: "Just the leader. It does everything itself, no review rounds" },
  ];
  // Seat counts and default pictures per crew, so the crew menu can show who comes with each choice before switching.
  const CREW_FACES = {
    main: { dev: ["atlas", "sonny", "vera", "sol", "nova", "terra"], design: ["atlas", "terra", "bo", "sol"], mkt: ["atlas", "ziggy", "vera", "bo", "terra"] },
    duo: ["atlas", "sonny"], solo: ["atlas"],
  };
  // The 20 flat presets that ship in public/avatars, in picker order.
  const AVATAR_PRESETS = ["atlas", "sonny", "vera", "sol", "nova", "terra", "pip", "momo", "juno", "ziggy", "rumi", "kiki", "bo", "fig", "dune", "sage", "mel", "ollie", "taro", "ash"];
  // A picture that already wears a crown: the leader badge would only repeat it.
  const CROWNED_PRESETS = new Set(["atlas"]);
  const SLOT_PRESET = { leader: "atlas", coder: "sonny", reviewer1: "vera", reviewer2: "sol", fixer: "nova", finalReviewer: "terra", designer: "terra", imageAndAssets: "bo", designReviewer: "sol", secondOpinion: "ziggy", socialMedia: "vera", image: "bo", videoAndMotion: "terra" };
  const NAME_PRESET = { atlas: "atlas", sonny: "sonny", vera: "vera", sol: "sol", nova: "nova", terra: "terra", astra: "ziggy", x: "bo" };
  const ME_DEFAULT = "ash.svg";
  const AVATAR_MAX_CHARS = 512 * 1024; // the server refuses a bigger uploaded picture (server/config.ts AVATAR_MAX_CHARS)
  const CLI_LABEL = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", gemini: "Gemini CLI" };
  const MAX_IMAGES = 8; // server/index.ts validateImages refuses more
  const MAX_FILES = 8; // server/index.ts validateFiles refuses more
  const FILE_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".pdf", ".csv", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".css", ".scss", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".c", ".h", ".cc", ".cpp", ".cs", ".swift", ".kt", ".sql", ".sh", ".ps1", ".bat", ".log", ".diff", ".patch"]);
  const MODEL_LABEL = {
    "gpt-6-sol": "Sol 6", "gpt-6-luna": "Luna 6", "gpt-6-astra": "Astra 6",
    "deepseek/deepseek-flash": "DeepSeek Flash", "deepseek/deepseek-pro": "DeepSeek Pro",
    "opencode/mimo-v2.6-flash-free": "MiMo Flash (free)", "opencode/muse-spark-1.3-contributor-free": "Muse Spark (free)",
    "opencode-go/gpt-5.6-luna": "GPT 5.6 Luna (Go)", "google/gemini-3-pro": "Gemini 3 Pro",
    "google/gemini-3-flash": "Gemini 3 Flash", "moonshot/kimi-k3": "Kimi K3", "qwen/qwen4-coder": "Qwen 4 Coder",
    "zai/glm-5": "GLM 5", "xai/grok-5": "Grok 5", "mistral/devstral-3": "Devstral 3", "openrouter/llama-5-405b": "Llama 5 405B",
  };
  // The server accepts an unlisted model id only in these shapes (server/config.ts isValidModel).
  const CUSTOM_MODEL = { codex: /^gpt-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/, opencode: /^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/ };
  const MODEL_BRAND = { claude: ["claude", "#D97757"], codex: ["openai", "var(--logo-ink)"], opencode: ["opencode", "var(--logo-ink)"], gemini: ["googlegemini", "#8ea6ff"], obsidian: ["obsidian", "#9b8cff"], github: ["github", "var(--logo-ink)"] };
  const STOP_CONFIRM = "release may leave a process running and editing files";
  const UNBLOCK_CONFIRM = "allow this seat to launch again";
  const ROUND_STEP_IDS = new Set(["review", "finalCheck"]);
  const STALL_MINUTES = 5; // server/stall.ts STALL_THRESHOLD_MS
  const MAX_MESSAGE_BYTES = 2 * 1024 * 1024; // the server's WebSocket maxPayload (server/index.ts)
  const MAX_OUTPUT_CHARS = 200 * 1024; // the server keeps the tail of a run's output up to this much (server/index.ts), and so does the page
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
  let pickerSeat = null;
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
  let tabProcess = "main";
  let projectProcess = "main";
  let projectKind = "dev";
  let setupKind = "dev";
  let setupMenu = null; // { draw }: the crew picker that is open now
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
  function selectTabFromUser(tabId) {
    userTabSelectionVersion++;
    return send({ type: "selectTab", tabId });
  }
  // This run's secret for the server. The Electron app hands it over through its preload (window.cc.appKey); a plain browser tab opened
  // from `npm start` carries it as #key=... in the address, which is read once, removed from the address bar and kept for reloads of this tab only.
  let appKeyValue = "", connectTicket = 0;
  async function getAppKey() {
    if (appKeyValue) return appKeyValue;
    try {
      if (window.cc && typeof window.cc.appKey === "function") appKeyValue = String(await window.cc.appKey() ?? "");
      else {
        appKeyValue = /(?:^|[#&])key=([0-9a-fA-F]+)/.exec(location.hash)?.[1] ?? sessionStorage.getItem("cc-app-key") ?? "";
        if (appKeyValue) sessionStorage.setItem("cc-app-key", appKeyValue);
        if (location.hash) history.replaceState(null, "", location.pathname + location.search);
      }
    } catch { /* no key: the server refuses the connection and the Disconnected banner shows */ }
    return appKeyValue;
  }
  // A stale key (the server restarted with a new one) must not be kept for the page's life: forget it so the next attempt re-reads it.
  function forgetAppKey() { appKeyValue = ""; try { sessionStorage.removeItem("cc-app-key"); } catch { /* storage unavailable */ } }
  // Every POST carries the key (a wrong or missing one is a 403 the callers already show as a failed upload).
  async function keyedFetch(url, options) {
    const res = await fetch(url, { ...options, headers: { ...options.headers, "X-App-Key": await getAppKey() } });
    if (res.status === 403) forgetAppKey();
    return res;
  }
  function connect() {
    clearTimeout(reconnectTimer); reconnectTimer = 0;
    connState = "connecting"; renderConn();
    const ticket = ++connectTicket;
    getAppKey().then((key) => { if (ticket === connectTicket) openSocket(key); });
  }
  function openSocket(key) {
    const next = new WebSocket(`ws://${location.host}/?key=${encodeURIComponent(key)}`);
    socket = next;
    let everOpened = false;
    next.addEventListener("open", () => {
      everOpened = true;
      connState = "on"; renderConn();
      reconnectDelay = 1000;
      historyRequested.clear(); historyInFlight.clear(); historyRefreshAfterFlight.clear(); historyFailed.clear(); transcriptRequests.clear();
      clientPrefOverrides.clear();
      send({ type: "hello" });
      // A held action whose send was lost with the connection waits for the first state: it is dropped there if the server did apply it, resent if not.
      for (const item of pendingActions.values()) {
        if (item.sent || item.lost) continue;
        if (item.dueAt <= Date.now()) sendHeld(item.id);
        else scheduleHeld(item);
      }
      const tab = currentTab(); const seat = selectedSeat(tab);
      if (selectedView === "history" && tab && seat) requestHistory(tab, seat, true);
    });
    next.addEventListener("message", (event) => {
      try { onMessage(JSON.parse(event.data)); }
      catch (error) { console.error("Invalid Command Center message", error); }
    });
    next.addEventListener("close", () => {
      if (socket !== next) return;
      if (!everOpened) forgetAppKey();
      historyInFlight.clear(); transcriptRequests.clear();
      // What was sent and not answered before the drop may never have arrived: a held action goes back to waiting (see the next state), and
      // a stop request nobody confirmed is forgotten, so neither a tab stays hidden nor a Stop button stays disabled until a reload.
      heldActionInFlight = null;
      for (const item of pendingActions.values()) if (item.sent) { item.sent = false; item.lost = true; item.readyToSend = false; }
      for (const [runId, state] of stopStates) if (state === "requested") stopStates.delete(runId);
      killOrder = [];
      if (stopAllTrack && !stopAllTrack.accepted) stopAllTrack = null;
      for (const answer of approvalAnswers.values()) if (answer.status === "running") { answer.status = "failed"; answer.message = "Disconnected. Reconnect before answering."; }
      renderToolApproval();
      for (const [tabId, requestId] of [...pendingChatByTab]) {
        pendingChatByTab.delete(tabId);
        const request = chatRequestsById.get(requestId);
        if (!request) continue;
        if (request.sent) request.status = "disconnected";
        else chatRequestsById.delete(requestId);
      }
      // A queued message sent and not answered before the drop may or may not have arrived: the chat history after the reconnect decides.
      for (const list of queueByTab.values()) for (const item of list) if (item.state === "sending") { item.state = "unknown"; chatRequestsById.delete(item.requestId); }
      streamingByTab.clear();
      lostActions = pendingActionIds();
      // A Save in flight is neither saved nor failed: the server's revisions settle it after the reconnect.
      for (const tabId of savePending) saveStates.set(tabId, { status: "unknown", message: "The connection dropped while saving. Whether the handover was written is checked when Command Center reconnects", startRevision: findTab(tabId)?.chatRevision ?? null, startSavedRevision: findTab(tabId)?.savedRevision ?? 0, checking: true });
      savePending.clear();
      if (pendingRun) runDialogStatus("The connection dropped before the server answered. Check the seat before starting it again.", true);
      if (pendingCreate) pendingCreate.dropped = true; // the reconnect snapshot decides whether it was created
      if (refreshState?.status === "running") { refreshState = { status: "failed", at: Date.now() }; if (!$("setModal").hidden) renderSettings(); }
      connState = "off"; retryAt = Date.now() + reconnectDelay;
      renderStage(); renderConn(); ensureTicker();
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    });
    next.addEventListener("error", () => next.close());
  }
  function renderConn() {
    const box = $("conn"); if (!box) return;
    box.hidden = connState === "on";
    box.classList.toggle("off", connState === "off");
    box.innerHTML = connState === "connecting" ? '<span class="spin" aria-hidden="true"></span>Connecting to Command Center…'
      : `<span>Disconnected. Reconnecting in <b id="retryS">${Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))} s</b></span><button type="button" data-reconnect>Retry now</button>`;
    box.querySelector("[data-reconnect]")?.addEventListener("click", () => connect());
  }

  function projects() { return serverState?.projects ?? []; }
  function allTabs() { return projects().flatMap((project) => project.tabs.map((tab) => ({ project, tab }))); }
  function findTab(tabId) { return allTabs().find(({ tab }) => tab.id === tabId)?.tab ?? null; }
  function findProject(projectId) { return projects().find((project) => project.id === projectId) ?? null; }
  function hiddenProject(projectId) { return [...pendingActions.values()].some((item) => item.hideProjectId === projectId); }
  function hiddenTab(tabId) { return [...pendingActions.values()].some((item) => item.hideTabId === tabId); }
  function visibleProjects() { return projects().filter((project) => !hiddenProject(project.id)); }
  function activeEntry() {
    const wanted = serverState?.selectedTabId;
    const visible = allTabs().filter(({ project, tab }) => !hiddenProject(project.id) && !hiddenTab(tab.id));
    return visible.find(({ tab }) => tab.id === wanted) ?? visible[0] ?? null;
  }
  function currentTab() { return activeEntry()?.tab ?? null; }
  function currentProject() { return activeEntry()?.project ?? null; }
  function engineSeat(tab, slot) { return tab?.processState?.seats?.find((item) => item.slotId === slot) ?? null; }
  function seatRole(tab, seat) { return engineSeat(tab, seat?.slot)?.roleLabel ?? (seat?.isLeader ? "Leader" : seat?.cli ?? ""); }
  function leader(tab) { return tab?.crew?.find((seat) => seat.isLeader) ?? tab?.crew?.find((seat) => seat.slot === "leader") ?? tab?.crew?.[0] ?? null; }
  function leaderName(tab) { return leader(tab)?.name ?? "the leader"; }
  function seatFor(tab, slot) { return tab?.crew?.find((seat) => seat.slot === slot) ?? null; }
  function selectedSeat(tab) {
    if (!tab) return null;
    const key = selectedSeatByTab.get(tab.id);
    return tab.crew.find((seat) => seat.slot === key) ?? leader(tab);
  }
  function seatKeyOf(tab, seat) { return seat?.seatKey ?? `${tab.id}.${seat?.slot}`; }
  function liveRuns(tab, seat) { return (tab?.runs ?? []).filter((run) => run.seatSlotId === seat?.slot && run.status === "working"); }
  // A crew seat with working runs keeps its model, effort and CLI until they end (the server refuses too); the leader never locks.
  // An unconfirmed stop (launchSafety.uncertain) may still be running, so it locks the seat too; the server counts it the same way.
  function seatLocked(tab, seat) { return Boolean(seat) && !seat.isLeader && (liveRuns(tab, seat).length > 0 || uncertainRows().some((row) => (row.seatKey ?? row.seatId) === seatKeyOf(tab, seat))); }
  const LOCK_TIP = "Model, effort and tool can change when its runs finish.";
  function activeTabBusy(tab) { return Boolean(tab?.derived?.busy || (tab?.runs ?? []).some((run) => run.status === "working")); }
  function processLabel(id) { return PROCESSES.find((item) => item.id === id)?.name ?? id; }
  function kindLabel(id) { return KINDS.find((item) => item.id === id)?.name ?? id; }
  function tabLabel(tabId) { for (const { project, tab } of allTabs()) if (tab.id === tabId) return `${project.name} / ${tab.name}`; return ""; }
  function folderName(value) { return String(value ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? String(value ?? ""); }
  // Which preset a seat wears: its own saved preset, else the default for its slot.
  function avatarKeyFor(seat) {
    const key = String(seat?.pic ?? "").match(/^\/?avatars\/([a-z]+)\.svg$/)?.[1];
    if (key && AVATAR_PRESETS.includes(key)) return key;
    return SLOT_PRESET[seat?.slot] ?? NAME_PRESET[String(seat?.name ?? "").toLowerCase()] ?? "ash";
  }
  // An uploaded seat picture is exactly the route the server hands back from POST /api/avatar, nothing else.
  const UPLOADED_PIC = /^\/api\/avatar\/avatar-[0-9a-f-]{36}\.(?:png|jpg|webp)$/i;
  function seatPic(seat) {
    const value = String(seat?.pic ?? "");
    if (UPLOADED_PIC.test(value)) return value;
    return `/avatars/${avatarKeyFor(seat)}.svg`;
  }
  function picHasCrown(seat) { return !UPLOADED_PIC.test(String(seat?.pic ?? "")) && CROWNED_PRESETS.has(avatarKeyFor(seat)); }
  // An uploaded picture is a data URL of up to 512 KB: copied into every user message it would be rebuilt with each state message. It is
  // turned into one short blob URL instead, kept for as long as the picture is the same. No escaping here: img() and .src take it as is.
  let mePicCache = { av: "", url: "" };
  function mePic() {
    if (!/^data:image\//.test(me.av)) return `/avatars/${me.av}`;
    if (mePicCache.av !== me.av) {
      try {
        const bytes = Uint8Array.from(atob(me.av.slice(me.av.indexOf(",") + 1)), (char) => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: me.av.slice(5, me.av.indexOf(";")) }));
        if (mePicCache.url) URL.revokeObjectURL(mePicCache.url);
        mePicCache = { av: me.av, url };
      } catch { return me.av; }
    }
    return mePicCache.url;
  }
  // A picture that fails to load falls back exactly once: the fallback never retries itself.
  function img(src, fallback, attrs = "") { return `<img src="${esc(src)}" data-fallback="${esc(fallback)}" alt=""${attrs}>`; }
  function seatImg(seat, attrs = "") { return img(seatPic(seat), `/avatars/${SLOT_PRESET[seat?.slot] ?? "ash"}.svg`, attrs); }
  function logo(cli, size = 12, pad = 3) {
    const brand = MODEL_BRAND[cli];
    const path = window.CC_LOGOS?.[brand?.[0]];
    if (!brand || !path) return `<span class="lg" aria-hidden="true" style="width:${size + pad * 2}px;height:${size + pad * 2}px">${esc((isAcpCli(cli) ? cliLabel(cli) : cli)?.[0]?.toUpperCase() ?? "?")}</span>`;
    return `<span class="lg" aria-hidden="true" style="width:${size + pad * 2}px;height:${size + pad * 2}px"><svg width="${size}" height="${size}" viewBox="0 0 24 24"><path fill="${brand[1]}" d="${esc(path)}"/></svg></span>`;
  }
  function formatModel(cli, model, tab = null) {
    if (isAcpCli(cli)) return acpShownModel(cli, tab) ?? "CLI default";
    const info = cli === "claude" ? serverState?.claudeModels?.find((item) => (typeof item === "string" ? item : item.value) === model) : null;
    if (MODEL_LABEL[model]) return MODEL_LABEL[model];
    const discovered = typeof info === "object" && info?.displayName ? info.displayName.replace(/\s*\([^)]*context[^)]*\)\s*$/i, "") : "";
    const claudeNames = { "claude-opus-5-5[1m]": "Opus 5.5", "claude-sonnet-5": "Sonnet 5", "claude-fable-5-1": "Fable 5.1", "claude-haiku-4-5": "Haiku 4.5" };
    return claudeNames[model] ?? (discovered || model || cli || "Unknown model");
  }
  // A CLI added in Settings by its start command (Agent Client Protocol) is "acp:<id>"; it can lead a tab, in Full access only.
  const isAcpCli = (cli) => typeof cli === "string" && cli.startsWith("acp:");
  const acpCli = (cli) => (serverState?.acpClis ?? []).find((item) => item.kind === cli) ?? null;
  function cliLabel(cli) { return CLI_LABEL[cli] ?? (isAcpCli(cli) ? acpCli(cli)?.name ?? titleCase(cli.slice(4)) : titleCase(cli || "Unknown CLI")); }
  // The model an ACP CLI shows: the one reported by THIS tab's leader (null until its session has started), else the one that CLI reported last time it ran anywhere (config lastModel).
  const acpShownModel = (cli, tab) => tab?.acpLeader?.model ?? acpCli(cli)?.lastModel ?? null;
  function pref(key, fallback = false) {
    if (clientPrefOverrides.has(key)) return clientPrefOverrides.get(key);
    return serverState?.clientPrefs?.[key] ?? fallback;
  }
  function formatUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    const pieces = [];
    const context = usage.contextTokens;
    const window = usage.contextWindow;
    if (context !== null && context !== undefined && Number.isFinite(Number(context))) {
      const value = Number(context).toLocaleString();
      pieces.push(window !== null && window !== undefined && Number(window) > 0 ? `${value} / ${Number(window).toLocaleString()} ctx` : `${value} ctx`);
    }
    const tokens = usage.totalTokens ?? usage.total_tokens ?? ((Number(usage.inputTokens ?? usage.input_tokens) || 0) + (Number(usage.outputTokens ?? usage.output_tokens) || 0));
    if (Number.isFinite(Number(tokens)) && Number(tokens) > 0) pieces.push(`${Number(tokens).toLocaleString()} tokens`);
    if (usage.costUsd !== null && usage.costUsd !== undefined && Number.isFinite(Number(usage.costUsd)) && Number(usage.costUsd) >= 0) pieces.push(`$${Number(usage.costUsd).toFixed(4)}`);
    if (Number.isFinite(Number(usage.turns)) && Number(usage.turns) > 0) pieces.push(`${Number(usage.turns)} ${Number(usage.turns) === 1 ? "turn" : "turns"}`);
    return pieces.length ? pieces.join(" · ") : null;
  }
  function usageTokens(usage) {
    if (!usage || typeof usage !== "object") return null;
    const total = usage.totalTokens ?? usage.total_tokens;
    if (Number.isFinite(Number(total)) && total !== null && total !== undefined) return Number(total);
    const input = usage.inputTokens ?? usage.input_tokens, output = usage.outputTokens ?? usage.output_tokens;
    if (input === undefined && output === undefined) return Number.isFinite(Number(usage.contextTokens)) && usage.contextTokens !== null && usage.contextTokens !== undefined ? Number(usage.contextTokens) : null;
    return (Number(input) || 0) + (Number(output) || 0);
  }
  const fmtK = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  function titleCase(value) { return String(value ?? "").replace(/([A-Z])/g, " $1").replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase()); }
  const cap = (value) => value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
  const joinNames = (list) => list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
  const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function agoText(ms) {
    const seconds = Math.max(0, Date.now() - Number(ms)) / 1000;
    return seconds < 60 ? "just now" : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)} h ago` : `${Math.floor(seconds / 86400)} d ago`;
  }
  function spanText(start, end) {
    const total = Math.max(0, Math.floor(((end ?? Date.now()) - start) / 1000));
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  }
  function modelOptions(cli) {
    if (isAcpCli(cli)) return ["default"];
    let values = serverState?.modelOptions?.[cli];
    if (Array.isArray(values)) return [...new Set(values.filter((item) => typeof item === "string"))];
    if (cli === "claude" && Array.isArray(serverState?.claudeModels)) return serverState.claudeModels.map((item) => typeof item === "string" ? item : item.value).filter(Boolean);
    if (cli === "opencode" && Array.isArray(serverState?.opencodeModels)) return [...new Set(serverState.opencodeModels.filter((item) => typeof item === "string"))];
    return [];
  }
  function effortOptions(cli) { return Array.isArray(serverState?.effortOptions?.[cli]) ? serverState.effortOptions[cli] : []; }
  function modelSupportsEffort(cli, model) {
    if (isAcpCli(cli)) return false;
    if (cli !== "claude") return true;
    const info = serverState?.claudeModels?.find((item) => typeof item === "object" && item.value === model);
    return info?.supportsEffort !== false;
  }
  function modelLine(cli, model, effort, tab = null) { return `${formatModel(cli, model, tab)}${modelSupportsEffort(cli, model) && effort ? ` · ${effort}` : ""}`; }
  function recordActivity(text, type = "", tabId = null) {
    activity.unshift({ id: `${Date.now()}-${Math.random()}`, text, type, tabId, at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
    activity = activity.slice(0, 80);
  }
  // The server keeps every launch notice until it is acknowledged, and each launch also arrives as its own leaderLaunch message: the Activity
  // feed shows a notice once, when its id is first seen (however many notices pile up or fall off the feed's 80), and updates that line in
  // place if the outcome later gets confirmed.
  function noticeText(notice) { return `${notice.source ?? "Command Center"} requested ${notice.seatName ?? notice.seatId}${notice.headsUp ? ` · heads up: ${notice.headsUp}` : ""}${notice.pending ? " · outcome unconfirmed" : ""}`; }
  function noteNotice(notice) {
    if (!notice?.id) return;
    const text = noticeText(notice), known = seenNotices.get(notice.id);
    if (known === text) return;
    seenNotices.set(notice.id, text);
    if (known === undefined) {
      recordActivity(text, notice.pending ? "waiting" : "working", tabIdOfKey(notice.seatKey ?? notice.seatId));
      activity[0].noticeId = notice.id;
    } else {
      const entry = activity.find((item) => item.noticeId === notice.id);
      if (entry) { entry.text = text; entry.type = notice.pending ? "waiting" : "working"; }
    }
  }
  function addStateNotices(state) {
    const notices = state?.launchSafety?.notices ?? [];
    for (const notice of notices) noteNotice(notice);
    const ids = new Set(notices.map((notice) => notice.id));
    for (const id of seenNotices.keys()) if (!ids.has(id)) seenNotices.delete(id);
  }
  function tabIdOfKey(key) { const value = String(key ?? ""); const dot = value.lastIndexOf("."); return dot > 0 ? value.slice(0, dot) : null; }
  // A tab-scoped seat key names its tab and slot; an old bare seat ID belongs to no tab.
  function seatOfKey(key) {
    const value = String(key ?? ""); const dot = value.lastIndexOf(".");
    if (dot > 0) { const tab = findTab(value.slice(0, dot)); return { tab, seat: seatFor(tab, value.slice(dot + 1)), slot: value.slice(dot + 1), key: value, legacy: false }; }
    return { tab: null, seat: null, slot: value, key: value, legacy: true };
  }
  function seatNameOfKey(key) { return seatOfKey(key).seat?.name ?? String(key ?? "A seat"); }
  // The events worth a signal. The desktop notice follows Notifications; the chime follows the sound button, on its own.
  function notableEvent(kind) {
    if (["routine", "internal-stop"].includes(kind)) return false;
    if (kind === "leader-turn") return !document.hasFocus();
    return ["worker-finish", "worker-fail", "worker-stall", "needs-user"].includes(kind);
  }
  // The bell's volume, a whole percent the server keeps and validates (server/config.ts isBellVolume): 100 is the full bell.
  function bellVolume() { return pref("bellVolume", 100); }
  // One audio context for the whole session: a fresh one per beep spends the whole short tone starting up, so nothing is heard.
  let bellAudioCtx = null;
  // Every bell follows the sound switch and the saved volume. Test passes the slider's own level instead, and plays even while the sound is off.
  function playCompletionSound(testVolume = null) {
    if (testVolume === null && !pref("bellEnabled", false)) return;
    const level = (testVolume ?? bellVolume()) / 100;
    if (!(level > 0)) return; // 0% plays nothing at all
    try {
      const Audio = window.AudioContext ?? window.webkitAudioContext;
      if (!Audio) return;
      const context = bellAudioCtx ??= new Audio();
      // A struck bell, twice: a 2 kHz strike, then a lower 1.78 kHz strike 0.45 s later (ding-dong). Inharmonic partials (ratio, level, ring seconds) reach 5.5 kHz, where the ear is most sensitive.
      // Partial levels are divided by their sum and scaled by a gain measured offline (browser test) so the rendered peak sits just under full scale at 100%; the volume scales that gain, and the limiter is only a catch near 0 dBFS, not a squash.
      // The first strike is damped over its last 50 ms so the second one has a fresh, sharp attack.
      const tone = () => {
        const now = context.currentTime;
        const partials = [[1, 1, 1.2], [1.51, 0.5, 1], [2, 0.4, 0.85], [2.76, 0.3, 0.6]];
        const total = partials.reduce((sum, [, level]) => sum + level, 0);
        const master = context.createGain(); master.gain.value = 1.2 / total * level;
        const limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.1;
        master.connect(limiter); limiter.connect(context.destination);
        for (const [strike, pitch] of [[0, 2000], [0.45, 1780]]) {
          for (const [ratio, level, ring] of partials) {
            const at = now + strike; const oscillator = context.createOscillator(); const gain = context.createGain();
            const end = strike === 0 ? 0.45 : ring;
            oscillator.type = "sine"; oscillator.frequency.value = pitch * ratio;
            gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(level, at + 0.004);
            gain.gain.exponentialRampToValueAtTime(level * 0.75, at + 0.4); gain.gain.exponentialRampToValueAtTime(0.0001, at + end);
            oscillator.connect(gain); gain.connect(master); oscillator.start(at); oscillator.stop(at + end);
          }
        }
      };
      if (context.state === "suspended") context.resume().then(tone).catch(() => {}); else tone();
    } catch { /* audio can be unavailable until the browser grants playback */ }
  }
  function notify(kind, title, body) {
    if (!notableEvent(kind)) return false;
    try {
      if (pref("notificationsEnabled", true) && "Notification" in window && Notification.permission === "granted") new Notification(title, { body });
    } catch { /* desktop notifications are optional */ }
    playCompletionSound();
    return true;
  }
  // `previous` is the state before this one: the first state after a page load has none, and what is already waiting then is not new.
  function newApprovalRequests(previous, next) {
    if (!previous) return;
    const oldTabs = new Map((previous.projects ?? []).flatMap((project) => project.tabs).map((tab) => [tab.id, tab]));
    for (const tab of (next?.projects ?? []).flatMap((project) => project.tabs)) {
      const oldIds = new Set((oldTabs.get(tab.id)?.pendingApprovals ?? []).map((item) => item.approvalId));
      for (const item of tab.pendingApprovals ?? []) if (!oldIds.has(item.approvalId)) notify("needs-user", `${leaderName(tab)} needs your answer`, `${tab.name}: ${String(item.summary).split("\n")[0].slice(0, 200)}`);
      if (tab.processState?.approval?.state === "pending" && oldTabs.get(tab.id)?.processState?.approval?.state !== "pending") {
        notify("needs-user", "Your look is needed", `${tab.name} is waiting for your approval.`);
      }
    }
  }
  function chatInfo(tabId, message) {
    const old = chatMeta.get(tabId) ?? {};
    const next = { ...old };
    if (Number.isSafeInteger(message.revision)) next.revision = message.revision;
    if (Number.isSafeInteger(message.savedRevision)) next.savedRevision = message.savedRevision;
    if (Number.isFinite(message.at)) next.lastAt = message.at;
    if (Array.isArray(message.messages)) {
      const latest = message.messages.at(-1);
      if (Number.isFinite(latest?.at)) next.lastAt = latest.at;
    }
    chatMeta.set(tabId, next);
  }
  // Server-confirmed facts settle the client-side waits: a new tab or project appearing, a preset picture saved, a Save confirmed after a reconnect, every stopped run exiting.
  function settleFromState() {
    // The next step's button appears in the same spot as the one just clicked: it ignores clicks for a moment so a fast multi-click cannot walk several steps.
    // The guard starts when the step (or look approval) of a tab with a sent step action actually changes, however late that state arrives.
    const seen = new Set();
    for (const { tab } of allTabs()) {
      seen.add(tab.id);
      const steps = tab.derived?.stepBar ?? [], signature = `${steps.findIndex((step) => step.state === "current")}|${tab.processState?.approval?.state ?? ""}|${tab.processState?.phase ?? ""}|${tab.processState?.round ?? ""}|${tab.processState?.selectedMakerSlotId ?? ""}`;
      const moved = tabStepSignature.has(tab.id) && tabStepSignature.get(tab.id) !== signature;
      if (moved && stepActionSent.delete(tab.id)) stepClickGuard.set(tab.id, Date.now() + STEP_CLICK_GUARD_MS);
      tabStepSignature.set(tab.id, signature);
      // A step button stays "Sending…" until the server's state shows the step moved (or its refusal arrives, or a few seconds pass): a state that
      // was already on its way when the button was clicked must not turn it back on before the server has acted, or a double-click skips a step.
      if (processPending.has(tab.id) && (moved || Date.now() - (processPendingSince.get(tab.id) ?? 0) > PROCESS_PENDING_MS)) { processPending.delete(tab.id); processPendingSince.delete(tab.id); }
    }
    for (const tabId of [...tabStepSignature.keys()]) if (!seen.has(tabId)) { tabStepSignature.delete(tabId); stepActionSent.delete(tabId); }
    for (const tabId of [...processPending.keys()]) if (!seen.has(tabId)) { processPending.delete(tabId); processPendingSince.delete(tabId); }
    if (pendingCreate?.kind === "tab") {
      const project = findProject(pendingCreate.projectId);
      const added = project?.tabs.find((tab) => !pendingCreate.knownTabIds.has(tab.id));
      if (added) { pendingCreate = null; updateCreateButtons(); closeLayerOf($("modal")); showToast(`${added.name} tab created`); }
    } else if (pendingCreate?.kind === "project") {
      const added = findProject(pendingCreate.id);
      if (added) { pendingCreate = null; updateCreateButtons(); closeLayerOf($("projModal")); showToast(`${added.name} created`); }
    }
    if (pendingCreate?.dropped && connState === "on") {
      const statusId = pendingCreate.kind === "tab" ? "tStat" : "npStat";
      pendingCreate = null;
      $(statusId).textContent = "Not sure it was created. Check the tabs, then try again"; $(statusId).classList.add("bad");
      updateCreateButtons();
    }
    if (avatarPending) {
      const seat = seatFor(findTab(avatarPending.tabId), avatarPending.slot);
      if (!seat) avatarPending = null;
      else if (seat.pic === avatarPending.pic) { avatarPending = null; if ($("avatarStatus")) { $("avatarStatus").textContent = ""; $("avatarStatus").dataset.status = "done"; } }
    }
    for (const [tabId, state] of saveStates) {
      const tab = findTab(tabId);
      if (!tab) { saveStates.delete(tabId); continue; }
      if (state.status !== "unknown" || connState !== "on") continue;
      if (Number.isSafeInteger(state.startRevision) && Number.isSafeInteger(tab.savedRevision) && tab.savedRevision >= state.startRevision && tab.savedRevision > (state.startSavedRevision ?? 0)) {
        saveStates.delete(tabId); recordActivity("Save confirmed after reconnecting", "done", tabId); showToast(`${tab.name}: the handover save was confirmed`);
      } else saveStates.set(tabId, { ...state, checking: false, message: "The connection dropped before the server confirmed the save, and its saved revision did not move. Save again to be sure" });
    }
    const workingIds = new Set(allTabs().flatMap(({ tab }) => (tab.runs ?? []).filter((run) => run.status === "working").map((run) => run.runId)));
    for (const runId of stopStates.keys()) if (!workingIds.has(runId)) stopStates.delete(runId);
    if (stopAllTrack?.accepted) reportStopAll(workingIds);
  }
  // A live run's log: the server's state carries the tail it holds (up to 200 KiB) for every running run, and each output chunk after it is appended.
  // Taking that tail from every state is what makes a reload start with the earlier lines, and a reconnect (or the server's "fell behind" resync)
  // fill the chunks that were missed. A finished run's log is dropped: its saved log opens from History.
  function rebaseRunOutput(state) {
    const live = new Set();
    for (const { tab } of (state?.projects ?? []).flatMap((project) => project.tabs.map((tab) => ({ tab })))) {
      for (const run of tab.runs ?? []) {
        if (run.status !== "working") continue;
        live.add(run.runId);
        if (typeof run.output === "string") outputByRun.set(run.runId, run.output.length > MAX_OUTPUT_CHARS ? run.output.slice(-MAX_OUTPUT_CHARS) : run.output);
      }
    }
    for (const runId of [...outputByRun.keys()]) if (!live.has(runId)) outputByRun.delete(runId);
    for (const runId of [...stallActions.keys()]) if (!live.has(runId)) stallActions.delete(runId);
  }
  // Appends one chunk; true when the front of the log had to be cut to stay within the cap (the shown text then cannot just be extended).
  function appendOutput(runId, chunk) {
    const next = (outputByRun.get(runId) ?? "") + chunk;
    const trimmed = next.length > MAX_OUTPUT_CHARS;
    outputByRun.set(runId, trimmed ? next.slice(-MAX_OUTPUT_CHARS) : next);
    return trimmed;
  }
  function runEndBody(tab, message) {
    const run = (tab?.runs ?? []).find((item) => item.runId === message.runId);
    const label = mdPlain(message.label ?? run?.label);
    if (message.message) return String(message.message);
    if (message.type === "runFinish") return label ? `${label} finished.` : "The run finished.";
    const code = Number.isInteger(message.exitCode) ? `, exit ${message.exitCode}` : "";
    return label ? `${label} failed (${message.outcome ?? "failed"}${code}).` : `The run failed (${message.outcome ?? "failed"}${code}).`;
  }
  function uncertainRows() { return serverState?.launchSafety?.uncertain ?? []; }
  function uncertainRun(runId) { return uncertainRows().some((row) => row.runId === runId); }
  function reportStopAll(workingIds) {
    const track = stopAllTrack; if (!track) return;
    const remaining = [...track.runIds].filter((id) => workingIds.has(id));
    const unconfirmed = remaining.filter((id) => uncertainRun(id));
    if (remaining.length > unconfirmed.length) return;
    stopAllTrack = null;
    const exited = track.runIds.size - remaining.length;
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    if (!track.runIds.size) return;
    if (unconfirmed.length) showToast(`Stop all: ${plural(exited, "run")} exited, ${unconfirmed.length} not confirmed and may still be running. Needs you has Try again and Release`);
    else showToast(`Stop sent: all ${plural(exited, "run")} exited. Leaders were told to stop`);
    for (const tabId of track.tabIds) recordActivity(unconfirmed.length ? `Stop all: ${plural(exited, "run")} exited, ${unconfirmed.length} not confirmed` : "Stop all: every run exited", unconfirmed.length ? "failed" : "stopped", tabId);
  }
  function onMessage(message) {
    // Settings "Check again": the server answers its refreshSettings request with an actionResult, or an error, carrying the page's requestId.
    if ((message.type === "actionResult" || message.type === "error") && typeof message.requestId === "string" && refreshState?.status === "running" && refreshState.requestId === message.requestId) {
      refreshState = { status: message.type === "error" ? "failed" : "done", at: Date.now() };
      if (!$("setModal").hidden) renderSettings();
      if (message.type === "actionResult") return;
    }
    if ((message.type === "actionResult" || message.type === "error") && typeof message.requestId === "string" && message.action !== "answerApproval") {
      retireAction({ requestId: message.requestId, status: message.type === "error" ? "failed" : "done", message: message.type === "error" ? message.message ?? "Failed" : "Done" });
    }
    if ((message.type === "actionResult" || message.type === "error") && message.action === "answerApproval") {
      const item = [...approvalAnswers.values()].find((item) => item.requestId === message.requestId);
      if (item) { item.status = message.type === "error" ? "failed" : "done"; item.message = message.message ?? ""; renderToolApproval(); }
      return;
    }
    if (message.type === "actionResult") { renderAll(); return; }
    if (message.type === "state") {
      const previous = serverState;
      serverState = message;
      for (const item of listedActions()) retireAction(item);
      const listedIds = new Set(listedActions().map((item) => item?.requestId));
      for (const id of pendingActionIds()) {
        if (listedIds.has(id)) seenListedActions.add(id);
        else if (seenListedActions.has(id) || lostActions.has(id)) retireAction({ requestId: id, status: "unknown", message: "" });
      }
      const stillPending = pendingActionIds();
      for (const id of seenListedActions) if (!stillPending.has(id)) seenListedActions.delete(id);
      lostActions = new Set();
      const tabIds = new Set(allTabs().map(({ tab }) => tab.id));
      for (const map of [permissionActionResults, requestActionResults, requestFormCleared]) for (const id of map.keys()) if (!tabIds.has(id)) map.delete(id);
      const requestKeys = new Set((message.requests ?? []).map((request) => `request-resolve-${request.id}`));
      for (const key of settingsActionResults.keys()) if (key.startsWith("request-resolve-") && !requestKeys.has(key)) settingsActionResults.delete(key);
      const removalKeys = new Set(Object.entries(message.settings?.skills ?? {}).flatMap(([cli, inventory]) => [
        ...(inventory.mcpServers ?? []).map((server) => `mcp-remove-${cli}-${server.name}`),
        ...(cli === "claude" ? (inventory.plugins ?? []).map((name) => `plugin-remove-${name}`) : []),
      ]));
      for (const key of settingsActionResults.keys()) if ((key.startsWith("mcp-remove-") || key.startsWith("plugin-remove-")) && !removalKeys.has(key)) settingsActionResults.delete(key);
      for (const [key, value] of clientPrefOverrides) {
        const actual = message.clientPrefs?.[key];
        if (JSON.stringify(actual) === JSON.stringify(value)) clientPrefOverrides.delete(key);
      }
      applyServerLooks();
      rebaseRunOutput(message);
      $("setBody").querySelectorAll("[data-setting]").forEach((button) => button.setAttribute("aria-checked", String(settingValue(button.dataset.setting))));
      addStateNotices(message);
      newApprovalRequests(previous, message);
      settleConfirmedActions();
      settleFromState();
      // The state carries the step line too, so a page that connected mid-reply shows it.
      for (const { tab } of allTabs()) { if (tab.leaderActivity && tab.derived?.leaderTurnActive) stepByTab.set(tab.id, tab.leaderActivity); else stepByTab.delete(tab.id); }
      for (const tabId of [...flushArmed]) flushQueue(tabId);
      renderAll();
      return;
    }
    if (message.type === "leaderActivity") {
      if (typeof message.label === "string" && message.label) stepByTab.set(message.tabId, message.label); else stepByTab.delete(message.tabId);
      paintStep(message.tabId);
      return;
    }
    if (message.type === "chatHistory") {
      transcriptRequests.delete(message.tabId);
      const messages = Array.isArray(message.messages) ? message.messages : [];
      const requestIds = new Set(messages.filter((item) => item?.role === "user").map((item) => item.requestId).filter((id) => typeof id === "string"));
      for (const request of [...chatRequestsById.values()]) {
        if (request.tabId !== message.tabId || !request.sent || !["disconnected", "abandoned"].includes(request.status)) continue;
        settleChatRequest(request, requestIds.has(request.requestId));
      }
      for (const item of [...queueFor(message.tabId)]) if (item.state === "unknown") {
        if (requestIds.has(item.requestId)) removeQueued(message.tabId, item); else { item.state = "waiting"; item.requestId = null; }
      }
      transcripts.set(message.tabId, messages);
      chatInfo(message.tabId, message);
      streamingByTab.delete(message.tabId);
      renderStage();
      for (const tabId of [...flushArmed]) flushQueue(tabId);
      return;
    }
    if (message.type === "chatMessage") {
      const list = transcripts.get(message.tabId) ?? [];
      // The server sends no id: a tab's revision is the unique, increasing key. No numeric revision = never dropped.
      const fresh = !Number.isFinite(message.revision) || !list.some((item) => item.revision === message.revision);
      if (!Number.isFinite(message.revision)) list.push(message);
      else if (fresh) {
        const at = list.findIndex((item) => item.revision > message.revision);
        if (at < 0) list.push(message); else list.splice(at, 0, message);
      }
      transcripts.set(message.tabId, list);
      chatInfo(message.tabId, message);
      // The reply so far was written down because a message was steered into it: the draft on screen is now that message, and the rest streams below the steer.
      if (message.split) streamingByTab.delete(message.tabId);
      if (message.role === "user") {
        const request = chatRequestsById.get(message.requestId);
        if (request?.tabId === message.tabId) settleChatRequest(request, true);
      }
      if (message.tabId === currentTab()?.id) renderStage();
      if (fresh && message.role === "assistant") markUnread(message.tabId);
      if (message.role !== "notice") recordActivity(message.role === "user" || message.type === "user" ? "You sent a message" : `${leaderName(findTab(message.tabId))} replied`, "", message.tabId);
      renderSide();
      return;
    }
    if (message.type === "chatDelta") {
      const draft = streamingByTab.get(message.tabId) ?? "";
      streamingByTab.set(message.tabId, draft + String(message.text ?? ""));
      if (message.tabId === currentTab()?.id) streamDraftUpdate(message.tabId);
      return;
    }
    if (message.type === "chatDone") {
      replyEnds.set(message.tabId, { kind: "done" });
      streamingByTab.delete(message.tabId); stepByTab.delete(message.tabId);
      chatInfo(message.tabId, message);
      if (message.tabId === currentTab()?.id) { updateChatLoading(message.tabId); renderStage(); }
      if (queueFor(message.tabId).length) { flushArmed.add(message.tabId); flushQueue(message.tabId); }
      notify("leader-turn", "The lead finished", "Your reply is ready.");
      recordActivity(`${leaderName(findTab(message.tabId))} finished a reply`, "done", message.tabId); renderSide();
      return;
    }
    if (message.type === "chatNotice") {
      // A note about an old leader process: it never ends, clears or fails the turn that is running now.
      const noticeTab = findTab(message.tabId)?.name;
      showToast(message.tabId === currentTab()?.id ? String(message.message ?? "") : (noticeTab ? noticeTab + ": " : "A background tab: ") + String(message.message ?? ""));
      return;
    }
    if (message.type === "chatError") {
      streamingByTab.delete(message.tabId); stepByTab.delete(message.tabId);
      // A stopped or failed reply: nothing queued goes out on its own now; each message waits for its own Send click.
      holdQueue(message.tabId);
      chatInfo(message.tabId, message);
      if (message.tabId === currentTab()?.id) { updateChatLoading(message.tabId); renderStage(); }
      const errorText = message.message ?? "The lead could not reply";
      const tabName = findTab(message.tabId)?.name;
      markUnread(message.tabId);
      notify("leader-turn", "The lead could not reply", errorText);
      showToast(message.tabId === currentTab()?.id ? errorText : (tabName ? tabName + ": " : "A background tab: ") + errorText);
      return;
    }
    if (message.type === "chatCleared" || message.type === "chatRestored") {
      if (message.type === "chatCleared") { clearQueue(message.tabId); replyEnds.set(message.tabId, { kind: "cleared" }); stepByTab.delete(message.tabId); }
      transcripts.set(message.tabId, message.messages ?? []);
      chatInfo(message.tabId, message);
      if (message.type === "chatCleared" && message.noUndo) {
        const previous = clearUndos.get(message.tabId); if (previous) clearTimeout(previous.timer);
        clearUndos.delete(message.tabId);
        recordActivity("Chat cleared", "", message.tabId);
      } else if (message.type === "chatCleared") {
        const previous = clearUndos.get(message.tabId); if (previous) clearTimeout(previous.timer);
        const undo = { sent: false, timer: 0, dueAt: Date.now() + 10000 };
        undo.timer = setTimeout(() => { clearUndos.delete(message.tabId); renderUndo(); }, 10000);
        clearUndos.set(message.tabId, undo);
        recordActivity("Chat cleared", "", message.tabId);
      } else {
        const undo = clearUndos.get(message.tabId); if (undo) clearTimeout(undo.timer);
        clearUndos.delete(message.tabId);
        showToast("Chat restored");
      }
      if (message.tabId === currentTab()?.id) renderStage();
      renderUndo();
      return;
    }
    if (message.type === "chatUndoRejected") {
      if (message.reason === "busy") {
        const held = clearUndos.get(message.tabId); if (held) held.sent = false; renderUndo();
        showToast("Undo is not possible while the leader is answering or saving; try again when it is done.");
        return;
      }
      const undo = clearUndos.get(message.tabId); if (undo) clearTimeout(undo.timer);
      clearUndos.delete(message.tabId); renderUndo();
      showToast(message.reason === "expired" ? "Undo expired" : "This cleared chat is no longer available");
      return;
    }
    if (message.type === "saved") {
      chatInfo(message.tabId, message); savePending.delete(message.tabId); saveStates.delete(message.tabId);
      // A successful Save writes one entry to the leader's Past sessions (the server's history for seat <tab>.<leader slot>): list it again.
      { const saved = findTab(message.tabId), lead = leader(saved); if (saved && lead) requestHistory(saved, lead, true); }
      if (message.tabId === currentTab()?.id) renderStage();
      recordActivity("Saved the handover", "done", message.tabId);
      showToast("Saved"); renderAll(); return;
    }
    if (message.type === "output") {
      const chunk = String(message.chunk ?? "");
      updateRunOutput(message.runId, chunk, appendOutput(message.runId, chunk));
      return;
    }
    if (message.type === "rateLimit") {
      rateWindowsByRun.set(message.runId, message.windows);
      renderMeters();
      return;
    }
    if (message.type === "runStart") {
      const seat = findTab(message.tabId)?.crew?.find((item) => item.seatKey === message.seatKey);
      recordActivity(`${seat?.name ?? seatNameOfKey(message.seatKey)} started ${message.model ? formatModel(seat?.cli, message.model) : "a run"}`, "working", message.tabId ?? tabIdOfKey(message.seatKey)); renderSide();
      return;
    }
    if (["runFinish", "runFail", "runStop"].includes(message.type)) {
      const tab = findTab(message.tabId) ?? findTab(tabIdOfKey(message.seatKey));
      const seat = tab?.crew?.find((item) => item.seatKey === message.seatKey || (!message.seatKey && item.slot === message.slot));
      if (tab && seat) requestHistory(tab, seat, true);
      if (seat && message.type !== "runStop") {
        const verb = message.type === "runFinish" ? "finished" : "failed";
        const kind = seat.isLeader ? "leader-turn" : message.type === "runFinish" ? "worker-finish" : "worker-fail";
        notify(kind, `${seat.name} ${verb}`, runEndBody(tab, message));
      }
      recordActivity(`${seat?.name ?? message.seatKey ?? "A seat"} ${message.type === "runFinish" ? "finished" : message.type === "runFail" ? "failed" : "stopped a run"}`, message.type === "runFail" ? "failed" : message.type === "runStop" ? "stopped" : "done", tab?.id ?? tabIdOfKey(message.seatKey)); renderSide();
      return;
    }
    if (message.type === "runStalled") {
      const seat = (findTab(message.tabId) ?? findTab(tabIdOfKey(message.seatKey)))?.crew?.find((item) => item.seatKey === message.seatKey);
      // The server says what it does about it: "relaunch" (it stops the run and starts it once more) or "escalate" (it leaves it for you).
      const action = message.action === "relaunch" ? "relaunch" : "escalate";
      if (typeof message.runId === "string") stallActions.set(message.runId, action);
      if (seat) notify(seat.isLeader ? "leader-turn" : "worker-stall", `${seat.name} is stalled`, action === "relaunch" ? "No output for 5 minutes. It is being stopped and started once more." : "Check the run before it can continue.");
      recordActivity(`${seat?.name ?? message.seatKey ?? "A seat"} stalled`, "waiting", message.tabId ?? tabIdOfKey(message.seatKey)); renderSide(); return;
    }
    if (message.type === "leaderLaunch") { noteNotice(message); renderAll(); return; }
    if (message.type === "historyList") {
      const key = message.seatKey;
      historyInFlight.delete(key); historyFailed.delete(key);
      historyBySeat.set(key, message.runs ?? []);
      if (historyRefreshAfterFlight.delete(key)) {
        historyRequested.delete(key);
        const owner = historyOwner(key);
        if (owner) requestHistory(owner.tab, owner.seat);
      }
      renderStage(); return;
    }
    if (message.type === "historyRun") {
      if (!Number.isSafeInteger(message.timestamp) || historyRunRequested.get(message.seatKey) !== message.timestamp) return;
      const detailKey = `${message.seatKey}:${message.timestamp}`;
      historyDetails.set(detailKey, { ...message, full: message.full === true });
      historyFullRequested.delete(detailKey);
      renderStage(); return;
    }
    if (message.type === "runAccepted") {
      if (pendingRun && pendingRun.tabId === message.tabId) {
        const seat = seatFor(findTab(pendingRun.tabId), pendingRun.slot);
        pendingRun = null;
        closeLayerOf($("runModal"));
        showToast(`${seat?.name ?? "The seat"} started`);
      }
      renderAll(); return;
    }
    if (message.type === "folderBusy") {
      // The server held this message or run because another agent is working in the folder: nothing was sent, so the lock, the draft and the attachments are released untouched.
      const request = message.action === "chat" ? chatRequestsById.get(message.requestId) : null;
      // A queued message that was held back never goes out on its own afterwards: only the confirm below (or its button) sends it.
      const queued = request?.tabId === message.tabId ? request.queueItem : null;
      if (queued) queued.held = true;
      if (request?.tabId === message.tabId) settleChatRequest(request, false);
      if (message.action === "run" && pendingRun && pendingRun.tabId === message.tabId) { pendingRun = null; runDialogStatus("Another agent is working in this folder.", false); }
      if (message.tabId === currentTab()?.id) updateChatLoading(message.tabId);
      const lines = (Array.isArray(message.items) ? message.items : []).map(folderBusyLine);
      const body = `${lines.join(" ")} Working in the same files can overwrite each other's changes.`;
      // The selected tab is shared server state: if it moved while this warning was open, Continue would resend another tab's draft.
      const again = () => (message.tabId !== currentTab()?.id ? showToast(`${findTab(message.tabId)?.name ?? "That tab"} is no longer selected. Select it and send again.`) : message.action === "run" ? startRun(true) : queued ? goQueued(message.tabId, queued.id, true) : sendChat(true));
      if (message.tabId !== currentTab()?.id) showToast(`${findTab(message.tabId)?.name ?? "A background tab"}: another agent is working in this folder. Send again to choose.`);
      else confirmAction({ title: "Another agent is working in this folder", body, ok: "Continue anyway", cancel: "Cancel" }, again, message.action === "run" ? $("runStart") : $("ci"));
      renderAll(); return;
    }
    if (message.type === "projectRules") { showToast(message.message); return; } // what happened to the AGENTS.md of a ticked "Work on this project only"
    if (message.type === "steerRefused") {
      // The server did not push the message into the reply (an approval is waiting, Save runs, the leader is not up yet): it stays where it is in the queue.
      const request = chatRequestsById.get(message.requestId);
      if (request?.tabId === message.tabId) settleChatRequest(request, false);
      showToast(message.message ?? "That message could not be steered into the reply");
      renderAll(); return;
    }
    if (message.type === "killAccepted") {
      const asked = killOrder.indexOf(message.runId); if (asked >= 0) killOrder.splice(asked, 1);
      if (stopStates.get(message.runId) === "requested") stopStates.set(message.runId, "accepted");
      renderAll(); return;
    }
    if (message.type === "stopAllAccepted") {
      if (stopAllTrack && !stopAllTrack.accepted) {
        stopAllTrack.accepted = true;
        for (const id of stopAllTrack.runIds) if (stopStates.get(id) === "requested") stopStates.set(id, "accepted");
        const runs = stopAllTrack.runIds.size, tabs = stopAllTrack.tabIds.size;
        showToast(runs ? `Stop accepted; waiting for exits: ${runs} run${runs === 1 ? "" : "s"} in ${tabs} tab${tabs === 1 ? "" : "s"}` : `Stop sent to ${tabs} tab${tabs === 1 ? "" : "s"}. No runs were working`);
        for (const tabId of stopAllTrack.tabIds) recordActivity(runs ? "Stop all accepted: waiting for runs to exit" : "Stop all: stop sent", "stopped", tabId);
        if (!runs) stopAllTrack = null;
      }
      renderAll(); return;
    }
    if (message.type === "settingsRefreshed") {
      // Untagged: it may refresh the shown data, but only the reply carrying the running refresh's requestId ends that refresh (above).
      if (!$("setModal").hidden) renderSettings();
      return;
    }
    if (message.type === "error") {
      if (message.action === "selectTab" && typeof message.tabId === "string") transcriptRequests.delete(message.tabId);
      if (message.action === "historyList") for (const key of message.seatKey ? [message.seatKey] : [...historyInFlight]) { historyInFlight.delete(key); historyFailed.add(key); historyRequested.delete(key); }
      if (message.action === "save" && typeof message.tabId === "string") {
        savePending.delete(message.tabId);
        saveStates.set(message.tabId, { status: "failed", message: message.message ?? "Save failed" });
        if (message.tabId === currentTab()?.id) renderStage();
        recordActivity("Save failed", "failed", message.tabId);
        showToast(message.message ?? "Save failed"); renderAll(); return;
      }
      if ((message.action === "chat" || message.action === "steer") && typeof message.tabId === "string") {
        const request = chatRequestsById.get(message.requestId);
        // Busy: another reply began first (a Save, another window). A queued message goes back to the front, an unsent composer message joins the queue.
        if (request?.tabId === message.tabId && message.reason === "busy") {
          if (request.queueItem) { putFront(message.tabId, request.queueItem); flushArmed.add(message.tabId); }
          else queueFromRequest(request);
        }
        if (request?.tabId === message.tabId) settleChatRequest(request, false);
        if (findTab(message.tabId)?.pendingApprovals?.length) approvalChatErrors.set(message.tabId, message.message ?? "Answer the pending approval before sending a message.");
        if (message.tabId === currentTab()?.id) updateChatLoading(message.tabId);
      }
      if (message.action === "run" && pendingRun && (!message.tabId || message.tabId === pendingRun.tabId)) {
        pendingRun = null;
        runDialogStatus(`Not started: ${message.message ?? "the server refused the launch"}`, false);
      }
      if ((message.action === "addTab" || message.action === "addProject") && pendingCreate) {
        const statusId = pendingCreate.kind === "tab" ? "tStat" : "npStat";
        pendingCreate = null;
        $(statusId).textContent = `Not created: ${message.message ?? "the server refused it"}`; $(statusId).classList.add("bad");
        updateCreateButtons();
      }
      // A refused stop frees only its own run: the server answers killRun messages in order and the refusal names no run, so it is the oldest one unanswered.
      if (message.action === "killRun") { const refused = message.runId ?? killOrder.shift(); if (message.runId) killOrder = killOrder.filter((id) => id !== message.runId); if (stopStates.get(refused) === "requested") stopStates.delete(refused); }
      if (["approveLook", "advanceStep", "reviewFindings", "finishFix", "reviewClean", "selectMarketingMaker"].includes(message.action)) { processPending.delete(message.tabId); processPendingSince.delete(message.tabId); stepActionSent.delete(message.tabId); }
      if (message.action === "updateSeat" && avatarPending && (!message.tabId || message.tabId === avatarPending.tabId)) {
        avatarPending = null;
        if ($("avatarStatus")) { $("avatarStatus").textContent = `Picture not changed: ${message.message ?? "the server refused it"}`; $("avatarStatus").dataset.status = "failed"; }
      }
      if (message.action === "refreshSettings" && refreshState?.status === "running" && refreshState.requestId === message.requestId) { refreshState = { status: "failed", at: Date.now() }; if (!$("setModal").hidden) renderSettings(); }
      restoreRejectedActions(message);
      showToast(message.message ?? "The server refused that request");
      renderAll();
      return;
    }
    if (["launchBlockCleared", "launchNoticesAcked", "unconfirmedReleased"].includes(message.type)) {
      renderAll();
    }
  }

  function settleConfirmedActions() {
    for (const [id, item] of pendingActions) {
      if (item.type === "removeTab" && !findTab(item.tabId)) finishPending(id, true);
      else if (item.type === "removeProject" && !findProject(item.projectId)) finishPending(id, true);
      else if (item.type === "setProcess") {
        const tab = findTab(item.message.tabId);
        if (tab && tab.kind === item.message.kind && tab.process === item.message.process && (item.sent || item.lost)) finishPending(id);
      }
    }
    // What is still waiting after the first state since a reconnect was never applied: send it again.
    let resend = false;
    for (const item of pendingActions.values()) if (item.lost) { item.lost = false; resend = true; item.readyToSend = true; }
    if (resend) sendNextHeldAction();
  }
  function finishPending(id, releaseRemoved = false) {
    const item = pendingActions.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    pendingActions.delete(id);
    if (releaseRemoved) for (const tabId of item.releaseTabIds ?? []) releaseTabAttachments(tabId);
    renderUndo();
    if (heldActionInFlight === id) {
      heldActionInFlight = null;
      sendNextHeldAction();
    }
  }
  function restoreRejectedActions(error) {
    const sent = pendingActions.get(heldActionInFlight)?.message;
    if (!sent || error.action !== sent.type || error.tabId !== sent.tabId || error.projectId !== sent.projectId) return;
    const id = heldActionInFlight;
    heldActionInFlight = null;
    finishPending(id);
    sendNextHeldAction();
  }
  function scheduleHeld(item) {
    clearTimeout(item.timer);
    item.timer = setTimeout(() => { item.readyToSend = true; sendNextHeldAction(); }, Math.max(0, item.dueAt - Date.now()));
  }
  function holdAction(message, label, hidden = {}) {
    const id = `held-${nextActionId++}`;
    const selectedTabId = serverState?.selectedTabId;
    const hidesSelection = (message.type === "removeTab" && message.tabId === selectedTabId)
      || (message.type === "removeProject" && findProject(message.projectId)?.tabs.some((tab) => tab.id === selectedTabId));
    const item = { id, message, label, ...hidden, previousSelectedTabId: hidesSelection ? selectedTabId : null, selectionVersion: userTabSelectionVersion, sent: false, readyToSend: false, timer: 0, dueAt: Date.now() + 10000 };
    pendingActions.set(id, item);
    if (item.previousSelectedTabId) item.fallbackSelectedTabId = activeEntry()?.tab.id ?? null;
    scheduleHeld(item);
    renderUndo(); renderAll(); ensureTicker();
    return id;
  }
  function sendHeld(id, flushing = false) {
    const item = pendingActions.get(id);
    if (!item || item.sent) return false;
    item.readyToSend = true;
    if (heldActionInFlight && heldActionInFlight !== id && !flushing) return false;
    clearTimeout(item.timer);
    item.timer = 0;
    item.sent = true;
    if (!heldActionInFlight) heldActionInFlight = id;
    if (!send(item.message)) {
      item.sent = false;
      if (heldActionInFlight === id) heldActionInFlight = null;
      renderUndo(); renderAll(); return false;
    }
    renderUndo(); renderAll();
    return true;
  }
  let heldActionInFlight = null;
  function sendNextHeldAction() {
    if (heldActionInFlight) return;
    const item = [...pendingActions.values()].find((candidate) => candidate.readyToSend && !candidate.sent);
    if (item) sendHeld(item.id);
  }
  function undoHeld(id) {
    const item = pendingActions.get(id);
    if (!item || item.sent) return;
    finishPending(id); renderAll();
    const stillOnFallback = (tabId) => tabId === item.previousSelectedTabId || tabId === item.fallbackSelectedTabId;
    if (item.previousSelectedTabId && item.fallbackSelectedTabId && item.selectionVersion === userTabSelectionVersion && stillOnFallback(serverState?.selectedTabId) && stillOnFallback(lastSelectRequest ?? item.previousSelectedTabId)) {
      send({ type: "selectTab", tabId: item.previousSelectedTabId });
    }
    showToast("Undone");
  }
  function undoSeconds(dueAt) { return `${Math.max(0, Math.ceil((dueAt - Date.now()) / 1000))} s`; }
  function renderUndo() {
    const toast = $("undo");
    const held = [...pendingActions.values()];
    const clears = [...clearUndos.entries()];
    if (!held.length && !clears.length) { toast.replaceChildren(); toast.classList.remove("on", "act"); toast.hidden = true; toast.inert = true; toast.setAttribute("aria-hidden", "true"); return; }
    const focused = document.activeElement?.closest?.("#undo") ? document.activeElement.dataset.undoHeld ?? `clear:${document.activeElement.dataset.undoClear}` : null;
    toast.innerHTML = `${held.map((item) => `<div class="undo-item"><span title="${esc(item.label)}">${esc(item.sent ? `${item.label}…` : item.label)}</span>${item.sent ? "" : `<small data-undo-due="${item.dueAt}">${undoSeconds(item.dueAt)}</small><button type="button" data-undo-held="${esc(item.id)}">Undo</button>`}</div>`).join("")}${clears.map(([tabId, item]) => `<div class="undo-item"><span>${item.sent ? "Restoring chat…" : `Chat cleared${findTab(tabId) ? ` in ${esc(findTab(tabId).name)}` : ""}`}</span>${item.sent ? "" : `<small data-undo-due="${item.dueAt ?? Date.now()}">${undoSeconds(item.dueAt ?? Date.now())}</small><button type="button" data-undo-clear="${esc(tabId)}">Undo</button>`}</div>`).join("")}`;
    toast.hidden = false; toast.inert = false; toast.setAttribute("aria-hidden", "false");
    toast.classList.add("on");
    toast.classList.toggle("act", held.some((item) => !item.sent) || clears.some(([, item]) => !item.sent));
    toast.querySelectorAll("[data-undo-held]").forEach((button) => button.addEventListener("click", () => undoHeld(button.dataset.undoHeld)));
    toast.querySelectorAll("[data-undo-clear]").forEach((button) => button.addEventListener("click", () => {
      const tabId = button.dataset.undoClear;
      const item = clearUndos.get(tabId);
      if (!item) return;
      if (item.sent || !send({ type: "undoClear", tabId })) return;
      item.sent = true; renderUndo();
    }));
    if (focused) (toast.querySelector(`[data-undo-held="${CSS.escape(focused)}"]`) ?? toast.querySelector(`[data-undo-clear="${CSS.escape(focused.replace(/^clear:/, ""))}"]`))?.focus({ preventScroll: true });
    ensureTicker();
  }

  // ---------- layers: a modal (Settings, a dialog) may carry one popover or one confirm dialog on top; closing hands focus back ----------
  const FOCUS_ATTRS = ["data-seat-id", "data-seat-pic", "data-seat-open", "data-tab-id", "data-project-id", "data-project-menu", "data-seat-more", "data-run-view", "data-run-tab", "data-history-timestamp", "data-session-action", "data-settings-model", "data-settings-advisor", "data-setting-action", "data-focus-key", "data-l", "data-theme-toggle", "data-wait-approval", "data-wait-tab", "data-request-action", "data-process-action", "data-avatar", "data-model", "data-effort", "data-kind", "data-process", "data-set-process", "data-permission-mode", "data-back-history", "data-chat-live", "data-run-seat", "data-stop-seat", "data-stop-run", "data-seat-model", "data-seat-advisor", "data-seat-watch", "data-seat-chat", "data-seat-history", "data-seat-rename", "data-seat-picture", "data-seat-unblock", "data-open-screenshots", "data-confirm-unblock", "data-confirm-release", "data-unblock", "data-release", "data-retry-kill", "data-ack-notice", "data-dismiss-run", "data-open-seat"];
  function focusKeyOf(el) {
    if (!el || el === document.body || !el.getAttribute) return null;
    if (el.id) return `#${CSS.escape(el.id)}`;
    for (const name of FOCUS_ATTRS) if (el.hasAttribute(name)) { const value = el.getAttribute(name); return value ? `[${name}="${CSS.escape(value)}"]` : `[${name}]`; }
    return null;
  }
  const shown = (el) => Boolean(el?.isConnected && el.getClientRects().length && !el.closest("[hidden],[inert]"));
  // A disabled control (or one in a disabled fieldset) cannot take focus: .focus() on it does nothing, so it is never a target.
  const focusable = (el) => shown(el) && !el.matches(":disabled");
  function focusEquivalent(el, key) {
    if (focusable(el)) { el.focus({ preventScroll: true }); return true; }
    const found = key ? $$(key).find(focusable) : null;
    if (found) { found.focus({ preventScroll: true }); return true; }
    return false;
  }
  function isOpen(layer) { return layerStack.some((entry) => entry.el === layer); }
  function setLayer(layer, open, opener = null, modal = false) {
    if (open) {
      if (isOpen(layer)) return;
      // A modal replaces the others (the confirm dialog stacks on top); a popover replaces other popovers and keeps the modal under it.
      const popOver = layerStack.find((entry) => !entry.modal && opener && entry.el.contains(opener));
      // A popover opened from outside an open dialog (not one of its own controls) closes that dialog too.
      for (const entry of [...layerStack].reverse()) if (modal ? !(layer.id === "confirmModal" && entry.modal) : !entry.modal || !opener || !entry.el.contains(opener) && !popOver) setLayer(entry.el, false, null, entry.modal, false);
      // A dialog opened from inside a popover returns focus to whatever opened that popover.
      const returnTo = popOver ? popOver.opener : opener ?? document.activeElement;
      const entry = { el: layer, opener: returnTo, key: focusKeyOf(returnTo), modal };
      layerStack.push(entry); currentLayer = layer;
      layer.hidden = false; layer.inert = false; layer.setAttribute("aria-hidden", "false");
      void layer.offsetWidth; layer.classList.add("on");
      if (returnTo?.hasAttribute?.("aria-expanded") && !modal) returnTo.setAttribute("aria-expanded", "true");
      if (modal) { $("scrim").hidden = false; $("scrim").setAttribute("aria-hidden", "false"); $("scrim").classList.add("on"); }
      const first = layer.querySelector('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex="0"]');
      if (modal) layer.focus({ preventScroll: true });
      else first?.focus();
      fixRadios(layer);
    } else {
      const restore = arguments.length < 5 || arguments[4] !== false;
      const index = layerStack.findIndex((entry) => entry.el === layer);
      if (index < 0) return;
      const [entry] = layerStack.splice(index, 1);
      currentLayer = layerStack.at(-1)?.el ?? null;
      layer.classList.remove("on"); layer.hidden = true; layer.inert = true; layer.setAttribute("aria-hidden", "true");
      if (entry.opener?.hasAttribute?.("aria-expanded") && !entry.modal) entry.opener.setAttribute("aria-expanded", "false");
      // The crew's pictures may have been redrawn while the card was open: make every rail button follow the closed card IN PLACE.
      // Redrawing here would replace the button a pointer is pressing (the card closes on pointerdown), and the click would never fire.
      if (layer.id === "seatPop") {
        const tab = currentTab(), viewing = tab ? viewedSeat(tab) : "";
        for (const row of $$("#crew .seat")) {
          row.classList.toggle("on", row.dataset.seatId === viewing);
          for (const button of $$("[aria-expanded]", row)) button.setAttribute("aria-expanded", "false");
        }
      }
      if (!layerStack.some((item) => item.modal)) { const scrim = $("scrim"); scrim.classList.remove("on"); scrim.hidden = true; scrim.setAttribute("aria-hidden", "true"); }
      if (layer.id === "avModal") avatarTarget = null;
      if (layer.id === "setModal") settingsSubmits.clear();
      if (layer.id === "confirmModal") { const cancelled = confirmCancelled; confirmCallback = null; confirmCancelled = null; cancelled?.(); }
      if (layer.id === "renameModal") renameCallback = null;
      if (layer.id === "runModal" && !pendingRun) runTarget = null;
      if (restore && !focusEquivalent(entry.opener, entry.key)) {
        const top = layerStack.at(-1)?.el;
        if (top) top.focus({ preventScroll: true });
      }
      markCrewSwitcher();
    }
  }
  function closeLayer(restore = true) {
    const layer = currentLayer;
    if (!layer) return;
    const entry = layerStack.at(-1);
    setLayer(layer, false, null, entry?.modal ?? false, restore);
  }
  // Closes exactly this dialog, whatever else is on top (a confirm dialog opened over it stays); focus goes back to its opener only if it was the top layer.
  function closeLayerOf(layer) {
    const entry = layerStack.find((item) => item.el === layer);
    if (entry) setLayer(layer, false, null, entry.modal, layerStack.at(-1) === entry);
  }
  function openModal(id, opener) { setLayer($(id), true, opener, true); }
  // A redraw (the crew after a card opens) replaces the button a popover hangs from: find its live twin by focus key.
  function liveAnchor(anchor) {
    if (!anchor || anchor.isConnected) return anchor;
    const key = focusKeyOf(anchor);
    return (key ? $$(key).find(shown) : null) ?? anchor;
  }
  function openPopover(pop, anchorArg, right = false) {
    const anchor = liveAnchor(anchorArg);
    const opener = anchor?.isConnected ? anchor : null;
    // Already open on another picture (the seat card switching seats): Escape and the toggle follow the NEW opener.
    const open = layerStack.find((entry) => entry.el === pop);
    if (open && opener && open.opener !== opener) { open.opener = opener; open.key = focusKeyOf(opener); }
    setLayer(pop, true, opener, false);
    pop.classList.toggle("right", right);
    pop.dataset.anchorKey = focusKeyOf(anchor) ?? "";
    pop._anchor = anchor; pop._right = right;
    placePopover(pop);
    markCrewSwitcher();
  }
  // Below the anchor (above it when there is no room), or beside it for the crew rail.
  function placePopover(pop) {
    let anchor = pop._anchor;
    if (!anchor?.isConnected && pop.dataset.anchorKey) anchor = $$(pop.dataset.anchorKey).find(shown) ?? anchor;
    if (!anchor?.isConnected) return;
    pop._anchor = anchor;
    const rect = anchor.getBoundingClientRect(), width = pop.offsetWidth || 340, height = pop.offsetHeight || 260;
    if (pop._right) {
      pop.style.left = `${Math.max(12, Math.min(rect.right + 14, innerWidth - width - 12))}px`;
      pop.style.top = `${Math.max(12, Math.min(rect.top - 10, innerHeight - height - 12))}px`;
      return;
    }
    const left = Math.max(12, Math.min(rect.right - width > 12 && rect.left + width > innerWidth - 12 ? rect.right - width : rect.left, innerWidth - width - 12));
    pop.style.left = `${left}px`;
    pop.style.top = `${rect.bottom + 8 + height > innerHeight - 12 ? Math.max(12, rect.top - height - 8) : rect.bottom + 8}px`;
  }
  function closePopovers() {
    for (const id of ["pop", "projPop", "ctxPop", "setupPop", "inboxPop", "seatPop", "permPop", "soundPop"]) {
      const pop = $(id); if (!pop.hidden) setLayer(pop, false);
    }
  }
  function togglePopover(pop, anchor, open) {
    const entry = layerStack.find((item) => item.el === pop);
    if (entry && (entry.opener === anchor || entry.key === focusKeyOf(anchor))) { setLayer(pop, false); return; }
    open();
  }
  // Roving tabindex: Tab enters a radio group on its checked choice and the arrow keys move inside it.
  function fixRadios(root) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll('[role="radiogroup"]').forEach((group) => {
      const items = [...group.querySelectorAll('[role="radio"]')];
      const on = items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0];
      items.forEach((item) => { item.tabIndex = item === on ? 0 : -1; });
    });
  }
  function makeMenu(pop, anchor, items, label = "Options") {
    pop.setAttribute("aria-label", label);
    pop.innerHTML = items.map((item, index) => item.hr ? '<div class="hr"></div>' : item.hint
      ? `<div class="hint"${item.attrs ? ` ${item.attrs}` : ""}>${esc(item.hint)}</div>`
      : `<button type="button" class="opt" data-menu-index="${index}"${item.attrs ? ` ${item.attrs}` : ""}${item.pressed !== undefined ? ` aria-pressed="${String(item.pressed)}"` : ""} ${item.disabled ? "disabled" : ""}><span class="nm"><span${item.danger ? ' class="danger"' : ""} title="${esc(item.label)}">${esc(item.label)}</span>${item.sub ? `<small>${esc(item.sub)}</small>` : ""}</span>${item.pressed !== undefined ? ICONS.tick : ""}</button>`).join("");
    openPopover(pop, anchor);
    pop.querySelectorAll("[data-menu-index]").forEach((button) => button.addEventListener("click", () => {
      const item = items[Number(button.dataset.menuIndex)];
      if (!item || item.disabled) return;
      setLayer(pop, false, null, false, !item.keepFocusAway); item.run?.();
    }));
  }
  // onCancel runs when the dialog closes any way but OK: Cancel, Escape, the scrim, or another dialog taking its place.
  function confirmAction({ title, body, ok = "OK", cancel = "Cancel", danger = false, phrase = "" }, callback, opener = document.activeElement, onCancel = null) {
    $("confirmTitle").textContent = title; $("confirmBody").textContent = body;
    $("confirmPhraseField").hidden = !phrase; $("confirmPhrase").value = ""; $("confirmPhrase").dataset.phrase = phrase;
    $("confirmPhraseLabel").innerHTML = phrase ? `Type <b>${esc(phrase)}</b> to confirm` : "";
    $("confirmErr").textContent = "";
    $("confirmOk").textContent = ok; $("confirmOk").className = `btn ${danger ? "danger" : "primary"}`;
    $("confirmCancel").textContent = cancel;
    openModal("confirmModal", opener);
    confirmCallback = callback; confirmCancelled = onCancel;
    if (phrase) $("confirmPhrase").focus();
  }
  function confirmAccepted() {
    const input = $("confirmPhrase"), phrase = input.dataset.phrase;
    if (phrase && input.value.trim() !== phrase) { $("confirmErr").textContent = "Type the words exactly as shown"; input.focus(); return; }
    const callback = confirmCallback, typed = input.value.trim();
    confirmCallback = null; confirmCancelled = null;
    setLayer($("confirmModal"), false, null, true);
    callback?.(typed);
  }
  function renameDialog(title, value, save, opener) {
    $("renameTitle").textContent = title; $("renameInput").value = value;
    $("renameModal").setAttribute("aria-label", title);
    openModal("renameModal", opener);
    renameCallback = save;
    $("renameInput").focus(); $("renameInput").select();
  }
  function renameAccepted() {
    const next = $("renameInput").value.trim(), callback = renameCallback;
    renameCallback = null;
    setLayer($("renameModal"), false, null, true);
    if (next) callback?.(next);
  }

  // ---------- tool approvals ----------
  const approvalAnswers = new Map();
  const approvalChatErrors = new Map();
  let approvalFocusTabId = null;
  // A click answers only the approval that was SHOWN when the press started: after the panel swaps to another
  // approval its buttons ignore input for APPROVAL_SETTLE_MS, and a press that began on a different one is dropped.
  const APPROVAL_SETTLE_MS = 400;
  let lastApproval = { id: "", at: 0 };
  let approvalSettleUntil = 0;
  let approvalSettleTimer = 0;
  let approvalPressId = null;
  let approvalKeyPressId = null;
  const heldApprovalKeys = new Set();
  const heldApprovalPointers = new Set();
  let approvalClickNote = "";
  // The leader's current name, so a renamed leader is never called by its old one.
  function approvalTitle(tool, tab) {
    const who = cap(leaderName(tab));
    if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(tool)) return `${who} wants to edit a file`;
    if (["Bash", "PowerShell"].includes(tool)) return `${who} wants to run a command`;
    if (tool.startsWith("launch:")) return `${who} wants to launch ${tool.slice(7)}`;
    return `${who} wants to use ${tool}`;
  }
  function renderToolApproval() {
    const tab = currentTab();
    const items = [...(tab?.pendingApprovals ?? [])].sort((a, b) => a.createdAt - b.createdAt);
    const item = items[0]; const panel = $("approvalPanel");
    if (item && item.approvalId !== lastApproval.id) {
      approvalSettleUntil = performance.now() + APPROVAL_SETTLE_MS;
      clearTimeout(approvalSettleTimer); approvalSettleTimer = setTimeout(renderToolApproval, APPROVAL_SETTLE_MS + 20);
    }
    lastApproval = { id: item?.approvalId ?? "", at: performance.now() };
    panel.hidden = !item;
    panel.dataset.approvalId = item?.approvalId ?? "";
    syncComposerVisibility();
    if (!item) { if (tab) approvalChatErrors.delete(tab.id); return; }
    if (approvalFocusTabId === tab.id) {
      approvalFocusTabId = null; panel.scrollIntoView({ block: "nearest" }); panel.focus({ preventScroll: true });
    }
    $("approvalTitle").textContent = approvalTitle(item.tool, tab); $("approvalTitle").title = approvalTitle(item.tool, tab);
    $("approvalSummary").textContent = item.summary;
    $("approvalCount").textContent = `1 of ${items.length}`;
    const answer = approvalAnswers.get(item.approvalId);
    const state = actionStateFor(answer?.requestId);
    if (answer && state && state.status !== "running") { answer.status = state.status; answer.message = state.message; }
    const busy = answer?.status === "running";
    const settling = performance.now() < approvalSettleUntil;
    $("approvalAllow").disabled = busy || settling; $("approvalDeny").disabled = busy || settling;
    $("approvalError").textContent = answer?.status === "failed" ? answer.message : busy ? "Sending your answer..." : approvalChatErrors.get(tab.id) ?? (approvalClickNote === item.approvalId ? "Click once to answer." : "");
  }
  function answerToolApproval(allow, event) {
    if (event.detail !== 0 && approvalPressId?.pointerId !== (event.pointerId ?? 0)) return;
    const tab = currentTab(), approvalId = $("approvalPanel").dataset.approvalId;
    // A click with no key or pointer press before it (screen reader, voice control) answers the shown, settled approval.
    const pressed = (event.detail === 0 ? approvalKeyPressId ?? approvalPressId ?? { id: approvalId } : approvalPressId)?.id;
    if (event.detail === 0 && !approvalKeyPressId && !approvalPressId && (heldApprovalKeys.size || heldApprovalPointers.size)) return;
    if (!tab || !approvalId || approvalAnswers.get(approvalId)?.status === "running" || performance.now() < approvalSettleUntil || pressed !== approvalId) return;
    if (event.detail > 1) { approvalClickNote = approvalId; renderToolApproval(); return; }
    approvalPressId = null; approvalKeyPressId = null;
    approvalClickNote = "";
    const requestId = newRequestId();
    approvalAnswers.set(approvalId, { requestId, status: "running", message: "" });
    if (!send({ type: "answerApproval", requestId, tabId: tab.id, approvalId, allow })) approvalAnswers.set(approvalId, { requestId, status: "failed", message: "Disconnected. Reconnect before answering." });
    renderToolApproval();
  }

  // ---------- top bar ----------
  function renderHeader() {
    const entry = activeEntry();
    const project = entry?.project;
    const tab = entry?.tab;
    if (project && tab) projectLastTab.set(project.id, tab.id);
    // Opening a project reads it; a removed project takes its mark with it.
    if (project) unreadProjects.delete(project.id);
    for (const id of unreadProjects) if (!findProject(id)) unreadProjects.delete(id);
    const box = $("ptabs");
    const focusedProject = document.activeElement?.closest?.("#ptabs .ptab")?.dataset.projectId;
    const focusedMenu = document.activeElement?.closest?.("#ptabs [data-project-menu]")?.dataset.projectMenu;
    box.innerHTML = visibleProjects().map((item) => {
      const on = item.id === project?.id, marker = attentionMark(attentionFor(item.tabs.filter((candidate) => !hiddenTab(candidate.id)))), unread = unreadProjects.has(item.id);
      // The options button is the tab's neighbour, not its child: a tab (role=tab) holds no other control.
      return `<div class="ptabw${on ? " sel" : ""}"><div class="ptab" role="tab" data-project-id="${esc(item.id)}" aria-controls="stage" tabindex="${on ? 0 : -1}" aria-selected="${String(on)}" title="${esc(item.name)}${marker ? ` · ${esc(marker.label)}` : ""}${unread ? " · unread" : ""}"><span class="pn"${on ? ' id="projName"' : ""} title="${esc(item.name)}">${esc(item.name)}</span>${marker ? `<i class="pdot${marker.bad ? " bad" : ""}" role="img" aria-label="${esc(marker.label)}"></i>` : ""}${unread ? '<i class="pdot unread" role="img" aria-label="unread"></i>' : ""}</div><button type="button" class="dots" data-project-menu="${esc(item.id)}" aria-haspopup="dialog" aria-expanded="false" aria-label="Options for ${esc(item.name)}" title="Project options"${on ? "" : ' tabindex="-1"'}>${ICONS.dots}</button></div>`;
    }).join("");
    box.querySelectorAll(".ptab").forEach((node) => {
      node.addEventListener("click", () => selectProject(node.dataset.projectId));
      node.addEventListener("keydown", (event) => tabKeys(event, node, box, ".ptab", (next) => selectProject(next.dataset.projectId)));
    });
    box.querySelectorAll("[data-project-menu]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); const item = findProject(button.dataset.projectMenu); if (item) togglePopover($("ctxPop"), button, () => projectMenu(item, button)); }));
    if (focusedMenu) box.querySelector(`[data-project-menu="${CSS.escape(focusedMenu)}"]`)?.focus({ preventScroll: true });
    else if (focusedProject) box.querySelector(`[data-project-id="${CSS.escape(focusedProject)}"]`)?.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      const more = $("pmore"); more.hidden = box.scrollWidth <= box.clientWidth + 1;
      const selected = box.querySelector(".ptabw.sel");
      if (selected && !more.hidden) { const r = selected.getBoundingClientRect(), b = box.getBoundingClientRect(); if (r.left < b.left || r.right > b.right) box.scrollLeft += r.left < b.left ? r.left - b.left - 14 : r.right - b.right + 14; }
    });
    renderInboxButton();
    renderSoundButton();
    const meImage = $("meImg");
    const wanted = mePic();
    if (meImage.getAttribute("src") !== wanted) { meImage.dataset.fellBack = ""; meImage.src = wanted; }
    meImage.dataset.fallback = `/avatars/${ME_DEFAULT}`;
    applyTheme(activeTheme);
  }
  // Tabs, project tabs and Details pills: arrows, Home and End move and select; Enter and Space select.
  function tabKeys(event, node, box, selector, choose) {
    if (event.target !== node) return;
    const choices = $$(selector, box); const index = choices.indexOf(node);
    let next = null;
    if (event.key === "ArrowRight") next = choices[(index + 1) % choices.length];
    if (event.key === "ArrowLeft") next = choices[(index + choices.length - 1) % choices.length];
    if (event.key === "Home") next = choices[0];
    if (event.key === "End") next = choices.at(-1);
    if (next) { event.preventDefault(); next.focus(); choose(next); }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(node); }
  }
  // A finished reply (or a failed one) in a project that is not shown marks that project's tab until it is opened.
  function markUnread(tabId) {
    const project = allTabs().find(({ tab }) => tab.id === tabId)?.project;
    if (!project || project.id === currentProject()?.id || unreadProjects.has(project.id)) return;
    unreadProjects.add(project.id); renderHeader();
  }
  // The completion sound's speaker opens a popover: its switch is the same bellEnabled pref as Settings > Behaviour, its slider the bellVolume pref.
  // The speaker shows muted when the sound is off or at 0%.
  let soundSliding = false; // the slider moved and was not let go yet: a state redraw must not pull it back
  function renderSoundButton() {
    const on = Boolean(pref("bellEnabled", false)), volume = bellVolume(), button = $("soundBtn");
    button.dataset.muted = String(!on || volume === 0);
    button.title = on ? `Completion sound: on, ${volume}%` : "Completion sound: off";
    $("soundPop").dataset.on = String(on);
    $("soundSwitch").setAttribute("aria-checked", String(on));
    if (!soundSliding) $("soundVol").value = String(volume);
    showSoundLevel();
  }
  function showSoundLevel() {
    const slider = $("soundVol");
    $("soundVolOut").textContent = `${slider.value}%`;
    slider.style.setProperty("--v", String(Number(slider.value) / 100));
  }
  function openSoundPop(anchor) { soundSliding = false; renderSoundButton(); openPopover($("soundPop"), anchor); }
  // Settings cannot be open under the popover (opening it closes Settings), and Settings reads the pref when it opens.
  function toggleSound() {
    const next = !pref("bellEnabled", false);
    if (send({ type: "updateClientPref", key: "bellEnabled", value: next })) { clientPrefOverrides.set("bellEnabled", next); if (next) playCompletionSound(); }
    renderSoundButton();
  }
  // Saved once, when the slider is let go (or per arrow key), never on every pixel of a drag.
  function saveSoundVolume() {
    soundSliding = false;
    saveClientPref("bellVolume", Number($("soundVol").value));
    renderSoundButton();
  }
  // The app window has no native title bar: the top bar ends in our own minimize, maximize/restore and close buttons. A plain browser has no bridge for them, so they stay hidden.
  function bindWindowButtons() {
    const cc = window.cc;
    if (typeof cc?.closeWindow !== "function") return;
    $("winBtns").hidden = false;
    $("winMin").addEventListener("click", () => cc.minimizeWindow());
    $("winMax").addEventListener("click", () => cc.toggleMaximizeWindow());
    $("winClose").addEventListener("click", () => cc.closeWindow());
    cc.onWindowMaximized(renderMaximized);
    Promise.resolve(cc.isWindowMaximized()).then(renderMaximized).catch(() => {});
    cc.onCloseRequested(answerCloseRequest);
  }
  function renderMaximized(maximized) {
    const button = $("winMax"), label = maximized === true ? "Restore" : "Maximize";
    button.dataset.maximized = String(maximized === true);
    button.setAttribute("aria-label", label); button.title = label;
  }
  // Every way of closing the app (our Close, Alt+F4, the taskbar, File > Quit) asks this page first (electron/main.js). With nothing working it
  // closes at once; otherwise it waits on this dialog. A second ask while it shows redraws the same dialog, never a second one.
  function answerCloseRequest() {
    // Work that belongs to no tab (a Settings action, an upload) is named too, and alone it also holds the close.
    const cc = window.cc, working = allTabs().filter(({ tab }) => tab.activeWork), other = serverState?.globalWork ?? [];
    if (!working.length && !other.length) { cc.answerClose("close"); return; }
    cc.answerClose("hold");
    const names = working.map(({ project, tab }) => `${project.name}\u00A0·\u00A0${tab.name}`), one = working.length === 1;
    const list = names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3} more` : names.join(", ");
    confirmAction({ title: "Close Command Center?", body: [working.length ? `${working.length} ${one ? "tab is" : "tabs are"} still working: ${list}.` : "", other.length ? `${working.length ? "Also" : "Still working"}: ${other.join(", ")}.` : "", `Closing stops ${working.length + other.length === 1 ? "it" : "them"}.`].filter(Boolean).join(" "), ok: "Close anyway", cancel: "Keep open", danger: true },
      () => cc.answerClose("close"), document.activeElement, () => cc.answerClose("keep"));
  }
  function selectProject(projectId) {
    const project = findProject(projectId); if (!project) return;
    const remembered = projectLastTab.get(projectId);
    const visible = project.tabs.filter((tab) => !hiddenTab(tab.id));
    const next = visible.find((tab) => tab.id === remembered) ?? visible[0];
    closePopovers();
    // Picking a project is a user choice even when it lands on the tab already shown: a held removal's Undo then leaves it alone.
    if (next) selectTabFromUser(next.id);
  }
  function renderInboxButton() {
    const items = allAttention(), count = items.length, bad = items.some((item) => item.bad), button = $("inboxBtn");
    button.classList.toggle("has", count > 0 && !bad); button.classList.toggle("bad", bad);
    $("inboxN").textContent = String(count); $("inboxN").hidden = !count;
    button.setAttribute("aria-label", count ? `Needs you, ${count} waiting` : "Needs you, nothing waiting");
    button.title = count ? `${count} thing${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} you` : "Nothing needs you right now";
  }

  // ---------- inner tabs ----------
  function renderTabs() {
    const entry = activeEntry(), project = entry?.project, tab = entry?.tab;
    const tabsBox = $("tabs");
    tabsBox.setAttribute("aria-label", project ? `Tabs in ${project.name}` : "Tabs in this project");
    const focusedTabId = document.activeElement?.closest?.("#tabs .tab")?.dataset.tabId;
    const focusedMore = document.activeElement?.matches?.("#tabs .tmore") ? document.activeElement.dataset.moreFor : null;
    $$(".tabw", tabsBox).forEach((node) => node.remove());
    if (project) for (const item of project.tabs.filter((candidate) => !hiddenTab(candidate.id))) {
      const selected = item.id === tab?.id, marker = attentionMark(attention(item));
      const wrap = document.createElement("div"); wrap.className = `tabw${selected ? " sel" : ""}`;
      const el = document.createElement("div");
      el.className = "tab"; el.dataset.tabId = item.id; el.title = `${item.name} · ${kindLabel(item.kind)} · ${processLabel(item.process)}${marker ? ` · ${marker.label}` : ""}`;
      el.setAttribute("role", "tab"); el.setAttribute("aria-controls", "stage"); el.setAttribute("aria-selected", String(selected)); el.tabIndex = selected ? 0 : -1;
      el.innerHTML = `<span class="tl" title="${esc(item.name)}">${esc(item.name)}</span>${marker ? `<i class="pdot${marker.bad ? " bad" : ""}" role="img" aria-label="${esc(marker.label)}"></i>` : ""}`;
      // Every tab keeps its ⋯ (shown on hover for the others), so a background tab can be renamed or removed without opening it. It is the tab's neighbour, not its child.
      const more = document.createElement("button");
      more.type = "button"; more.className = "dots tmore"; more.dataset.moreFor = item.id; more.setAttribute("aria-haspopup", "dialog"); more.setAttribute("aria-expanded", "false");
      more.setAttribute("aria-label", `Options for the ${item.name} tab`); more.title = "Tab options"; if (!selected) more.tabIndex = -1; more.innerHTML = ICONS.dots;
      el.addEventListener("click", () => selectTabFromUser(item.id));
      more.addEventListener("click", (event) => { event.stopPropagation(); togglePopover($("ctxPop"), more, () => tabMenu(item, more)); });
      el.addEventListener("keydown", (event) => tabKeys(event, el, tabsBox, ".tab", (next) => selectTabFromUser(next.dataset.tabId)));
      wrap.append(el, more);
      tabsBox.append(wrap);
    }
    if (focusedMore) tabsBox.querySelector(`.tmore[data-more-for="${CSS.escape(focusedMore)}"]`)?.focus({ preventScroll: true });
    else if (focusedTabId) tabsBox.querySelector(`[data-tab-id="${CSS.escape(focusedTabId)}"]`)?.focus({ preventScroll: true });
    $("addtab").disabled = !project;
    const selected = tabsBox.querySelector(".tabw.sel");
    if (selected) requestAnimationFrame(() => { const r = selected.getBoundingClientRect(), b = tabsBox.getBoundingClientRect(); if (r.left < b.left || r.right > b.right) tabsBox.scrollLeft += r.left < b.left ? r.left - b.left - 4 : r.right - b.right + 4; });
  }
  function tabMenu(tab, anchor) {
    const project = findProjectForTab(tab.id);
    const tabBusy = activeTabBusy(tab);
    const items = [
      { label: "Rename", run: () => renameDialog("Rename tab", tab.name, (name) => send({ type: "renameTab", tabId: tab.id, name }), anchor) },
      { label: "Change folder", sub: tab.folder, run: () => pickFolder((folder) => send({ type: "changeFolder", tabId: tab.id, folder })) },
      { label: "Kind and crew", sub: `${kindLabel(tab.kind)} · ${processLabel(tab.process)}`, keepFocusAway: true, run: () => processMenu(tab, $("tabs").querySelector(`[data-tab-id="${CSS.escape(tab.id)}"]`) ?? anchor) },
      { hr: true },
      ...(project?.tabs.length > 1 ? [{ label: "Remove tab", sub: tabBusy ? "The server may refuse while work is active" : "Files in its folder are not touched", danger: true, run: () => holdAction({ type: "removeTab", tabId: tab.id }, `${tab.name} tab will be removed`, { type: "removeTab", tabId: tab.id, hideTabId: tab.id, releaseTabIds: [tab.id] }) }] : [{ hint: "A project needs at least one tab." }]),
    ];
    makeMenu($("ctxPop"), anchor, items, "Tab options");
  }
  function findProjectForTab(tabId) { return projects().find((project) => project.tabs.some((tab) => tab.id === tabId)) ?? null; }
  function projectMenu(project, anchor) {
    const busy = project.tabs.some(activeTabBusy);
    const items = [
      { label: "Rename", run: () => renameDialog("Rename project", project.name, (name) => send({ type: "renameProject", projectId: project.id, name }), anchor) },
      { label: "Change folder", sub: `New tabs start in ${project.folder}`, run: () => pickFolder((folder) => {
        send({ type: "changeProjectFolder", projectId: project.id, folder });
      }) },
      { hr: true },
      ...(projects().length > 1 ? [{ label: "Remove from Command Center", sub: busy ? "The server may refuse while work is active" : "Its files and folders stay on disk", danger: true, run: () => holdAction({ type: "removeProject", projectId: project.id }, `${project.name} will be removed`, { type: "removeProject", projectId: project.id, hideProjectId: project.id, releaseTabIds: project.tabs.map((tab) => tab.id) }) }] : [{ hint: "Command Center needs at least one project." }]),
    ];
    makeMenu($("ctxPop"), anchor, items, "Project options");
  }
  function renderProjectPopover(anchor) {
    const pop = $("projPop"), current = currentProject();
    const items = visibleProjects().map((project) => {
      const tabs = project.tabs.filter((tab) => !hiddenTab(tab.id)).length, marker = attentionMark(attentionFor(project.tabs));
      return `<button type="button" class="opt" data-project="${esc(project.id)}" aria-pressed="${String(project.id === current?.id)}"><span class="nm"><span title="${esc(project.name)}">${esc(project.name)}</span><small>${tabs} tab${tabs === 1 ? "" : "s"}${marker ? ` · ${esc(marker.label)}` : ""}</small></span>${ICONS.tick}</button>`;
    }).join("");
    pop.innerHTML = `<div class="grp">All projects</div>${items || '<div class="nores">No projects.</div>'}<div class="hr"></div><button type="button" class="opt" data-new-project><span class="nm"><span>New project</span></span></button>`;
    openPopover(pop, anchor);
    pop.querySelectorAll("[data-project]").forEach((button) => button.addEventListener("click", () => { setLayer(pop, false); selectProject(button.dataset.project); }));
    pop.querySelector("[data-new-project]")?.addEventListener("click", () => { setLayer(pop, false, null, false, false); openProjectDialog($("addProj")); });
  }

  // ---------- crew rail ----------
  function toolApprovalWaiting(tab, seat) { return Boolean(seat?.isLeader && tab?.pendingApprovals?.length); }
  function lookPending(tab) { return tab?.processState?.approval?.state === "pending"; }
  function seatBlocked(tab, seat) { const key = seatKeyOf(tab, seat); return (serverState?.launchSafety?.blocked ?? []).some((row) => (typeof row === "string" ? row : row?.seatKey ?? row?.seatId) === key); }
  function stopLabel(state) { return state === "unconfirmed" ? "Stop not confirmed" : state === "requested" ? "Stop requested…" : "Stopping…"; }
  function runStopState(tab, run) {
    if (uncertainRun(run.runId)) return "unconfirmed";
    const local = stopStates.get(run.runId);
    if (local) return local;
    return engineSeat(tab, run.seatSlotId)?.status === "stopped" ? "accepted" : null;
  }
  function reviewActor(tab) {
    const step = (tab?.derived?.stepBar ?? []).find((item) => item.state === "current");
    if (!step || !ROUND_STEP_IDS.has(step.stepId) || tab.processState?.approval?.state !== "approved" || tab.processState?.phase === "clean") return null;
    return { step, seat: seatFor(tab, step.owners?.[0]), phase: tab.processState.phase, round: tab.processState.round ?? 1 };
  }
  function seatLine(tab, seat) {
    if (toolApprovalWaiting(tab, seat)) return { cls: "waiting", text: "Waiting on your answer" };
    const live = liveRuns(tab, seat);
    const closing = live.map((run) => runStopState(tab, run)).filter(Boolean);
    if (closing.length) { const state = closing.find((item) => item === "unconfirmed") ?? closing.find((item) => item === "accepted") ?? closing[0]; return { cls: state === "requested" ? "working" : "stopped", text: stopLabel(state) }; }
    if (seat.isLeader && savePending.has(tab.id)) return { cls: "working", text: "Saving the handover" };
    if (seat.isLeader && tab.derived?.leaderTurnActive) return { cls: "working", text: "Replying" };
    if (seat.isLeader && lookPending(tab)) return { cls: "waiting", text: "Waiting on your look" };
    const actor = reviewActor(tab);
    if (seat.isLeader && actor?.seat && !actor.seat.isLeader && ["failed", "stopped"].includes(actor.seat.status)) return { cls: "waiting", text: `Round ${actor.round} paused` };
    if (actor?.seat?.slot === seat.slot && seat.status === "failed") return { cls: "failed", text: `Failed · round ${actor.round}` };
    if (seat.status === "stalled") return { cls: "stalled", text: "Stalled: no output" };
    if (live.length > 1) return { cls: "working", text: `Working on ${live.length} runs` };
    const task = mdPlain(seat.isLeader ? engineSeat(tab, seat.slot)?.task : seat.task);
    if (seat.status === "working" || seat.status === "waiting") return { cls: seat.status, text: task || titleCase(seat.status) };
    if (seatBlocked(tab, seat) && !seat.isLeader) return { cls: "stopped", text: "Launch blocked" };
    if (seat.status === "stopped") return { cls: "stopped", text: task && /round/.test(task) ? task : "Stopped by you" };
    return { cls: seat.status || "idle", text: seat.status === "done" ? "Finished" : seat.status === "failed" ? "Failed" : "Ready" };
  }
  function seatDot(tab, seat, line) {
    if (toolApprovalWaiting(tab, seat) || (seat.isLeader && line.cls === "waiting")) return "waiting";
    if (line.cls === "stopped" && seat.status !== "stopped") return "stopped";
    if (line.cls === "failed" || line.cls === "stalled") return line.cls;
    return seat.status === "idle" || !seat.status ? "idle" : seat.status;
  }
  function needsYou(tab, seat) { return Boolean(seat.isLeader && (tab.pendingApprovals?.length || lookPending(tab) || (serverState?.requests ?? []).some((request) => request.status === "pending" && request.toTabId === tab.id))); }
  // A working seat's activity line takes a colour picked for its picture (close to the picture, not read from it); uploads use the working green.
  function seatHue(seat) { return { atlas: "#7d8bff", sonny: "#3bbf9a", vera: "#b58cff", sol: "#f2b630", nova: "#ff8fb8", terra: "#ef7d57", pip: "#5fb6ff", momo: "#ffb27a", juno: "#9b7a5c", ziggy: "#7ed957", rumi: "#7a6cff", kiki: "#ff6b6b", bo: "#5aa0ff", fig: "#d36bb4", dune: "#c7a27a", sage: "#a77bff", mel: "#b58a8a", ollie: "#4fd1c5", taro: "#ffa94d", ash: "#8f9bb3" }[UPLOADED_PIC.test(String(seat?.pic ?? "")) ? "" : avatarKeyFor(seat)] ?? "var(--working)"; }
  function renderCrew() {
    const tab = currentTab();
    const box = $("crew");
    const focusedPart = document.activeElement?.closest?.("#crew [data-seat-pic], #crew [data-seat-open]"), focusedKey = focusedPart ? focusKeyOf(focusedPart) : null;
    box.replaceChildren();
    $("stage").classList.toggle("wide", railWide);
    renderCrewJobs(tab);
    const toggle = $("railBtn"), toggleLabel = railWide ? "Hide crew details" : "Show crew details";
    toggle.setAttribute("aria-expanded", String(railWide)); toggle.setAttribute("aria-label", toggleLabel); toggle.title = toggleLabel;
    if (!tab) { $("crewLbl").textContent = "Crew"; $("setupsLbl").textContent = ""; return; }
    const flag = tab.derived?.roundFlag;
    $("crewLbl").innerHTML = `Crew${flag ? `<span class="rflag" title="The review passed two rounds">${esc(flag)}</span>` : ""}`;
    const switcher = $("setupsBtn"), crewName = processLabel(tab.process);
    $("setupsLbl").textContent = crewName;
    switcher.setAttribute("aria-label", `Crew: ${crewName}, ${kindLabel(tab.kind)}. Change the crew`);
    switcher.dataset.tip = `Crew: ${crewName}${flag ? ` · ${flag}` : ""}\nClick to change the crew`;
    switcher.title = railWide ? `Crew: ${crewName}, ${kindLabel(tab.kind)}` : "";
    const viewSeat = viewedSeat(tab), cardSlot = !$("seatPop").hidden ? $("seatPop").dataset.slot : null;
    tab.crew.forEach((seat, index) => {
      if (index === 1) { const line = document.createElement("span"); line.className = "csep"; line.setAttribute("aria-hidden", "true"); box.append(line); }
      const live = liveRuns(tab, seat), line = seatLine(tab, seat), dot = seatDot(tab, seat, line), role = seatRole(tab, seat);
      const act = needsYou(tab, seat) ? "need" : line.cls === "working" ? "work" : "";
      const row = document.createElement("div");
      row.className = `seat${cardSlot === seat.slot || viewSeat === seat.slot ? " on" : ""}${act ? ` ${act}` : ""}`;
      row.dataset.seatId = seat.slot;
      if (act === "work") row.style.setProperty("--c", seatHue(seat));
      const tip = `${seat.name} · ${role}
${line.text}`;
      row.dataset.tip = tip;
      if (railWide) row.title = tip;
      row.innerHTML = `<button type="button" class="av" data-seat-pic="${esc(seat.slot)}" aria-haspopup="dialog" aria-expanded="${String(cardSlot === seat.slot)}" aria-label="Open ${esc(seat.name)}'s card${railWide ? "" : `: ${esc(role)}, ${esc(line.text)}`}">${seatImg(seat)}<i class="dot ${esc(dot)}"></i>${live.length > 1 ? `<b class="cnt" title="${live.length} runs in parallel">${live.length}</b>` : ""}${seat.isLeader && !picHasCrown(seat) ? `<span class="crown" title="Leader">${ICONS.crown}</span>` : ""}</button><button type="button" class="fx" data-seat-open="${esc(seat.slot)}" aria-label="View ${esc(seat.name)}'s work: ${esc(role)}, ${esc(line.text)}"${seat.isLeader && inChat(tab) ? ` aria-haspopup="dialog" aria-expanded="${String(cardSlot === seat.slot)}"` : ""}${viewSeat === seat.slot ? ' aria-current="true"' : ""}><span class="fn name" title="${esc(seat.name)}">${esc(seat.name)}</span><span class="fr role" title="${esc(role)}">${esc(role)}</span><span class="sl ${esc(line.cls)}" title="${esc(line.text)}">${esc(line.text)}</span></button>${act ? '<i class="pl" aria-hidden="true"></i>' : ""}`;
      const pic = row.querySelector("[data-seat-pic]");
      pic.addEventListener("click", () => togglePopover($("seatPop"), pic, () => openSeatCard(tab, seat, pic)));
      row.querySelector("[data-seat-open]").addEventListener("click", (event) => seatClicked(tab, seat, event.currentTarget));
      box.append(row);
    });
    if (focusedKey) box.querySelector(focusedKey)?.focus({ preventScroll: true });
    const anyBusy = allTabs().some(({ tab: item }) => activeTabBusy(item));
    const stop = $("stopAll"); stop.disabled = !anyBusy;
    $("stopAllLbl").textContent = railWide ? "Stop all tabs" : "Stop all";
    stop.title = anyBusy ? "Stop every running seat and leader in every tab" : "Nothing is running in any tab";
    stop.setAttribute("aria-label", stop.title);
    stop.dataset.tip = stop.title;
  }
  function viewedSeat(tab) { const seat = selectedSeat(tab); return seat && !seat.isLeader ? seat.slot : ""; }
  function inChat(tab) { const seat = selectedSeat(tab); return Boolean(tab && seat?.isLeader && selectedView !== "history"); }
  function seatClicked(tab, seat, button) {
    if (seat.isLeader) {
      if (!inChat(tab)) { selectedSeatByTab.set(tab.id, seat.slot); selectedView = "live"; closePopovers(); renderStage(); renderCrew(); return; }
      togglePopover($("seatPop"), button, () => openSeatCard(tab, seat, button));
      return;
    }
    const same = selectedSeatByTab.get(tab.id) === seat.slot && selectedView === "live";
    selectedSeatByTab.set(tab.id, seat.slot); selectedView = "live";
    if (!same) historyRunRequested.delete(seatKeyOf(tab, seat));
    closePopovers(); renderStage(); renderCrew();
  }
  function markCrewSwitcher() {
    const entry = layerStack.find((item) => item.el === $("setupPop"));
    $("setupsBtn")?.setAttribute("aria-expanded", String(Boolean(entry && entry.opener === $("setupsBtn"))));
  }

  // ---------- status line, steps and save ----------
  function workerPhrases(tab) {
    return tab.crew.filter((seat) => !seat.isLeader && seat.status === "working").map((seat) => {
      const live = liveRuns(tab, seat).length, task = mdPlain(seat.task);
      if (live > 1) return `${seat.name} is working on ${live} runs`;
      if (/ · round \d+$/.test(task)) return `${seat.name} is ${task.replace(" · ", " ").toLowerCase()}`;
      if (task === "Waiting to review") return `${seat.name} is waiting to review`;
      return `${seat.name} is working on ${task || "a task"}`;
    });
  }
  function unseenFailedRuns(tab) {
    const generation = tab.processState?.crewGenerationId;
    return (tab.runs ?? []).filter((run) => run.status === "failed" && !run.seatIsLeader && run.crewGenerationId === generation && !dismissedRuns.has(run.runId));
  }
  function tabUncertain(tab) { return uncertainRows().filter((row) => tabIdOfKey(row.seatKey ?? row.seatId) === tab.id); }
  function statusOf(tab) {
    const lead = leader(tab), phrases = workerPhrases(tab);
    const meanwhile = phrases.length ? `Meanwhile ${joinNames(phrases)}` : "";
    if (connState === "off") return { tone: "off", text: "Not connected", sub: "Reconnecting. What you change now is not sent" };
    const also = tab.pendingApprovals?.length ? "Also waiting on your answer" : lookPending(tab) ? "Also waiting on your look" : meanwhile;
    const uncertain = tabUncertain(tab);
    if (uncertain.length) return { tone: "bad", text: `${seatNameOfKey(uncertain[0].seatKey ?? uncertain[0].seatId)} may still be running: the stop was not confirmed`, sub: "Needs you has Try again and Release" };
    const failed = unseenFailedRuns(tab)[0];
    if (failed) return { tone: "bad", text: `${failed.seatName}'s run failed: ${mdPlain(failed.label)}`, sub: also };
    const stalled = (tab.runs ?? []).find((run) => run.status === "working" && run.stalled);
    if (stalled) return { tone: "bad", text: `${stalled.seatName}'s run stalled: ${mdPlain(stalled.label)}`, sub: stallActions.get(stalled.runId) === "relaunch" ? `No output for ${STALL_MINUTES} minutes. It is being stopped and started once more` : `No output for ${STALL_MINUTES} minutes` };
    const approvals = [...(tab.pendingApprovals ?? [])].sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
    if (approvals.length) return { tone: "wait", text: `Waiting on you: ${approvalTitle(approvals[0].tool, tab)}`, sub: approvals.length > 1 ? `and ${approvals.length - 1} more` : meanwhile };
    if (lookPending(tab)) return { tone: "wait", text: "Waiting on you: approve the look", sub: meanwhile };
    const save = saveStates.get(tab.id);
    if (save?.status === "failed") return { tone: "bad", text: "Save failed", sub: save.message };
    if (save?.status === "unknown") return { tone: save.checking ? "work" : "bad", text: "Save not confirmed yet", sub: save.message };
    const closing = (tab.runs ?? []).filter((run) => run.status === "working" && runStopState(tab, run));
    if (closing.length) { const names = joinNames([...new Set(closing.map((run) => run.seatName))]); return closing.every((run) => runStopState(tab, run) === "requested") ? { tone: "work", text: `Stop requested for ${names}`, sub: "Nothing changes until the server accepts it" } : { tone: "work", text: `Stopping ${names}…`, sub: "Accepted. Waiting for the process to close" }; }
    const requests = (serverState?.requests ?? []).filter((request) => request.status === "pending" && request.toTabId === tab.id);
    if (requests.length) return { tone: "wait", text: `Waiting on you: a request from ${tabLabel(requests[0].fromTabId) || "another tab"}`, sub: meanwhile };
    const actor = reviewActor(tab);
    if (actor) {
      const line = String(tab.derived?.approvedCardLine ?? "").replace(/\.$/, "");
      if (actor.seat?.status === "stopped") return { tone: "bad", text: `Round ${actor.round} is paused. ${actor.seat.name} was stopped`, sub: `${seatBlocked(tab, actor.seat) ? `Allow ${actor.seat.name} again and run it` : `Run ${actor.seat.name} again`} to continue` };
      if (actor.seat?.status === "failed") return { tone: "bad", text: `Round ${actor.round} is paused. ${actor.seat.name}'s run failed`, sub: `Open ${actor.seat.name} and run it again to continue` };
      const others = phrases.filter((phrase) => !actor.seat || !phrase.startsWith(`${actor.seat.name} `));
      return { tone: "work", text: line || `Round ${actor.round}`, sub: others.length && !/^Waiting for/.test(line) ? `Also ${joinNames(others)}` : "" };
    }
    if (savePending.has(tab.id)) return { tone: "work", text: "Saving the handover…", sub: meanwhile };
    if (tab.derived?.leaderTurnActive) return { tone: "work", text: `${lead?.name ?? "The leader"} is replying`, sub: meanwhile };
    if (tab.processState?.approval?.state === "approved" && !phrases.length) return { tone: lead?.status === "working" ? "work" : "idle", text: String(tab.derived?.approvedCardLine ?? "Approved").replace(/\.$/, ""), sub: "" };
    if (phrases.length) return { tone: "work", text: cap(phrases[0]), sub: phrases.length > 1 ? `Also ${joinNames(phrases.slice(1))}` : "" };
    const stopped = tab.crew.filter((seat) => seat.status === "stopped");
    if (stopped.length) return { tone: "idle", text: `Stopped by you: ${joinNames(stopped.map((seat) => seat.name))}`, sub: (serverState?.launchSafety?.blocked ?? []).some((key) => tabIdOfKey(typeof key === "string" ? key : key?.seatKey ?? key?.seatId) === tab.id) ? "Blocked seats need Allow again before they launch" : "" };
    const jobs = jobsOf(tab).length;
    return { tone: "idle", text: "Ready", sub: jobs ? `${lead?.name ?? "The leader"} is free, ${jobs} background job${jobs === 1 ? "" : "s"} running` : `${lead?.name ?? "The leader"} is ready when you are` };
  }
  function renderStatusLine(tab) {
    const button = $("statusBtn");
    if (!tab) { button.innerHTML = ""; return; }
    const status = statusOf(tab), steps = tab.derived?.stepBar ?? [], index = Math.max(0, steps.findIndex((step) => step.state === "current"));
    const current = steps[index];
    button.innerHTML = `<span class="pill ${esc(status.tone)}" data-tone="${esc(status.tone)}"><i></i><span class="pt">${esc(status.text)}</span></span>${status.sub ? `<span class="sub">${esc(status.sub)}</span>` : ""}${steps.length ? `<span class="stepn">Step ${index + 1} of ${steps.length}<span class="sl"><span aria-hidden="true"> · </span>${esc(String(current?.label ?? "").split(" · ")[0])}</span>${ICONS.chev}</span>` : ""}`;
    button.title = `${status.text}${status.sub ? `. ${status.sub}` : ""}. Click to show every step and what comes next`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", String(stepsOpen));
    $("stepsWrap").classList.toggle("on", stepsOpen); $("stepsWrap").inert = !stepsOpen;
    renderPipe(tab);
    renderSaveArea(tab);
  }
  function stepOwners(tab, step) {
    return (step.owners ?? []).map((owner) => owner === "user" ? { user: true } : { seat: seatFor(tab, owner) }).filter((item) => item.user || item.seat);
  }
  function renderPipe(tab) {
    const pipe = $("pipe");
    const steps = tab.derived?.stepBar ?? [];
    const currentIndex = steps.findIndex((step) => step.state === "current");
    const actor = reviewActor(tab);
    pipe.innerHTML = steps.map((step, index) => {
      const active = index === currentIndex;
      const stop = active && actor && ["stopped", "failed"].includes(actor.seat?.status);
      const owners = active ? stepOwners(tab, step).map((item) => item.user
        ? `<span class="you" title="You">${esc(meName()[0])}</span>`
        : seatImg(item.seat, ` title="${esc(item.seat.name)}"`)).join("") : "";
      const label = stop ? `${step.label.split(" · ")[0]} · round ${actor.round} · ${actor.seat.name} ${actor.seat.status}` : step.label;
      const cls = step.state === "done" ? "done" : active ? `now${stop ? " stop" : lookPending(tab) ? "" : " go"}${(tab.processState?.round ?? 1) > 2 && ROUND_STEP_IDS.has(step.stepId) ? " hot" : ""}` : "";
      return `${index ? '<span class="link" aria-hidden="true"></span>' : ""}<span class="step ${cls}" data-step="${index}" data-step-id="${esc(step.stepId)}"${active ? ' aria-current="step"' : ""} title="${esc(label)}"><span class="n">${step.state === "done" ? "✓" : index + 1}</span><span class="sx">${esc(label)}</span>${active && owners ? `<span class="who">${owners}</span>` : ""}</span>`;
    }).join("");
    pipe.setAttribute("aria-label", `${kindLabel(tab.kind)} · ${processLabel(tab.process)} process`);
    const acts = $("stepActs"), focused = document.activeElement?.closest?.("#stepActs") ? focusKeyOf(document.activeElement) : null;
    acts.innerHTML = stepActions(tab);
    acts.querySelectorAll("[data-process-action]").forEach((button) => button.addEventListener("click", () => runProcessAction(tab, button.dataset.processAction)));
    acts.querySelectorAll("[data-maker]").forEach((button) => button.addEventListener("click", () => { if (button.getAttribute("aria-checked") !== "true") runProcessAction(tab, "selectMarketingMaker", { slot: button.dataset.maker }); }));
    acts.querySelector("[data-ask-changes]")?.addEventListener("click", askForChanges);
    acts.querySelectorAll("[data-open-screenshots]").forEach((button) => button.addEventListener("click", () => openScreenshotViewer(button.dataset.openScreenshots, null, button)));
    acts.querySelectorAll("[data-open-seat]").forEach((button) => button.addEventListener("click", () => openSeatView(tab.id, button.dataset.openSeat)));
    fixRadios(acts);
    if (focused) acts.querySelector(focused)?.focus({ preventScroll: true });
    const history = tab.processState?.roundHistory ?? [];
    $("rounds").innerHTML = history.map((round) => `<span>Round ${esc(round.round)} · ${esc(round.reviewerName)} · ${round.outcome === "clean" ? "clean" : `findings, ${esc(round.fixerName ?? "the fixer")} ${round.round === tab.processState.round && actor?.phase === "fix" ? "fixing" : "fixed"}`}</span>`).join("");
    const rounds = steps.some((step) => ROUND_STEP_IDS.has(step.stepId));
    $("stepnote").textContent = lookPending(tab) ? (rounds ? "Review round 1 waits for running work to finish once you approve. Nothing is reviewed until then." : "Stand-alone has no review rounds: approving finishes the work.") : rounds ? "Review rounds repeat until a round comes back clean." : "Stand-alone has no review rounds.";
  }
  function stepActions(tab) {
    const steps = tab.derived?.stepBar ?? [], index = steps.findIndex((step) => step.state === "current"), step = steps[index];
    if (!step) return "";
    const pending = processPending.get(tab.id);
    const button = (action, label, primary = false, extra = "") => `<button type="button" class="btn sm${primary ? " primary" : ""}" data-process-action="${action}"${extra}${pending ? " disabled" : ""}>${pending === action ? "Sending…" : esc(label)}</button>`;
    if (step.stepId === "look" && lookPending(tab)) {
      const shots = screenshotPaths(tab).length;
      return `<span class="lbl">Your turn:</span>${button("approveLook", "Approve the look", true)}<button type="button" class="btn sm" data-ask-changes>Ask for changes</button>${shots ? `<button type="button" class="btn sm" data-open-screenshots="${esc(tab.id)}">Open screenshots (${shots})</button>` : ""}`;
    }
    const actor = reviewActor(tab);
    if (actor) {
      const seat = actor.seat, name = seat?.name ?? "The assigned seat";
      const waiting = /^Waiting for /.test(String(tab.derived?.approvedCardLine ?? ""));
      if (waiting) return `<span class="faint">Approved. ${esc(String(tab.derived.approvedCardLine).replace(/^Waiting for /, "Review round " + actor.round + " starts when ").replace(/ to finish\.$/, " finish."))}</span>`;
      if (seat && ["stopped", "failed"].includes(seat.status)) return `<span class="faint">Round ${esc(actor.round)} is paused because ${esc(name)}${seat.status === "failed" ? "'s run failed. Open it and run it again to continue." : ` was stopped. ${seatBlocked(tab, seat) ? "Allow it again and run it" : "Run it again"} to continue.`}</span><button type="button" class="btn sm" data-open-seat="${esc(seat.slot)}">Open ${esc(name)}</button>`;
      const running = seat && liveRuns(tab, seat).length > 0;
      if (actor.phase === "review") {
        if (running) return `<span class="faint">${esc(name)}'s review run is still going. Its result buttons appear when it ends.</span>`;
        return `<span class="lbl">When ${esc(name)}'s review is in:</span>${button("reviewFindings", "Found findings")}${button("reviewClean", "Review is clean", true)}`;
      }
      const makers = tab.kind === "mkt" && tab.process === "main" ? tab.crew.filter((item) => ["socialMedia", "image", "videoAndMotion"].includes(item.slot)) : [];
      const makerBox = makers.length ? `<span class="makers" role="radiogroup" aria-label="Who fixes this round">${makers.map((item) => `<button type="button" role="radio" data-maker="${esc(item.slot)}" aria-checked="${String((tab.processState.selectedMakerSlotId ?? "socialMedia") === item.slot)}"${pending ? " disabled" : ""}>${esc(item.name)}</button>`).join("")}</span>` : "";
      if (running) return `<span class="faint">${esc(name)}'s fix run is still going. Finish fixes unlocks when it ends.</span>${makerBox}<button type="button" class="btn sm primary" data-process-action="finishFix" disabled>Finish fixes</button>`;
      return `<span class="lbl">${esc(name)} is fixing round ${esc(actor.round)}.</span>${makerBox}${button("finishFix", "Finish fixes", true)}`;
    }
    if (step.stepId !== "look" && !ROUND_STEP_IDS.has(step.stepId) && index < steps.length - 1) return button("advanceStep", `Continue to ${String(steps[index + 1]?.label ?? "the next step").split(" · ")[0]}`, true);
    if (index === steps.length - 1) return `<span class="faint">Last step. ${esc(leaderName(tab))} finishes up here.</span>`;
    return "";
  }
  function runProcessAction(tab, action, extra = {}) {
    if (processPending.has(tab.id) || Date.now() < (stepClickGuard.get(tab.id) ?? 0)) return;
    if (!send({ type: action, tabId: tab.id, ...extra })) return;
    const since = Date.now();
    processPending.set(tab.id, action); processPendingSince.set(tab.id, since);
    // With no further state the button would stay "Sending…" for ever: free it after PROCESS_PENDING_MS unless the answer (or a newer click) got there first.
    setTimeout(() => {
      if (processPending.get(tab.id) !== action || processPendingSince.get(tab.id) !== since) return;
      processPending.delete(tab.id); processPendingSince.delete(tab.id);
      renderStatusLine(findTab(tab.id) ?? tab); renderChatIfShown();
    }, PROCESS_PENDING_MS);
    if (action !== "selectMarketingMaker") stepActionSent.add(tab.id);
    renderStatusLine(tab); renderChatIfShown();
  }
  function renderChatIfShown() { const tab = currentTab(); if (tab && inChat(tab)) renderChat(tab); }
  function meName() { return "You"; }
  function contextLine(tab) {
    const context = Number(tab?.leaderUsage?.contextTokens);
    const window = Number(tab?.leaderUsage?.contextWindow);
    if (tab?.leaderUsage?.contextTokens === null || tab?.leaderUsage?.contextTokens === undefined || !Number.isFinite(context) || !Number.isFinite(window) || window <= 0) return "not reported yet";
    return `${Math.max(0, Math.min(100, context / window * 100)).toFixed(1)}% of ${fmtK(window)} (estimate from the last turn)`;
  }
  function savedLabel(tab) {
    const meta = chatMeta.get(tab.id) ?? {};
    const revision = Number.isSafeInteger(meta.revision) ? meta.revision : tab.chatRevision;
    const savedRevision = Number.isSafeInteger(meta.savedRevision) ? meta.savedRevision : tab.savedRevision;
    if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(savedRevision)) return "";
    if (revision === savedRevision) return revision === 0 ? "Nothing to save yet" : "Saved";
    const at = meta.lastAt ?? transcript(tab).at(-1)?.at;
    if (Number.isFinite(at) && at > 0) return `Not saved since ${clockTime(at)}`;
    return "Not saved yet";
  }
  function renderSaveArea(tab) {
    const status = $("saveSt"), button = $("saveBtn"), save = saveStates.get(tab.id), saving = savePending.has(tab.id);
    const label = savedLabel(tab), dirty = /^Not saved/.test(label);
    const word = saving ? "Saving…" : save?.status === "failed" ? "Save failed" : save?.status === "unknown" ? "Save not confirmed" : label;
    status.className = `savest${save?.status === "failed" ? " bad" : (dirty && !saving) || save?.status === "unknown" ? " warn" : ""}`;
    const split = word.match(/^(Not saved)( since .+)$/);
    status.innerHTML = `${saving ? '<span class="spin" aria-hidden="true"></span>' : ""}${split ? `${esc(split[1])}<span class="sw2">${esc(split[2])}</span>` : esc(word)}`;
    status.title = `${word}${save?.message ? `. ${save.message}` : ""}`;
    button.disabled = saving;
    button.innerHTML = `${ICONS.save}${save ? "Retry save" : "Save"}${dirty && !saving ? '<span class="udot" aria-hidden="true"></span>' : ""}`;
    button.title = `${save?.message ? `${save.message}. ` : ""}Saves the handover to ${tab.folder}${tab.folder?.includes("/") ? "/" : "\\"}.command-center${tab.folder?.includes("/") ? "/" : "\\"}${tab.id}${tab.folder?.includes("/") ? "/" : "\\"}RESUME.md`;
    button.setAttribute("aria-label", `${save ? "Retry save" : "Save"}. ${word}`);
  }
  function startSave(tab) {
    if (!tab || savePending.has(tab.id)) return;
    savePending.add(tab.id); saveStates.delete(tab.id); renderStage();
    if (!send({ type: "save", tabId: tab.id })) { savePending.delete(tab.id); renderStage(); }
  }
  function chatMenu(anchor) {
    const tab = currentTab(); if (!tab) return;
    const name = leaderName(tab);
    makeMenu($("ctxPop"), anchor, [
      { label: "Past sessions", sub: `Saved sessions with ${name}, and runs from earlier crews`, attrs: 'data-session-action="history"', run: () => showLeaderHistory(tab) },
      { label: "Clear chat", danger: true, sub: `Asks first. Stops ${name} and starts fresh`, keepFocusAway: true, attrs: 'data-session-action="clear"', run: () => clearConfirmMenu(anchor) },
      { hr: true },
      { hint: `${name}'s context: ${contextLine(tab)}`, attrs: `data-context-meter title="${esc(contextLine(tab))}"` },
    ], "Chat options");
  }
  function clearConfirmMenu(anchor) {
    const tab = currentTab(); if (!tab) return;
    const name = leaderName(tab), label = savedLabel(tab), dirty = /^Not saved/.test(label), saved = Number(tab.savedRevision) > 0;
    makeMenu($("ctxPop"), anchor?.isConnected ? anchor : $("chatMore"), [
      { hint: tab.chatProblem
        ? "Clear moves the damaged chat file aside as a copy and starts a fresh chat. This cannot be undone."
        : `${dirty ? `${label}. ` : ""}Clear stops ${name} and starts a fresh chat. ${saved ? `${name} reads the saved handover first.` : "Nothing is saved yet, so the fresh chat has no handover."} You can undo for 10 seconds.` },
      ...(dirty ? [{ label: "Save first", sub: "Then clear it yourself", run: () => startSave(tab) }] : []),
      { label: "Clear chat", danger: true, attrs: "data-clear-confirm", run: () => send({ type: "clear", tabId: tab.id }) },
      { label: "Cancel", attrs: "data-clear-cancel", run: () => {} },
    ], "Clear chat?");
  }

  // ---------- chat ----------
  function transcript(tab) { return transcripts.get(tab.id) ?? []; }
  function messageRole(message) { return message.role ?? message.kind ?? message.type ?? "assistant"; }
  function messageText(message) { return message.text ?? message.content ?? message.message ?? ""; }
  function attachmentList(tabId) { return attachmentsByTab.get(tabId) ?? []; }
  function noteTextEdit(tabId) { textVersionByTab.set(tabId, (textVersionByTab.get(tabId) ?? 0) + 1); }
  // Only a send still on its way locks the composer: while the leader replies a message is queued instead (see queueComposer).
  function chatSendLocked(tabId) { return pendingChatByTab.has(tabId); }
  function newChatRequestId() {
    let requestId;
    do { requestId = crypto.randomUUID().replaceAll("-", ""); } while (chatRequestsById.has(requestId));
    return requestId;
  }
  function newRequestId() { return crypto.randomUUID().replaceAll("-", ""); }
  function listedActions() {
    const settings = serverState?.settings ?? {};
    return [
      ...Object.values(settings.tools ?? {}).map((item) => item?.action),
      settings.github?.action, settings.preferenceAction,
      ...Object.values(settings.skills ?? {}).map((item) => item?.action),
      ...Object.values(settings.permissionActions ?? {}),
      ...Object.values(settings.uploads ?? {}),
      ...Object.values(serverState.requestActions ?? {}),
      ...allTabs().map(({ tab }) => tab.permissionAction),
    ];
  }
  function actionStateFor(requestId) {
    if (!requestId || !serverState) return null;
    const finished = [...settingsActionResults.values(), ...permissionActionResults.values(), ...requestActionResults.values()].find((item) => item.requestId === requestId);
    if (finished) return finished;
    const listed = listedActions().find((item) => item?.requestId === requestId);
    if (listed) return listed;
    return null;
  }
  function actionStatusMarkup(key) {
    const requestId = settingsActionId(key);
    if (!requestId) return '<span class="action-status" aria-live="polite"></span>';
    const state = actionStateFor(requestId);
    const status = state?.status ?? "running";
    return `<span class="action-status" data-status="${esc(status)}" data-status-for="${esc(requestId)}" aria-live="polite">${esc(state?.message ?? (status === "running" ? "Working" : ""))}</span>`;
  }
  const settingsSubmits = new Map();
  const settingsEdits = new Set();
  const savedBy = { "vault-save": ["vault-path"], "folder-save": ["default-folder"], "plugin-add": ["plugin-name"], "acp-add": ["acp-name", "acp-command"], ...Object.fromEntries(["claude", "codex", "opencode", "gemini"].map((cli) => [`mcp-add-${cli}`, [`mcp-name-${cli}`, `mcp-command-${cli}`]])) };
  function sendSettingsAction(key, payload) {
    const requestId = newRequestId();
    if (!send({ ...payload, requestId })) return null;
    if (savedBy[key]) settingsSubmits.set(key, { requestId, fields: new Map((savedBy[key] ?? []).map((field) => [field, $("setBody").querySelector(`[data-focus-key="${field}"]`)?.value])) });
    pendingSettingsActions.set(key, requestId);
    return requestId;
  }
  function abandonChatOnTabSwitch(tabId) {
    const requestId = pendingChatByTab.get(tabId);
    if (!requestId) return;
    pendingChatByTab.delete(tabId);
    const request = chatRequestsById.get(requestId);
    if (!request) return;
    if (request.sent) request.status = "abandoned";
    else chatRequestsById.delete(requestId);
  }
  function settleChatRequest(request, accepted) {
    if (chatRequestsById.get(request.requestId) !== request) return;
    // A queued message that was sent or steered: it leaves the queue when the server took it, otherwise it waits where it was.
    if (request.queueItem) {
      chatRequestsById.delete(request.requestId);
      request.queueItem.state = "waiting"; request.queueItem.requestId = null;
      if (accepted) removeQueued(request.tabId, request.queueItem);
      if (currentTab()?.id === request.tabId) { renderQueue(); updateChatLoading(request.tabId); }
      return;
    }
    const anotherRequestIsPending = pendingChatByTab.get(request.tabId) !== undefined
      && pendingChatByTab.get(request.tabId) !== request.requestId;
    chatRequestsById.delete(request.requestId);
    if (pendingChatByTab.get(request.tabId) === request.requestId) pendingChatByTab.delete(request.tabId);
    if (accepted && !anotherRequestIsPending) {
      if ((textVersionByTab.get(request.tabId) ?? 0) === request.textVersion) {
        draftsByTab.set(request.tabId, "");
        if (composerTabId === request.tabId) { $("ci").value = ""; fitComposer(); }
      }
      const list = attachmentList(request.tabId);
      const remaining = list.filter((item) => !request.items.includes(item));
      for (const item of request.items) if (list.includes(item)) releaseAttachment(item);
      if (remaining.length) attachmentsByTab.set(request.tabId, remaining);
      else attachmentsByTab.delete(request.tabId);
    }
    if (currentTab()?.id === request.tabId) { renderAttachments(); updateChatLoading(request.tabId); }
  }
  function releaseAttachment(item) {
    if (!item || item.released) return;
    item.released = true;
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    item.previewUrl = ""; item.file = null; item.promise = null;
  }
  // Correlation keeps accepted sends tied to their original composer snapshot.
  function releaseTabAttachments(tabId) {
    pendingChatByTab.delete(tabId);
    for (const [requestId, request] of chatRequestsById) if (request.tabId === tabId) chatRequestsById.delete(requestId);
    for (const item of attachmentList(tabId)) releaseAttachment(item);
    clearQueue(tabId);
    attachmentsByTab.delete(tabId); draftsByTab.delete(tabId); textVersionByTab.delete(tabId);
    if (currentTab()?.id === tabId) renderAttachments();
  }
  function renderAttachments() {
    const tab = currentTab(); const box = $("atts");
    const rows = tab ? attachmentList(tab.id) : [];
    const locked = Boolean(tab && pendingChatByTab.has(tab.id));
    box.innerHTML = rows.map((item) => `<span class="att${item.kind === "file" ? " att-file" : " img"}${item.status === "error" ? " err" : ""}" data-attachment="${esc(item.id)}">${item.kind === "file" ? `<span class="file-icon" aria-hidden="true">${esc(item.extension.slice(1) || "file")}</span>` : `<img class="thumb" src="${esc(item.previewUrl)}" alt="">`}<span title="${esc(item.name)}">${esc(item.name)}</span>${item.status === "loading" ? "<small>Loading file</small>" : item.status === "error" ? `<small>${esc(item.error ?? "Could not load")}</small>` : ""}<button type="button" data-remove-attachment="${esc(item.id)}" aria-label="Remove attachment ${esc(item.name)}" title="Remove attachment">${ICONS.x}</button></span>`).join("");
    if (locked) box.querySelectorAll("[data-remove-attachment]").forEach((button) => { button.disabled = true; });
    box.querySelectorAll("[data-remove-attachment]").forEach((button) => button.addEventListener("click", () => {
      if (pendingChatByTab.has(tab?.id)) return;
      const current = attachmentList(tab?.id); const index = current.findIndex((item) => item.id === button.dataset.removeAttachment);
      if (index < 0) return;
      releaseAttachment(current[index]); current.splice(index, 1); if (!current.length) attachmentsByTab.delete(tab.id);
      renderAttachments(); updateChatLoading(tab.id);
    }));
    box.hidden = rows.length === 0;
  }
  function updateChatLoading(tabId) {
    if (currentTab()?.id === tabId) {
      const loadingAttachment = attachmentList(tabId).some((item) => item.status === "loading");
      const pending = pendingChatByTab.has(tabId);
      const activeTurn = findTab(tabId)?.derived?.leaderTurnActive === true;
      const canChat = inChat(currentTab());
      const status = pending ? loadingAttachment ? "Loading file" : "Sending" : loadingAttachment ? "Loading file" : "";
      $("chatStatus").textContent = status;
      $("chatStatus").hidden = !status;
      $("ci").readOnly = pending;
      $("attachBtn").disabled = !canChat || pending;
      $("sendBtn").disabled = !canChat || !$("ci").value.trim() || pending || savePending.has(tabId);
      // Mid-reply the button queues the message (it goes out when the reply ends, or when its Steer is clicked).
      const label = activeTurn ? "Queue message" : "Send message";
      $("sendBtn").setAttribute("aria-label", label); $("sendBtn").title = label;
    }
    renderQueue();
  }
  function addImageAttachment(file, tabId = currentTab()?.id) {
    if (!tabId || !findTab(tabId)) return;
    if (pendingChatByTab.has(tabId)) return;
    if (!/^image\/(?:png|jpeg|webp)$/.test(file?.type ?? "")) { showToast("Only PNG, JPEG and WebP images can be attached"); return; }
    if (file.size > 12 * 1024 * 1024) { showToast("Images must be 12 MiB or smaller"); return; }
    if (attachmentList(tabId).filter((item) => item.kind === "image").length >= MAX_IMAGES) { showToast(`Attach up to ${MAX_IMAGES} images per message`); return; }
    const item = { id: `attachment-${Date.now()}-${Math.random()}`, kind: "image", name: file.name || "Image", extension: "image", file, previewUrl: URL.createObjectURL(file), path: "", status: "loading", promise: null, released: false };
    const list = attachmentList(tabId); list.push(item); attachmentsByTab.set(tabId, list);
    item.promise = (async () => {
      const bytes = await file.arrayBuffer();
      if (item.released) return null;
      const requestId = newRequestId(); item.requestId = requestId;
      const response = await keyedFetch("/api/paste-image", { method: "POST", headers: { "Content-Type": file.type, "X-Request-Id": requestId }, body: bytes });
      if (!response.ok) throw new Error(`Image upload failed (${response.status})`);
      const result = await response.json();
      if (typeof result.path !== "string") throw new Error("Image upload returned no path");
      if (item.released) return null;
      item.path = result.path; item.file = null; item.status = "ready";
      return result.path;
    })().catch((error) => {
      if (!item.released) { item.status = "error"; item.file = null; showToast(error?.message ?? "Could not load that image"); }
      return null;
    }).finally(() => {
      updateChatLoading(tabId);
      if (currentTab()?.id === tabId) renderAttachments();
    });
    renderAttachments(); updateChatLoading(tabId);
  }
  function fileExtension(name) { return String(name ?? "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ""; }
  function addFileAttachment(file, tabId = currentTab()?.id) {
    if (!tabId || !findTab(tabId) || pendingChatByTab.has(tabId)) return;
    const extension = fileExtension(file?.name);
    if (!FILE_EXTENSIONS.has(extension)) { showToast("That file type is not supported"); return; }
    if (file.size > 20 * 1024 * 1024) { showToast("Files must be 20 MiB or smaller"); return; }
    if (attachmentList(tabId).filter((item) => item.kind === "file").length >= MAX_FILES) { showToast(`Attach up to ${MAX_FILES} files per message`); return; }
    const item = { id: `attachment-${Date.now()}-${Math.random()}`, kind: "file", name: file.name, extension, file, previewUrl: "", path: "", status: "loading", promise: null, released: false };
    const list = attachmentList(tabId); list.push(item); attachmentsByTab.set(tabId, list);
    item.promise = (async () => {
      const bytes = await file.arrayBuffer();
      if (item.released) return null;
      const requestId = newRequestId(); item.requestId = requestId;
      const response = await keyedFetch("/api/paste-file", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Request-Id": requestId, "X-File-Name": encodeURIComponent(file.name) }, body: bytes });
      if (!response.ok) throw new Error(`File upload failed (${response.status})`);
      const result = await response.json();
      if (typeof result.path !== "string") throw new Error("File upload returned no path");
      if (item.released) return null;
      item.path = result.path; item.name = result.name || item.name; item.file = null; item.status = "ready";
      return result.path;
    })().catch((error) => {
      if (!item.released) { item.status = "error"; item.error = error?.message ?? "Could not load that file"; item.file = null; showToast(item.error); }
      return null;
    }).finally(() => {
      updateChatLoading(tabId);
      if (currentTab()?.id === tabId) renderAttachments();
    });
    renderAttachments(); updateChatLoading(tabId);
  }
  function transcriptImageUrl(path) { return `/api/paste-image?path=${encodeURIComponent(path)}`; }
  function messageImages(message) {
    const images = Array.isArray(message.images) ? message.images : [];
    if (!images.length) return "";
    return images.map((path) => {
      const name = String(path).split(/[\\/]/).at(-1) || "Image";
      return `<button type="button" class="file img" data-open-shot="${esc(path)}" title="${esc(name)}"><img class="thumb" src="${esc(transcriptImageUrl(path))}" alt="">${esc(name)}</button>`;
    }).join("");
  }
  function messageFiles(message) {
    const files = Array.isArray(message.files) ? message.files : [];
    return files.map((path) => {
      const name = String(path).split(/[\\/]/).at(-1) || "File";
      return `<span class="file file-chip" title="${esc(name)}"><span class="file-icon" aria-hidden="true">${esc(fileExtension(name).slice(1) || "file")}</span>${esc(name)}</span>`;
    }).join("");
  }
  function messageTime(message) {
    if (typeof message.createdAt === "string") return message.createdAt;
    const timestamp = Number(message.at ?? message.time);
    return Number.isFinite(timestamp) && timestamp > 0 ? clockTime(timestamp) : "";
  }
  function screenshotPaths(tab) {
    const paths = transcript(tab).flatMap((message) => Array.isArray(message.images) ? message.images.filter((path) => typeof path === "string") : []);
    return [...new Set(paths)];
  }
  // A finished message is rendered once: the html is kept per tab + revision (the server sends no id) and reused until anything it shows changes.
  // ponytail: cleared past 3000 entries, a smarter eviction if a long session ever shows the refill cost.
  const messageHtmlCache = new Map();
  function renderMessage(tab, message) {
    const speaker = leader(tab);
    const sig = [messageRole(message), message.revision, messageText(message), messageTime(message), speaker?.name, seatPic(speaker), speaker?.slot, JSON.stringify(message.images ?? null), JSON.stringify(message.files ?? null)].join("\u0001");
    const key = Number.isFinite(message.revision) ? `${tab.id}\u0001${message.revision}` : null;
    // The html holds the picture's blob URL, which a later upload revokes: the URL itself is part of what the html depends on.
    const pic = mePic();
    const cached = key && messageHtmlCache.get(key);
    if (cached && cached.sig === sig && cached.pic === pic) return cached.html;
    const html = renderMessageHtml(tab, message);
    if (key) { if (messageHtmlCache.size > 3000) messageHtmlCache.clear(); messageHtmlCache.set(key, { sig, pic, html }); }
    return html;
  }
  function renderMessageHtml(tab, message) {
    // A heads-up from Command Center itself: a quiet line, not the leader speaking and not you.
    if (messageRole(message) === "notice") return `<div class="msg note" data-message-id="${esc(message.id ?? message.revision ?? "")}"><p>${esc(messageText(message))}</p></div>`;
    const user =["user", "human"].includes(messageRole(message));
    const speaker = leader(tab);
    const text = esc(messageText(message));
    const when = messageTime(message);
    const chips = messageImages(message) + messageFiles(message);
    const files = chips ? `<div class="files">${chips}</div>` : "";
    return user
      ? `<div class="msg mine" data-message-id="${esc(message.id ?? message.revision ?? "")}"><div class="body"><span class="meta">${esc(when)} <b>${esc(meName())}</b></span><div class="bubble"><p>${text}</p></div>${files}</div>${img(mePic(), `/avatars/${ME_DEFAULT}`, ' class="uav" alt="Your avatar"').replace(' alt=""', "")}</div>`
      : `<div class="msg" data-message-id="${esc(message.id ?? message.revision ?? "")}">${seatImg(speaker)}<div class="body"><span class="meta"><b>${esc(speaker?.name ?? "Lead")}</b>${esc(when)}</span><div class="md">${mdHtml(messageText(message))}</div>${files}</div></div>`;
  }
  function lookCard(tab) {
    const shots = screenshotPaths(tab).length, pending = processPending.get(tab.id);
    if (lookPending(tab)) {
      const rounds = (tab.derived?.stepBar ?? []).some((step) => ROUND_STEP_IDS.has(step.stepId));
      return `<div class="msg"><span></span><div class="ask" id="lookCard"><div class="h">${ICONS.warn}Your turn: approve the look</div><p>${rounds ? "Review round 1 starts after you approve and any running work finishes. Nothing is reviewed until then." : "Stand-alone has no review rounds: approving finishes this work."}</p><div class="acts"><button type="button" class="btn primary" data-process-action="approveLook"${pending ? " disabled" : ""}>${pending === "approveLook" ? "Approving…" : "Approve the look"}</button><button type="button" class="btn" data-ask-changes>Ask for changes</button>${shots ? `<button type="button" class="btn" data-open-screenshots="${esc(tab.id)}">Open screenshots <span class="faint">${shots}</span></button>` : ""}</div></div></div>`;
    }
    if (tab.processState?.approval?.state === "approved") {
      const actor = reviewActor(tab), paused = actor?.seat && ["stopped", "failed"].includes(actor.seat.status);
      const line = paused ? `Round ${actor.round} is paused. ${actor.seat.name}${actor.seat.status === "failed" ? "'s run failed." : " was stopped."}` : tab.derived?.approvedCardLine ?? "The process continues.";
      return `<div class="msg"><span></span><div class="ask ${paused ? "stop" : "ok"}"><div class="h">${paused ? ICONS.warn : ICONS.ok}Look approved</div><p>${esc(line)}</p>${shots ? `<div class="acts"><button type="button" class="btn" data-open-screenshots="${esc(tab.id)}">Open screenshots <span class="faint">${shots}</span></button></div>` : ""}</div></div>`;
    }
    return "";
  }
  function askForChanges() {
    const tab = currentTab(); if (!tab) return;
    selectedSeatByTab.set(tab.id, leader(tab)?.slot); selectedView = "live";
    renderStage();
    const input = $("ci");
    if (!input.value.trim()) { input.value = "Please make these changes: "; draftsByTab.set(tab.id, input.value); noteTextEdit(tab.id); }
    fitComposer(); updateChatLoading(tab.id);
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  }
  // A streamed delta only rewrites the text of the bubble already on screen, at most once per frame; anything else renders the stage as before.
  let streamFrame = 0;
  function streamDraftUpdate(tabId) {
    const view = $("view");
    const bubble = view.dataset.tabId === tabId && view.dataset.mode === "chat" ? view.querySelector("[data-stream] .md") : null;
    if (!bubble || !streamingByTab.get(tabId) || selectedSeat(currentTab())?.isLeader === false || selectedView === "history") { renderStage(); return; }
    if (streamFrame) return;
    // The timer is the fallback for a window that is not painting (hidden, minimized), where frames never come.
    let timer = 0;
    streamFrame = requestAnimationFrame(() => { clearTimeout(timer); paint(); });
    timer = setTimeout(() => { cancelAnimationFrame(streamFrame); paint(); }, 50);
    function paint() {
      streamFrame = 0;
      // The one scheduled paint serves whichever chat is shown now: a delta for it may have returned early while this frame was held for another tab.
      const shown = currentTab()?.id, live = $("view"), p = live.dataset.tabId === shown && live.dataset.mode === "chat" ? live.querySelector("[data-stream] .md") : null, draft = streamingByTab.get(shown);
      if (!p || !draft) { if (shown === tabId) renderStage(); return; }
      const stick = live.scrollHeight - live.scrollTop - live.clientHeight <= 4;
      p.innerHTML = mdHtml(draft);
      if (stick) live.scrollTop = live.scrollHeight;
    }
  }
  // The step line sits in the Replying bubble's header; a change repaints just that span.
  function paintStep(tabId) {
    const view = $("view");
    if (tabId !== currentTab()?.id || view.dataset.tabId !== tabId || view.dataset.mode !== "chat") return;
    const label = stepByTab.get(tabId) ?? "";
    for (const element of view.querySelectorAll("[data-activity]")) { element.textContent = label; element.hidden = !label; }
  }
  function renderChat(tab) {
    const messages = transcript(tab).map((message) => renderMessage(tab, message)).join("");
    const draft = streamingByTab.get(tab.id);
    const lead = leader(tab);
    const step = `<span class="act" data-activity${stepByTab.get(tab.id) ? "" : " hidden"}>${esc(stepByTab.get(tab.id) ?? "")}</span>`;
    const stream = draft ? `<div class="msg" data-stream>${seatImg(lead)}<div class="body"><span class="meta"><b>${esc(lead?.name ?? "Lead")}</b>Replying${step}</span><div class="md">${mdHtml(draft)}</div></div></div>`
      : tab.derived?.leaderTurnActive && !tab.pendingApprovals?.length ? `<div class="msg">${seatImg(lead)}<div class="body"><span class="meta"><b>${esc(lead?.name ?? "Lead")}</b>Replying${step}</span><span class="typing" role="img" aria-label="Replying"><i></i><i></i><i></i></span></div></div>` : "";
    const look = lookCard(tab);
    // The server could not read this tab's saved transcript (the file is kept as it is): say why the chat is empty.
    const problem = tab.chatProblem ? `<p class="action-status" data-status="failed" role="alert" data-chat-problem>This chat could not be read (${esc(tab.chatProblem)}). Clear the chat to start a new one; the damaged file is kept as a copy.</p>` : "";
    const view = $("view");
    const previousScrollTop = view.scrollTop;
    const stickToBottom = view.dataset.tabId !== tab.id || view.dataset.mode !== "chat" || view.scrollHeight - view.scrollTop - view.clientHeight <= 4;
    if (!messages && !stream && !look) {
      const name = lead?.name ?? "The leader";
      view.innerHTML = `<div class="thread" aria-label="Chat with ${esc(name)}">${problem}<div class="empty empty-chat">${seatImg(lead)}<h2>${esc(name)} is ready</h2><p>Tell ${esc(name)} what you want. The crew picks it up from there, and anything that needs you shows up in Needs you at the top.</p><div class="chips">${["Where did we leave off?", "What is left?", "What should we build next?"].map((text) => `<button type="button" data-suggest>${esc(text)}</button>`).join("")}</div></div></div>`;
    } else view.innerHTML = `<div class="thread" aria-label="Chat with ${esc(lead?.name ?? "the leader")}">${problem}${messages}${stream}${look}</div>`;
    view.dataset.tabId = tab.id; view.dataset.mode = "chat";
    view.querySelectorAll("[data-process-action]").forEach((button) => button.addEventListener("click", () => runProcessAction(tab, button.dataset.processAction)));
    view.querySelector("[data-ask-changes]")?.addEventListener("click", askForChanges);
    view.querySelectorAll("[data-open-screenshots]").forEach((button) => button.addEventListener("click", () => openScreenshotViewer(button.dataset.openScreenshots, null, button)));
    view.querySelectorAll("[data-open-shot]").forEach((button) => button.addEventListener("click", () => openScreenshotViewer(tab.id, button.dataset.openShot, button)));
    view.querySelectorAll("[data-suggest]").forEach((button) => {
      button.disabled = chatSendLocked(tab.id) || savePending.has(tab.id);
      button.addEventListener("click", () => { $("ci").value = button.textContent; draftsByTab.set(tab.id, $("ci").value); noteTextEdit(tab.id); updateChatLoading(tab.id); sendChat(); });
    });
    if (messages || stream) view.scrollTop = stickToBottom ? view.scrollHeight : previousScrollTop;
  }

  // ---------- a crew member's own view, past sessions and saved runs ----------
  function historyStatus(outcome) {
    return outcome && typeof outcome === "object" && typeof outcome.status === "string" ? outcome.status : "unknown";
  }
  function historyStatusColor(outcome) {
    const status = historyStatus(outcome);
    return status === "done" ? "var(--done)" : status === "failed" || status === "stopped" ? "var(--failed)" : "var(--idle)";
  }
  function historyDate(timestamp) {
    return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Time unavailable";
  }
  function historyExitCode(outcome) {
    const code = outcome && typeof outcome === "object" ? outcome.exitCode : null;
    return Number.isInteger(code) ? String(code) : "unknown";
  }
  function historyBytes(bytes) {
    return Number.isFinite(Number(bytes)) && Number(bytes) >= 0 ? `${Number(bytes).toLocaleString()} B` : "unknown bytes";
  }
  function accessText(tab, seat) {
    if (seat?.isLeader) return "Leader · permission mode of this chat";
    const canWrite = engineSeat(tab, seat?.slot)?.canWrite, folder = folderName(tab.folder);
    if (seat?.cli === "codex") return canWrite === false ? "Read-only (asked not to write; Codex can still write through commands)" : `Asked to stay inside ${folder} (Codex can still reach outside it)`;
    return `${canWrite === false ? "Told not to write" : `Can write, works in ${folder}`} · ${cliLabel(seat?.cli)} has no folder sandbox`;
  }
  function historyRows(entries) {
    return entries.map((run) => {
      const timestamp = Number(run.timestamp ?? run.startedAt ?? run.started ?? 0);
      const status = historyStatus(run.outcome);
      return `<button type="button" class="run" data-history-timestamp="${timestamp}"><span class="rs" style="background:${historyStatusColor(run.outcome)}"></span><span><b>${esc(historyDate(timestamp))}</b><small>${esc(status)} · exit ${esc(historyExitCode(run.outcome))}</small></span><span class="mono">exit ${esc(historyExitCode(run.outcome))}</span><span class="mono">${esc(historyBytes(run.sizeBytes))}</span></button>`;
    }).join("");
  }
  function retiredRows(tab, seat) {
    const runs = (tab.derived?.runViews?.retiredHistory ?? []).filter((run) => seat.isLeader || run.seatSlotId === seat.slot).slice().sort((a, b) => Number(b.endedAt ?? b.startedAt) - Number(a.endedAt ?? a.startedAt));
    if (!runs.length) return "";
    return `<h3>Runs from earlier crews</h3><p class="faint" style="margin:0;font-size:12.5px">Kept from crews this tab used before. Their saved logs open from that seat's History when the seat still exists.</p>${runs.map((run) => `<div class="run"><span class="rs" style="background:${run.status === "failed" || run.status === "stopped" ? "var(--failed)" : "var(--done)"}"></span><span><b title="${esc(`${run.seatName} · ${mdPlain(run.label)}`)}">${esc(run.seatName)} · ${plainMd(run.label)}</b><small>${esc(historyDate(Number(run.endedAt ?? run.startedAt)))} · ${esc(run.outcome ?? run.status)}</small></span><span class="mono">${esc(run.endedAt ? spanText(run.startedAt, run.endedAt) : "")}</span><span class="mono">${esc(formatModel(run.cli, run.model))}</span></div>`).join("")}`;
  }
  // One saved run, read from its files. The leader's Past sessions shows it on its own; a worker keeps its header above it.
  function historyDetailMarkup(seat, key, detail) {
    const back = seat.isLeader ? "Past sessions" : "All saved runs";
    const top = `<div class="wv runs"><button type="button" class="back" data-back-history>${ICONS.back}<span>${esc(back)}</span></button>`;
    const status = historyStatus(detail.outcome), cls = status === "done" ? "ok" : status === "failed" || status === "stopped" ? "bad" : "";
    const capped = detail.truncated ? (detail.full ? " · fuller log, still capped by the server" : " · capped, showing the end of the log") : "";
    const fuller = detail.truncated && !detail.full;
    const fullBusy = historyFullRequested.has(`${key}:${detail.timestamp}`);
    return `${top}<div class="wvhead"><div><b>${esc(historyDate(Number(detail.timestamp)))}</b><small>${esc(seat.name)} · read from its saved files, no AI is called</small></div></div><div class="metarow"><span>${esc(historyDate(Number(detail.timestamp)))}</span><span class="${cls}">${esc(status)}</span><span>exit ${esc(historyExitCode(detail.outcome))}</span><span>${esc(historyBytes(detail.totalBytes))}${esc(capped)}</span></div>${detail.brief ? `<h3>Brief</h3><pre class="plain">${esc(detail.brief)}</pre>` : ""}<h3>Log</h3><div class="term">${fuller ? `<div class="tb"><span class="mono">Showing the end of ${esc(historyBytes(detail.totalBytes))}</span><span class="spacer"></span><button type="button" class="tbtn jump" data-full-log data-full-timestamp="${esc(detail.timestamp)}"${fullBusy ? " disabled" : ""}>${fullBusy ? "Reading…" : "Load the fuller log"}</button></div>` : ""}<pre>${esc(detail.output || "No log saved.")}</pre></div></div>`;
  }
  // The saved-runs list the server never answered: say so, with a way to ask again. A list that did arrive (even an older one) is shown instead.
  function historyFailure(key, runs) {
    return historyFailed.has(key) && !Array.isArray(runs) ? '<p class="faint">Could not load the saved runs just now. <button type="button" class="btn sm" data-history-retry>Try again</button></p>' : "";
  }
  function bindHistoryView(view, tab, seat, key) {
    view.querySelector("[data-history-retry]")?.addEventListener("click", () => { requestHistory(tab, seat, true); renderStage(); });
    view.querySelector("[data-full-log]")?.addEventListener("click", (event) => {
      const timestamp = Number(event.currentTarget.dataset.fullTimestamp), detailKey = `${key}:${timestamp}`;
      if (historyFullRequested.has(detailKey)) return;
      // A failed send changes nothing; each fuller-log request has its own token so an older timer cannot clear a newer request.
      if (!send({ type: "historyRun", seatKey: key, timestamp, full: true })) return;
      const token = ++historyRunToken;
      historyFullRequested.set(detailKey, token); historyRunRequested.set(key, timestamp);
      setTimeout(() => { if (historyFullRequested.get(detailKey) === token) { historyFullRequested.delete(detailKey); renderStage(); } }, HISTORY_WAIT_MS);
      renderStage();
    });
    // The list stays until the saved run arrives; only the newest pick can open (a late reply for an older pick is ignored).
    view.querySelectorAll("[data-history-timestamp]").forEach((button) => button.addEventListener("click", () => {
      const timestamp = Number(button.dataset.historyTimestamp);
      // A failed send leaves an earlier request (and its timer) exactly as it was.
      if (!send({ type: "historyRun", seatKey: key, timestamp })) return;
      historyRunRequested.set(key, timestamp);
      const token = ++historyRunToken; historyRunTokens.set(key, token);
      // A saved run the server never answers (its error names no run) stops saying "Reading its saved files…" after a while.
      setTimeout(() => { if (historyRunTokens.get(key) === token && historyRunRequested.get(key) === timestamp && !historyDetails.has(`${key}:${timestamp}`)) { historyRunRequested.delete(key); showToast("Could not read that saved run. Try again"); renderStage(); } }, HISTORY_WAIT_MS);
      view.querySelectorAll("[data-history-timestamp][aria-busy]").forEach((item) => item.removeAttribute("aria-busy"));
      button.setAttribute("aria-busy", "true");
      const note = button.querySelector("small"); if (note) note.textContent = "Reading its saved files…";
    }));
    view.querySelector("[data-back-history]")?.addEventListener("click", () => { const requested = historyRunRequested.get(key); historyDetails.delete(`${key}:${requested}`); historyFullRequested.delete(`${key}:${requested}`); historyRunRequested.delete(key); renderStage(); });
    view.querySelectorAll("[data-chat-live]").forEach((button) => button.addEventListener("click", () => { selectedView = "live"; renderStage(); renderCrew(); }));
  }
  function renderLeaderHistory(tab, seat) {
    const view = $("view"), key = seatKeyOf(tab, seat), runs = historyBySeat.get(key);
    if (!historyRequested.has(key) && !historyFailed.has(key)) requestHistory(tab, seat);
    const requested = historyRunRequested.get(key);
    const detail = requested !== undefined ? historyDetails.get(`${key}:${requested}`) : null;
    if (detail) { view.innerHTML = historyDetailMarkup(seat, key, detail); view.dataset.tabId = tab.id; view.dataset.mode = "history"; bindHistoryView(view, tab, seat, key); return; }
    const entries = Array.isArray(runs) ? runs : [];
    const loading = !Array.isArray(runs) && historyInFlight.has(key);
    view.innerHTML = `<div class="wv runs"><button type="button" class="back" data-chat-live data-session-action="chat">${ICONS.back}<span>Back to the chat</span></button><div class="wvhead">${seatImg(seat)}<div><b>Past sessions</b><small>${esc(seat.name)} · opening one reads its saved files, no AI is called</small></div></div>${loading ? '<p class="faint"><span class="spin" aria-hidden="true" style="margin-right:8px"></span>Loading saved runs…</p>' : historyFailure(key, runs) || `<span class="lbl">${entries.length} saved run${entries.length === 1 ? "" : "s"}</span>${historyRows(entries) || '<p class="faint">No runs yet. Save writes one.</p>'}`}${retiredRows(tab, seat)}</div>`;
    view.dataset.tabId = tab.id; view.dataset.mode = "history";
    bindHistoryView(view, tab, seat, key);
  }
  function seatFacts(tab, seat, current, last, line, blocked) {
    const fact = (label, value, attrs = "") => `<div><span>${label}</span><b${attrs}>${value}</b></div>`;
    const doing = current ? mdPlain(current.label) : seat.status === "working" || line.cls === "waiting" ? line.text : blocked ? "Nothing. Launch blocked" : "Nothing. Ready for a brief";
    if (current) {
      const tokens = usageTokens(current.usage);
      return `<div class="facts">${fact("Doing now", esc(doing), ` title="${esc(doing)}"`)}${fact("Model", `${esc(modelLine(current.cli, current.model, current.effort))} <span class="faint">· this run</span>`)}${fact("Running for", esc(spanText(current.startedAt)), ` data-run-time="${esc(current.runId)}"`)}${fact("Tokens", tokens !== null ? `${esc(fmtK(tokens))} <span class="faint">· this run</span>` : "Not reported")}</div>`;
    }
    return `<div class="facts">${fact("Doing now", esc(doing), ` title="${esc(doing)}"`)}${fact("Model", `${esc(modelLine(seat.cli, seat.model, seat.effort))} <span class="faint">· next run</span>`)}${fact("Last run", last ? `${esc(agoText(last.endedAt ?? last.startedAt))} · took ${esc(spanText(last.startedAt, last.endedAt ?? last.startedAt))}` : "None yet")}${fact("Access", esc(accessText(tab, seat)), ` title="${esc(accessText(tab, seat))}"`)}</div>`;
  }
  function lastResult(tab, seat, last, heading) {
    if (!last) return `<h3>${heading}</h3><p class="faint" style="margin:0">No finished run yet in this crew.</p>`;
    const bad = last.status === "failed" || last.status === "stopped", findings = last.outcome === "findings";
    return `<h3>${heading}</h3><div class="last${bad ? " bad" : findings ? " wait" : ""}"><div class="lh"><span class="rs"></span><b title="${plainMd(last.label)}">${plainMd(last.label)}</b><span class="metarow"><span${bad ? ' class="bad"' : findings ? "" : ' class="ok"'}>${esc(cap(last.outcome ?? last.status))}</span><span>${esc(agoText(last.endedAt ?? last.startedAt))}</span><span>took ${esc(spanText(last.startedAt, last.endedAt ?? last.startedAt))}</span><span>${esc(modelLine(last.cli, last.model, last.effort))}</span></span><span class="spacer"></span><button type="button" class="btn sm" data-run-view="history" data-last-history>Open History</button></div></div>`;
  }
  function renderRunView(tab, seat) {
    const view = $("view");
    const focused = document.activeElement?.dataset?.runTab ?? document.activeElement?.dataset?.historyTimestamp ?? (document.activeElement?.matches?.("[data-run-view]") ? `view:${document.activeElement.dataset.runView}` : document.activeElement?.matches?.("[data-back-history]") ? "back-history" : document.activeElement?.matches?.("[data-chat-live]") ? "chat-live" : "");
    const key = seatKeyOf(tab, seat);
    const active = liveRuns(tab, seat);
    const selected = active.find((run) => run.runId === selectedRunBySeat.get(seat.slot)) ?? active[0];
    if (selected) selectedRunBySeat.set(seat.slot, selected.runId);
    const line = seatLine(tab, seat), blocked = seatBlocked(tab, seat), dot = seatDot(tab, seat, line);
    const generation = tab.processState?.crewGenerationId;
    const finished = (tab.runs ?? []).filter((run) => run.seatSlotId === seat.slot && run.status !== "working" && run.crewGenerationId === generation).sort((a, b) => Number(b.endedAt ?? b.startedAt) - Number(a.endedAt ?? a.startedAt));
    const historyOpen = selectedView === "history";
    const requested = historyRunRequested.get(key);
    const stopping = active.length ? stopLabelFor(tab, active) : "";
    const head = `<div id="stagehead" class="wv"><button type="button" class="back" data-back-chat>${ICONS.back}<span>Back to the chat with ${esc(leaderName(tab))}</span></button><div class="vhead"><span class="av big">${seatImg(seat)}<i class="dot ${esc(dot)}"></i></span><div class="vwho"><b><span data-seat-name title="${esc(seat.name)}">${esc(seat.name)}</span></b><small title="${esc(seatRole(tab, seat))} · ${esc(cliLabel(seat.cli))}">${esc(seatRole(tab, seat))} · ${esc(cliLabel(seat.cli))}</small></div><span class="vstat ${esc(line.cls)}" role="status"><i></i><span class="vt" title="${esc(line.text)}">${esc(line.text)}</span></span><span class="spacer"></span><button type="button" class="btn primary sm" data-run-seat>${active.length ? "Run another" : "Run"}</button>${active.length || seat.status === "working" ? `<button type="button" class="btn danger sm" data-stop-seat title="Stops every run of ${esc(seat.name)} and blocks new launches until you allow it"${stopping ? " disabled" : ""}>${stopping ? esc(stopping) : `Stop seat (${active.length || 1})`}</button>` : ""}<button type="button" class="soft ico" data-seat-more="${esc(seat.slot)}" aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(seat.name)}: model, name, picture and launches" title="Model, name, picture and launches">${ICONS.dots}</button></div>${seatFacts(tab, seat, selected, finished[0], line, blocked)}${blocked ? `<div class="blk">${ICONS.warn}<span>Launch blocked after a stop. ${esc(seat.name)} cannot start until you allow it.</span><button type="button" class="btn sm" data-seat-unblock>Allow again</button></div>` : ""}<div class="vbar"><div class="segs" role="tablist" aria-label="Run view"><button type="button" role="tab" data-run-view="live" aria-selected="${String(!historyOpen)}">Live</button><button type="button" role="tab" data-run-view="history" aria-selected="${String(historyOpen)}">History</button></div>${!historyOpen && active.length > 1 ? `<div class="runtabs" role="tablist" aria-label="Live runs">${active.map((run) => `<button type="button" role="tab" data-run-tab="${esc(run.runId)}" aria-selected="${String(run.runId === selected.runId)}" title="${plainMd(run.label)}"><span class="d"></span><span>${plainMd(run.label)}</span></button>`).join("")}</div>` : ""}</div></div>`;
    let body = "";
    const detail = requested !== undefined ? historyDetails.get(`${key}:${requested}`) : null;
    if (historyOpen && detail) body = historyDetailMarkup(seat, key, detail);
    else if (historyOpen) {
      const runs = historyBySeat.get(key);
      if (!historyRequested.has(key) && !historyFailed.has(key)) requestHistory(tab, seat);
      const entries = Array.isArray(runs) ? runs : [];
      const loading = !Array.isArray(runs) && historyInFlight.has(key);
      body = `<div class="wv runs">${loading ? '<p class="faint"><span class="spin" aria-hidden="true" style="margin-right:8px"></span>Loading saved runs…</p>' : historyFailure(key, runs) || `<span class="lbl">${entries.length} saved run${entries.length === 1 ? "" : "s"}</span>${historyRows(entries) || '<p class="faint">No runs yet.</p>'}`}</div>`;
    } else if (selected) {
      const output = outputByRun.get(selected.runId) ?? selected.output ?? "";
      const usage = formatUsage(selected.usage);
      const state = runStopState(tab, selected);
      body = `<div class="wv"><div class="term"><div class="tb"><span class="mono" title="${plainMd(selected.label)}">${plainMd(selected.label)}</span><span class="spacer"></span><span class="mono">${esc(cliLabel(selected.cli))} · ${esc(modelLine(selected.cli, selected.model, selected.effort))}${usage ? ` · ${esc(usage)}` : ""}</span><button type="button" class="tbtn jump" data-jump-log hidden>Jump to latest</button><button type="button" class="tbtn" data-stop-run="${esc(selected.runId)}" aria-label="Stop ${plainMd(selected.label)}" title="Stops only this run"${state ? " disabled" : ""}>${state ? esc(stopLabel(state)) : "Stop this run"}</button></div><pre data-output-run="${esc(selected.runId)}">${esc(output)}</pre></div><div class="files touched"><span class="lbl">${esc(accessText(tab, seat))} ·</span><span class="file" title="${esc(selected.folderPath)}">${esc(selected.folderPath)}</span></div>${lastResult(tab, seat, finished[0], "Last finished run")}</div>`;
    } else {
      body = `<div class="wv">${lastResult(tab, seat, finished[0], "Last result")}${blocked ? "" : `<p class="faint" style="margin:0;font-size:12.5px">${esc(seat.name)} starts when ${esc(leaderName(tab))} hands over a brief, or when you press Run.</p>`}</div>`;
    }
    const previousLog = view.querySelector("[data-output-run]");
    const logState = previousLog ? { id: previousLog.dataset.outputRun, top: previousLog.scrollTop, near: nearEnd(previousLog) } : null;
    const sameView = view.dataset.tabId === tab.id && view.dataset.mode === `worker:${seat.slot}`;
    const scrollTop = view.scrollTop;
    view.innerHTML = `<div class="wv" style="gap:18px">${head}${body}</div>`;
    view.dataset.tabId = tab.id; view.dataset.mode = `worker:${seat.slot}`;
    view.scrollTop = sameView ? scrollTop : 0;
    const log = view.querySelector("[data-output-run]");
    if (log) { if (logState && logState.id === log.dataset.outputRun && !logState.near) log.scrollTop = logState.top; else log.scrollTop = log.scrollHeight; jumpButton(log); }
    view.querySelector("[data-back-chat]").addEventListener("click", () => { selectedSeatByTab.set(tab.id, leader(tab)?.slot); selectedView = "live"; renderStage(); renderCrew(); });
    view.querySelector("[data-run-seat]")?.addEventListener("click", (event) => openRunDialog(tab, seat, event.currentTarget));
    view.querySelectorAll("[data-stop-seat]").forEach((button) => button.addEventListener("click", () => stopSeat(tab, seat)));
    view.querySelector("[data-seat-more]")?.addEventListener("click", (event) => togglePopover($("seatPop"), event.currentTarget, () => openSeatCard(tab, seat, event.currentTarget)));
    view.querySelector("[data-seat-unblock]")?.addEventListener("click", (event) => unblockWithConfirm(tab, seat, event.currentTarget));
    view.querySelectorAll("[data-run-view]").forEach((button) => button.addEventListener("click", () => {
      selectedView = button.dataset.runView;
      if (selectedView === "history") { historyRunRequested.delete(key); requestHistory(tab, seat); }
      renderStage(); renderCrew();
      if (button.hasAttribute("data-last-history")) $("view").querySelector('[data-run-view="history"]')?.focus({ preventScroll: true });
    }));
    view.querySelectorAll("[data-run-tab]").forEach((button) => button.addEventListener("click", () => { selectedRunBySeat.set(seat.slot, button.dataset.runTab); renderStage(); }));
    view.querySelectorAll("[data-stop-run]").forEach((button) => button.addEventListener("click", () => killRun(button.dataset.stopRun)));
    view.querySelector("[data-jump-log]")?.addEventListener("click", () => { const pre = view.querySelector("[data-output-run]"); if (pre) { pre.scrollTop = pre.scrollHeight; jumpButton(pre); } });
    view.querySelector("[data-output-run]")?.addEventListener("scroll", (event) => jumpButton(event.currentTarget));
    if (historyOpen) bindHistoryView(view, tab, seat, key);
    restoreRunViewFocus(view, focused, historyOpen ? "history" : "live");
  }
  function stopLabelFor(tab, runs) { const states = runs.map((run) => runStopState(tab, run)); return states.every(Boolean) ? stopLabel(states.find((item) => item === "unconfirmed") ?? states.find((item) => item === "accepted") ?? states[0]) : ""; }
  const nearEnd = (pre) => pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  function jumpButton(pre) { const jump = pre.closest(".term")?.querySelector("[data-jump-log]"); if (jump) jump.hidden = nearEnd(pre); }
  function restoreRunViewFocus(view, focused, fallback) {
    let target = focused.startsWith("view:") ? view.querySelector(`#stagehead [data-run-view="${CSS.escape(fallback)}"]`) ?? view.querySelector(`[data-run-view="${CSS.escape(focused.slice(5))}"]`) : null;
    if (!target && focused === "back-history") target = view.querySelector("[data-back-history]") ?? view.querySelector('[data-run-view="history"]');
    if (!target && focused === "chat-live") target = view.querySelector("[data-chat-live]") ?? $("chatMore");
    if (!target && focused) target = view.querySelector(`[data-run-tab="${CSS.escape(focused)}"],[data-history-timestamp="${CSS.escape(focused)}"]`);
    if (!target && /^\d+$/.test(focused)) target = view.querySelector("[data-back-history]");
    target?.focus({ preventScroll: true });
  }
  // Extending the shown text costs the size of the chunk; only a log that hit its cap (its front was cut) is rewritten whole.
  function updateRunOutput(runId, chunk, trimmed) {
    const element = $("view").querySelector(`[data-output-run="${CSS.escape(runId)}"]`);
    if (!element) return;
    const follow = nearEnd(element), top = element.scrollTop;
    const node = element.firstChild;
    if (!trimmed && node?.nodeType === 3 && node === element.lastChild) node.appendData(chunk);
    else element.textContent = outputByRun.get(runId) ?? "";
    element.scrollTop = follow ? element.scrollHeight : top;
    jumpButton(element);
  }
  function requestHistory(tab, seat, refresh = false) {
    const key = seat.seatKey ?? `${tab.id}.${seat.slot}`;
    if (refresh) historyRequested.delete(key);
    if (historyInFlight.has(key)) { if (refresh) historyRefreshAfterFlight.add(key); return; }
    if (historyRequested.has(key)) return;
    historyRequested.add(key);
    historyInFlight.add(key);
    historyFailed.delete(key);
    if (!send({ type: "historyList", seatKey: key })) { historyRequested.delete(key); historyInFlight.delete(key); return; }
    // The server's history errors name no seat, so a list that never answers is given up on here instead of spinning until a reconnect.
    const ticket = (historyTickets.get(key) ?? 0) + 1; historyTickets.set(key, ticket);
    setTimeout(() => { if (historyTickets.get(key) === ticket && historyInFlight.delete(key)) { historyRequested.delete(key); historyFailed.add(key); renderStage(); } }, HISTORY_WAIT_MS);
  }
  function historyOwner(key) {
    for (const { tab } of allTabs()) {
      const seat = tab.crew.find((item) => (item.seatKey ?? `${tab.id}.${item.slot}`) === key);
      if (seat) return { tab, seat };
    }
    return null;
  }
  function showLeaderHistory(tab) {
    const lead = leader(tab); if (!lead) return;
    selectedSeatByTab.set(tab.id, lead.slot); selectedView = "history"; historyRunRequested.delete(seatKeyOf(tab, lead));
    renderStage(); renderCrew();
    $("view").querySelector("[data-chat-live]")?.focus({ preventScroll: true });
  }
  function openSeatView(tabId, slot) {
    const tab = findTab(tabId); if (!tab || !seatFor(tab, slot)) return;
    closePopovers();
    if (tab.id !== currentTab()?.id) selectTabFromUser(tab.id);
    selectedSeatByTab.set(tab.id, slot); selectedView = "live";
    renderStage(); renderCrew();
    $("view").querySelector('[data-run-view="live"]')?.focus({ preventScroll: true });
  }
  function renderStage() {
    const tab = currentTab(); const seat = selectedSeat(tab);
    renderPermissionButton(tab);
    const nextHistoryKey = selectedView === "history" && tab && seat ? seat.seatKey ?? `${tab.id}.${seat.slot}` : null;
    const openedHistory = nextHistoryKey && nextHistoryKey !== historyViewKey;
    historyViewKey = nextHistoryKey;
    if (openedHistory) requestHistory(tab, seat, true);
    if (tab) renderStatusLine(tab);
    if ((tab?.id ?? null) !== composerTabId) {
      if (composerTabId) {
        draftsByTab.set(composerTabId, $("ci").value);
        abandonChatOnTabSwitch(composerTabId);
      }
      composerTabId = tab?.id ?? null; composerGeneration++;
      $("ci").value = draftsByTab.get(composerTabId) ?? "";
      fitComposer();
    }
    const canChat = inChat(tab);
    const pending = Boolean(tab && pendingChatByTab.has(tab.id));
    $("ci").readOnly = pending;
    $("attachBtn").disabled = !canChat || pending;
    $("sendBtn").disabled = !tab || !canChat || !$("ci").value.trim() || chatSendLocked(tab.id) || savePending.has(tab.id);
    const lead = leader(tab);
    $("ci").placeholder = `Message ${lead?.name ?? "the leader"}...`;
    $("ci").setAttribute("aria-label", `Message ${lead?.name ?? "the leader"}`);
    renderFolderButton(tab);
    renderJobsLine(tab);
    syncComposerVisibility();
    if (!tab || !seat) { $("view").innerHTML = '<p class="muted empty-chat">Waiting for server state.</p>'; return; }
    renderAttachments();
    updateChatLoading(tab.id);
    if (!seat.isLeader) renderRunView(tab, seat);
    else if (selectedView === "history") renderLeaderHistory(tab, seat);
    else renderChat(tab);
  }
  function syncComposerVisibility() {
    const tab = currentTab();
    const chat = inChat(tab);
    $("cbox").hidden = !chat;
    $("composer").hidden = !chat && !tab?.pendingApprovals?.length;
  }
  // ---------- background jobs a Claude leader runs: the line by the message box and the rows under the crew ----------
  function jobAge(since) { const minutes = Math.floor(Math.max(0, Date.now() - since) / 60000); return minutes < 1 ? "under 1 min" : `${minutes} min`; }
  function jobsOf(tab) { return Array.isArray(tab?.leaderJobs) ? tab.leaderJobs.map((job) => ({ description: String(job.description ?? ""), startedAt: Number(job.startedAt) || Date.now() })) : []; }
  // Rebuilt only when the list changed, so the spinner is not restarted by every state message; the minutes tick on their own (see tick).
  function setJobsHtml(box, jobs, html) {
    const signature = JSON.stringify(jobs);
    box.hidden = !jobs.length;
    if (box.dataset.sig === signature) return;
    box.dataset.sig = signature; box.innerHTML = jobs.length ? html : "";
  }
  function renderJobsLine(tab) {
    const jobs = jobsOf(tab);
    const oldest = jobs.length ? Math.min(...jobs.map((job) => job.startedAt)) : 0;
    setJobsHtml($("jobsLine"), jobs, `<i class="spin" aria-hidden="true"></i><span>${jobs.length === 1 ? `1 background job still running: ${esc(jobs[0].description)}, ` : `${jobs.length} background jobs still running, longest `}<span data-job-since="${oldest}">${jobAge(oldest)}</span></span>`);
  }
  function renderCrewJobs(tab) {
    const jobs = jobsOf(tab);
    setJobsHtml($("crewJobs"), jobs, `<div class="jhead">Background jobs</div>${jobs.map((job) => `<div class="jrow" title="${esc(job.description)}"><i class="spin" aria-hidden="true"></i><span class="jt">${esc(job.description)}</span><span class="ja" data-job-since="${job.startedAt}">${jobAge(job.startedAt)}</span></div>`).join("")}`);
  }
  function renderFolderButton(tab) {
    const button = $("folderBtn");
    button.hidden = !tab || !window.cc || typeof window.cc.pickFolder !== "function";
    $("folder").textContent = tab ? folderName(tab.folder) : "";
    button.title = tab ? `Works in ${tab.folder}. Click to change the folder` : "";
    button.setAttribute("aria-label", tab ? `Home folder ${tab.folder}. Change folder` : "Change folder");
  }

  // ---------- details: activity, changes, notes and usage ----------
  function renderSide() {
    const tab = currentTab();
    $("side").hidden = !sideOpen; $("main").classList.toggle("side", sideOpen);
    $("sideBtn").setAttribute("aria-pressed", String(sideOpen));
    const rows = activity.filter((item) => !item.tabId || item.tabId === tab?.id);
    $("feed").innerHTML = rows.length ? rows.map((item) => `<div class="ev"><span class="d ${esc(item.type)}"></span><span class="x">${esc(item.text)}</span><time>${esc(item.at)}</time></div>`).join("") : '<span class="faint">Nothing yet in this tab.</span>';
    renderUsage(tab);
    renderLower();
  }
  function renderUsage(tab) {
    const usage = $("usage");
    if (!tab) { usage.innerHTML = '<span class="faint">No usage reported yet.</span>'; return; }
    $("usageTitle").textContent = `This session in ${tab.name}`;
    // Numbers only where the server measured them (the leader's last turn, each live run); every other seat says Not reported.
    const rows = [];
    const lead = leader(tab);
    for (const seat of tab.crew) {
      if (seat.isLeader) { rows.push({ seat, model: formatModel(seat.cli, seat.model, tab), value: formatUsage(tab.leaderUsage) }); continue; }
      const live = (tab.runs ?? []).filter((run) => run.seatSlotId === seat.slot && run.status === "working" && formatUsage(run.usage));
      if (live.length) for (const run of live) rows.push({ seat, model: formatModel(run.cli, run.model), value: formatUsage(run.usage) });
      else rows.push({ seat, model: formatModel(seat.cli, seat.model), value: null });
    }
    const advisor = leader(tab)?.cli === "claude" ? tab.advisor?.model : null;
    const row = (picture, name, model, value, note) => `<div class="useRow${value ? "" : " unmeasured"}">${picture}<span title="${esc(name)} · ${esc(model)}">${esc(name)} <span class="faint">· ${esc(model)}</span></span>${value ? `<span class="v">${esc(value)}</span>` : `<span class="nr">${esc(note)}</span>`}</div>`;
    usage.innerHTML = (rows.some((item) => item.value) ? "" : '<p class="faint" data-usage-empty>No usage reported yet.</p>')
      + rows.map((item) => row(seatImg(item.seat), item.seat.name, item.model, item.value, "Not reported")).join("")
      + (advisor ? row('<span class="advglyph" aria-hidden="true">✦</span>', "Advisor", formatModel("claude", advisor), null, "Not reported separately") : "");
    $("contextLine").textContent = lead ? `${lead.name}'s context: ${contextLine(tab)} · ${formatModel(lead.cli, lead.model, tab)}. Numbers cover the leader's last turn and live runs; a finished run's numbers stay in its own log.` : "";
  }
  function renderLower() {
    document.querySelectorAll(".pills [data-l]").forEach((button) => { const on = button.dataset.l === lowerSection; button.setAttribute("aria-selected", String(on)); button.tabIndex = on ? 0 : -1; });
    $("sideBody").setAttribute("aria-labelledby", `sp-${lowerSection}`);
    $("feed").hidden = lowerSection !== "activity";
    $("usagePanel").hidden = lowerSection !== "usage";
    $("lowerBody").hidden = !["changes", "notes"].includes(lowerSection);
    if (lowerSection === "changes") renderChanges();
    else if (lowerSection === "notes") renderNotes();
  }
  function renderChanges() {
    const tab = currentTab(); const changes = tab?.changes;
    if (!tab || !changes) { $("lowerBody").innerHTML = '<p class="faint" style="margin:0">Git status is unavailable right now. It is read again when a run finishes or you open this tab.</p>'; return; }
    if (!changes.repo) { $("lowerBody").innerHTML = `<div class="kv"><span>Folder</span><span class="path" title="${esc(tab.folder)}">${esc(tab.folder)}</span></div><p class="change-empty faint" data-change-not-repo style="margin:0">Not a git repository. This folder has no commits or uncommitted files to show.</p>`; return; }
    const files = Array.isArray(changes.uncommittedFiles) ? changes.uncommittedFiles : [];
    const ahead = Math.max(0, Number(changes.ahead) || 0), behind = Math.max(0, Number(changes.behind) || 0);
    const hash = changes.lastCommit?.hash ?? "No commit recorded";
    const remote = `${ahead ? `${ahead} commit${ahead === 1 ? "" : "s"} not pushed` : "Up to date"}${behind ? ` · ${behind} behind` : ""}`;
    const rows = [
      `<div class="kv" data-change-row="branch"><span>Branch</span><span class="mono" title="${esc(changes.branch ?? "Unknown")}">${esc(changes.branch ?? "Unknown")}</span></div>`,
      `<div class="kv" data-change-row="commit"><span>Last commit</span><span class="mono" title="${esc(`${hash}${changes.lastCommit?.subject ? ` ${changes.lastCommit.subject}` : ""}`)}">${esc(hash)}</span></div>`,
      `<div class="kv" data-change-row="remote"><span>Remote</span><span style="color:${ahead ? "var(--warn-text)" : "var(--working-text)"}">${esc(remote)}</span></div>`,
      `<div class="kv" data-change-row="files"><span>Not committed</span><span class="mono change-count" style="color:${files.length ? "var(--warn-text)" : "var(--text-2)"}">${files.length} file${files.length === 1 ? "" : "s"}</span></div>`,
    ];
    const fileList = files.length ? `<div class="fl changes-files" data-change-file-list>${files.map((file) => {
      const status = file.status === "??" ? "A" : (String(file.status || "?").match(/[MAD]/)?.[0] ?? "M");
      return `<div><b class="${status}" aria-label="${status}">${status}</b><span title="${esc(file.path)}">${esc(file.path)}</span></div>`;
    }).join("")}</div>` : '<span class="faint">Working tree clean.</span>';
    $("lowerBody").innerHTML = `${rows.join("")}${fileList}`;
  }
  function openObsidianVault() {
    const vaultPath = serverState?.settings?.vault?.path;
    if (!vaultPath) return;
    if (!window.cc || typeof window.cc.openObsidian !== "function") return;
    const url = `obsidian://open?path=${encodeURIComponent(vaultPath)}`;
    Promise.resolve(window.cc.openObsidian(url)).then((result) => {
      if (result?.ok === false) showToast(result.message ?? "Could not open Obsidian");
    }).catch((error) => showToast(error?.message ?? "Could not open Obsidian"));
  }
  function renderNotes() {
    const tab = currentTab(); const notes = tab?.notes;
    if (!tab || !notes) { $("lowerBody").innerHTML = '<span class="faint">Waiting for server state.</span>'; return; }
    const content = typeof notes.content === "string" ? notes.content : "";
    const vault = serverState?.settings?.vault?.path ?? null;
    // A fenced block (one with its closing ```) shows as typed, as code; the fence lines themselves are dropped.
    const raw = content.split(/\r?\n/), closes = fenceCloses(raw), lines = [];
    for (let i = 0, fenced = false; i < raw.length; i += 1) {
      const line = raw[i].trim();
      if (!fenced && /^```/.test(line) && /^```\s*[\w+#.-]*$/.test(line) && closes[i] > i) { fenced = true; continue; }
      if (fenced ? /^```\s*$/.test(line) : /^```/.test(line)) { fenced = false; continue; }
      if (line) lines.push({ line, code: fenced });
    }
    const first = lines.shift();
    const noteHtml = (item, bare) => item.code ? `<code>${esc(item.line)}</code>` : mdInline(bare ? item.line.replace(/^[-*+]\s+/, "").replace(/^#+\s*/, "") : item.line.replace(/^#+\s*/, ""));
    const summary = first ? noteHtml(first) : mdInline("Nothing saved yet. Save writes where you left off.");
    const noteRows = lines.map((item) => `<li data-note-row>${noteHtml(item, true)}</li>`).join("");
    const separator = tab.folder?.includes("/") ? "/" : "\\";
    // The server reads this tab's own handover, or the folder's older shared one until the tab has saved its own.
    const shared = Boolean(notes.path) && !notes.path.replace(/\\/g, "/").endsWith(`/${tab.id}/RESUME.md`);
    const openButton = window.cc && typeof window.cc.openObsidian === "function"
      ? `<div class="note-open-row"><button type="button" class="btn" data-open-vault ${vault ? "" : "disabled"}>${logo("obsidian", 13, 2)}Open in Obsidian</button>${vault ? "" : '<span class="faint" data-vault-empty style="font-size:12.5px">No vault is connected</span>'}</div>` : "";
    $("lowerBody").innerHTML = `${notes.truncated ? `<div class="blk soft2">${ICONS.warn}<span>The handover is longer than 64 KiB, so only its first 64 KiB shows here.</span></div>` : ""}<div class="resume"><span class="lbl">Where we left off</span><p>${summary}${notes.truncated ? " …" : ""}</p></div>${noteRows ? `<ul class="note-rows">${noteRows}</ul>` : '<ul class="note-rows"><li class="faint" style="list-style:none;margin-left:-18px">No note details yet.</li></ul>'}<div class="kv"><span>File</span><span class="path" title="${esc(`${tab.folder}${separator}.command-center${separator}${shared ? "" : `${tab.id}${separator}`}RESUME.md`)}">.command-center${separator}${shared ? "" : `${tab.id}${separator}`}RESUME.md${shared ? " (shared, older: this tab's Save writes its own)" : ""}</span></div>${openButton}`;
    $("lowerBody").querySelector("[data-open-vault]")?.addEventListener("click", openObsidianVault);
  }
  function renderMeters() {
    const meters = $("meters");
    const rows = [];
    for (const [runId, windows] of rateWindowsByRun) {
      const run = allTabs().flatMap(({ tab }) => tab.runs ?? []).find((item) => item.runId === runId);
      if (!run || !windows || typeof windows !== "object") continue;
      for (const [key, value] of Object.entries(windows)) {
        if (!value || typeof value !== "object") continue;
        let percent = null;
        for (const field of ["utilization", "usedPercent", "percentage", "percent"]) {
          const candidate = value[field]; if (typeof candidate === "number" && Number.isFinite(candidate)) { percent = candidate <= 1 ? candidate * 100 : candidate; break; }
          if (typeof candidate === "string" && /^\d+(?:\.\d+)?%$/.test(candidate)) { percent = Number.parseFloat(candidate); break; }
        }
        if (percent === null && Number(value.limit) > 0 && Number.isFinite(Number(value.used))) percent = Number(value.used) / Number(value.limit) * 100;
        if (percent === null || !Number.isFinite(percent)) continue;
        percent = Math.max(0, Math.min(percent, 100));
        const pct = `${percent.toFixed(0)}%`;
        rows.push(`<div class="meter"><div class="row"><span>${esc(cliLabel(run.cli))} · ${esc(titleCase(key))}</span><b>${pct}</b></div><div class="bar"><i style="width:${pct}"></i></div><span class="faint" style="font-size:12px">Reported by ${esc(run.seatName ?? "a run")}'s run</span></div>`);
      }
    }
    meters.innerHTML = rows.join(""); meters.hidden = !rows.length;
    $("metersNote").textContent = rows.length ? "Other CLIs: not reported. Limits show up only while a run reports them." : "Not reported. Limits show up only while a run reports them.";
  }
  // Open or closed is the server's client pref (detailsOpen): a new window on a new port keeps it. Nothing changes when it could not be sent.
  function setSideOpen(open) {
    if (!saveClientPref("detailsOpen", open)) return;
    sideOpen = open;
    renderSide();
  }
  function sideWidth() { return Math.max(280, Math.min(560, Math.round(sideWidthDraft ?? Number(pref("rightPanelWidth", 320)) ?? 320))); }
  function applySideWidth() {
    const width = sideWidth();
    $("main").style.setProperty("--sidew", `${width}px`);
    $("sgrip").setAttribute("aria-valuenow", String(width));
  }
  function saveSideWidth(width) {
    const value = Math.max(280, Math.min(560, Math.round(width)));
    sideWidthDraft = null;
    if (value === Number(pref("rightPanelWidth", 320))) { applySideWidth(); return; }
    if (send({ type: "updateClientPref", key: "rightPanelWidth", value })) clientPrefOverrides.set("rightPanelWidth", value);
    applySideWidth();
  }

  // ---------- Needs you ----------
  function attention(tab) {
    const items = [];
    for (const approval of tab.pendingApprovals ?? []) items.push({ type: "toolApproval", tab, approval });
    if (lookPending(tab)) items.push({ type: "look", tab });
    for (const request of serverState?.requests ?? []) if (request.status === "pending" && request.toTabId === tab.id) items.push({ type: "request", tab, request });
    for (const run of unseenFailedRuns(tab)) items.push({ type: "failed", tab, run, bad: true });
    for (const run of (tab.runs ?? []).filter((item) => item.status === "working" && item.stalled)) items.push({ type: "stalled", tab, run, bad: true });
    const safety = serverState?.launchSafety ?? {};
    for (const row of safety.uncertain ?? []) if (tabIdOfKey(row.seatKey ?? row.seatId) === tab.id) items.push({ type: "uncertain", tab, row, bad: true });
    for (const row of safety.blocked ?? []) { const key = typeof row === "string" ? row : row?.seatKey ?? row?.seatId; if (tabIdOfKey(key) === tab.id) items.push({ type: "blocked", tab, key }); }
    for (const row of safety.notices ?? []) if (row.pending && tabIdOfKey(row.seatKey ?? row.seatId) === tab.id) items.push({ type: "notice", tab, row });
    const save = saveStates.get(tab.id);
    if (save?.status === "failed" || (save?.status === "unknown" && !save.checking)) items.push({ type: "save", tab, save, bad: true });
    return items;
  }
  function attentionFor(tabs) { return tabs.flatMap(attention); }
  // Safety records that belong to no current tab (old bare seat IDs, or a removed tab) still need you: they are listed on their own, never dropped.
  function orphanAttention() {
    const safety = serverState?.launchSafety ?? {}, known = (key) => Boolean(findTab(tabIdOfKey(key)));
    return [
      ...(safety.uncertain ?? []).filter((row) => !known(row.seatKey ?? row.seatId)).map((row) => ({ type: "uncertain", tab: null, row, bad: true })),
      ...(safety.blocked ?? []).map((row) => typeof row === "string" ? row : row?.seatKey ?? row?.seatId).filter((key) => key && !known(key)).map((key) => ({ type: "blocked", tab: null, key })),
      ...(safety.notices ?? []).filter((row) => row.pending && !known(row.seatKey ?? row.seatId)).map((row) => ({ type: "notice", tab: null, row })),
    ];
  }
  function allAttention() { return [...allTabs().filter(({ project, tab }) => !hiddenProject(project.id) && !hiddenTab(tab.id)).flatMap(({ tab }) => attention(tab)), ...orphanAttention()]; }
  function attentionMark(items) { return items.length ? { bad: items.some((item) => item.bad), label: `${items.length} thing${items.length === 1 ? "" : "s"} need${items.length === 1 ? "s" : ""} you` } : null; }
  function whereLine(item, key) {
    if (item.tab) return `<small title="${esc(tabLabel(item.tab.id))}">${esc(tabLabel(item.tab.id))}</small>`;
    const value = String(key ?? "");
    const label = value.includes(".") ? `Removed tab · seat ${value}` : `Old seat ID ${value}`;
    return `<small title="${esc(label)}">${esc(label)}</small>`;
  }
  function nonCodexWarning(seat) { return seat && seat.cli !== "codex" ? `<p class="safety-warning">Only Codex seats can be held read-only. ${esc(seat.name)} runs on ${esc(cliLabel(seat.cli))}.</p>` : ""; }
  function phraseInput(attr, key, label, placeholder) { const draftKey = `${attr}:${key}`; return `<input class="inp phrase" ${attr}="${esc(key)}" data-phrase-key="${esc(draftKey)}" value="${esc(phraseDrafts.get(draftKey) ?? "")}" aria-label="${esc(label)}" placeholder="${esc(placeholder)}" autocomplete="off">`; }
  function requestCard(request, incoming) {
    const actionKey = `request-resolve-${request.id}`;
    const localRequestId = settingsActionId(actionKey);
    const trackedAction = localRequestId ? actionStateFor(localRequestId) ?? { requestId: localRequestId, status: "running", message: "Working" } : null;
    // A card that already resolved is never "Working".
    const action = request.status !== "pending" && trackedAction?.status === "running" ? null : trackedAction;
    const source = requestTabLabel(request.fromTabId); const destination = requestTabLabel(request.toTabId);
    const status = requestStatusLabel(request.status);
    const leaderNameText = destination.tab ? leaderName(destination.tab) : "the leader";
    const stateClass = request.status === "accepted" ? "ok" : request.status === "pending" ? "wait" : request.status === "destinationRemoved" ? "bad" : "";
    const controls = request.status === "pending" && incoming && destination.tab
      ? `<div class="acts req-actions"><button type="button" class="btn sm primary" data-request-action="accept:${esc(request.id)}" ${action?.status === "running" ? "disabled" : ""}><span class="bl" title="${esc(`Hand to ${destination.name}'s ${leaderNameText}`)}">Hand to ${esc(destination.name)}'s ${esc(leaderNameText)}</span></button><button type="button" class="btn sm" data-request-action="decline:${esc(request.id)}" ${action?.status === "running" ? "disabled" : ""}>Decline</button></div>`
      : `<div class="acts"><span class="state req-sent-state ${stateClass}" data-request-status="${esc(request.status)}">${esc(status)}</span>${request.status === "destinationRemoved" ? '<span class="st">That tab was removed, so this request can no longer be answered.</span>' : ""}</div>`;
    return `<article class="ncard req${request.status === "destinationRemoved" ? " removed" : request.status !== "pending" ? " resolved" : ""}${incoming ? " incoming" : " sent"}" data-request-id="${esc(request.id)}"><div class="route"><span class="tg${source.tab ? "" : " gone"}" title="${esc(source.label)}">${esc(source.label)}</span><span class="route-arrow" aria-label="to">&#8594;</span><span class="tg${destination.tab ? "" : " gone"}" title="${esc(destination.label)}">${esc(destination.label)}</span><span class="spacer"></span><time class="req-time">${esc(requestTimeAgo(request.createdAt))}</time></div><b class="req-title">${plainMd(request.title)}</b><div class="req-body md">${mdHtml(request.body)}</div>${action ? `<span class="action-status" data-status="${esc(action.status)}" data-status-for="${esc(localRequestId)}">${esc(action.message)}</span>` : ""}${controls}</article>`;
  }
  function attentionCard(item) {
    const tab = item.tab;
    if (item.type === "toolApproval") return `<div class="ncard apx">${whereLine(item)}<b>${esc(approvalTitle(item.approval.tool, tab))}</b><code class="approval-code"><span class="approval-path">${esc(item.approval.summary)}</span></code><div class="acts"><button type="button" class="btn sm primary" data-wait-approval="${esc(item.approval.approvalId)}" data-approval-tab="${esc(tab.id)}">Open it</button><span class="st">Answer it above ${esc(tab.name)}'s composer</span></div></div>`;
    if (item.type === "look") { const shots = screenshotPaths(tab).length; return `<div class="ncard look">${whereLine(item)}<b>Approve the look</b><p>${esc(leaderName(tab))}${shots ? ` has ${shots} screenshot${shots === 1 ? "" : "s"} ready for you.` : " is waiting for your look."}</p><div class="acts"><button type="button" class="btn sm primary" data-wait-tab="${esc(tab.id)}">Open it</button></div></div>`; }
    if (item.type === "request") return requestCard(item.request, true);
    if (item.type === "failed") return `<div class="ncard bad">${whereLine(item)}<b>${esc(item.run.seatName)}'s run failed</b><p>${plainMd(item.run.label)} · ${esc(item.run.outcome ?? "failed")}${item.run.endedAt ? ` · ${esc(agoText(item.run.endedAt))}` : ""}</p><div class="acts"><button type="button" class="btn sm primary" data-open-seat="${esc(item.run.seatSlotId)}" data-open-tab="${esc(tab.id)}">Open ${esc(item.run.seatName)}</button><button type="button" class="btn sm" data-dismiss-run="${esc(item.run.runId)}">Dismiss</button></div></div>`;
    if (item.type === "stalled") return `<div class="ncard bad">${whereLine(item)}<b>${esc(item.run.seatName)}'s run stalled</b><p>${plainMd(item.run.label)}: no output for ${STALL_MINUTES} minutes. ${stallActions.get(item.run.runId) === "relaunch" ? "Command Center is stopping it and starting it once more." : "It was not relaunched by itself."}</p><div class="acts"><button type="button" class="btn sm primary" data-open-seat="${esc(item.run.seatSlotId)}" data-open-tab="${esc(tab.id)}">Watch it</button><button type="button" class="btn sm danger" data-stop-run="${esc(item.run.runId)}">Stop this run</button></div></div>`;
    if (item.type === "uncertain") {
      const key = item.row.seatKey ?? item.row.seatId ?? "unknown seat", runId = item.row.runId, owner = seatOfKey(key);
      const run = owner.tab?.runs?.find((candidate) => candidate.runId === runId);
      const sameSeat = uncertainRows().filter((row) => (row.seatKey ?? row.seatId) === key).length;
      return `<div class="ncard bad">${whereLine(item, key)}<b>Stop not confirmed · ${esc(owner.seat?.name ?? owner.slot)}</b><p>PID ${esc(item.row.pid ?? "unknown")}${run ? ` (${plainMd(run.label)})` : ""} may still be running and editing files. Try to stop it again, or release it if you are sure.</p>${nonCodexWarning(owner.seat)}${runId ? `<div class="acts"><button type="button" class="btn sm" data-retry-kill="${esc(runId)}">Try to stop again</button></div>` : ""}<div class="acts">${phraseInput("data-confirm-release", runId ?? key, `Confirm release for ${key}`, STOP_CONFIRM)}<button type="button" class="btn sm danger" data-release="${esc(runId ?? "")}" data-release-seat="${esc(key)}">Release</button>${sameSeat > 1 && runId ? `<button type="button" class="btn sm danger" data-release-all="${esc(key)}" data-release-ref="${esc(runId)}">Release all ${sameSeat} for ${esc(owner.seat?.name ?? "this seat")}</button>` : ""}</div></div>`;
    }
    if (item.type === "blocked") {
      const owner = seatOfKey(item.key);
      return `<div class="ncard">${whereLine(item, item.key)}<b>Launch blocked · ${esc(owner.seat?.name ?? owner.slot)}</b><p>${esc(owner.seat?.name ?? "This seat")} was stopped and cannot start again, by you or by ${esc(owner.tab ? leaderName(owner.tab) : "a leader")}, until you allow it.</p>${nonCodexWarning(owner.seat)}<div class="acts">${phraseInput("data-confirm-unblock", item.key, `Confirm unblock for ${item.key}`, UNBLOCK_CONFIRM)}<button type="button" class="btn sm" data-unblock="${esc(item.key)}">Allow again</button></div></div>`;
    }
    if (item.type === "notice") return `<div class="ncard">${whereLine(item, item.row.seatKey ?? item.row.seatId)}<b>Launch outcome unconfirmed · ${esc(item.row.seatName ?? item.row.seatId)}</b><p>${esc(item.row.source ?? "Command Center")} started ${plainMd(item.row.brief ?? "a run")}. The server could not confirm whether it launched; check ${esc(item.row.seatName ?? "the seat")} before running it again.</p><div class="acts"><button type="button" class="btn sm" data-ack-notice="${esc(item.row.id)}">Acknowledge</button></div></div>`;
    if (item.type === "save") return `<div class="ncard bad">${whereLine(item)}<b>${item.save.status === "failed" ? "Save failed" : "Save not confirmed"}</b><p>${esc(item.save.message)}</p><div class="acts"><button type="button" class="btn sm primary" data-save-tab="${esc(tab.id)}">Retry save</button></div></div>`;
    return "";
  }
  function renderInbox() {
    const items = allAttention();
    const list = $("inboxList"), records = $("inboxRecords");
    if (!list) return;
    const focusKey = document.activeElement?.closest?.("#inboxPop") && !document.activeElement.closest("#reqForm") ? focusKeyOf(document.activeElement) : null;
    const selection = document.activeElement?.matches?.(".phrase") ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    $("inboxHead").textContent = `Needs you${items.length ? ` · ${items.length}` : ""}`;
    list.innerHTML = items.length ? items.map(attentionCard).join("") : '<div class="allclear"><b>Nothing needs you right now</b><span>Approvals, looks, requests and stopped or failed work show up here.</span></div>';
    const safety = serverState?.launchSafety ?? {};
    const released = safety.released ?? [], recordNotices = (safety.notices ?? []).filter((row) => !row.pending);
    records.innerHTML = `${released.length ? `<div class="grp">Released without a confirmed exit · ${released.length}</div>${released.map((row) => { const owner = seatOfKey(row.seatId); return `<div class="ncard sent"><div class="route"><span class="tg">PID ${esc(row.pid)}</span><span class="tg" title="${esc(owner.seat?.name ?? row.seatId)}">${esc(owner.seat?.name ?? row.seatId)}</span></div><p>${esc(owner.tab ? tabLabel(owner.tab.id) : owner.legacy ? `Old seat ID ${row.seatId}` : "Removed tab")}. Released by you; it may still be running. The seat stays blocked until you allow it.</p></div>`; }).join("")}` : ""}${recordNotices.length ? `<div class="grp row"><span>Launch records · ${recordNotices.length}</span><button type="button" class="btn sm" data-ack-all>Acknowledge all</button></div>${recordNotices.map((row) => { const owner = seatOfKey(row.seatKey ?? row.seatId); return `<div class="ncard sent"><div class="route"><span class="tg" title="${esc(row.source ?? "Command Center")}">${esc(row.source === "Local client" ? "You" : row.source ?? "Command Center")}</span><span class="route-arrow" aria-label="to">&#8594;</span><span class="tg" title="${esc(row.seatName ?? row.seatId)}">${esc(row.seatName ?? row.seatId)}</span><span class="spacer"></span><span class="faint" title="${esc(owner.tab ? tabLabel(owner.tab.id) : "Removed tab")}">${esc(owner.tab ? tabLabel(owner.tab.id) : "Removed tab")}</span></div><p>Launched: ${plainMd(row.brief ?? "")}</p><div class="acts"><button type="button" class="btn sm" data-ack-notice="${esc(row.id)}">Acknowledge</button></div></div>`; }).join("")}` : ""}`;
    bindInbox($("inboxPop"));
    renderRequests();
    if (focusKey && !document.activeElement?.isConnected) { const next = $$(focusKey).find(shown); if (next) { next.focus({ preventScroll: true }); if (selection && next.setSelectionRange) try { next.setSelectionRange(selection[0], selection[1]); } catch { /* not a text field */ } } }
    if (!$("inboxPop").hidden) placePopover($("inboxPop"));
  }
  function bindInbox(root) {
    root.querySelectorAll("[data-wait-tab]").forEach((button) => button.addEventListener("click", () => {
      const tabId = button.dataset.waitTab; closePopovers();
      const tab = findTab(tabId); if (tab) { selectedSeatByTab.set(tab.id, leader(tab)?.slot); selectedView = "live"; }
      selectTabFromUser(tabId); renderStage();
      requestAnimationFrame(() => $("lookCard")?.querySelector("button")?.focus({ preventScroll: true }));
    }));
    root.querySelectorAll("[data-wait-approval]").forEach((button) => button.addEventListener("click", () => {
      approvalFocusTabId = button.dataset.approvalTab;
      const tab = findTab(approvalFocusTabId); if (tab) { selectedSeatByTab.set(tab.id, leader(tab)?.slot); selectedView = "live"; }
      setLayer($("inboxPop"), false, null, false, false);
      selectTabFromUser(button.dataset.approvalTab); renderToolApproval();
    }));
    root.querySelectorAll("[data-open-seat]").forEach((button) => button.addEventListener("click", () => openSeatView(button.dataset.openTab ?? currentTab()?.id, button.dataset.openSeat)));
    root.querySelectorAll("[data-dismiss-run]").forEach((button) => button.addEventListener("click", () => { dismissedRuns.add(button.dataset.dismissRun); saveDismissed(); renderAll(); }));
    root.querySelectorAll("[data-save-tab]").forEach((button) => button.addEventListener("click", () => { const tab = findTab(button.dataset.saveTab); if (!tab) return; closePopovers(); if (tab.id !== currentTab()?.id) selectTabFromUser(tab.id); startSave(tab); }));
    root.querySelectorAll("[data-stop-run]").forEach((button) => button.addEventListener("click", () => killRun(button.dataset.stopRun)));
    root.querySelectorAll("[data-phrase-key]").forEach((input) => input.addEventListener("input", () => phraseDrafts.set(input.dataset.phraseKey, input.value)));
    root.querySelectorAll("[data-unblock]").forEach((button) => button.addEventListener("click", () => {
      const seatKey = button.dataset.unblock; const confirm = root.querySelector(`[data-confirm-unblock="${CSS.escape(seatKey)}"]`)?.value ?? "";
      if (confirm !== UNBLOCK_CONFIRM) { showToast(`Type ${UNBLOCK_CONFIRM} to unblock this seat`); return; }
      if (send({ type: "unblockSeat", seatKey, confirm })) phraseDrafts.delete(`data-confirm-unblock:${seatKey}`);
    }));
    root.querySelectorAll("[data-release]").forEach((button) => button.addEventListener("click", () => {
      const ref = button.dataset.release || button.dataset.releaseSeat; const confirm = root.querySelector(`[data-confirm-release="${CSS.escape(ref)}"]`)?.value ?? "";
      if (confirm !== STOP_CONFIRM) { showToast(`Type ${STOP_CONFIRM} to release this process`); return; }
      const sent = button.dataset.release ? send({ type: "releaseUnconfirmed", runId: button.dataset.release, confirm }) : send({ type: "releaseUnconfirmedSeat", seatId: button.dataset.releaseSeat, confirm });
      if (sent) phraseDrafts.delete(`data-confirm-release:${ref}`);
    }));
    root.querySelectorAll("[data-release-all]").forEach((button) => button.addEventListener("click", () => {
      const confirm = root.querySelector(`[data-confirm-release="${CSS.escape(button.dataset.releaseRef)}"]`)?.value ?? "";
      if (confirm !== STOP_CONFIRM) { showToast(`Type ${STOP_CONFIRM} to release them`); return; }
      send({ type: "releaseUnconfirmedSeat", seatId: button.dataset.releaseAll, confirm });
    }));
    root.querySelectorAll("[data-retry-kill]").forEach((button) => button.addEventListener("click", () => sendKill(button.dataset.retryKill)));
    root.querySelectorAll("[data-ack-notice]").forEach((button) => button.addEventListener("click", () => send({ type: "ackLaunchNotice", id: Number(button.dataset.ackNotice) })));
    root.querySelector("[data-ack-all]")?.addEventListener("click", () => { const ids = (serverState?.launchSafety?.notices ?? []).filter((row) => !row.pending).map((row) => row.id); if (ids.length) send({ type: "ackLaunchNotices", ids }); });
    root.querySelectorAll("[data-request-action]").forEach((button) => button.addEventListener("click", () => { if (resolveRequestFrom(button)) renderInbox(); }));
  }
  // Accept or Decline names the tab the request is addressed to, not the tab that happens to be open: Needs you lists requests for every tab.
  function resolveRequestFrom(button) {
    const [status, id] = button.dataset.requestAction.split(":");
    const request = (serverState?.requests ?? []).find((item) => item.id === id);
    if (!request) { showToast("That request is not on the list any more"); return false; }
    const requestId = newRequestId();
    if (!send({ type: "resolveRequest", id, status: status === "accept" ? "accepted" : "declined", requestId, tabId: request.toTabId })) return false;
    pendingSettingsActions.set(`request-resolve-${id}`, requestId);
    return true;
  }
  function renderRequestBadge() {
    const tab = currentTab(); const count = tab ? Number(serverState?.pendingRequestCounts?.[tab.id] ?? tab.pendingRequestCount ?? 0) : 0;
    const badge = $("reqN"); badge.textContent = String(count); badge.hidden = count < 1;
    $("reqHeadLabel").textContent = tab ? `Requests · ${tabLabel(tab.id)}` : "Requests";
    $("reqHeadLabel").title = $("reqHeadLabel").textContent;
    $("reqHead").title = count ? `${count} pending for ${tab?.name ?? "this tab"}` : `Requests for ${tab?.name ?? "this tab"}`;
  }
  function requestTabLabel(tabId) {
    for (const { project, tab } of allTabs()) if (tab.id === tabId) return { name: tab.name, project: project.name, label: `${project.name} / ${tab.name}`, tab };
    return { name: "Destination removed", project: "Removed", label: "Removed tab", tab: null };
  }
  function requestTimeAgo(value) {
    const age = Math.max(0, Date.now() - Number(value || Date.now()));
    if (age < 60_000) return "Just now";
    if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
    if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
    return `${Math.floor(age / 86_400_000)}d ago`;
  }
  function requestStatusLabel(status) {
    return status === "accepted" ? "Handed over" : status === "pending" ? "Pending" : status === "declined" ? "Declined" : status === "destinationRemoved" ? "Destination removed" : titleCase(status);
  }
  function openInbox(anchor = $("inboxBtn")) {
    renderInbox();
    openPopover($("inboxPop"), anchor);
    // Needs you can open on any of a dozen cards: the panel takes focus itself, and Tab enters its first control.
    $("inboxPop").focus({ preventScroll: true });
  }
  function renderRequests() {
    const tab = currentTab();
    const active = document.activeElement;
    const focusedAction = active?.dataset?.requestAction;
    const focusedField = ["reqTo", "reqTitle", "reqBody", "reqSend"].includes(active?.id) ? active.id : null;
    const requests = Array.isArray(serverState?.requests) ? serverState.requests : [];
    const incomingRequests = requests.filter((request) => request.toTabId === tab?.id && request.status !== "pending").sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    const sentRequests = requests.filter((request) => request.fromTabId === tab?.id).sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    const incomingCards = incomingRequests.map((request) => requestCard(request, true)).join("");
    const sentCards = sentRequests.map((request) => requestCard(request, false)).join("");
    $("reqList").innerHTML = `<section class="req-section" data-request-section="incoming"><h3 class="grp">Incoming, answered</h3>${incomingCards || '<p class="hint request-empty">No answered incoming requests.</p>'}</section><section class="req-section" data-request-section="sent"><h3 class="grp">Sent from ${esc(tab?.name ?? "this tab")}</h3>${sentCards || '<p class="hint request-empty">Nothing sent from this tab yet.</p>'}</section>`;
    $("reqFrom").textContent = tab ? `From ${tabLabel(tab.id)}` : "From this tab";
    const options = allTabs().filter(({ tab: item }) => item.id !== tab?.id).map(({ project, tab: item }) => `<option value="${esc(item.id)}">${esc(project.name)} / ${esc(item.name)}</option>`).join("");
    const selected = $("reqTo").value;
    $("reqTo").innerHTML = options || '<option value="">No other tabs</option>';
    if (selected && [...$("reqTo").options].some((option) => option.value === selected)) $("reqTo").value = selected;
    $("reqTo").disabled = !options;
    const pendingRequestAction = pendingRequestActions.get(tab?.id) ?? requestActionResults.get(tab?.id)?.requestId;
    const sendAction = pendingRequestAction ? actionStateFor(pendingRequestAction) : null;
    // A sent request empties the form once, so a second click cannot send a duplicate.
    if (sendAction?.status === "done" && requestFormCleared.get(tab.id) !== pendingRequestAction) { requestFormCleared.set(tab.id, pendingRequestAction); $("reqTitle").value = ""; $("reqBody").value = ""; }
    const sending = Boolean(pendingRequestAction && (!sendAction || sendAction.status === "running"));
    const canSend = Boolean(tab && options && !sending);
    $("reqSend").disabled = !canSend;
    $("reqStatus").textContent = sendAction?.message ?? (pendingRequestAction ? "Working" : "");
    $("reqStatus").dataset.status = sendAction?.status ?? (pendingRequestAction ? "running" : "");
    $("reqSend").textContent = sending ? "Sending…" : "Send request";
    $("reqList").querySelectorAll("[data-request-action]").forEach((button) => button.addEventListener("click", () => { if (resolveRequestFrom(button)) renderRequests(); }));
    renderRequestBadge();
    if (focusedAction) $("reqList").querySelector(`[data-request-action="${CSS.escape(focusedAction)}"]`)?.focus({ preventScroll: true });
    else if (focusedField) $(focusedField)?.focus({ preventScroll: true });
  }

  // ---------- stopping ----------
  // The server answers each killRun with killAccepted or an error that names no run, in the order it got them: killOrder remembers that order.
  function sendKill(runId) {
    if (!send({ type: "killRun", runId })) return false;
    killOrder.push(runId);
    return true;
  }
  function killRun(runId) {
    const run = allTabs().flatMap(({ tab }) => tab.runs ?? []).find((item) => item.runId === runId);
    if (!run || run.status !== "working") { sendKill(runId); return; }
    if (stopStates.has(runId) && !uncertainRun(runId)) return;
    if (sendKill(runId)) stopStates.set(runId, "requested");
    renderAll();
  }
  function stopSeat(tab, seat) {
    const runs = liveRuns(tab, seat);
    if (!send({ type: "stopSeat", tabId: tab.id, slot: seat.slot })) return;
    for (const run of runs) if (!stopStates.has(run.runId)) stopStates.set(run.runId, "requested");
    if (seat.isLeader) holdQueue(tab.id);
    if (seat.isLeader) showToast(`Asked the server to stop ${seat.name}'s session. Your next message starts a fresh one.`);
    else showToast(runs.length ? `Asking the server to stop ${seat.name}…` : `${seat.name} will be blocked from launching until you allow it again`);
    renderAll();
  }
  function stopAll() {
    const tabs = allTabs().map(({ tab }) => tab).filter(activeTabBusy);
    const runIds = new Set(tabs.flatMap((tab) => (tab.runs ?? []).filter((run) => run.status === "working").map((run) => run.runId)));
    if (!send({ type: "stopAll" })) return;
    stopAllTrack = { runIds, tabIds: new Set(tabs.map((tab) => tab.id)), accepted: false };
    for (const id of runIds) if (!stopStates.has(id)) stopStates.set(id, "requested");
    for (const { tab } of allTabs()) holdQueue(tab.id);
    showToast("Asking the server to stop everything in every tab…");
    renderAll();
  }
  function unblockWithConfirm(tab, seat, opener) {
    const key = seatKeyOf(tab, seat);
    confirmAction({ title: `Allow ${seat.name} to launch again?`, body: `${seat.name} was stopped. Once allowed, you or ${leaderName(tab)} can start it again.`, ok: "Allow again", phrase: UNBLOCK_CONFIRM }, (typed) => {
      send({ type: "unblockSeat", seatKey: key, confirm: typed });
    }, opener);
  }

  // ---------- composer extras ----------
  const PERMISSIONS = [
    // Each CLI enforces a mode its own way (PROTOCOL.md, Limits): only Claude's wording is a promise; Codex and OpenCode say what really happens.
    ["ask", "Ask before edits", (name, cli) => cli === "codex" ? `${name} asks for commands Codex judges unsafe. Some commands and file writes can still go through without asking`
      : cli === "opencode" ? `${name} asks before edits and commands. Reading files and folders does not ask`
      : `${name} asks before changing any file or running a command`],
    ["accept", "Auto-accept edits", (_name, cli) => cli === "codex" ? "Edits and commands inside the folder go through. Codex asks when it needs more access" : "Edits go through, commands still ask"],
    ["plan", "Plan only", (_name, cli) => cli === "codex" ? "Codex's read-only mode. It is not a lock: a command can still write a file"
      : cli === "opencode" ? "Edits are denied. Commands still ask, and a command you allow can still write a file"
      : "Reads and plans, changes nothing"],
    ["bypass", "Bypass permissions", (name) => `${name} runs everything without asking. Crew access does not change. Use with care.`],
  ];
  let permissionRefocus = false;
  const acpWarning = (tab) => `${tab.acpLeader?.name ?? leaderName(tab)} may edit files and run commands without asking. Command Center cannot make it ask yet.`;
  function permissionActionFor(tab) {
    const requestId = pendingPermissionAction.get(tab?.id) ?? permissionActionResults.get(tab?.id)?.requestId;
    return (requestId && (actionStateFor(requestId) ?? { requestId, status: "running", message: "Working" })) || tab?.permissionAction || null;
  }
  function renderPermissionButton(tab) {
    const button = $("permBtn");
    if (!tab) { button.disabled = true; button.textContent = "Permission"; button.dataset.p = "ask"; $("acpNote").hidden = true; return; }
    const mode = tab.permissionMode ?? serverState?.settings?.permissionModes?.[tab.id] ?? "accept";
    $("acpNote").hidden = !tab.acpLeader; $("acpNote").textContent = tab.acpLeader ? acpWarning(tab) : "";
    const action = permissionActionFor(tab);
    const label = PERMISSIONS.find(([id]) => id === mode)?.[1] ?? "Unknown";
    // The browser drops focus from a button that becomes disabled; hand it back once the change settles.
    if (action?.status === "running" && document.activeElement === button) permissionRefocus = true;
    button.disabled = action?.status === "running";
    if (!button.disabled && permissionRefocus) {
      permissionRefocus = false;
      if (!document.activeElement || document.activeElement === document.body) button.focus({ preventScroll: true });
    }
    button.dataset.p = mode;
    const state = action?.status === "running" ? '<span class="perm-state">· Applying</span>' : action?.status === "failed" ? '<span class="perm-state bad">· Not changed</span>' : "";
    button.innerHTML = `<i class="perm-dot" aria-hidden="true"></i><span data-permission-label>${esc(label)}</span>${state}<svg class="perm-chevron" width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    button.title = action?.message ? `${label}: ${action.message}` : `Permission mode: ${label}`;
    button.setAttribute("aria-label", `Permission mode: ${label}${action?.status === "running" ? ", applying" : action?.status === "failed" ? ", not changed" : ""}`);
  }
  function openPermissionPicker(tab, anchor) {
    if (!tab) return;
    const mode = tab.permissionMode ?? serverState?.settings?.permissionModes?.[tab.id] ?? "accept";
    const action = permissionActionFor(tab);
    const name = leaderName(tab), cli = leader(tab)?.cli;
    const pop = $("permPop");
    if (tab.acpLeader) {
      // An ACP CLI decides by itself whether it asks (it can edit without ever asking): Full access is the only mode it has, so Ask, Accept and Plan are not offered.
      pop.innerHTML = `<div class="grp lbl">Permissions for this chat</div><button type="button" class="opt perm" aria-pressed="true" disabled><span class="nm">Bypass permissions<small>${esc(acpWarning(tab))}</small></span>${ICONS.tick}</button><div class="hint">Ask, Accept and Plan come back for a CLI only after we have tested that it really asks.</div>`;
      openPopover(pop, anchor);
      return;
    }
    pop.innerHTML = `<div class="grp lbl">Permissions for this chat</div>${PERMISSIONS.map(([id, label, description]) => `<button type="button" class="opt perm" data-permission-mode="${id}" aria-pressed="${String(mode === id)}" ${action?.status === "running" ? "disabled" : ""}><span class="nm">${esc(label)}<small>${esc(description(name, cli))}</small></span>${ICONS.tick}</button>`).join("")}${action?.status === "failed" ? `<p class="hint" data-permission-status style="color:var(--danger-text)">${esc(action.message)}</p>` : ""}<div class="hint">A tool that still needs you shows up above the message box, and in Needs you.</div>`;
    openPopover(pop, anchor);
    pop.querySelectorAll("[data-permission-mode]").forEach((button) => button.addEventListener("click", () => {
      const next = button.dataset.permissionMode;
      if (next === mode) { setLayer(pop, false); return; }
      const apply = () => {
        const requestId = newRequestId();
        if (!send({ type: "setPermissionMode", tabId: tab.id, mode: next, requestId, ...(next === "bypass" ? { confirm: true } : {}) })) return;
        pendingPermissionAction.set(tab.id, requestId);
        renderPermissionButton(tab);
      };
      setLayer(pop, false);
      if (next === "bypass") confirmAction({ title: `Bypass permissions in ${tab.name}?`, body: `${name} will edit files and run commands in ${tab.folder} without asking you first, and launch writable seats without asking. This changes ${name} only: each crew seat keeps the access its crew gives it. You can switch back at any time.`, ok: "Allow bypass", danger: true }, apply, $("permBtn"));
      else apply();
    }));
  }

  // ---------- full render ----------
  function requestVisibleTabTranscript() {
    const entry = activeEntry();
    if (!entry) return;
    if (serverState?.selectedTabId === entry.tab.id && transcripts.has(entry.tab.id)) return;
    if (transcriptRequests.has(entry.tab.id)) return;
    send({ type: "selectTab", tabId: entry.tab.id });
  }
  function renderAll() {
    const active = document.activeElement, key = active && active !== document.body ? focusKeyOf(active) : null;
    // The same control can exist in the work view and in an open card: focus comes back inside the layer it was in.
    const LAYERS = ".pop,.modal", layerId = key ? active.closest(LAYERS)?.id : null;
    const selection = active && "selectionStart" in active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    requestVisibleTabTranscript();
    const none = Boolean(serverState) && !visibleProjects().length;
    $("first").hidden = !none; $("stage").hidden = none;
    if (none) { sideOpen && ($("side").hidden = true); renderFirst(); }
    renderHeader(); renderTabs(); renderCrew(); renderStage(); renderSide(); renderUndo(); renderInbox();
    if (!$('setModal').hidden) renderSettings();
    renderAvatarStatus();
    renderToolApproval();
    applySideWidth();
    refreshPopovers();
    if (key && !active.isConnected && (document.activeElement === document.body || !document.activeElement)) { const next = $$(key).find((el) => shown(el) && (layerId ? el.closest(LAYERS)?.id === layerId : !el.closest(LAYERS))); if (next) { next.focus({ preventScroll: true }); if (selection && next.setSelectionRange) try { next.setSelectionRange(selection[0], selection[1]); } catch { /* not a text field */ } } }
    ensureTicker();
  }
  function refreshPopovers() {
    const seatPop = $("seatPop");
    if (!seatPop.hidden) {
      const tab = findTab(seatPop.dataset.tabId), seat = seatFor(tab, seatPop.dataset.slot);
      if (!tab || !seat || tab.id !== currentTab()?.id) setLayer(seatPop, false, null, false, false);
      else renderSeatCard(tab, seat);
    }
    const pickPop = $("pop");
    if (!pickPop.hidden && pickerSeat && pickPop.querySelector("#mq")) {
      const tab = findTab(pickerSeat.tabId), seat = seatFor(tab, pickerSeat.slot);
      if (!tab || !seat) setLayer(pickPop, false, null, false, false);
      else drawModelPicker(tab, seat, pickPop._anchor, pickerSeat.fromCard, true);
    }
    for (const id of ["seatPop", "pop", "projPop", "ctxPop", "setupPop", "permPop", "inboxPop", "soundPop"]) { const pop = $(id); if (!pop.hidden) placePopover(pop); }
  }
  function renderFirst() {
    const tools = serverState?.settings?.tools ?? {};
    const status = (cli) => { const tool = tools[cli]; return tool?.installed === false ? "Not installed" : tool?.installed === true ? (tool.signedIn === true ? "Signed in" : tool.signedIn === false ? "Installed, not signed in" : "Installed, sign-in status unknown") : "Install status unknown"; };
    $("first").innerHTML = `<div class="fcard"><svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><path d="M42.2 46.6A19 19 0 1 1 42.2 17.4" fill="none" stroke="url(#orbitMark)" stroke-width="12" stroke-linecap="round"/><circle cx="50.5" cy="32" r="6.5" fill="#ffc94d"/></svg><h2>Add your first project</h2><p>A project is a folder on your PC. It starts with one Development tab and the Main Crew; you can add Design or Marketing tabs and change the crew later.</p><button type="button" class="btn primary" data-first-project>New project</button><div class="card checks">${["claude", "codex", "opencode", "gemini"].map((cli) => `<div class="crow"><span class="logo">${logo(cli, 16, 0)}</span><div class="d"><b>${esc(cliLabel(cli))}</b><small>${esc(status(cli))}</small></div>${tools[cli]?.signedIn === true ? '<span class="tool-connected"><i></i>Ready</span>' : `<button type="button" class="btn sm" data-first-setup>Set up</button>`}</div>`).join("")}</div><p class="faint" style="font-size:12.5px">Claude, Codex or OpenCode can run the leader, and so can any ACP CLI you add in Settings. You only need the ones your crew uses.</p></div>`;
    $("first").querySelector("[data-first-project]")?.addEventListener("click", (event) => openProjectDialog(event.currentTarget));
    $("first").querySelectorAll("[data-first-setup]").forEach((button) => button.addEventListener("click", (event) => openSettings(event.currentTarget, "tools")));
  }
  function ensureTicker() {
    if (tickerTimer) return;
    if (!needsTicker()) return;
    tickerTimer = setInterval(tick, 1000);
  }
  function needsTicker() { return Boolean(document.querySelector("[data-run-time],[data-undo-due],[data-job-since]") || connState === "off"); }
  function tick() {
    document.querySelectorAll("[data-job-since]").forEach((element) => { element.textContent = jobAge(Number(element.dataset.jobSince)); });
    document.querySelectorAll("[data-run-time]").forEach((element) => {
      const run = allTabs().flatMap(({ tab }) => tab.runs ?? []).find((item) => item.runId === element.dataset.runTime);
      if (run?.status === "working") element.textContent = spanText(run.startedAt);
    });
    document.querySelectorAll("[data-undo-due]").forEach((element) => { element.textContent = undoSeconds(Number(element.dataset.undoDue)); });
    const retry = $("retryS"); if (retry) retry.textContent = `${Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))} s`;
    if (!needsTicker()) { clearInterval(tickerTimer); tickerTimer = 0; }
  }

  // ---------- creating tabs and projects, switching the crew ----------
  function availableKindOptions(selected) {
    return KINDS.map((kind) => `<button type="button" role="radio" aria-checked="${String(kind.id === selected)}" data-kind="${kind.id}"><b>${esc(kind.name)}</b><small>${esc(kind.desc)}</small></button>`).join("");
  }
  function kindSegments(selected) { return KINDS.map((kind) => `<button type="button" role="radio" data-kind="${kind.id}" aria-checked="${String(kind.id === selected)}">${esc(kind.name)}</button>`).join(""); }
  function processDescription(kind, process) {
    if (process !== "main") return PROCESSES.find((item) => item.id === process)?.desc ?? "";
    return { dev: "Leader, coder, two reviewers, a fixer, final review", design: "Leader, designer, image and assets, design reviewer", mkt: "Leader, second opinion, social media, image, video and motion" }[kind] ?? "";
  }
  function availableProcessOptions(selected, kind = "dev") {
    return PROCESSES.map((process) => `<button type="button" role="radio" aria-checked="${String(process.id === selected)}" data-process="${process.id}"><b>${esc(process.name)}</b><small>${esc(processDescription(kind, process.id))}</small></button>`).join("");
  }
  function bindRadios(box, selector, callback) {
    box.addEventListener("click", (event) => {
      const button = event.target.closest(selector); if (!button || !box.contains(button)) return;
      box.querySelectorAll(selector).forEach((item) => item.setAttribute("aria-checked", String(item === button)));
      fixRadios(box.parentElement ?? box);
      callback(button);
    });
    box.addEventListener("keydown", (event) => {
      if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = $$(selector, box).filter((item) => !item.disabled); const index = items.indexOf(document.activeElement); if (index < 0) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + items.length) % items.length;
      items[next].focus(); items[next].click();
    });
  }
  function openAddTab(opener) {
    const project = currentProject(); if (!project) return;
    tabKind = "dev"; tabProcess = "main";
    $("mProj").textContent = project.name; $("tName").value = "";
    $("tStat").textContent = ""; $("tStat").classList.remove("bad"); $("tOnly").checked = true;
    updateFolderDisplay("tab", project.folder);
    $("kindBox").innerHTML = availableKindOptions(tabKind); $("tplBox").innerHTML = availableProcessOptions(tabProcess, tabKind);
    openModal("modal", opener);
  }
  function openProjectDialog(opener) {
    projectProcess = "main"; projectKind = "dev";
    const defaultFolder = serverState?.settings?.folders?.defaultProjectFolder ?? "";
    $("pName").value = ""; $("pOnly").checked = true; updateFolderDisplay("project", defaultFolder);
    $("pFolderHelp").textContent = defaultFolder ? `Starts in your default folder, ${defaultFolder}. Browse to pick another.` : "No default folder is set. Browse to pick one, or set it in Settings, Folders.";
    $("pKind").innerHTML = kindSegments(projectKind); $("pTpl").innerHTML = availableProcessOptions(projectProcess, projectKind);
    $("npStat").classList.remove("bad");
    updateProjectSubmit();
    openModal("projModal", opener);
  }
  let selectedTabFolder = "";
  let selectedProjectFolder = "";
  function updateFolderDisplay(which, folder) {
    const path = String(folder ?? "");
    if (which === "tab") { selectedTabFolder = path; $("tDir").textContent = path || "No folder chosen"; $("tDir").title = path || "No folder chosen"; $("tFolderWarn").hidden = Boolean(path); $("createTab").disabled = !path || Boolean(pendingCreate); }
    else { selectedProjectFolder = path; $("pDir").textContent = path || "No folder chosen"; $("pDir").title = path || "No folder chosen"; $("pFolderWarn").hidden = Boolean(path); updateProjectSubmit(); }
  }
  function updateProjectSubmit() {
    const ready = Boolean(selectedProjectFolder && $("pName").value.trim());
    $("createProj").disabled = !ready || Boolean(pendingCreate);
    if (!pendingCreate && !$("npStat").classList.contains("bad")) $("npStat").textContent = ready ? "" : !selectedProjectFolder ? "Choose a folder to create it." : "Give it a name to create it.";
  }
  function updateCreateButtons() {
    $("createTab").disabled = !selectedTabFolder || Boolean(pendingCreate); $("createTab").textContent = pendingCreate?.kind === "tab" ? "Creating…" : "Create tab";
    $("createProj").textContent = pendingCreate?.kind === "project" ? "Creating…" : "Create project"; updateProjectSubmit();
  }
  async function pickFolder(callback) {
    if (!window.cc || typeof window.cc.pickFolder !== "function") { showToast("Open the Command Center app to choose a folder"); return; }
    try { const folder = await window.cc.pickFolder(); if (folder) callback(folder); }
    catch (error) { showToast(error?.message ?? "Could not choose a folder"); }
  }
  function crewFaces(kind, process) { const faces = process === "main" ? CREW_FACES.main[kind] : CREW_FACES[process]; return faces ?? []; }
  function processMenu(tab, anchor) {
    setupKind = tab.kind;
    const pop = $("setupPop");
    const busy = activeTabBusy(tab);
    const draw = () => {
      pop.innerHTML = `<div class="grp">Kind for ${esc(tab.name)}</div><div class="kseg process-kinds" id="setupKinds" role="radiogroup" aria-label="Kind">${KINDS.map((kind) => `<button type="button" role="radio" data-kind="${kind.id}" aria-checked="${String(kind.id === setupKind)}">${esc(kind.name)}</button>`).join("")}</div><div class="grp">Crew</div><div class="process-options">${PROCESSES.map((process) => {
        const inUse = process.id === tab.process && setupKind === tab.kind, faces = crewFaces(setupKind, process.id);
        return `<button type="button" class="opt su" data-set-process="${process.id}" aria-pressed="${String(inUse)}"><span class="nm"><span>${esc(process.name)}</span><small>${esc(processDescription(setupKind, process.id))} · ${faces.length} seat${faces.length === 1 ? "" : "s"}${inUse ? " · in use" : ""}</small></span><span class="faces">${faces.map((face) => `<img src="/avatars/${face}.svg" alt="">`).join("")}</span>${ICONS.tick}</button>`;
      }).join("")}</div><div class="hint">${busy ? "Kind and crew can change only while nothing runs in this tab: the server refuses a busy tab, and the change comes back. Stop its work first." : "Seats and steps come with the crew. You can still change each seat's model, effort, name and picture; those choices carry over where the seat still exists."}</div>`;
      fixRadios(pop);
      pop.querySelectorAll("[data-set-process]").forEach((button) => button.addEventListener("click", () => {
        const process = button.dataset.setProcess;
        // one waiting crew/kind change per tab: a new pick replaces the unsent one; picking the server's own value cancels it
        for (const item of [...pendingActions.values()]) if (!item.sent && item.message.type === "setProcess" && item.message.tabId === tab.id) finishPending(item.id);
        if (process === tab.process && setupKind === tab.kind) { setLayer(pop, false); renderAll(); return; }
        setLayer(pop, false);
        const message = { type: "setProcess", tabId: tab.id, process, kind: setupKind };
        holdAction(message, `${tab.name} will use ${processLabel(process)}${setupKind !== tab.kind ? ` · ${kindLabel(setupKind)}` : ""}`, { type: "setProcess", tabId: tab.id, message });
      }));
    };
    draw();
    openPopover(pop, anchor, anchor === $("setupsBtn") && !railWide);
    setupMenu = { draw };
    if (!pop.dataset.kindBound) {
      pop.dataset.kindBound = "1"; // bound once: the popover is shared, so the open tab's draw is looked up on every event
      pop.addEventListener("click", (event) => {
        const button = event.target.closest("[data-kind]"); if (pop.hidden || !button || !$("setupKinds")?.contains(button)) return;
        setupKind = button.dataset.kind; setupMenu.draw(); pop.querySelector(`[data-kind="${CSS.escape(setupKind)}"]`)?.focus({ preventScroll: true }); placePopover(pop);
      });
      pop.addEventListener("keydown", (event) => {
        const button = event.target.closest?.("[data-kind]"); if (pop.hidden || !button || !["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const ids = KINDS.map((kind) => kind.id), index = ids.indexOf(button.dataset.kind);
        setupKind = event.key === "Home" ? ids[0] : event.key === "End" ? ids.at(-1) : ids[(index + (event.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length];
        setupMenu.draw(); pop.querySelector(`[data-kind="${CSS.escape(setupKind)}"]`)?.focus({ preventScroll: true });
      });
    }
    markCrewSwitcher();
  }
  function createTab() {
    const project = currentProject(); if (!project || !selectedTabFolder || pendingCreate) return;
    const name = $("tName").value.trim() || kindLabel(tabKind);
    if (!send({ type: "addTab", projectId: project.id, name, kind: tabKind, process: tabProcess, folder: selectedTabFolder, projectOnly: $("tOnly").checked })) return;
    pendingCreate = { kind: "tab", projectId: project.id, knownTabIds: new Set(project.tabs.map((tab) => tab.id)) };
    $("tStat").textContent = "Creating…"; $("tStat").classList.remove("bad");
    updateCreateButtons();
  }
  function createProject() {
    const name = $("pName").value.trim(); if (!name || !selectedProjectFolder || pendingCreate) return;
    const id = `project-${slug(name)}-${Date.now().toString(36)}`;
    if (!send({ type: "addProject", id, name, folder: selectedProjectFolder, tabFolder: selectedProjectFolder, kind: projectKind, process: projectProcess, projectOnly: $("pOnly").checked })) return;
    pendingCreate = { kind: "project", id };
    $("npStat").textContent = "Creating…"; $("npStat").classList.remove("bad");
    updateCreateButtons();
  }
  function slug(value) { return String(value).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project"; }

  // ---------- seat card and pickers ----------
  function seatUsageText(tab, seat) {
    if (seat.isLeader) return formatUsage(tab.leaderUsage) ?? "Not reported";
    const runs = liveRuns(tab, seat).filter((run) => run.usage);
    const total = runs.reduce((sum, run) => sum + (usageTokens(run.usage) ?? 0), 0);
    return runs.length ? `${fmtK(total)} tokens in live runs` : "Not reported";
  }
  function renderSeatCard(tab, seat) {
    const pop = $("seatPop");
    const focusKey = document.activeElement?.closest?.("#seatPop") ? focusKeyOf(document.activeElement) : null;
    const runs = liveRuns(tab, seat), line = seatLine(tab, seat), blocked = !seat.isLeader && seatBlocked(tab, seat), locked = seatLocked(tab, seat);
    const now = seat.isLeader && seat.status === "idle" && !tab.derived?.leaderTurnActive && line.cls !== "waiting" ? (tab.leaderStatus === "ready" ? "Ready for your next message" : "Ready. The session starts with your first message") : !seat.isLeader && (seat.status === "idle" || !seat.status) && !blocked ? `Ready. Starts when ${leaderName(tab)} hands over a brief, or when you press Run` : line.text;
    const alive = seat.isLeader && (tab.leaderStatus === "ready" || tab.derived?.leaderTurnActive || seat.status === "working" || seat.status === "waiting");
    const advisor = tab.advisor?.model ?? null;
    pop.dataset.tabId = tab.id; pop.dataset.slot = seat.slot;
    pop.setAttribute("aria-label", `Seat ${seat.name}`);
    pop.innerHTML = `<div class="sc"><div class="top">${seatImg(seat)}<div style="min-width:0;flex:1"><b><span title="${esc(seat.name)}">${esc(seat.name)}</span><button type="button" class="pen" data-seat-rename aria-label="Rename ${esc(seat.name)}" title="Rename">${ICONS.pencil}</button></b><small title="${esc(seatRole(tab, seat))}">${esc(seatRole(tab, seat))}${seat.isLeader && seatRole(tab, seat).toLowerCase() !== "leader" ? " · leader" : ""}</small></div><button type="button" class="dots" data-seat-picture aria-haspopup="dialog" aria-label="Change picture for ${esc(seat.name)}" title="Change picture">${ICONS.picture}</button></div><div class="now ${esc(line.cls)}"><i></i><span>${esc(now)}</span></div>${blocked ? `<div class="blk">${ICONS.warn}<span>Launch blocked after a stop. ${esc(seat.name)} cannot start until you allow it.</span><button type="button" class="btn sm" data-seat-unblock>Allow again</button></div>` : ""}${runs.length ? `<div class="rows">${runs.map((run) => { const state = runStopState(tab, run); return `<div class="sr"><span class="d"></span><button type="button" class="srl" data-watch-run="${esc(run.runId)}" title="Watch ${plainMd(run.label)}">${plainMd(run.label)}</button><span class="tm" data-run-time="${esc(run.runId)}">${esc(spanText(run.startedAt))}</span><button type="button" class="x" data-stop-run="${esc(run.runId)}" aria-label="Stop ${plainMd(run.label)}" title="Stop only this run"${state ? " disabled" : ""}>${state ? esc(stopLabel(state)) : ICONS.stop}</button></div>`; }).join("")}</div>` : ""}<div class="rows"><button type="button" class="rowb" data-seat-model${locked ? ` disabled aria-disabled="true" title="${LOCK_TIP}"` : ""}><span>Model</span><span class="v">${logo(seat.cli, 13, 0)}<span><span class="model-label">${esc(formatModel(seat.cli, seat.model, tab))}</span>${modelSupportsEffort(seat.cli, seat.model) ? ` <span class="faint eff">· ${esc(seat.effort)}</span>` : ""}</span></span>${ICONS.rchev}</button>${locked ? `<div class="hint" data-model-locked>Locked while working</div>` : ""}${seat.isLeader ? `${seat.cli === "claude" ? `<button type="button" class="rowb" data-seat-advisor><span>Advisor</span><span class="v" style="color:var(--adv)"><span>✦ ${esc(advisor ? formatModel("claude", advisor) : "Off")}</span></span>${ICONS.rchev}</button>` : ""}<div class="rowb"><span>Context</span><span class="v" data-context-meter title="${esc(contextLine(tab))}"><span>${esc(cap(contextLine(tab)))}</span></span><span></span></div>` : `<div class="rowb"><span>Access</span><span class="v" title="${esc(accessText(tab, seat))}"><span>${esc(accessText(tab, seat))}</span></span><span></span></div>`}<div class="rowb"><span>Usage</span><span class="v" title="${esc(seatUsageText(tab, seat))}"><span>${esc(seatUsageText(tab, seat))}</span></span><span></span></div></div>${seat.isLeader ? `<div class="acts"><button type="button" class="btn" data-seat-chat>Chat</button><button type="button" class="btn" data-seat-history>Past sessions</button></div>` : `<div class="acts"><button type="button" class="btn" data-seat-watch>Watch</button></div>`}<div class="acts">${seat.isLeader ? (alive ? `<button type="button" class="btn danger" data-stop-seat title="Stops ${esc(seat.name)}'s session and denies anything it is waiting on. Your next message starts a fresh one.">Stop ${esc(seat.name)}</button>` : "") : `<button type="button" class="btn primary" data-run-seat>${runs.length ? "Run another" : "Run"}</button><button type="button" class="btn danger" data-stop-seat title="${runs.length ? `Stops every run of ${esc(seat.name)} and blocks new launches` : `Blocks ${esc(seat.name)} from launching until you allow it again`}">${runs.length ? "Stop seat" : "Block launches"}</button>`}</div></div>`;
    const anchor = () => pop._anchor;
    pop.querySelector("[data-seat-rename]").addEventListener("click", () => renameDialog(`Rename ${seat.name}`, seat.name, (name) => send({ type: "updateSeat", tabId: tab.id, slot: seat.slot, name }), anchor()));
    pop.querySelector("[data-seat-picture]").addEventListener("click", () => openSeatAvatar(tab, seat, anchor()));
    pop.querySelector("[data-seat-unblock]")?.addEventListener("click", () => unblockWithConfirm(tab, seat, anchor()));
    pop.querySelectorAll("[data-watch-run]").forEach((button) => button.addEventListener("click", () => { selectedSeatByTab.set(tab.id, seat.slot); selectedRunBySeat.set(seat.slot, button.dataset.watchRun); selectedView = "live"; closePopovers(); renderStage(); renderCrew(); }));
    pop.querySelectorAll("[data-stop-run]").forEach((button) => button.addEventListener("click", () => killRun(button.dataset.stopRun)));
    pop.querySelector("[data-seat-model]").addEventListener("click", () => openModelPicker(tab, seat, anchor(), true));
    pop.querySelector("[data-seat-advisor]")?.addEventListener("click", () => openAdvisor(tab, seat, anchor(), true));
    pop.querySelector("[data-seat-chat]")?.addEventListener("click", () => { selectedSeatByTab.set(tab.id, seat.slot); selectedView = "live"; closePopovers(); renderStage(); renderCrew(); $("ci").focus(); });
    pop.querySelector("[data-seat-watch]")?.addEventListener("click", () => { selectedSeatByTab.set(tab.id, seat.slot); selectedView = "live"; historyRunRequested.delete(seatKeyOf(tab, seat)); closePopovers(); renderStage(); renderCrew(); });
    pop.querySelector("[data-seat-history]")?.addEventListener("click", () => { closePopovers(); showLeaderHistory(tab); });
    pop.querySelector("[data-run-seat]")?.addEventListener("click", () => openRunDialog(tab, seat, anchor()));
    pop.querySelector("[data-stop-seat]")?.addEventListener("click", () => stopSeat(tab, seat));
    // A control that just locked cannot hold focus: keep it on the first enabled one so it does not fall to the page.
    const focusTarget = focusKey ? pop.querySelector(focusKey) : null;
    if (focusTarget) (focusTarget.disabled ? pop.querySelector("button:not(:disabled)") : focusTarget)?.focus({ preventScroll: true });
  }
  function openSeatCard(tab, seat, anchor) {
    renderSeatCard(tab, seat);
    openPopover($("seatPop"), anchor, Boolean(anchor?.closest?.("#crew")));
    renderCrew();
  }
  function reopenSeatCard(tab, seat, anchor) {
    const live = findTab(tab.id), current = seatFor(live, seat.slot);
    if (live && current) openSeatCard(live, current, anchor);
  }
  // The seat's own CLI first, then every other installed one. updateSeat takes only these three.
  function pickerClis(seat) {
    const tools = serverState?.settings?.tools ?? {};
    const acp = seat.isLeader ? (serverState?.acpClis ?? []).map((item) => item.kind) : [];
    return [...["claude", "codex", "opencode"].filter((cli) => cli === seat.cli || tools[cli]?.installed === true), ...acp].sort((a, b) => Number(b === seat.cli) - Number(a === seat.cli));
  }
  function modelRows(seat, query, tab = null) {
    const q = query.trim().toLowerCase(), typed = query.trim();
    let total = 0;
    const html = pickerClis(seat).map((cli) => {
      const values = modelOptions(cli); if (cli === seat.cli && seat.model && !values.includes(seat.model)) values.unshift(seat.model);
      total += values.length;
      const listed = values.filter((model) => !q || model.toLowerCase().includes(q) || formatModel(cli, model, cli === seat.cli ? tab : null).toLowerCase().includes(q));
      const custom = typed && CUSTOM_MODEL[cli]?.test(typed) && !values.includes(typed);
      if (!listed.length && !custom) return "";
      return `<div class="grp" data-grp="${esc(cli)}">${logo(cli, 12, 0)} ${esc(cliLabel(cli))}${cli === seat.cli ? " · this seat" : ""}</div>${listed.map((model) => `<button type="button" class="opt" data-model="${esc(model)}" data-cli="${esc(cli)}" aria-pressed="${String(cli === seat.cli && model === seat.model)}">${logo(cli, 12, 3)}<span class="nm"><span>${esc(isAcpCli(cli) ? "CLI default" : formatModel(cli, model))}</span><small>${esc(isAcpCli(cli) ? `CLI default · ${acpShownModel(cli, cli === seat.cli ? tab : null) ?? "model shown after first use"}` : model)}${isAcpCli(cli) || modelSupportsEffort(cli, model) ? "" : " · no effort setting"}</small></span>${ICONS.tick}</button>`).join("")}${custom ? `<button type="button" class="opt" data-model="${esc(typed)}" data-cli="${esc(cli)}"><span class="nm"><span>Use ${esc(typed)}</span><small>Not in the list. The server checks it when you save.</small></span></button>` : ""}`;
    }).join("");
    return html || `<div class="nores">${total ? "No match. Type a full id like gpt-6-sol or provider/model to use it." : "No models are available from the server."}</div>`;
  }
  function pickerHints(seat, locked) {
    const hints = [];
    if (seat.isLeader) {
      hints.push("Switching to another CLI starts a fresh session. The chat stays.");
      if (seat.cli === "codex") hints.push("Codex skips asking for commands it considers safe.");
      if (seat.cli === "opencode") hints.push("Plan blocks edits, but a shell command can still write.");
      if (isAcpCli(seat.cli)) hints.push(`${cliLabel(seat.cli)} runs with Full access only: it may edit files and run commands without asking.`);
      hints.push(seat.cli === "claude" ? "A model change applies right away, or after the current answer if one is running." : "A model change applies from the next turn.");
    } else if (!locked) hints.push("Applies to the next run.");
    return hints.map((text) => `<div class="hint">${esc(text)}</div>`).join("");
  }
  // Drawn again on every state broadcast while open, so the tick and the effort row follow the server and never a local guess.
  function drawModelPicker(tab, seat, anchor, fromCard, refresh = false) {
    const pop = $("pop"), locked = seatLocked(tab, seat);
    const keep = refresh ? { query: $("mq")?.value ?? "", scroll: $("mrows")?.scrollTop ?? 0, key: pop.contains(document.activeElement) ? focusKeyOf(document.activeElement) : null, caret: document.activeElement?.id === "mq" ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null } : null;
    pop.setAttribute("aria-label", `Choose model and effort for ${seat.name}`);
    const efforts = effortOptions(seat.cli), hasEffort = modelSupportsEffort(seat.cli, seat.model) && efforts.length > 0;
    pop.innerHTML = `${fromCard ? `<button type="button" class="back" data-pop-back style="margin:4px">${ICONS.back}<span>${esc(seat.name)}</span></button>` : ""}<div class="msearch"><input class="inp" id="mq" type="search" aria-label="Search models" placeholder="Search models" autocomplete="off"></div><div class="mscroll" id="mrows">${modelRows(seat, keep?.query ?? "", tab)}</div>${hasEffort ? `<div class="grp">Effort</div><div class="effort" role="radiogroup" aria-label="Effort">${efforts.map((effort) => `<button type="button" role="radio" aria-checked="${String(seat.effort === effort)}" data-effort="${esc(effort)}">${esc(effort)}</button>`).join("")}</div>` : `<div class="hint">${esc(formatModel(seat.cli, seat.model, tab))} has no effort setting.</div>`}${pickerHints(seat, locked)}`;
    const lockPicker = () => { if (!locked) return; pop.querySelectorAll("[data-model],[data-effort]").forEach((button) => { button.disabled = true; button.setAttribute("aria-disabled", "true"); }); };
    if (locked) pop.insertAdjacentHTML("afterbegin", `<div class="hint" data-picker-locked>Locked while working. ${LOCK_TIP}</div>`);
    lockPicker();
    fixRadios(pop);
    const bindModels = () => pop.querySelectorAll("[data-model]").forEach((button) => button.addEventListener("click", () => {
      const message = { type: "updateSeat", tabId: tab.id, slot: seat.slot, model: button.dataset.model };
      if (button.dataset.cli !== seat.cli) message.cli = button.dataset.cli;
      if (message.cli && isAcpCli(message.cli)) {
        // An ACP CLI can be picked only knowing it runs with Full access.
        const label = cliLabel(message.cli);
        confirmAction({ title: `Use ${label} as ${seat.name}'s CLI?`, body: `${label} may edit files and run commands without asking. Command Center cannot make it ask yet, so Ask, Accept and Plan are not available with it. You can switch back to another CLI at any time.`, ok: "Use with Full access", danger: true }, () => send({ ...message, confirm: true }), button);
        return;
      }
      send(message);
    }));
    bindModels();
    $("mq").addEventListener("input", () => { $("mrows").innerHTML = modelRows(seat, $("mq").value, tab); bindModels(); lockPicker(); });
    pop.querySelectorAll("[data-effort]").forEach((button) => button.addEventListener("click", () => { send({ type: "updateSeat", tabId: tab.id, slot: seat.slot, effort: button.dataset.effort }); setLayer(pop, false); }));
    pop.querySelector("[data-pop-back]")?.addEventListener("click", () => { setLayer(pop, false, null, false, false); reopenSeatCard(tab, seat, anchor); });
    if (!keep) return;
    $("mq").value = keep.query; $("mrows").scrollTop = keep.scroll;
    let target = keep.key ? pop.querySelector(keep.key) : null;
    if (target?.disabled) target = $("mq");
    if (target) { target.focus({ preventScroll: true }); if (keep.caret && target.setSelectionRange) try { target.setSelectionRange(keep.caret[0], keep.caret[1]); } catch { /* not a text field */ } }
    placePopover(pop);
  }
  function openModelPicker(tab, seat, anchor, fromCard = false) {
    pickerSeat = { tabId: tab.id, slot: seat.slot, fromCard };
    drawModelPicker(tab, seat, anchor, fromCard);
    openPopover($("pop"), anchor, Boolean(anchor?.closest?.("#crew")));
    $("mq").focus({ preventScroll: true });
    $("mrows").querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest" });
  }
  function openAdvisor(tab, seat, anchor, fromCard = false) {
    const pop = $("pop"); const models = serverState?.claudeModels ?? modelOptions("claude");
    const choices = models.map((item) => typeof item === "string" ? { value: item, label: formatModel("claude", item) } : { value: item.value, label: item.displayName ?? item.value }).filter((item) => item.value);
    const current = tab.advisor?.model ?? "";
    pop.setAttribute("aria-label", `Choose advisor for ${seat.name}`);
    pop.innerHTML = `${fromCard ? `<button type="button" class="back" data-pop-back style="margin:4px">${ICONS.back}<span>${esc(seat.name)}</span></button>` : ""}<div class="grp">Advisor for ${esc(seat.name)}</div><button type="button" class="opt" data-advisor="" aria-pressed="${String(!current)}"><span class="nm"><span>Off</span><small>No advisor calls</small></span>${ICONS.tick}</button>${choices.map((item) => `<button type="button" class="opt" data-advisor="${esc(item.value)}" aria-pressed="${String(item.value === current)}">${logo("claude", 12, 3)}<span class="nm"><span>${esc(item.label)}</span><small>${esc(item.value)}</small></span>${ICONS.tick}</button>`).join("")}<div class="hint">Claude only, no effort setting. Asked before a plan, when an error repeats, and before calling work done.</div>`;
    openPopover(pop, anchor, Boolean(anchor?.closest?.("#crew")));
    pop.querySelectorAll("[data-advisor]").forEach((button) => button.addEventListener("click", () => {
      send({ type: "setAdvisor", tabId: tab.id, advisor: button.dataset.advisor ? { model: button.dataset.advisor } : null }); setLayer(pop, false);
    }));
    pop.querySelector("[data-pop-back]")?.addEventListener("click", () => { setLayer(pop, false, null, false, false); reopenSeatCard(tab, seat, anchor); });
  }

  // ---------- pictures ----------
  function openSeatAvatar(tab, seat, anchor) { avatarTarget = { tabId: tab.id, slot: seat.slot }; drawAvatars(false, anchor); }
  function openMeAvatar(anchor) { avatarTarget = null; drawAvatars(true, anchor); }
  function drawAvatars(isMe, opener) {
    avatarUploadRequestId = null;
    const seat = isMe ? null : seatFor(findTab(avatarTarget.tabId), avatarTarget.slot);
    $("avTitle").textContent = isMe ? "Your picture" : `Picture for ${seat?.name ?? "this seat"}`;
    $("avatarStatus").textContent = isMe ? "Any PNG, JPEG or WebP picture. It stays on this PC." : "PNG, JPEG or WebP, up to 12 MiB.";
    $("avatarStatus").dataset.status = "";
    const choices = isMe ? AVATAR_PRESETS.map((file) => ({ key: file, src: `/avatars/${file}.svg`, selected: me.av === `${file}.svg` }))
      : AVATAR_PRESETS.map((file) => {
        const tab = findTab(avatarTarget.tabId);
        const seat = seatFor(tab, avatarTarget.slot);
        return { key: file, src: `/avatars/${file}.svg`, selected: !UPLOADED_PIC.test(String(seat?.pic ?? "")) && avatarKeyFor(seat) === file };
      });
    $("avgrid").innerHTML = `${choices.map((choice) => `<button type="button" role="radio" aria-checked="${String(choice.selected)}" data-avatar="${esc(choice.key)}" aria-label="${esc(cap(choice.key))}" title="${esc(cap(choice.key))}"><img src="${esc(choice.src)}" alt=""></button>`).join("")}<button type="button" class="up" id="avUpload" aria-label="Upload a picture">Upload</button>`;
    $("avgrid").querySelectorAll("[data-avatar]").forEach((button) => button.addEventListener("click", () => {
      if (isMe) { me = { av: `${button.dataset.avatar}.svg` }; saveMe(); $("meImg").dataset.fellBack = ""; $("meImg").src = mePic(); renderStage(); }
      else {
        const pic = `avatars/${button.dataset.avatar}.svg`;
        if (!send({ type: "updateSeat", tabId: avatarTarget.tabId, slot: avatarTarget.slot, pic })) return;
        avatarPending = { tabId: avatarTarget.tabId, slot: avatarTarget.slot, pic };
        $("avatarStatus").textContent = "Saving…"; $("avatarStatus").dataset.status = "running";
      }
      $("avgrid").querySelectorAll("[data-avatar]").forEach((item) => item.setAttribute("aria-checked", String(item === button)));
      fixRadios($("avModal"));
    }));
    $("avUpload").addEventListener("click", () => $("avUp").click());
    openModal("avModal", opener);
    fixRadios($("avModal"));
  }
  // A picture must decode before it replaces the old one: broken bytes keep the old picture, and the picker says why.
  function decodes(src) { return new Promise((resolve) => { const probe = new Image(); probe.onload = () => resolve(probe.naturalWidth > 0); probe.onerror = () => resolve(false); probe.src = src; }); }
  async function uploadMe(file) {
    if (!file || !file.type.startsWith("image/")) { showToast("Choose an image file"); return; }
    if (avatarTarget) {
      if (!/^image\/(?:png|jpeg|webp)$/.test(file.type)) { showToast("Seat pictures must be PNG, JPEG or WebP"); return; }
      if (file.size > 12 * 1024 * 1024) { showToast("Pictures must be 12 MiB or smaller"); return; }
      const target = { ...avatarTarget };
      const requestId = newRequestId(); avatarUploadRequestId = requestId;
      $("avatarStatus").textContent = "Uploading"; $("avatarStatus").dataset.status = "running"; $("avUpload").disabled = true;
      try {
        const bytes = await file.arrayBuffer();
        if (avatarUploadRequestId !== requestId) return;
        const response = await keyedFetch("/api/avatar", { method: "POST", headers: { "Content-Type": file.type, "X-Request-Id": requestId }, body: bytes });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Picture upload failed (${response.status})`);
        if (avatarUploadRequestId !== requestId || !findTab(target.tabId) || !seatFor(findTab(target.tabId), target.slot)) return;
        if (!send({ type: "updateSeat", tabId: target.tabId, slot: target.slot, pic: result.path })) throw new Error("Seat picture could not be applied");
        $("avatarStatus").textContent = "Done"; $("avatarStatus").dataset.status = "done";
        // He chose the picture, so it is applied either way; only close the dialog if it is still the open layer.
        closeLayerOf($("avModal"));
      } catch (error) {
        avatarUploadRequestId = null;
        $("avatarStatus").textContent = error?.message ?? "Picture upload failed"; $("avatarStatus").dataset.status = "failed";
        if ($("avUpload")) $("avUpload").disabled = false;
      }
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      if (typeof reader.result !== "string") return;
      if (!(await decodes(reader.result))) { $("avatarStatus").textContent = "That file did not decode as a picture, so the old one stays"; $("avatarStatus").dataset.status = "failed"; return; }
      if (reader.result.length > AVATAR_MAX_CHARS) { $("avatarStatus").textContent = "That picture is too large to keep (limit " + AVATAR_MAX_CHARS / 1024 + " KB), so the old one stays"; $("avatarStatus").dataset.status = "failed"; return; }
      me = { av: reader.result }; saveMe(); $("meImg").dataset.fellBack = ""; $("meImg").src = mePic(); renderStage(); closeLayerOf($("avModal"));
    };
    reader.onerror = () => showToast("Could not load that picture");
    reader.readAsDataURL(file);
  }
  function renderAvatarStatus() {
    if (!avatarUploadRequestId || $("avModal").hidden) return;
    const status = serverState?.settings?.uploads?.[avatarUploadRequestId];
    if (!status || status.requestId !== avatarUploadRequestId) return;
    $("avatarStatus").textContent = status.message ?? status.status;
    $("avatarStatus").dataset.status = status.status;
    if ($("avUpload")) $("avUpload").disabled = status.status === "running";
  }

  // ---------- running a seat ----------
  function runDialogStatus(text, unknown) {
    const status = $("runStat"); if (!status) return;
    status.textContent = text; status.classList.toggle("bad", true);
    $("runStart").textContent = unknown ? "Outcome unknown" : "Start run";
    $("runStart").disabled = unknown || runUnknown || !$("runPrompt").value.trim();
    if (unknown) { pendingRun = null; runUnknown = true; }
  }
  function openRunDialog(tab, seat, opener) {
    runTarget = { tabId: tab.id, slot: seat.slot, name: seat.name }; runUnknown = false;
    const running = liveRuns(tab, seat).length, blocked = seatBlocked(tab, seat);
    $("runModal").setAttribute("aria-label", `Run ${seat.name}`);
    $("runTitle").textContent = `Run ${seat.name}`; $("runPrompt").value = ""; $("runStart").disabled = true; $("runStart").textContent = "Start run";
    $("runSub").innerHTML = `${esc(seatRole(tab, seat))} · ${logo(seat.cli, 12, 0)} ${esc(modelLine(seat.cli, seat.model, seat.effort))}${running ? ` · ${running} already running, this one runs alongside` : ""}`;
    $("runBlk").innerHTML = blocked ? `<div class="blk">${ICONS.warn}<span>Launch blocked after a stop. Allow ${esc(seat.name)} again to start it.</span><button type="button" class="btn sm" data-run-unblock>Allow again</button></div>` : "";
    $("runBlk").querySelector("[data-run-unblock]")?.addEventListener("click", (event) => unblockWithConfirm(tab, seat, event.currentTarget));
    $("runFolder").textContent = tab.folder; $("runFolder").title = tab.folder;
    $("runAccess").textContent = `${accessText(tab, seat)}.`;
    $("runStat").textContent = ""; $("runStat").classList.remove("bad");
    openModal("runModal", opener);
  }
  function folderBusyAgo(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0)), m = Math.round(s / 60);
    return s < 60 ? `${s} second${s === 1 ? "" : "s"} ago` : `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  function folderBusyLine(item) {
    const writer = item?.writer;
    if (writer) return `${writer.seatName} (${writer.roleLabel}) in your ${writer.tabName} tab is writing code in this folder right now.`;
    const tool = typeof item?.tool === "string" ? item.tool : "";
    return tool ? `${"AEIOU".includes(tool[0]) ? "An" : "A"} ${tool} session outside Command Center was active here ${folderBusyAgo(item.agoSeconds)}.` : `Something outside Command Center changed files here ${folderBusyAgo(item?.agoSeconds)}.`;
  }
  function startRun(confirmBusy) {
    const prompt = $("runPrompt").value.trim(); if (!runTarget || !prompt || pendingRun || runUnknown) return;
    const target = runTarget;
    $("runStart").disabled = true; $("runStart").textContent = "Starting…";
    $("runStat").textContent = `Asking the server to launch ${target.name}…`; $("runStat").classList.remove("bad");
    // Waiting before sending: the server's answer can arrive inside send itself.
    pendingRun = { tabId: target.tabId, slot: target.slot };
    if (!send({ type: "run", tabId: target.tabId, slot: target.slot, prompt, ...(confirmBusy === true ? { confirmBusy: true } : {}) })) {
      pendingRun = null;
      $("runStart").disabled = false; $("runStart").textContent = "Start run";
      $("runStat").textContent = "Nothing was started."; $("runStat").classList.add("bad");
    }
  }

  // ---------- screenshots ----------
  function openScreenshotViewer(tabId, path = null, opener = null) {
    const tab = findTab(tabId); if (!tab) return;
    const paths = screenshotPaths(tab);
    if (!paths.length) return;
    viewerState = { tabId, index: path ? Math.max(0, paths.indexOf(path)) : -1, actual: false };
    if (path && !paths.includes(path)) viewerState.index = -1;
    $("viewerTitle").textContent = `Screenshots · ${tabLabel(tabId)}`;
    drawViewer();
    openModal("viewer", opener ?? document.querySelector(`[data-open-screenshots="${CSS.escape(tabId)}"]`));
  }
  function drawViewer() {
    const tab = findTab(viewerState?.tabId); if (!tab) return;
    const paths = screenshotPaths(tab), index = viewerState.index, path = paths[index];
    const bad = '<span class="bad">This picture could not be shown: the file did not decode as an image.</span>';
    const box = $("viewerFiles");
    if (path) {
      const name = String(path).split(/[\\/]/).at(-1) || "Screenshot";
      box.className = "bigshot";
      box.innerHTML = `<div class="bar2"><button type="button" class="btn sm" data-shot-grid>${ICONS.back}All screenshots</button><b title="${esc(name)}">${esc(name)}</b><span>${index + 1} of ${paths.length}</span><span class="spacer"></span><button type="button" class="btn sm" data-shot-fit aria-pressed="${String(viewerState.actual)}">${viewerState.actual ? "Fit to window" : "Actual size"}</button><button type="button" class="btn sm" data-shot-step="-1"${index > 0 ? "" : " disabled"}>Prev</button><button type="button" class="btn sm" data-shot-step="1"${index < paths.length - 1 ? "" : " disabled"}>Next</button></div><figure class="frame viewer-file${viewerState.actual ? " actual" : ""}"><img src="${esc(transcriptImageUrl(path))}" alt="${esc(name)}">${bad}</figure>`;
    } else {
      box.className = "";
      box.innerHTML = `<div class="viewer-files">${paths.map((item, position) => { const name = String(item).split(/[\\/]/).at(-1) || "Screenshot"; return `<figure class="viewer-file"><button type="button" data-shot-open="${position}" aria-label="Open ${esc(name)} at full size"><img src="${esc(transcriptImageUrl(item))}" alt="">${bad}</button><span title="${esc(name)}">${esc(name)}</span></figure>`; }).join("")}</div><p class="faint" style="font-size:12.5px;margin:0">Click a screenshot to check it at full size.</p>`;
    }
    box.querySelectorAll("img").forEach((image) => {
      const broken = () => image.closest("figure")?.classList.add("broken");
      image.addEventListener("error", broken, { once: true });
      image.addEventListener("load", () => { if (!image.naturalWidth) broken(); }, { once: true });
    });
    box.querySelectorAll("[data-shot-open]").forEach((button) => button.addEventListener("click", () => { viewerState.index = Number(button.dataset.shotOpen); viewerState.actual = false; drawViewer(); box.querySelector("[data-shot-grid]")?.focus(); }));
    box.querySelector("[data-shot-grid]")?.addEventListener("click", () => { const from = viewerState.index; viewerState.index = -1; drawViewer(); box.querySelector(`[data-shot-open="${from}"]`)?.focus(); });
    box.querySelector("[data-shot-fit]")?.addEventListener("click", () => { viewerState.actual = !viewerState.actual; drawViewer(); box.querySelector("[data-shot-fit]")?.focus(); });
    box.querySelectorAll("[data-shot-step]").forEach((button) => button.addEventListener("click", () => { viewerState.index = Math.max(0, Math.min(paths.length - 1, viewerState.index + Number(button.dataset.shotStep))); drawViewer(); (box.querySelector(`[data-shot-step="${button.dataset.shotStep}"]:not([disabled])`) ?? box.querySelector("[data-shot-grid]"))?.focus(); }));
  }

  // ---------- settings ----------
  function openSettings(anchor, section = currentTab() ? "crew" : "tools") {
    settingsSection = section;
    settingsFocusKey = null;
    renderSettings(true);
    openModal("setModal", anchor ?? $("setBtn"));
    requestAnimationFrame(() => { const body = $("setBody"), target = body.querySelector(`#s-${CSS.escape(section)}`); if (target) body.scrollTop = target.offsetTop - 20; markSettingsNav(); });
  }
  function settingSwitch(key, label, description, value, disabled = false, extra = "") {
    return `<div class="crow" style="grid-template-columns:minmax(0,1fr) auto"><div class="d"><b>${esc(label)}</b><small class="wrap">${esc(description)}</small>${extra}</div><button type="button" class="switch" role="switch" aria-checked="${String(value)}" aria-label="${esc(label)}" data-setting="${esc(key)}" data-focus-key="setting-${esc(key)}"${disabled ? " disabled" : ""}></button></div>`;
  }
  function settingValue(key) {
    return pref(key, key === "notificationsEnabled");
  }
  function settingsActionRunning(key) {
    const requestId = settingsActionId(key);
    if (!requestId) return false;
    const state = actionStateFor(requestId);
    return !state || state.status === "running";
  }
  function settingsFocusSnapshot(body) {
    const active = document.activeElement?.closest("#setModal") ? document.activeElement : null;
    if (active?.dataset.focusKey) settingsFocusKey = active.dataset.focusKey;
    // Focus that moved somewhere else on purpose (a picker over Settings) is left there; only lost focus comes back.
    const lost = !document.activeElement || document.activeElement === document.body;
    return { key: active?.dataset.focusKey ?? (active || lost ? settingsFocusKey : null), value: active && "value" in active ? active.value : null, scrollTop: body.scrollTop };
  }
  // Text the user typed or browsed into a Settings field survives a re-render (every state broadcast) until it is saved or the modal closes. A field never edited always shows the server value.
  function settingsDraftSnapshot(body) {
    for (const [action, keys] of Object.entries(savedBy)) {
      const requestId = settingsActionId(action);
      if (requestId && actionStateFor(requestId)?.status === "done" && settingsSubmits.get(action)?.requestId === requestId) {
        const submitted = settingsSubmits.get(action).fields;
        keys.forEach((key) => { if (body.querySelector(`[data-focus-key="${key}"]`)?.value === submitted.get(key)) settingsEdits.delete(key); });
        settingsSubmits.delete(action); }
    }
    const drafts = new Map();
    for (const input of body.querySelectorAll("input[data-focus-key]")) {
      const key = input.dataset.focusKey;
      if (settingsEdits.has(key)) drafts.set(key, input.value);
    }
    return drafts;
  }
  function restoreSettingsDrafts(body, drafts) {
    for (const [key, value] of drafts) { const input = [...body.querySelectorAll("input[data-focus-key]")].find((item) => item.dataset.focusKey === key); if (input) input.value = value; }
  }
  function restoreSettingsFocus(body, snapshot) {
    body.scrollTop = snapshot.scrollTop;
    if (snapshot.key) {
      let target = [...$("setModal").querySelectorAll("[data-focus-key]")].find((item) => item.dataset.focusKey === snapshot.key);
      const vaultActionId = settingsActionId("vault-save");
      const vaultActionDone = actionStateFor(vaultActionId)?.status === "done";
      if (snapshot.key === "vault-toggle" && target?.disabled && vaultActionDone) {
        target = $("setModal").querySelector('[data-setting-action="vault-browse"]') ?? $("vaultPath");
      }
      if (target?.disabled && target.matches("[data-settings-model]")) target = $("setModal").querySelector("[data-settings-crew]");
      if (target && !target.disabled && target.type !== "hidden") {
        target.focus({ preventScroll: true });
        if (document.activeElement === target) settingsFocusKey = target.dataset.focusKey;
      }
    }
  }
  function markSettingsNav() {
    $("setNav").querySelectorAll("[data-settings-section]").forEach((button) => button.setAttribute("aria-current", String(button.dataset.settingsSection === settingsSection)));
  }
  let settingsScrollLock = 0;
  const openSettingsForms = new Set();
  function trackSettingsScroll() {
    const body = $("setBody"); const sections = [...body.querySelectorAll(".settings-section")];
    if (!sections.length || Date.now() - settingsScrollLock < 400) return;
    const top = body.getBoundingClientRect().top;
    let current = sections[0];
    // Rounded: the header above Settings can sit on a fractional pixel, and a section scrolled to 60px must still count.
    for (const section of sections) if (Math.round(section.getBoundingClientRect().top - top) <= 60) current = section;
    if (body.scrollTop > 0 && body.scrollTop + body.clientHeight >= body.scrollHeight - 2) current = sections[sections.length - 1];
    settingsSection = current.dataset.section;
    markSettingsNav();
  }
  function settingsToolRow(cli, tool) {
    const key = `install-${cli}`;
    const packageNames = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex", opencode: "opencode-ai", gemini: "@google/gemini-cli" };
    const version = tool?.version ? ` · ${tool.version}` : "";
    const subtitle = tool?.installed === false ? "Not installed." : tool?.installed === true
      ? `${tool.signedIn === true ? "Signed in" : tool.signedIn === false ? "Installed · Not signed in" : cli === "gemini" ? "Installed · Gemini checks its own sign-in" : "Installed · Sign-in status unknown"}${version}`
      : `Install status unknown${version}`;
    const install = tool?.installed === false ? `<button type="button" class="btn primary sm" data-setting-action="install-cli" data-cli="${cli}" data-focus-key="${key}" ${settingsActionRunning(key) ? "disabled" : ""}>Install</button>` : "";
    const loginKey = `login-${cli}`;
    const login = tool?.installed === true && tool.signedIn !== true && cli !== "gemini" ? `<button type="button" class="btn sm" data-setting-action="login-cli" data-cli="${cli}" data-focus-key="${loginKey}" ${settingsActionRunning(loginKey) ? "disabled" : ""}>Sign in</button>` : "";
    const connected = tool?.signedIn === true ? '<span class="tool-connected" data-tool-status="connected"><i></i>Connected</span>' : "";
    const command = tool?.installed === false ? `npm install -g ${packageNames[cli]}` : "";
    const copy = command ? `<div class="cmd"><code title="${esc(command)}">${esc(command)}</code><button type="button" data-copy="${esc(command)}">Copy</button></div>` : "";
    return `<div class="crow tool-row" data-tool-row data-cli="${cli}"><span class="logo">${logo(cli, 18, 0)}</span><div class="d"><b>${esc(CLI_LABEL[cli] ?? cli)}</b><small data-tool-subtitle title="${esc(subtitle)}">${esc(subtitle)}</small>${copy}</div><div class="tool-row-action" data-tool-row-action>${connected}${install}${login}${actionStatusMarkup(key)}${actionStatusMarkup(loginKey)}</div></div>`;
  }
  function skillBlock(cli, inventory = {}) {
    const skillCount = Array.isArray(inventory.skills) ? inventory.skills.length : 0;
    const mcpItems = Array.isArray(inventory.mcpServers) ? inventory.mcpServers : [];
    const pluginItems = Array.isArray(inventory.plugins) ? inventory.plugins : [];
    const instructionItems = Array.isArray(inventory.instructionFiles) ? inventory.instructionFiles : [];
    const fileLabel = (path) => String(path ?? "").replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || String(path ?? "");
    const instructions = instructionItems.map((item) => `<div class="sitem instruction-row"><span title="${esc(item.path)}">${esc(fileLabel(item.path))} <small>(${esc(item.scope)})</small></span></div>`).join("") || '<span class="sempty">None found</span>';
    const counts = cli === "gemini" ? "Instruction files only. Gemini's MCP is not managed here" : `${skillCount} skills · ${mcpItems.length} MCP servers${cli === "claude" ? ` · ${pluginItems.length} plugins` : ""}`;
    const header = `<div class="skill-head"><span class="logo">${logo(cli, 18, 0)}</span><div class="d"><b>${esc(CLI_LABEL[cli] ?? cli)}</b><small>${esc(counts)}</small></div></div>`;
    const instructionsBlock = `<div class="sblock"><div class="sh"><span>Instruction files</span></div>${instructions}</div>`;
    if (cli === "gemini") return `<section class="card skill-card" data-skill-cli="${cli}">${header}${instructionsBlock}</section>`;

    const canRemoveMcp = cli === "claude" || cli === "codex";
    const mcpRows = mcpItems.map((server) => {
      const key = `mcp-remove-${cli}-${server.name}`;
      return `<div class="sitem"><span>${esc(server.name)}</span>${canRemoveMcp ? `<span class="skill-row-actions"><button type="button" class="btn sm" data-setting-action="mcp-remove" data-cli="${cli}" data-name="${esc(server.name)}" data-focus-key="${esc(key)}" ${settingsActionRunning(key) ? "disabled" : ""}>Remove</button>${actionStatusMarkup(key)}</span>` : '<small>Remove it with OpenCode itself</small>'}</div>`;
    });
    const mcpFormKey = `mcp-${cli}`;
    const mcpForm = `<form class="settings-form" data-mcp-form="${cli}" ${openSettingsForms.has(mcpFormKey) ? "" : "hidden"}><input class="settings-input" name="name" maxlength="64" data-focus-key="mcp-name-${cli}" placeholder="Name, like github" aria-label="MCP name" required><input class="settings-input" name="commandOrUrl" data-focus-key="mcp-command-${cli}" placeholder="https://example.com/mcp or npx -y server" aria-label="HTTPS URL or command" required><div class="settings-actions"><button class="btn sm primary" type="submit" data-focus-key="mcp-submit-${cli}" ${settingsActionRunning(`mcp-add-${cli}`) ? "disabled" : ""}>Add MCP</button>${actionStatusMarkup(`mcp-add-${cli}`)}</div></form>`;
    const mcp = `<div class="sblock"><div class="sh"><span>MCP servers</span><button type="button" class="btn sm" data-settings-add="${mcpFormKey}" data-focus-key="${mcpFormKey}-toggle" aria-expanded="${String(openSettingsForms.has(mcpFormKey))}">+ Add</button></div>${inventory.inventoryError ? `<p class="settings-help">${esc(inventory.inventoryError)}</p>` : ""}${mcpRows.join("") || '<span class="sempty">None installed</span>'}${mcpForm}</div>`;
    const skillsRows = (inventory.skills ?? []).map((name) => `<div class="sitem"><span title="${esc(name)}">${esc(name)}</span></div>`).join("") || '<span class="sempty">None installed</span>';
    const skills = `<div class="sblock"><div class="sh"><span>Skills</span></div>${skillsRows}</div>`;
    const plugins = cli === "claude" ? `<div class="sblock"><div class="sh"><span>Plugins</span><button type="button" class="btn sm" data-settings-add="plugins-claude" data-focus-key="plugins-claude-toggle" aria-expanded="${String(openSettingsForms.has("plugins-claude"))}">+ Add</button></div>${pluginItems.map((name) => {
      const key = `plugin-remove-${name}`;
      return `<div class="sitem"><span title="${esc(name)}">${esc(name)}</span><span class="skill-row-actions"><button type="button" class="btn sm" data-setting-action="plugin-remove" data-name="${esc(name)}" data-focus-key="${esc(key)}" ${settingsActionRunning(key) ? "disabled" : ""}>Remove</button>${actionStatusMarkup(key)}</span></div>`;
    }).join("") || '<span class="sempty">None installed</span>'}<form class="settings-form" data-plugin-form ${openSettingsForms.has("plugins-claude") ? "" : "hidden"}><input class="settings-input" name="name" maxlength="128" data-focus-key="plugin-name" placeholder="Claude Code plugin identifier" aria-label="Plugin name" required><div class="settings-actions"><button class="btn sm primary" type="submit" data-focus-key="plugin-submit" ${settingsActionRunning("plugin-add") ? "disabled" : ""}>Install plugin</button>${actionStatusMarkup("plugin-add")}</div></form></div>` : "";
    return `<section class="card skill-card" data-skill-cli="${cli}">${header}${instructionsBlock}${skills}${mcp}${plugins}</section>`;
  }
  function mcpInputValid(name, commandOrUrl) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return "MCP name must use 1-64 letters, numbers, underscores, or hyphens.";
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(commandOrUrl) && !/^https:\/\//i.test(commandOrUrl)) return "MCP URLs must be credential-free HTTPS URLs.";
    if (/^https:\/\//i.test(commandOrUrl)) {
      try { const url = new URL(commandOrUrl); if (url.protocol === "https:" && !url.username && !url.password) return ""; }
      catch { /* the CLI will not receive a malformed URL */ }
      return "MCP URLs must be credential-free HTTPS URLs.";
    }
    if (!commandOrUrl.trim() || /[;&|<>`$(){}\[\]*?~%!^\r\n]/.test(commandOrUrl)) return "MCP commands must be non-empty and contain no shell metacharacters.";
    return "";
  }
  function updateVaultControls() {
    const body = $("setBody"), project = currentProject();
    const input = $("vaultPath"); const selected = input.value.trim(); const saved = String(serverState?.settings?.vault?.path ?? "");
    const changed = selected !== saved;
    const display = $("vaultPathDisplay");
    if (display) { display.textContent = selected || "Choose a folder"; display.title = selected || "Choose a folder"; }
    const status = $("vaultConnectionStatus");
    if (status) {
      status.textContent = changed ? (selected ? "Selected, not connected" : "Not connected") : saved ? `${project?.name ?? "Project"} reads its notes here` : "Not connected";
      status.classList.toggle("connected", Boolean(saved && !changed));
    }
    const toggle = body.querySelector('[data-setting-action="vault-toggle"]');
    if (toggle) {
      toggle.textContent = saved && (!selected || !changed) ? "Disconnect" : "Connect";
      toggle.disabled = settingsActionRunning("vault-save") || (!selected && !saved);
    }
  }
  function settingsCrewSection() {
    const tab = currentTab(); if (!tab) return "";
    const lead = leader(tab), advisor = tab.advisor?.model ?? null;
    return `<section class="settings-section" id="s-crew" data-section="crew"><h3>Crew and models · ${esc(tabLabel(tab.id))}</h3><div class="card"><div class="crow"><span class="logo">${ICONS.crew}</span><div class="d"><b>${esc(processLabel(tab.process))} · ${esc(kindLabel(tab.kind))}</b><small title="${esc(processDescription(tab.kind, tab.process))}">${esc(processDescription(tab.kind, tab.process))}</small></div><button type="button" class="btn sm" data-settings-crew data-focus-key="settings-crew">Change</button></div>${tab.crew.map((seat) => `<div class="crow">${seatImg(seat)}<div class="d"><b title="${esc(seat.name)}">${esc(seat.name)}</b><small title="${esc(seatRole(tab, seat))}">${esc(seatRole(tab, seat))}</small>${seatLocked(tab, seat) ? `<small data-model-locked>Locked while working</small>` : ""}</div><button type="button" class="chipb" data-settings-model="${esc(seat.slot)}" data-focus-key="settings-model-${esc(seat.slot)}"${seatLocked(tab, seat) ? ` disabled aria-disabled="true" title="${LOCK_TIP}"` : ""} aria-label="Model for ${esc(seat.name)}: ${esc(modelLine(seat.cli, seat.model, seat.effort, tab))}">${logo(seat.cli, 13, 0)}<span class="model-label">${esc(formatModel(seat.cli, seat.model, tab))}</span>${modelSupportsEffort(seat.cli, seat.model) ? `<span class="eff">· ${esc(seat.effort)}</span>` : ""}</button></div>`).join("")}${lead?.cli === "claude" ? `<div class="crow"><span class="logo" style="color:var(--adv)" aria-hidden="true">✦</span><div class="d"><b>Advisor</b><small>${esc(lead.name)} asks it before plans and before calling work done</small></div><button type="button" class="chipb" data-settings-advisor data-focus-key="settings-advisor" style="color:var(--adv)" aria-label="Advisor: ${esc(advisor ? formatModel("claude", advisor) : "Off")}"><span>${esc(advisor ? formatModel("claude", advisor) : "Off")}</span></button></div>` : ""}</div></section>`;
  }
  // CLIs added by their start command (Agent Client Protocol). Each can lead a tab from the model menu, in Full access only.
  function settingsAcpSection() {
    const rows = (serverState?.acpClis ?? []).map((cli) => `<div class="crow" data-acp-row="${esc(cli.id)}"><span class="logo">${logo(cli.kind, 18, 0)}</span><div class="d"><b title="${esc(cli.name)}">${esc(cli.name)}</b><small title="${esc([cli.program, ...cli.args].join(" "))}">${esc([cli.program, ...cli.args].join(" "))}</small></div><div class="tool-row-action"><button type="button" class="btn sm danger" data-setting-action="acp-remove" data-id="${esc(cli.id)}" data-name="${esc(cli.name)}" data-focus-key="acp-remove-${esc(cli.id)}">Remove</button>${actionStatusMarkup(`acp-remove-${cli.id}`)}</div></div>`).join("") || '<div class="crow note"><span class="muted">No ACP CLIs added yet.</span></div>';
    return `<section class="settings-section" id="s-acp" data-section="acp"><h3>ACP CLIs</h3><p class="settings-help" style="margin:-4px 2px 10px">Any CLI that speaks the Agent Client Protocol can lead a tab. Type the command that starts it, like gemini --acp, then pick it from the leader's model menu. It runs with Full access: it may edit files and run commands without asking, and Command Center cannot make it ask yet.</p><div class="card">${rows}</div><form class="settings-form" data-acp-form><input class="settings-input" name="name" maxlength="40" data-focus-key="acp-name" placeholder="Name, like Gemini" aria-label="CLI name" required><input class="settings-input" name="command" maxlength="300" data-focus-key="acp-command" placeholder="Start command, like gemini --acp" aria-label="Start command" required><div class="settings-actions"><button class="btn sm primary" type="submit" data-focus-key="acp-submit"${settingsActionRunning("acp-add") ? " disabled" : ""}>Add CLI</button>${actionStatusMarkup("acp-add")}</div></form></section>`;
  }
  function renderSettings(fresh = false) {
    const nav = $("setNav"); const body = $("setBody");
    const snapshot = settingsFocusSnapshot(body);
    if (fresh) settingsEdits.clear();
    const drafts = fresh ? new Map() : settingsDraftSnapshot(body);
    const sections = [...(currentTab() ? [["crew", "Crew and models"]] : []), ["tools", "AI tools"], ["acp", "ACP CLIs"], ["github", "GitHub"], ["vault", "Notes vault"], ["folders", "Folders"], ["skills", "Skills and MCP"], ["appearance", "Appearance"], ["behaviour", "Behaviour"]];
    if (!sections.some(([id]) => id === settingsSection)) settingsSection = sections[0][0];
    const settings = serverState?.settings ?? {};
    nav.innerHTML = `<h2>Settings</h2>${sections.map(([id, label]) => `<button type="button" data-settings-section="${id}" data-focus-key="settings-nav-${id}" aria-current="${String(settingsSection === id)}">${label}</button>`).join("")}`;
    const themes = [["light", "Light", "#f0f0f0", "#ffffff"], ["dark", "Dark", "#0f0f11", "#19191c"], ["system", "Match my PC", "linear-gradient(90deg,#0f0f11 50%,#f0f0f0 50%)", "transparent"]];
    const toolRows = ["claude", "codex", "opencode", "gemini"].map((cli) => settingsToolRow(cli, settings.tools?.[cli])).join("");
    const github = settings.github ?? {};
    const githubSubtitle = github.connected === true ? "Signed in through the GitHub CLI. Pushing still depends on each folder having its own repository and remote." : github.connected === false ? "Not connected" : "Connection status unknown";
    const githubTitle = github.account ?? "GitHub CLI";
    const savedVaultPath = settings.vault?.path ?? ""; const vaultPath = savedVaultPath; const defaultFolder = settings.folders?.defaultProjectFolder ?? "";
    const canBrowse = Boolean(window.cc && typeof window.cc.pickFolder === "function");
    const project = currentProject();
    const projectTabs = project?.tabs ?? [];
    const tabFolders = projectTabs.map((tab) => `<div class="crow folder-row"><b title="${esc(tab.name)}">${esc(tab.name)}</b><span class="path folder-path" title="${esc(tab.folder ?? "No folder set")}">${esc(tab.folder ?? "No folder set")}</span><div class="ra folder-browse">${canBrowse ? `<button type="button" class="btn sm" data-setting-action="tab-folder-browse" data-tab-id="${esc(tab.id)}" data-focus-key="tab-folder-${esc(tab.id)}">Browse</button>` : ""}</div></div>`).join("");
    const projectFolderRow = project ? `<div class="crow folder-row"><b>New tabs</b><span class="path" title="${esc(project.folder)}">${esc(project.folder)}</span><div class="ra">${canBrowse ? `<button type="button" class="btn sm" data-setting-action="project-folder-browse" data-focus-key="project-folder">Browse</button>` : ""}</div></div>` : "";
    const vaultStatus = savedVaultPath ? `${project ? esc(project.name) + " reads its notes here" : "Connected"}` : "Not connected";
    const vaultPathControl = canBrowse
      ? `<span class="vault-path-display" id="vaultPathDisplay" title="${esc(vaultPath || "Choose a folder")}">${esc(vaultPath || "Choose a folder")}</span><input id="vaultPath" type="hidden" value="${esc(vaultPath)}" data-focus-key="vault-path">`
      : `<input class="settings-input vault-inline-path" id="vaultPath" value="${esc(vaultPath)}" data-focus-key="vault-path" placeholder="Paste the vault folder path" aria-label="Vault folder">`;
    const vaultToggleText = savedVaultPath && (!vaultPath || vaultPath === savedVaultPath) ? "Disconnect" : "Connect";
    const vaultConnectedClass = savedVaultPath ? "connected" : "";
    const refreshing = refreshState?.status === "running";
    const permission = "Notification" in window ? Notification.permission : "unsupported";
    const notificationsOn = Boolean(settingValue("notificationsEnabled"));
    const content = `${settingsCrewSection()}
      <section class="settings-section" id="s-tools" data-section="tools"><h3>AI tools<button type="button" class="btn sm" data-settings-refresh data-focus-key="settings-refresh"${refreshing ? " disabled" : ""}>${refreshing ? "Checking…" : "Check again"}</button></h3><div class="card tool-card">${toolRows}</div><p class="settings-help">${refreshing ? "Checking every CLI…" : refreshState?.status === "done" ? `Checked ${esc(agoText(refreshState.at))}. ` : refreshState?.status === "failed" ? "Could not check just now. Try again. " : ""}Installed and signed in are checked separately; Install runs npm in the background and asks first.</p></section>
      ${settingsAcpSection()}
      <section class="settings-section" id="s-github" data-section="github"><h3>GitHub</h3><div class="card"><div class="crow github-row"><span class="logo">${logo("github", 18, 0)}</span><div class="d"><b title="${esc(githubTitle)}">${esc(githubTitle)}</b><small class="wrap">${esc(githubSubtitle)}</small></div><div class="ra"><button type="button" class="btn sm" data-setting-action="github-login" data-focus-key="github-login" ${settingsActionRunning("github-login") ? "disabled" : ""}>${github.connected === true ? "Reconnect" : "Connect"}</button>${actionStatusMarkup("github-login")}</div></div></div></section>
      <section class="settings-section" id="s-vault" data-section="vault"><h3>Notes vault</h3><div class="card"><div class="crow vault-row" data-vault-row><span class="logo">${logo("obsidian", 18, 0)}</span><div class="d"><b>Obsidian vault</b><small><span class="vault-path-wrap">${vaultPathControl}</span><span class="vault-separator"> · </span><span id="vaultConnectionStatus" class="${vaultConnectedClass}">${vaultStatus}</span></small></div><div class="ra settings-actions">${canBrowse ? '<button type="button" class="btn sm" data-setting-action="vault-browse" data-focus-key="vault-browse">Browse</button>' : ""}<button type="button" class="btn sm" data-setting-action="vault-toggle" data-focus-key="vault-toggle" ${settingsActionRunning("vault-save") || (!vaultPath.trim() && !savedVaultPath) ? "disabled" : ""}>${vaultToggleText}</button>${actionStatusMarkup("vault-save")}</div></div></div><p class="settings-help vault-help">Optional. Save always writes the tab's own <code>.command-center/&lt;tab&gt;/RESUME.md</code>; the vault is what Open in Obsidian opens.</p></section>
      <section class="settings-section" id="s-folders" data-section="folders"><h3>Folders${project ? ` · ${esc(project.name)}` : ""}</h3><div class="card folder-card">${projectFolderRow}${tabFolders || '<div class="crow"><span class="muted">No tabs are available.</span></div>'}</div><p class="settings-help folder-help">Each tab's crew works in its own folder (no CLI is held to it by a sandbox). A folder can change only while that tab is idle; new tabs start in the project folder.</p><div class="card folder-default" style="margin-top:12px"><div class="settings-row"><label class="field"><span class="lbl">Default folder for new projects</span><input class="settings-input" id="defaultProjectFolder" value="${esc(defaultFolder)}" data-focus-key="default-folder" placeholder="Choose a folder"></label><div class="settings-actions">${canBrowse ? '<button type="button" class="btn sm" data-setting-action="folder-browse" data-focus-key="folder-browse">Browse</button>' : ""}<button type="button" class="btn sm primary" data-setting-action="folder-save" data-focus-key="folder-save" ${settingsActionRunning("folder-save") ? "disabled" : ""}>Save folder</button>${actionStatusMarkup("folder-save")}</div></div></div></section>
      <section class="settings-section" id="s-skills" data-section="skills"><h3>Skills and MCP</h3><p class="settings-help sintro" style="margin:-4px 2px 10px">Tools available to your agents, and the instruction files each CLI found. MCP and plugin Add and Remove run the CLI's own command and ask first.</p><div class="skills-grid">${["claude", "codex", "opencode", "gemini"].map((cli) => skillBlock(cli, settings.skills?.[cli])).join("")}</div></section>
      <section class="settings-section" id="s-appearance" data-section="appearance"><h3>Appearance</h3><div class="theme" role="radiogroup" aria-label="Appearance">${themes.map(([value, label, background, side]) => `<button type="button" role="radio" data-theme="${value}" aria-checked="${String(activeTheme === value)}" data-focus-key="theme-${value}"><span class="sw" style="background:${background}"><i style="background:${side}"></i><i></i></span>${label}</button>`).join("")}</div><p class="settings-help">${activeTheme === "system" ? "Following your PC: it switches by itself when Windows does." : "Remembered on this PC."}</p></section>
      <section class="settings-section" id="s-behaviour" data-section="behaviour"><h3>Behaviour</h3><div class="card">${settingSwitch("notificationsEnabled", "Notifications", "A desktop notice when a seat finishes, fails or needs you", settingValue("notificationsEnabled"), false, notificationsOn && permission === "denied" ? '<small class="wrap" style="color:var(--danger-text)">Blocked by the browser for this page. Allow notifications in the site settings, or nothing will show.</small>' : notificationsOn && permission === "unsupported" ? '<small class="wrap">This window cannot show desktop notices.</small>' : "")}${settingSwitch("bellEnabled", "Completion sound", "A short chime when a seat finishes, fails or needs you, with Notifications on or off. The speaker in the top bar switches it too and sets its volume", settingValue("bellEnabled"))}</div></section>`;
    body.innerHTML = `<div class="set">${content}</div>`;
    restoreSettingsDrafts(body, drafts);
    updateVaultControls();
    restoreSettingsFocus(body, snapshot);
    fixRadios(body);
    nav.querySelectorAll("[data-settings-section]").forEach((button) => button.addEventListener("click", () => {
      settingsSection = button.dataset.settingsSection; settingsScrollLock = Date.now(); markSettingsNav(); const target = body.querySelector(`#s-${CSS.escape(settingsSection)}`); if (target) body.scrollTop = target.offsetTop - 20; button.focus({ preventScroll: true });
    }));
    body.onscroll = trackSettingsScroll;
    body.querySelectorAll("[data-theme]").forEach((button) => button.addEventListener("click", () => {
      setTheme(button.dataset.theme); renderSettings();
      body.querySelector(`[data-theme="${CSS.escape(activeTheme)}"]`)?.focus({ preventScroll: true });
    }));
    $("vaultPath").addEventListener("input", updateVaultControls);
    body.querySelector("[data-settings-refresh]")?.addEventListener("click", () => {
      const requestId = newRequestId(), previous = refreshState;
      refreshState = { status: "running", at: Date.now(), requestId }; // before the send: a local server's answer can arrive inside it
      if (!send({ type: "refreshSettings", requestId })) { refreshState = previous; return; }
      renderSettings();
      // The server answers success and failure alike; if it never answers at all, "Checking…" does not stay on forever.
      setTimeout(() => { if (refreshState?.status === "running" && refreshState.requestId === requestId) { refreshState = { status: "failed", at: Date.now() }; if (!$("setModal").hidden) renderSettings(); } }, REFRESH_WAIT_MS);
    });
    body.querySelector("[data-settings-crew]")?.addEventListener("click", () => { const tab = currentTab(); if (!tab) return; closeLayer(false); processMenu(tab, $("tabs").querySelector('[aria-selected="true"]') ?? $("setupsBtn")); });
    body.querySelectorAll("[data-settings-model]").forEach((button) => button.addEventListener("click", () => { const tab = currentTab(), seat = seatFor(tab, button.dataset.settingsModel); if (tab && seat) togglePopover($("pop"), button, () => openModelPicker(tab, seat, button)); }));
    body.querySelector("[data-settings-advisor]")?.addEventListener("click", (event) => { const tab = currentTab(), lead = leader(tab); if (tab && lead) togglePopover($("pop"), event.currentTarget, () => openAdvisor(tab, lead, event.currentTarget)); });
    body.querySelectorAll("[data-settings-add]").forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.settingsAdd;
      if (openSettingsForms.has(key)) openSettingsForms.delete(key); else openSettingsForms.add(key);
      renderSettings();
    }));
    body.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
      const command = button.dataset.copy;
      try { await navigator.clipboard.writeText(command); showToast("Command copied"); }
      catch {
        const input = document.createElement("textarea"); input.value = command; input.setAttribute("readonly", ""); input.style.position = "fixed"; input.style.opacity = "0"; document.body.append(input); input.select();
        const copied = document.execCommand("copy"); input.remove(); showToast(copied ? "Command copied" : "Could not copy. Select it and copy by hand");
      }
    }));
    body.querySelectorAll("[data-setting]").forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.setting; const next = button.getAttribute("aria-checked") !== "true";
      if (send({ type: "updateClientPref", key, value: next })) {
        clientPrefOverrides.set(key, next);
        if (key === "bellEnabled") renderSoundButton();
        if (key === "notificationsEnabled" && next && "Notification" in window && Notification.permission === "default") Promise.resolve(Notification.requestPermission()).then(() => { if (!$("setModal").hidden) renderSettings(); }).catch(() => {});
      }
      renderSettings(); body.querySelector(`[data-setting="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
    }));
    body.querySelectorAll("[data-setting-action]").forEach((button) => button.addEventListener("click", () => {
      const action = button.dataset.settingAction; const cli = button.dataset.cli; const name = button.dataset.name;
      if (action === "vault-browse") { pickFolder((folder) => { if ($("setModal").hidden) return; $("vaultPath").value = folder; settingsEdits.add("vault-path"); updateVaultControls(); }); return; }
      if (action === "folder-browse") { pickFolder((folder) => { $("defaultProjectFolder").value = folder; settingsEdits.add("default-folder"); }); return; }
      if (action === "tab-folder-browse") { const tabId = button.dataset.tabId; pickFolder((folder) => send({ type: "changeFolder", tabId, folder })); return; }
      if (action === "project-folder-browse") { const projectId = currentProject()?.id; if (projectId) pickFolder((folder) => send({ type: "changeProjectFolder", projectId, folder })); return; }
      let payload = null; let key = ""; let confirmation = null;
      if (action === "install-cli") { key = `install-${cli}`; payload = { type: "installCli", cli, confirm: true }; confirmation = { title: `Install ${CLI_LABEL[cli]}?`, body: `Runs npm install -g with ${CLI_LABEL[cli]}'s own fixed package in the background. Signing in comes after.`, ok: "Install" }; }
      if (action === "login-cli") { key = `login-${cli}`; payload = { type: "cliLogin", cli }; }
      if (action === "github-login") { key = "github-login"; payload = { type: "ghLogin" }; }
      if (action === "vault-toggle") {
        key = "vault-save";
        const selected = $("vaultPath").value.trim(); const saved = String(settings.vault?.path ?? "");
        payload = { type: "setNotesVault", path: saved && selected === saved ? null : selected || null };
      }
      if (action === "folder-save") { key = "folder-save"; payload = { type: "setDefaultProjectFolder", folder: $("defaultProjectFolder").value.trim() }; }
      if (action === "mcp-remove") { key = `mcp-remove-${cli}-${name}`; payload = { type: "mcpRemove", cli, name, confirm: true }; confirmation = { title: `Remove ${name} from ${CLI_LABEL[cli]}?`, body: `Runs ${CLI_LABEL[cli]}'s own remove command. Agents lose this tool from their next session.`, ok: "Remove", danger: true }; }
      if (action === "acp-remove") { key = `acp-remove-${button.dataset.id}`; payload = { type: "removeAcpCli", id: button.dataset.id }; confirmation = { title: `Remove ${name}?`, body: `${name} leaves the ACP CLI list. A tab that leads with it must pick another CLI first.`, ok: "Remove", danger: true }; }
      if (action === "plugin-remove") { key = `plugin-remove-${name}`; payload = { type: "pluginUninstall", name, confirm: true }; confirmation = { title: `Remove the ${name} plugin?`, body: "Runs Claude Code's own uninstall command.", ok: "Remove", danger: true }; }
      if (!payload) return;
      const run = () => { const sentId = sendSettingsAction(key, payload); if (sentId) renderSettings(); };
      if (confirmation) confirmAction(confirmation, run, button); else run();
    }));
    body.querySelectorAll("[data-mcp-form]").forEach((form) => form.addEventListener("submit", (event) => {
      event.preventDefault(); const cli = form.dataset.mcpForm; const name = form.elements.name.value.trim(); const commandOrUrl = form.elements.commandOrUrl.value.trim();
      const error = mcpInputValid(name, commandOrUrl);
      if (error) { showToast(error); return; }
      const key = `mcp-add-${cli}`;
      // The Settings text promises "Add and Remove ... ask first": an MCP tool is a program that runs on this PC.
      confirmAction({ title: `Add ${name} to ${CLI_LABEL[cli]}?`, body: `Runs ${CLI_LABEL[cli]}'s own add command for ${commandOrUrl}. Agents get this tool from their next session and it runs on this PC, so only add one you trust.`, ok: "Add" },
        () => { if (sendSettingsAction(key, { type: "mcpAdd", cli, name, commandOrUrl })) renderSettings(); }, event.submitter ?? document.activeElement);
    }));
    body.querySelector("[data-acp-form]")?.addEventListener("submit", (event) => {
      event.preventDefault(); const name = event.currentTarget.elements.name.value.trim(); const command = event.currentTarget.elements.command.value.trim();
      if (!name || !command) return;
      confirmAction({ title: `Add ${name}?`, body: `Command Center will start ${command} from your PC when you pick ${name} as a leader. It runs with Full access, so only add a CLI you trust.`, ok: "Add" },
        () => { if (sendSettingsAction("acp-add", { type: "addAcpCli", name, command })) renderSettings(); }, event.submitter ?? document.activeElement);
    });
    body.querySelector("[data-plugin-form]")?.addEventListener("submit", (event) => {
      event.preventDefault(); const name = event.currentTarget.elements.name.value.trim(); if (!name) return;
      confirmAction({ title: `Install the ${name} plugin?`, body: "Runs Claude Code's own plugin install command. A plugin can run code on this PC, so only install one you trust.", ok: "Install" },
        () => { if (sendSettingsAction("plugin-add", { type: "pluginInstall", name })) renderSettings(); }, event.submitter ?? document.activeElement);
    });
  }

  // ---------- events ----------
  function bindEvents() {
    new ResizeObserver(() => { if ($("toast").classList.contains("on")) placeToast(); }).observe($("composer"));
    // A file dropped on the window must never open in place of the app. Nothing here takes a drop today; a future drop zone marks itself data-drop-zone.
    for (const type of ["dragover", "drop"]) document.addEventListener(type, (event) => { if (!event.target.closest?.("[data-drop-zone]")) event.preventDefault(); });
    $("pmore").addEventListener("click", (event) => togglePopover($("projPop"), event.currentTarget, () => renderProjectPopover(event.currentTarget)));
    $("addProj").addEventListener("click", (event) => openProjectDialog(event.currentTarget));
    $("addtab").addEventListener("click", (event) => openAddTab(event.currentTarget));
    $("setBtn").addEventListener("click", (event) => openSettings(event.currentTarget));
    $("inboxBtn").addEventListener("click", (event) => togglePopover($("inboxPop"), event.currentTarget, () => openInbox(event.currentTarget)));
    $("reqNew").addEventListener("click", () => {
      const open = $("reqForm").hidden;
      $("reqForm").hidden = !open; $("reqNew").setAttribute("aria-expanded", String(open)); $("reqNew").textContent = open ? "Close form" : "New request";
      placePopover($("inboxPop"));
      if (open) $("reqTitle").focus();
    });
    $("soundBtn").addEventListener("click", (event) => togglePopover($("soundPop"), event.currentTarget, () => openSoundPop(event.currentTarget)));
    $("soundSwitch").addEventListener("click", toggleSound);
    $("soundVol").addEventListener("input", () => { soundSliding = true; showSoundLevel(); });
    $("soundVol").addEventListener("change", saveSoundVolume);
    $("soundTest").addEventListener("click", () => playCompletionSound(Number($("soundVol").value)));
    $$("[data-theme-toggle]").forEach((button) => button.addEventListener("click", () => { setTheme(button.dataset.themeToggle); if (!$("setModal").hidden) renderSettings(); }));
    $("themeTg").addEventListener("keydown", (event) => {
      if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = resolvedTheme() === "light" ? "dark" : "light";
      setTheme(event.key === "Home" ? "light" : event.key === "End" ? "dark" : next);
      $("themeTg").querySelector('[aria-checked="true"]')?.focus();
    });
    $("permBtn").addEventListener("click", (event) => togglePopover($("permPop"), event.currentTarget, () => openPermissionPicker(currentTab(), event.currentTarget)));
    $("meBtn").addEventListener("click", (event) => openMeAvatar(event.currentTarget));
    bindWindowButtons();
    $("folderBtn").addEventListener("click", () => { const tab = currentTab(); if (tab) pickFolder((folder) => send({ type: "changeFolder", tabId: tab.id, folder })); });
    $("stopAll").addEventListener("click", stopAll);
    $("setupsBtn").addEventListener("click", (event) => { const tab = currentTab(); if (tab) togglePopover($("setupPop"), event.currentTarget, () => processMenu(tab, event.currentTarget)); });
    $("railBtn").addEventListener("click", () => setRailCollapsed(railWide));
    $("sideBtn").addEventListener("click", () => { setSideOpen(!sideOpen); if (sideOpen && innerWidth < 1280) $("sideClose").focus(); });
    $("sideClose").addEventListener("click", () => { setSideOpen(false); $("sideBtn").focus(); });
    $("statusBtn").addEventListener("click", () => { stepsOpen = !stepsOpen; const tab = currentTab(); if (tab) renderStatusLine(tab); });
    $("saveBtn").addEventListener("click", () => startSave(currentTab()));
    $("chatMore").addEventListener("click", (event) => togglePopover($("ctxPop"), event.currentTarget, () => chatMenu(event.currentTarget)));
    $("scrim").addEventListener("click", () => closeLayer());
    $("browse").addEventListener("click", () => pickFolder((folder) => updateFolderDisplay("tab", folder)));
    $("pBrowse").addEventListener("click", () => pickFolder((folder) => updateFolderDisplay("project", folder)));
    $("createTab").addEventListener("click", createTab);
    $("createProj").addEventListener("click", createProject);
    $("tName").addEventListener("input", () => { if (!$("tName").value.trim()) $("tFolderWarn").hidden = Boolean(selectedTabFolder); });
    $("pName").addEventListener("input", () => { $("npStat").classList.remove("bad"); updateProjectSubmit(); });
    $("runPrompt").addEventListener("input", () => { if (!pendingRun && !runUnknown) $("runStart").disabled = !$("runPrompt").value.trim(); });
    $("runStart").addEventListener("click", startRun);
    $("confirmOk").addEventListener("click", confirmAccepted);
    $("confirmCancel").addEventListener("click", () => setLayer($("confirmModal"), false, null, true));
    $("confirmPhrase").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); confirmAccepted(); } });
    $("renameSave").addEventListener("click", renameAccepted);
    $("renameInput").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); renameAccepted(); } });
    $("sendBtn").addEventListener("click", sendChat);
    $("ci").addEventListener("input", () => {
      const tabId = currentTab()?.id;
      if (tabId) { draftsByTab.set(tabId, $("ci").value); noteTextEdit(tabId); }
      fitComposer();
      updateChatLoading(tabId);
    });
    // Enter sends, Shift+Enter is a new line, and Enter while an IME is composing a character never sends.
    $("ci").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); sendChat(); } });
    $("attachBtn").addEventListener("click", () => { attachmentTargetTab = currentTab()?.id ?? null; $("attachInput").click(); });
    $("attachInput").addEventListener("change", (event) => {
      const tabId = attachmentTargetTab ?? currentTab()?.id; attachmentTargetTab = null;
      for (const file of event.target.files ?? []) {
        if (/^image\/(?:png|jpeg|webp)$/.test(file.type)) addImageAttachment(file, tabId);
        else addFileAttachment(file, tabId);
      }
      event.target.value = "";
    });
    $("ci").addEventListener("paste", (event) => {
      if (pendingChatByTab.has(currentTab()?.id)) { event.preventDefault(); return; }
      const files = [...(event.clipboardData?.items ?? [])].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
      if (!files.length) return;
      const accepted = files.filter((file) => /^image\/(?:png|jpeg|webp)$/.test(file.type) || FILE_EXTENSIONS.has(fileExtension(file.name)));
      if (accepted.length) {
        event.preventDefault();
        for (const file of accepted) {
          if (/^image\/(?:png|jpeg|webp)$/.test(file.type)) addImageAttachment(file);
          else addFileAttachment(file);
        }
      }
    });
    $("avUp").addEventListener("change", (event) => { const file = event.target.files?.[0]; event.target.value = ""; uploadMe(file); });
    $("reqForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const tab = currentTab(); const toTabId = $("reqTo").value;
      const title = $("reqTitle").value.trim(); const body = $("reqBody").value.trim();
      // The server's limit is 24 KiB in bytes; the form's length limit counts characters, so a long non-English text must be measured here.
      if (new TextEncoder().encode($("reqBody").value).length > REQUEST_BODY_BYTES) { $("reqStatus").textContent = "The details are too long (24 KiB at most)"; $("reqStatus").dataset.status = "failed"; return; }
      const pendingRequestAction = pendingRequestActions.get(tab?.id) ?? requestActionResults.get(tab?.id)?.requestId;
      const priorAction = pendingRequestAction ? actionStateFor(pendingRequestAction) : null;
      if (!tab || !toTabId || !title || !body || (pendingRequestAction && (!priorAction || priorAction.status === "running"))) {
        if (tab && (!title || !body)) { $("reqStatus").textContent = !title ? "Give it a title" : "Add the details"; $("reqStatus").dataset.status = "failed"; }
        return;
      }
      const requestId = newRequestId();
      if (!send({ type: "sendRequest", requestId, fromTabId: tab.id, toTabId, title, body })) return;
      pendingRequestActions.set(tab.id, requestId);
      renderRequests();
    });
    bindRadios($("kindBox"), "[data-kind]", (button) => { tabKind = button.dataset.kind; $("tplBox").innerHTML = availableProcessOptions(tabProcess, tabKind); fixRadios($("modal")); });
    bindRadios($("tplBox"), "[data-process]", (button) => { tabProcess = button.dataset.process; });
    bindRadios($("pKind"), "[data-kind]", (button) => { projectKind = button.dataset.kind; $("pTpl").innerHTML = availableProcessOptions(projectProcess, projectKind); fixRadios($("projModal")); });
    bindRadios($("pTpl"), "[data-process]", (button) => { projectProcess = button.dataset.process; });
    $$('[data-close]').forEach((button) => button.addEventListener("click", () => { const layer = button.closest(".modal"); if (layer) setLayer(layer, false, null, true); else closeLayer(); }));
    document.addEventListener("keydown", (event) => heldApprovalKeys.add(event.code || event.key), true);
    document.addEventListener("keyup", (event) => {
      heldApprovalKeys.delete(event.code || event.key);
      const press = approvalKeyPressId;
      if (press?.key !== (event.code || event.key)) return;
      setTimeout(() => { if (approvalKeyPressId === press) approvalKeyPressId = null; }, 0);
    }, true);
    document.addEventListener("pointerdown", (event) => heldApprovalPointers.add(event.pointerId ?? 0), true);
    document.addEventListener("pointerup", (event) => heldApprovalPointers.delete(event.pointerId ?? 0), true);
    document.addEventListener("pointercancel", (event) => {
      heldApprovalPointers.delete(event.pointerId ?? 0);
      if (approvalPressId?.pointerId === (event.pointerId ?? 0)) approvalPressId = null;
    }, true);
    $("setBody").addEventListener("input", (event) => { const key = event.target.dataset?.focusKey; if (key) settingsEdits.add(key); });
    window.addEventListener("blur", () => {
      heldApprovalKeys.clear(); heldApprovalPointers.clear();
      approvalPressId = null; approvalKeyPressId = null;
    });
    const settledApprovalId = () => performance.now() >= approvalSettleUntil ? $("approvalPanel").dataset.approvalId : "";
    for (const id of ["approvalAllow", "approvalDeny"]) $(id).addEventListener("pointerdown", (event) => { approvalPressId = { id: settledApprovalId(), pointerId: event.pointerId ?? 0 }; });
    document.addEventListener("pointerup", (event) => { const press = approvalPressId; if (press?.pointerId !== (event.pointerId ?? 0)) return; setTimeout(() => { if (approvalPressId === press) approvalPressId = null; }, 0); }, true);
    $("approvalPanel").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
      if (!event.repeat) approvalKeyPressId = { id: settledApprovalId(), key: event.code || event.key };
    });
    $("approvalAllow").addEventListener("click", (event) => answerToolApproval(true, event));
    $("approvalDeny").addEventListener("click", (event) => answerToolApproval(false, event));
    const pills = document.querySelector(".pills");
    document.querySelectorAll(".pills [data-l]").forEach((button) => {
      button.addEventListener("click", () => { lowerSection = button.dataset.l; renderLower(); button.focus({ preventScroll: true }); });
      button.addEventListener("keydown", (event) => tabKeys(event, button, pills, "[data-l]", (next) => { lowerSection = next.dataset.l; renderLower(); next.focus({ preventScroll: true }); }));
    });
    const grip = $("sgrip");
    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const right = $("side").getBoundingClientRect().right;
      grip.setPointerCapture?.(event.pointerId);
      const move = (moveEvent) => { sideWidthDraft = Math.max(280, Math.min(560, right - moveEvent.clientX)); applySideWidth(); };
      const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); saveSideWidth(sideWidth()); };
      grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up);
    });
    grip.addEventListener("keydown", (event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); saveSideWidth(sideWidth() + (event.key === "ArrowLeft" ? 16 : -16)); });
    document.addEventListener("pointerdown", (event) => {
      if (!currentLayer || currentLayer.classList.contains("modal")) return;
      if (!event.target.closest(".pop,[aria-haspopup]")) closePopovers();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (currentLayer) { event.preventDefault(); closeLayer(); return; }
        if (sideOpen && innerWidth < 1280 && $("side").contains(document.activeElement)) { event.preventDefault(); setSideOpen(false); $("sideBtn").focus(); return; }
      }
      if (event.key !== "Tab" || !currentLayer) return;
      // A modal keeps Tab inside it; a popover opened from inside a modal is the active scope until it closes.
      const top = currentLayer;
      const trapped = top.classList.contains("modal") || layerStack.some((entry) => entry.modal);
      if (!trapped) return;
      const focusable = $$('button:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]', top).filter((item) => !item.hidden && item.tabIndex >= 0 && item.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      else if (!top.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
    });
    // A picture that fails to load swaps to its fallback once; the flag stops a missing fallback from looping.
    document.addEventListener("error", (event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !image.dataset.fallback || image.dataset.fellBack === "1") return;
      if (image.getAttribute("src") === image.dataset.fallback) { image.dataset.fellBack = "1"; return; }
      image.dataset.fellBack = "1"; image.src = image.dataset.fallback;
    }, true);
    const tip = $("tip");
    const tipTarget = (event) => event.target.closest?.("#stage:not(.wide) .seat[data-tip],#stage:not(.wide) #setupsBtn,#stage:not(.wide) #stopAll");
    const showTip = (target) => { const rect = target.getBoundingClientRect(); tip.textContent = target.dataset.tip; tip.style.left = `${rect.right + 12}px`; tip.style.top = `${rect.top + rect.height / 2}px`; tip.classList.add("on"); };
    document.addEventListener("mouseover", (event) => { const target = tipTarget(event); if (target && !target.classList.contains("on")) showTip(target); else tip.classList.remove("on"); });
    document.addEventListener("focusin", (event) => { const target = tipTarget(event); if (target && event.target.matches(":focus-visible")) showTip(target); else tip.classList.remove("on"); });
    $("crew").addEventListener("scroll", () => tip.classList.remove("on"));
    $("ptabs").addEventListener("wheel", (event) => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) { $("ptabs").scrollLeft += event.deltaY; event.preventDefault(); } }, { passive: false });
    $("stage").addEventListener("transitionend", (event) => { if (event.target.id === "stage") refreshPopovers(); });
    window.addEventListener("resize", () => { refreshPopovers(); renderHeader(); });
    window.addEventListener("pagehide", () => {
      for (const id of pendingActions.keys()) sendHeld(id, true);
      for (const list of attachmentsByTab.values()) for (const item of list) releaseAttachment(item);
      for (const list of queueByTab.values()) for (const queued of list) for (const item of queued.items) releaseAttachment(item);
    });
    matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => { if (activeTheme === "system") { applyTheme(); if (!$("setModal").hidden) renderSettings(); } });
  }
  // ---------- queued messages: typed while the leader replies ----------
  function queueFor(tabId) { return queueByTab.get(tabId) ?? []; }
  function replyActive(tabId) { return findTab(tabId)?.derived?.leaderTurnActive === true; }
  function removeQueued(tabId, item) {
    const rest = queueFor(tabId).filter((other) => other !== item);
    if (rest.length) queueByTab.set(tabId, rest); else queueByTab.delete(tabId);
    for (const attachment of item.items) releaseAttachment(attachment);
    if (currentTab()?.id === tabId) renderQueue();
  }
  function clearQueue(tabId) { for (const item of [...queueFor(tabId)]) removeQueued(tabId, item); flushArmed.delete(tabId); }
  // The owner stopped this tab's leader, or its reply failed: nothing queued goes out on its own, and a flush waiting for the state is cancelled. This also covers a reply the server
  // had just finished (its chatDone still on the way), where Stop finds no turn and so no chatError ever comes.
  function holdQueue(tabId) {
    flushArmed.delete(tabId);
    for (const item of queueFor(tabId)) item.held = true;
    replyEnds.set(tabId, { kind: "stopped" });
    if (currentTab()?.id === tabId) renderQueue();
  }
  function putFront(tabId, item) { queueByTab.set(tabId, [item, ...queueFor(tabId).filter((other) => other !== item)]); }
  // The composer's message becomes a queued one; its attachments go with it (they are not released, the item owns them now).
  function queueFromRequest(request) {
    const rest = attachmentList(request.tabId).filter((item) => !request.items.includes(item));
    if (rest.length) attachmentsByTab.set(request.tabId, rest); else attachmentsByTab.delete(request.tabId);
    queueByTab.set(request.tabId, [...queueFor(request.tabId), { id: newRequestId(), text: request.text, items: request.items, held: false, state: "waiting", requestId: null }]);
    settleChatRequest(request, true); // empties the composer as an accepted send does
  }
  async function queueComposer(tabId) {
    if (queuingTabs.has(tabId)) return;
    const text = $("ci").value.trim(), items = [...attachmentList(tabId)], generation = composerGeneration;
    if (!text) return;
    queuingTabs.add(tabId);
    const endAtStart = replyEnds.get(tabId);
    try {
      await Promise.all(items.map((item) => item.promise).filter(Boolean));
      if (composerGeneration !== generation || $("ci").value.trim() !== text) return; // the tab changed or the text was edited while a file loaded
      const kept = items.filter((item) => attachmentList(tabId).includes(item) && !item.released);
      if (kept.some((item) => item.status !== "ready" || !item.path)) { showToast("Remove or retry the attachment that could not be loaded"); return; }
      // How did the reply end while the file loaded? A Clear leaves the message in the box; a Stop or failure queues it held; a normal end queues it behind the earlier ones and it goes out in order.
      const ended = replyEnds.get(tabId) !== endAtStart ? replyEnds.get(tabId).kind : replyActive(tabId) ? null : "done";
      if (ended === "cleared") return;
      const rest = attachmentList(tabId).filter((item) => !kept.includes(item));
      if (rest.length) attachmentsByTab.set(tabId, rest); else attachmentsByTab.delete(tabId);
      queueByTab.set(tabId, [...queueFor(tabId), { id: newRequestId(), text, items: kept, held: ended === "stopped", state: "waiting", requestId: null }]);
      draftsByTab.set(tabId, ""); noteTextEdit(tabId);
      if (composerTabId === tabId) { $("ci").value = ""; fitComposer(); }
      renderAttachments();
      if (ended === "done") { flushArmed.add(tabId); flushQueue(tabId); }
    } finally {
      queuingTabs.delete(tabId);
      if (currentTab()?.id === tabId) updateChatLoading(tabId);
    }
  }
  // Steer (a reply is running: pushed into it) or Send (it is not: a normal message). Both carry the item's own attachments and the folder-busy check.
  function goQueued(tabId, id, confirmBusy) {
    const item = queueFor(tabId).find((other) => other.id === id);
    const tab = findTab(tabId);
    if (!item || !tab || item.state !== "waiting") return;
    const steer = replyActive(tabId);
    if (steer && (tab.pendingApprovals?.length || savePending.has(tabId))) return;
    if (item.items.some((attachment) => attachment.released || attachment.status !== "ready" || !attachment.path)) { showToast("Remove or retry the attachment that could not be loaded"); return; }
    const requestId = newChatRequestId();
    const images = item.items.filter((attachment) => attachment.kind === "image").map((attachment) => attachment.path);
    const files = item.items.filter((attachment) => attachment.kind === "file").map((attachment) => attachment.path);
    chatRequestsById.set(requestId, { requestId, tabId, text: item.text, items: item.items, sent: true, status: "pending", queueItem: item, steer });
    item.state = "sending"; item.requestId = requestId;
    const payload = { type: steer ? "steer" : "chat", tabId, text: item.text, requestId, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), ...(confirmBusy === true ? { confirmBusy: true } : {}) };
    if (!send(payload)) { chatRequestsById.delete(requestId); item.state = "waiting"; item.requestId = null; }
    renderQueue();
  }
  // The reply ended normally and the state says the leader is idle: the first waiting message goes out as a normal send, the rest wait for that reply.
  function flushQueue(tabId) {
    if (!flushArmed.has(tabId)) return;
    if (!findTab(tabId) || replyActive(tabId) || !socket || socket.readyState !== WebSocket.OPEN) return;
    const list = queueFor(tabId);
    if (list.some((item) => item.state !== "waiting")) return;
    const next = list.find((item) => !item.held);
    flushArmed.delete(tabId);
    if (next) goQueued(tabId, next.id);
  }
  function renderQueue() {
    const box = $("queue"); if (!box) return;
    const tab = currentTab();
    const list = tab && inChat(tab) ? queueFor(tab.id) : [];
    const active = Boolean(tab && replyActive(tab.id));
    const why = !tab ? "" : tab.pendingApprovals?.length ? "Answer the approval first" : savePending.has(tab.id) ? "Save is running" : "";
    const html = list.map((item) => {
      const sending = item.state !== "waiting", blocked = active && why;
      const names = item.items.map((attachment) => esc(attachment.name)).join(", ");
      return `<div class="qitem" data-queue="${esc(item.id)}"><span class="qtext" title="${esc(item.text)}">${esc(item.text)}${names ? `<small>${names}</small>` : ""}</span>${blocked ? `<small class="qwhy">${esc(why)}</small>` : ""}<button type="button" class="btn sm" data-queue-go="${esc(item.id)}"${sending || blocked ? " disabled" : ""}>${active ? "Steer" : "Send"}</button><button type="button" class="qx" data-queue-remove="${esc(item.id)}" aria-label="Remove queued message" title="Remove"${sending ? " disabled" : ""}>${ICONS.x}</button></div>`;
    }).join("");
    box.hidden = !list.length;
    if (box.dataset.html === html) return;
    box.dataset.html = html; box.innerHTML = html;
    box.querySelectorAll("[data-queue-go]").forEach((button) => button.addEventListener("click", () => goQueued(tab.id, button.dataset.queueGo)));
    box.querySelectorAll("[data-queue-remove]").forEach((button) => button.addEventListener("click", () => {
      const item = queueFor(tab.id).find((other) => other.id === button.dataset.queueRemove);
      if (item && item.state === "waiting") removeQueued(tab.id, item);
    }));
  }
  function fitComposer() { const input = $("ci"); input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight || 24, 160)}px`; }
  async function sendChat(confirmBusy) {
    const tab = currentTab();
    if (!tab || !inChat(tab) || savePending.has(tab.id) || chatSendLocked(tab.id)) return;
    if (replyActive(tab.id)) { void queueComposer(tab.id); return; }
    if (queuingTabs.has(tab.id)) return; // the composer's message is already on its way to the queue, waiting for its upload
    const tabId = tab.id; const composerValue = $("ci").value; const text = composerValue.trim(); const queued = [...attachmentList(tabId)]; const generation = composerGeneration;
    if (!text) return;
    const requestId = newChatRequestId();
    const request = { requestId, tabId, text, composerValue, textVersion: textVersionByTab.get(tabId) ?? 0, items: queued, sent: false, status: "pending" };
    chatRequestsById.set(requestId, request);
    pendingChatByTab.set(tabId, requestId);
    renderAttachments();
    updateChatLoading(tabId);
    try {
      await Promise.all(queued.map((item) => item.promise).filter(Boolean));
      if (composerGeneration !== generation || pendingChatByTab.get(tabId) !== requestId) return; // tab switch abandons an upload still being read
      const stillAttached = queued.filter((item) => attachmentList(tabId).includes(item) && !item.released);
      if (stillAttached.some((item) => item.status !== "ready" || !item.path)) {
        showToast("Remove or retry the attachment that could not be loaded");
        settleChatRequest(request, false);
        return;
      }
      request.items = stillAttached;
      request.sent = true;
      const images = stillAttached.filter((item) => item.kind === "image").map((item) => item.path);
      const files = stillAttached.filter((item) => item.kind === "file").map((item) => item.path);
      const payload = { type: "chat", tabId, text, requestId, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), ...(confirmBusy === true ? { confirmBusy: true } : {}) };
      if (!send(payload)) { request.sent = false; settleChatRequest(request, false); return; }
    } catch (error) {
      if (pendingChatByTab.get(tabId) === requestId) settleChatRequest(request, false);
      showToast(error?.message ?? "The message could not be sent");
    } finally {
      if (currentTab()?.id === tabId) updateChatLoading(tabId);
    }
  }
  function setRailCollapsed(collapsed) {
    if (!saveClientPref("crewRailOpen", !collapsed)) return;
    railWide = !collapsed;
    $("tip").classList.remove("on");
    if (!$("setupPop").hidden) setLayer($("setupPop"), false, null, false, false);
    renderCrew();
  }

  bindEvents();
  applyTheme();
  setTimeout(showApp, 3000);
  renderCrew();
  renderSide();
  renderConn();
  connect();
})();
