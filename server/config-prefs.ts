import { readFileSync } from "node:fs";
import { isSafeSeatId } from "./process.ts";
import { launchSafetyPath, clientPrefsPath, publishConfigFile, liveWritePath, isObject, LEGACY_LEADER } from "./config-files.ts";

export type LaunchNotice = { type: "leaderLaunch"; id: number; seatId: string; seatName: string; brief: string; source: string; pending?: boolean; headsUp?: string };
// The launch budget is counted per tab. A plain number is from before that (it names no tab): it still loads, and the server drops it at start (it can be charged to no tab; the cost is at most one budget of free launches, once).
export type LaunchStamp = { tabId: string; at: number };
export type LaunchSafety = {
  blocked: string[];
  timestamps: (LaunchStamp | number)[];
  notices: LaunchNotice[];
  nextNoticeId: number;
  released: { seatId: string; pid: number; runId?: string }[];
  uncertain: { seatId: string; pid: number; runId?: string }[];
  // Runs started and not yet seen to end. After a hard crash these are what nobody tracks any more: the next start blocks their seats.
  live: { seatId: string; runId: string }[];
};
export function readLaunchSafety(path: string = launchSafetyPath): LaunchSafety {
  let raw: any;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { blocked: [], timestamps: [], notices: [], nextNoticeId: 1, released: [], uncertain: [], live: [] };
    throw new Error(`launch safety file is unreadable: ${path} (${(err as Error).message}); fix or delete it`, { cause: err });
  }
  // A file from an older version lacks the newer lists: those start empty. A list that is there but damaged is still refused.
  // Its notices may carry the leader's earlier message type; they are read as the current one.
  if (raw && Array.isArray(raw.notices)) for (const n of raw.notices) if (n && n.type === `${LEGACY_LEADER}Launch`) n.type = "leaderLaunch";
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const key of ["timestamps", "notices", "released", "uncertain", "live"]) if (raw[key] === undefined) raw[key] = [];
    if (raw.nextNoticeId === undefined && Array.isArray(raw.notices)) raw.nextNoticeId = 1 + Math.max(0, ...raw.notices.map((n: any) => (Number.isSafeInteger(n?.id) ? n.id : 0)));
  }
  const validPidRows = (rows: any) => Array.isArray(rows) && rows.every((item: any) => item && typeof item.seatId === "string" && isSafeSeatId(item.seatId) && Number.isSafeInteger(item.pid) && item.pid > 0 && (item.runId === undefined || (typeof item.runId === "string" && isSafeSeatId(item.runId))));
  if (!raw || !Array.isArray(raw.blocked) || !raw.blocked.every((id: unknown) => typeof id === "string" && isSafeSeatId(id))
    || !Array.isArray(raw.timestamps) || !raw.timestamps.every((n: any) => (typeof n === "number" && Number.isFinite(n) && n >= 0) || (n && typeof n.tabId === "string" && n.tabId.length > 0 && typeof n.at === "number" && Number.isFinite(n.at) && n.at >= 0))
    || !Number.isSafeInteger(raw.nextNoticeId) || raw.nextNoticeId < 1
    || !Array.isArray(raw.notices) || !raw.notices.every((n: LaunchNotice) => n && n.type === "leaderLaunch" && Number.isSafeInteger(n.id) && n.id > 0 && n.id < raw.nextNoticeId && typeof n.seatId === "string" && isSafeSeatId(n.seatId) && typeof n.seatName === "string" && typeof n.brief === "string" && typeof n.source === "string")
    || !validPidRows(raw.released)) throw new Error(`invalid launch safety state in ${path}; refusing to reset the brakes (fix or delete the file to start with none)`);
  if (!validPidRows(raw.uncertain)) throw new Error(`invalid unconfirmed process state in ${path}`);
  if (!Array.isArray(raw.live) || !raw.live.every((item: any) => item && typeof item.seatId === "string" && isSafeSeatId(item.seatId) && typeof item.runId === "string" && isSafeSeatId(item.runId))) throw new Error(`invalid running-process state in ${path}`);
  return raw;
}
export function writeLaunchSafety(state: LaunchSafety, path?: string): void { publishConfigFile(JSON.stringify(state, null, 2) + "\n", liveWritePath(path, launchSafetyPath), true); }

