import type { InstallTransport } from "../types.ts";

export const RELEASE_API = "https://api.github.com/repos/anomalyco/opencode/releases";
export const DOWNLOAD_LIMIT = 128 * 1024 * 1024;
export class ReleaseFailure extends Error {
  readonly transport: boolean;
  constructor(transport = false) { super("OpenCode release verification failed"); this.transport = transport; }
}
export type ReleaseAsset = { version: string; url: string; size: number; hash: string };
export function operationSignal(signal: AbortSignal, deadline: number): AbortSignal {
  signal.throwIfAborted();
  if (Date.now() >= deadline) throw new Error("Installation deadline expired");
  return AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
}
export function defaultTransport(env: NodeJS.ProcessEnv): InstallTransport {
  return (url, options) => {
    if (env.CC_TEST_FAKE_CLI === "1" || process.env.CC_TEST_FAKE_CLI === "1") throw new ReleaseFailure();
    return fetch(url, options);
  };
}
function safeAddress(url: string, asset: boolean): boolean {
  try {
    const value = new URL(url);
    return value.protocol === "https:" && !value.username && !value.password && !value.port && !value.hash &&
      (asset ? value.hostname === "github.com" && value.pathname.startsWith("/anomalyco/opencode/releases/download/") :
        value.origin + value.pathname === RELEASE_API);
  } catch { return false; }
}
export async function request(transport: InstallTransport, url: string, signal: AbortSignal): Promise<Response> {
  let response: Response;
  try { response = await transport(url, { signal, redirect: "manual", headers: { Accept: "application/vnd.github+json", "User-Agent": "Command-Center" } }); }
  catch { signal.throwIfAborted(); throw new ReleaseFailure(true); }
  // Manual redirect validation is owned here, not by the fetch implementation.
  for (let hops = 0; response.status >= 300 && response.status < 400; hops++) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (hops >= 3 || !location) throw new ReleaseFailure();
    const next = new URL(location, url);
    if (next.protocol !== "https:" || next.username || next.password || next.port || next.hash ||
      !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(next.hostname) || !safeAddress(url, true)) throw new ReleaseFailure();
    url = next.href;
    try { response = await transport(url, { signal, redirect: "manual", headers: { Accept: "application/octet-stream", "User-Agent": "Command-Center" } }); }
    catch { signal.throwIfAborted(); throw new ReleaseFailure(true); }
  }
  if (!response.ok) { await response.body?.cancel(); throw new ReleaseFailure(response.status >= 500 || response.status === 429); }
  if (!response.body) throw new ReleaseFailure();
  return response;
}
export async function selectRelease(transport: InstallTransport, signal: AbortSignal, arch: string): Promise<ReleaseAsset> {
  const name = arch === "x64" ? "opencode-windows-x64-baseline.zip" : arch === "arm64" ? "opencode-windows-arm64.zip" : null;
  if (!name) throw new ReleaseFailure();
  let total = 0, selected: any = null, complete = false;
  const tags = new Set<string>();
  for (let page = 1; page <= 50; page++) {
    signal.throwIfAborted();
    const response = await request(transport, `${RELEASE_API}?per_page=100&page=${page}`, signal);
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body!) {
      signal.throwIfAborted(); size += chunk.length; total += chunk.length;
      if (size > 16 * 1024 * 1024 || total > 64 * 1024 * 1024) { await response.body?.cancel().catch(() => {}); throw new ReleaseFailure(); }
      chunks.push(chunk);
    }
    let rows: any;
    try { rows = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ReleaseFailure(); }
    if (!Array.isArray(rows) || rows.length > 100) throw new ReleaseFailure();
    for (const row of rows) {
      if (!row || !/^v1\.\d+\.\d+$/.test(row.tag_name) || row.draft !== false || row.prerelease !== false) continue;
      if (tags.has(row.tag_name)) throw new ReleaseFailure();
      tags.add(row.tag_name);
      const parts = row.tag_name.slice(1).split(".").map(Number);
      if (!parts.every(Number.isSafeInteger)) throw new ReleaseFailure();
      if (!selected || parts[1] > selected.parts[1] || (parts[1] === selected.parts[1] && parts[2] > selected.parts[2])) selected = { row, parts };
    }
    // A full page is not proof of completion, even when its Link header is absent.
    if (rows.length < 100 && !/rel="?next"?/.test(response.headers.get("link") ?? "")) { complete = true; break; }
  }
  if (!complete || !selected || !Array.isArray(selected.row.assets)) throw new ReleaseFailure();
  const matches = selected.row.assets.filter((asset: any) => asset.name === name);
  if (matches.length !== 1) throw new ReleaseFailure();
  const asset = matches[0], version = selected.row.tag_name.slice(1);
  if (typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest) ||
    !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > DOWNLOAD_LIMIT || !safeAddress(asset.browser_download_url, true)) throw new ReleaseFailure();
  const path = new URL(asset.browser_download_url).pathname;
  if (path !== `/anomalyco/opencode/releases/download/v${version}/${name}`) throw new ReleaseFailure();
  return { version, url: asset.browser_download_url, size: asset.size, hash: asset.digest.slice(7).toLowerCase() };
}
