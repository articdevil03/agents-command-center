import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, extname, resolve, basename } from "node:path";
import { IMAGE_EXT_TO_MIME, IMAGE_MIME_TO_EXT, isSafeSeatId } from "../config.ts";
import { logsDir } from "../runner.ts";
import { isAllowedOrigin, isAllowedHost, isWithinDir, hasValidAppKey } from "../security.ts";
import { listSeatRuns, readTail, parseOutcome, HISTORY_FULL_MAX_BYTES, type HistoryEntry, type Outcome } from "../history.ts";
import { isSafeRequestId } from "../chat-store.ts";
import { pruneAvatars } from "../settings.ts";
import {
  FILE_EXTENSIONS, FILE_MAX_BYTES, IMAGE_MAX_BYTES, avatarDir, dataRoot, describeError, leaderBridge, publicDir, scratchDir, settingsService, workspaces,
} from "./state.ts";
import { inAvatars, inScratch } from "./uploads.ts";

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ...IMAGE_EXT_TO_MIME, ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const OUTCOME_PEEK_BYTES = 512;
type HistoryEntryWithOutcome = HistoryEntry & { outcome: Outcome | null };
type HistoryRun = { brief: string | null; output: string; truncated: boolean; totalBytes: number; outcome: Outcome | null };
const HISTORY_LIST_MAX = 200;
export async function listHistory(seatKey: unknown): Promise<HistoryEntryWithOutcome[]> {
  if (typeof seatKey !== "string" || !isSafeSeatId(seatKey)) throw new Error("invalid seat key");
  // The page asks after every run: only this seat's own files are listed and stat-ed, never every log of every seat.
  const files = (await readdir(logsDir)).filter((name) => name.startsWith(`${seatKey}-`));
  const stats = new Map<string, { size: number; mtimeMs: number }>();
  await Promise.all(files.filter((name) => name.endsWith(".log")).map(async (name) => {
    try { const info = await stat(join(logsDir, name)); stats.set(name, { size: info.size, mtimeMs: info.mtimeMs }); } catch { /* file was removed during listing */ }
  }));
  const entries = listSeatRuns(seatKey, files, stats).slice(0, HISTORY_LIST_MAX);
  return Promise.all(entries.map(async (entry) => {
    try { const tail = await readTail(join(logsDir, entry.logFile), OUTCOME_PEEK_BYTES); return { ...entry, outcome: parseOutcome(tail.text) }; }
    catch { return { ...entry, outcome: null }; }
  }));
}
export async function loadHistoryRun(seatKey: unknown, timestamp: unknown, full: boolean): Promise<HistoryRun> {
  if (typeof seatKey !== "string" || !isSafeSeatId(seatKey) || !Number.isSafeInteger(timestamp) || (timestamp as number) < 0) throw new Error("invalid history run");
  const logPath = resolve(logsDir, `${seatKey}-${timestamp}.log`);
  if (!isWithinDir(logPath, resolve(logsDir))) throw new Error("history path escaped logs directory");
  const maxBytes = full ? HISTORY_FULL_MAX_BYTES : undefined;
  const tail = await readTail(logPath, maxBytes);
  let brief: string | null = null;
  try {
    const path = resolve(logsDir, `${seatKey}-${timestamp}.brief.txt`);
    if (!isWithinDir(path, resolve(logsDir))) throw new Error("brief path escaped logs directory");
    brief = await readFile(path, "utf8");
  } catch { /* old logs may not have a sibling brief */ }
  return { brief, output: tail.text, truncated: tail.truncated, totalBytes: tail.totalBytes, outcome: parseOutcome(tail.text) };
}
async function serveStatic(requestPath: string): Promise<{ status: number; body: Buffer | string; type?: string }> {
  let decoded: string;
  try { decoded = decodeURIComponent(requestPath); } catch { return { status: 400, body: "bad path" }; }
  const safePath = decoded === "/" ? "/index.html" : decoded;
  const file = resolve(publicDir, `.${safePath}`);
  if (!isWithinDir(file, resolve(publicDir))) return { status: 403, body: "forbidden" };
  try { return { status: 200, body: await readFile(file), type: MIME[extname(file).toLowerCase()] ?? "application/octet-stream" }; }
  catch { return { status: 404, body: "not found" }; }
}
async function readBody(req: import("node:http").IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
export async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // A website must not frame the app (clickjacking on Allow / Bypass), and uploads must never be sniffed into something else.
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const headerRequestId = req.headers["x-request-id"];
  const uploadRequestId = typeof headerRequestId === "string" && isSafeRequestId(headerRequestId) ? headerRequestId : null;
  const uploadPath = (req.url ?? "/").split("?", 1)[0];
  const isUploadRoute = req.method === "POST" && ["/api/paste-image", "/api/avatar", "/api/paste-file"].includes(uploadPath);
  const refuseUpload = (status: number, message: string): void => {
    // A refused host or origin is not a real upload: it must not write status into state.
    if (isUploadRoute && uploadRequestId) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message, requestId: uploadRequestId }));
    } else { res.writeHead(status); res.end(message); }
  };
  if (!isAllowedHost(req.headers.host)) { refuseUpload(403, "forbidden host"); return; }
  const bridgeTab = /^\/api\/leader-mcp\/([^/]+)$/.exec(uploadPath)?.[1];
  if (bridgeTab !== undefined) {
    let tabId: string;
    try { tabId = decodeURIComponent(bridgeTab); } catch { res.writeHead(400); res.end("bad tab id"); return; }
    await leaderBridge.handle(req, res, tabId);
    return;
  }
  if (!isAllowedOrigin(req.headers.origin)) { refuseUpload(403, "forbidden origin"); return; }
  // Every write route needs the app key; only GETs (the page itself) stay open so the page can load and read its key.
  if (req.method !== "GET" && req.method !== "HEAD" && !hasValidAppKey(req.headers["x-app-key"])) { refuseUpload(403, "forbidden"); return; }
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const beginUpload = (): boolean => {
    if (!uploadRequestId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "a valid X-Request-Id header is required" }));
      return false;
    }
    settingsService.beginUpload(uploadRequestId);
    return true;
  };
  const endUpload = (status: number, message: string, value?: Record<string, unknown>): void => {
    if (uploadRequestId) settingsService.finishUpload(uploadRequestId, status >= 200 && status < 300, message);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status >= 200 && status < 300 ? { ...value, ...(uploadRequestId ? { requestId: uploadRequestId } : {}) } : { error: message, ...(uploadRequestId ? { requestId: uploadRequestId } : {}) }));
  };
  if (req.method === "POST" && url.pathname === "/api/paste-image") {
    if (!beginUpload()) return;
    const mime = req.headers["content-type"]?.split(";")[0].trim() ?? "";
    const extension = IMAGE_MIME_TO_EXT[mime as keyof typeof IMAGE_MIME_TO_EXT];
    if (!extension) { endUpload(415, "unsupported image type"); return; }
    try {
      const body = await readBody(req, IMAGE_MAX_BYTES);
      if (!body.length) { endUpload(400, "image body is empty"); return; }
      const imageDataRoot = realpathSync(dataRoot);
      const imageScratchDir = realpathSync(scratchDir);
      if (!isWithinDir(imageScratchDir, imageDataRoot)) throw new Error("scratch directory escaped data root");
      const path = join(imageScratchDir, `paste-${randomUUID()}.${extension}`);
      await writeFile(path, body, { flag: "wx" });
      endUpload(200, "Image uploaded", { path });
    } catch (err) { const message = describeError(err); endUpload(message === "request body too large" ? 413 : 400, message); }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/avatar") {
    if (!beginUpload()) return;
    const mime = req.headers["content-type"]?.split(";")[0].trim() ?? "";
    const extension = IMAGE_MIME_TO_EXT[mime as keyof typeof IMAGE_MIME_TO_EXT];
    if (!extension) { endUpload(415, "unsupported image type"); return; }
    try {
      const body = await readBody(req, IMAGE_MAX_BYTES);
      if (!body.length) { endUpload(400, "image body is empty"); return; }
      const filename = `avatar-${randomUUID()}.${extension}`;
      const avatarDataRoot = realpathSync(dataRoot);
      const realAvatarDir = realpathSync(avatarDir);
      if (!isWithinDir(realAvatarDir, avatarDataRoot)) throw new Error("avatar directory escaped data root");
      const diskPath = join(realAvatarDir, filename);
      await writeFile(diskPath, body, { flag: "wx" });
      // Seat pictures are the only references (settings keep none); pictures no seat uses any more are deleted, exact files only.
      pruneAvatars(realAvatarDir, workspaces.projects.flatMap((project) => project.tabs.flatMap((tab) => tab.crew.flatMap((seat) => seat.pic ? [seat.pic] : []))), filename);
      endUpload(200, "Avatar uploaded", { path: `/api/avatar/${filename}` });
    } catch (err) { const message = describeError(err); endUpload(message === "request body too large" ? 413 : 400, message); }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/paste-file") {
    if (!beginUpload()) return;
    const rawName = req.headers["x-file-name"];
    let filename = "";
    try { filename = typeof rawName === "string" ? decodeURIComponent(rawName) : ""; } catch { /* invalid encoding is refused below */ }
    const extension = extname(filename).toLowerCase();
    if (!filename || filename.length > 255 || filename !== basename(filename) || /[\\/\u0000-\u001f\u007f]/.test(filename) || filename.split(/[\\/]+/).includes("..") || !FILE_EXTENSIONS.has(extension)) {
      endUpload(415, "unsupported or unsafe file name"); return;
    }
    try {
      const body = await readBody(req, FILE_MAX_BYTES);
      if (!body.length) { endUpload(400, "file body is empty"); return; }
      const storedName = `file-${randomUUID()}${extension}`;
      const fileDataRoot = realpathSync(dataRoot);
      const fileScratchDir = realpathSync(scratchDir);
      if (!isWithinDir(fileScratchDir, fileDataRoot)) throw new Error("scratch directory escaped data root");
      const path = join(fileScratchDir, storedName);
      await writeFile(path, body, { flag: "wx" });
      endUpload(200, "File uploaded", { path, name: filename });
    } catch (err) { const message = describeError(err); endUpload(message === "request body too large" ? 413 : 400, message); }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/paste-image") {
    const requested = url.searchParams.get("path");
    if (!requested) { res.writeHead(400); res.end("missing image path"); return; }
    const file = resolve(requested); const extension = extname(file).toLowerCase();
    if (!inScratch(file) || !/^paste-[0-9a-f-]+\.(?:png|jpg|webp)$/i.test(basename(file)) || !IMAGE_EXT_TO_MIME[extension]) {
      res.writeHead(403); res.end("forbidden image path"); return;
    }
    try {
      const canonical = realpathSync(file);
      if (!inScratch(canonical)) { res.writeHead(403); res.end("forbidden image path"); return; }
      const image = await readFile(canonical);
      res.writeHead(200, { "Content-Type": IMAGE_EXT_TO_MIME[extension], "Cache-Control": "no-store" }); res.end(image);
    } catch {
      if (!res.headersSent) { res.writeHead(404); res.end("not found"); }
    }
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/avatar/")) {
    let filename: string;
    try { filename = decodeURIComponent(url.pathname.slice("/api/avatar/".length)); } catch { res.writeHead(400); res.end("bad avatar path"); return; }
    const file = resolve(avatarDir, filename);
    const extension = extname(file).toLowerCase();
    if (filename !== basename(filename) || !/^avatar-[0-9a-f-]{36}\.(?:png|jpg|webp)$/i.test(filename) || !inAvatars(file) || !IMAGE_EXT_TO_MIME[extension]) {
      res.writeHead(403); res.end("forbidden avatar path"); return;
    }
    try {
      const canonical = realpathSync(file);
      if (!inAvatars(canonical)) { res.writeHead(403); res.end("forbidden avatar path"); return; }
      const avatar = await readFile(canonical);
      res.writeHead(200, { "Content-Type": IMAGE_EXT_TO_MIME[extension], "Cache-Control": "no-store" }); res.end(avatar);
    } catch { res.writeHead(404); res.end("not found"); }
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end("method not allowed"); return; }
  const result = await serveStatic(url.pathname);
  res.writeHead(result.status, result.type ? { "Content-Type": result.type } : undefined);
  res.end(req.method === "HEAD" ? undefined : result.body);
}