export type ClientPrefs = {
  sidebarCollapsed: boolean; notificationsEnabled: boolean; bellEnabled: boolean; bellVolume: number; previewUrl: string;
  rightPanelCollapsed: boolean; rightPanelWidth: number;
  theme: "light" | "dark" | "system"; avatar: string; dismissedRuns: string[];
  crewRailOpen: boolean; detailsOpen: boolean;
};
export const DEFAULT_CLIENT_PREFS: ClientPrefs = {
  sidebarCollapsed: false, notificationsEnabled: true, bellEnabled: false, bellVolume: 100, previewUrl: "http://localhost:8081",
  rightPanelCollapsed: false, rightPanelWidth: 320,
  theme: "light", avatar: "ash.svg", dismissedRuns: [],
  crewRailOpen: true, detailsOpen: false,
};
// The app window opens on a new random port every launch, so the page cannot keep these in its own localStorage (a new port
// is a new, empty one): the server keeps them, including whether the crew rail and the details panel are open. An uploaded picture is a data URL that rides in every state message, so it is
// capped at 512 KiB (the picture dialog says so too); a preset is a short name.
export const AVATAR_MAX_CHARS = 512 * 1024;
// A tab keeps 50 finished runs (MAX_FINISHED_RUNS), so this holds every dismissal of 40 tabs; the page trims to the same number (DISMISSED_RUNS_MAX, public/app/01-markdown-state.js).
export const DISMISSED_RUNS_MAX = 2000;
function isTheme(value: unknown): value is ClientPrefs["theme"] { return value === "light" || value === "dark" || value === "system"; }
// The completion sound's volume, a whole percent: 0 is silent, 100 is the bell at full level.
function isBellVolume(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100; }
function isAvatar(value: unknown): value is string {
  return typeof value === "string" && (/^[a-z]+\.svg$/.test(value) || (/^data:image\//.test(value) && value.length <= AVATAR_MAX_CHARS));
}
function isDismissedRuns(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= DISMISSED_RUNS_MAX && value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200);
}
function isValidPreviewUrlValue(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  try { const parsed = new URL(value.trim()); return parsed.protocol === "http:" || parsed.protocol === "https:"; }
  catch { return false; }
}
export function readClientPrefs(path: string = clientPrefsPath): ClientPrefs {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { return { ...DEFAULT_CLIENT_PREFS }; }
  if (!isObject(raw)) return { ...DEFAULT_CLIENT_PREFS };
  if (raw.avatar === `${LEGACY_LEADER}.svg`) raw.avatar = "atlas.svg"; // the leader's earlier preset name
  return {
    sidebarCollapsed: typeof raw.sidebarCollapsed === "boolean" ? raw.sidebarCollapsed : DEFAULT_CLIENT_PREFS.sidebarCollapsed,
    notificationsEnabled: typeof raw.notificationsEnabled === "boolean" ? raw.notificationsEnabled : DEFAULT_CLIENT_PREFS.notificationsEnabled,
    // The completion sound is its own switch (the top bar's sound button): it plays with desktop notices on or off.
    bellEnabled: typeof raw.bellEnabled === "boolean" ? raw.bellEnabled : DEFAULT_CLIENT_PREFS.bellEnabled,
    bellVolume: isBellVolume(raw.bellVolume) ? raw.bellVolume : DEFAULT_CLIENT_PREFS.bellVolume,
    previewUrl: isValidPreviewUrlValue(raw.previewUrl) ? raw.previewUrl : DEFAULT_CLIENT_PREFS.previewUrl,
    rightPanelCollapsed: typeof raw.rightPanelCollapsed === "boolean" ? raw.rightPanelCollapsed : DEFAULT_CLIENT_PREFS.rightPanelCollapsed,
    rightPanelWidth: typeof raw.rightPanelWidth === "number" && Number.isFinite(raw.rightPanelWidth) && raw.rightPanelWidth > 0 ? raw.rightPanelWidth : DEFAULT_CLIENT_PREFS.rightPanelWidth,
    theme: isTheme(raw.theme) ? raw.theme : DEFAULT_CLIENT_PREFS.theme,
    avatar: isAvatar(raw.avatar) ? raw.avatar : DEFAULT_CLIENT_PREFS.avatar,
    dismissedRuns: isDismissedRuns(raw.dismissedRuns) ? [...raw.dismissedRuns] : [],
    crewRailOpen: typeof raw.crewRailOpen === "boolean" ? raw.crewRailOpen : DEFAULT_CLIENT_PREFS.crewRailOpen,
    detailsOpen: typeof raw.detailsOpen === "boolean" ? raw.detailsOpen : DEFAULT_CLIENT_PREFS.detailsOpen,
  };
}
export function writeClientPrefs(prefs: ClientPrefs, path?: string, onlyIfMissing = false): boolean {
  return publishConfigFile(JSON.stringify(prefs, null, 2) + "\n", liveWritePath(path, clientPrefsPath), !onlyIfMissing);
}
export function applyClientPrefUpdate(prefs: ClientPrefs, key: unknown, value: unknown): { ok: true; prefs: ClientPrefs } | { ok: false; error: string } {
  if (key === "sidebarCollapsed" || key === "rightPanelCollapsed" || key === "notificationsEnabled" || key === "bellEnabled" || key === "crewRailOpen" || key === "detailsOpen") {
    if (typeof value !== "boolean") return { ok: false, error: `invalid value for client pref "${key}": expected boolean` };
    return { ok: true, prefs: { ...prefs, [key]: value } };
  }
  if (key === "rightPanelWidth") {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return { ok: false, error: `invalid value for client pref "${key}": expected a positive number` };
    return { ok: true, prefs: { ...prefs, rightPanelWidth: value } };
  }
  if (key === "bellVolume") {
    if (!isBellVolume(value)) return { ok: false, error: 'invalid value for client pref "bellVolume": expected a whole number from 0 to 100' };
    return { ok: true, prefs: { ...prefs, bellVolume: value } };
  }
  if (key === "theme") {
    if (!isTheme(value)) return { ok: false, error: 'invalid value for client pref "theme": expected light, dark or system' };
    return { ok: true, prefs: { ...prefs, theme: value } };
  }
  if (key === "avatar") {
    if (!isAvatar(value)) return { ok: false, error: typeof value === "string" && value.startsWith("data:image/") ? `That picture is too large to keep (limit ${AVATAR_MAX_CHARS / 1024} KB). Pick a smaller one.` : 'invalid value for client pref "avatar": expected a preset name or an image' };
    return { ok: true, prefs: { ...prefs, avatar: value } };
  }
  if (key === "dismissedRuns") {
    if (!isDismissedRuns(value)) return { ok: false, error: `invalid value for client pref "dismissedRuns": expected up to ${DISMISSED_RUNS_MAX} run ids` };
    return { ok: true, prefs: { ...prefs, dismissedRuns: [...value] } };
  }
  if (key === "previewUrl") {
    if (!isValidPreviewUrlValue(value)) return { ok: false, error: "invalid value for client pref \"previewUrl\": expected an http(s) URL" };
    return { ok: true, prefs: { ...prefs, previewUrl: value } };
  }
  return { ok: false, error: `unknown client pref: ${String(key)}` };
}
