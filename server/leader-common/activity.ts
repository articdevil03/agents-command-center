// ---- What the leader is doing, in plain words. A label comes from the KIND of step (this table) and never from its input or output:
// a command, a search, a path or a file's text can hold a secret. The one exception is a Claude Skill's name (an identifier), cleaned below. ----
export const ACTIVITY = { command: "Running a command", read: "Reading a file", search: "Searching files", edit: "Editing files", web: "Searching the web", page: "Reading a web page", plan: "Planning", think: "Thinking", tool: "Using a tool", skill: "Using a skill" } as const;
export type ActivityStep = { label: string; helper: boolean };
// The crew tools already show as crew runs in the side panel: no step line for them. Same name as OPENCODE_CREW_SERVER and the Claude mcpServers key.
const CREW_SERVER = "tab-crew";
// One table for all three CLIs' tool names (Claude: Bash, WebSearch, Task...; OpenCode: bash, websearch, task...). null = a crew tool, to be skipped.
export function toolActivity(name: unknown): ActivityStep | null {
  const raw = typeof name === "string" ? name : "";
  if (raw.startsWith(`mcp__${CREW_SERVER}__`) || raw.startsWith(`${CREW_SERVER}_`)) return null;
  const step = (label: string, helper = false): ActivityStep => ({ label, helper });
  switch (raw.toLowerCase().replace(/[^a-z0-9]/g, "")) {
    case "bash": case "powershell": case "bashoutput": case "killshell": case "killbash": case "shell": return step(ACTIVITY.command);
    case "read": case "notebookread": return step(ACTIVITY.read);
    case "glob": case "grep": case "ls": case "list": case "search": case "codesearch": return step(ACTIVITY.search);
    case "write": case "edit": case "multiedit": case "notebookedit": case "patch": case "applypatch": return step(ACTIVITY.edit);
    case "websearch": return step(ACTIVITY.web);
    case "webfetch": case "fetch": return step(ACTIVITY.page);
    case "task": case "agent": return step("helper", true);
    case "todowrite": case "todoread": case "exitplanmode": case "enterplanmode": return step(ACTIVITY.plan);
    case "skill": return step(ACTIVITY.skill);
    default: return step(ACTIVITY.tool);
  }
}
export const cleanSkillName = (value: unknown): string | null => String(value ?? "").replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 40) || null;
// The steps running now, one label out: the newest step, or "N helpers working" when that is a helper. Nothing running = Thinking. Only a change is passed on.
// quiet: the answer itself is being written, nothing else to say while no step runs.
export type ActivityTracker = { start: (id: string, step: ActivityStep | null) => void; end: (id: string) => void; thinking: () => void; quiet: () => void; reset: () => void };
export function createActivityTracker(emit: (label: string | null) => void): ActivityTracker {
  const running = new Map<string, ActivityStep>();
  let shown: string | undefined;
  const show = (): void => {
    const steps = [...running.values()], last = steps.at(-1), helpers = steps.filter((item) => item.helper).length;
    const label = !last ? ACTIVITY.think : last.helper ? `${helpers} helper${helpers === 1 ? "" : "s"} working` : last.label;
    if (label !== shown) { shown = label; emit(label); }
  };
  return {
    start(id, step) { if (step) { running.set(id, step); show(); } },
    end(id) { if (running.delete(id)) show(); },
    thinking() { if (!running.size) show(); },
    quiet() { if (!running.size && shown !== null) { shown = null; emit(null); } },
    reset() { running.clear(); shown = undefined; },
  };
}

// Separate messages of one reply must not glue together ("one scene.Codex is drawing"): the first text of a new message / item / part, after text already said in this
// reply, starts on a new paragraph, unless the text so far already ends with a newline. The key names the message the text belongs to. The first text of a reply gets nothing.
export type Paragraphs = { text: (text: string, messageKey: string | number) => string; reset: () => void };
export function createParagraphs(): Paragraphs {
  let said = false, tail = "", lastKey: string | number | undefined;
  return {
    text(text, messageKey) {
      const fresh = messageKey !== lastKey;
      lastKey = messageKey;
      if (!text) return text;
      const out = fresh && said && !tail.endsWith("\n") ? `\n\n${text}` : text;
      said = true; tail = (tail + out).slice(-2);
      return out;
    },
    reset() { said = false; tail = ""; lastKey = undefined; },
  };
}

// A background job's description is written by the model: control characters out, 80 characters at most.
export const cleanJobDescription = (value: unknown): string => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "a background command";
