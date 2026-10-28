// Builds build/icon.ico from the approved Orbit logo (build/icon-source.svg).
// Chrome renders each size on a transparent page; the ICO container (PNG entries) is written here, no dependency.
// Usage: node scripts/make-icon.mjs [previewDir]   (previewDir gets the 256 and 32 px PNGs)
// CC_ICON_OUT overrides the output path and CHROME_PATH may be a .js/.mjs file run by Node: both exist so the test can run this script with a fake Chrome.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}; set CHROME_PATH`);

// The mark spans x/y 7..57 of the 64 box; this crop fills the canvas and keeps the round caps whole.
// Nothing leaves the PC: no background requests, updates or sync, and a dead proxy for anything that is not loopback (the page is a file URL).
const OFFLINE = ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", "--no-default-browser-check", "--disable-features=OptimizationHints,MediaRouter", "--proxy-server=127.0.0.1:9", "--proxy-bypass-list=<-loopback>"];
const [launcher, launcherArgs] = /\.[cm]?js$/.test(chrome) ? [process.execPath, [chrome]] : [chrome, []];
const out = process.env.CC_ICON_OUT ?? join(root, "build/icon.ico");
const svg = readFileSync(join(root, "build/icon-source.svg"), "utf8").replace('viewBox="0 0 64 64"', 'viewBox="5 5 54 54" width="100%" height="100%"');
const temp = mkdtempSync(join(tmpdir(), "cc-icon-"));
const made = [];
try {
  const entries = [];
  for (const size of SIZES) {
    const page = join(temp, `p${size}.html`), png = join(temp, `p${size}.png`);
    // Registered before they are written: a failed or partial write is still cleaned up below.
    made.push(page, png);
    writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    const run = spawnSync(launcher, [...launcherArgs, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--default-background-color=00000000", ...OFFLINE, `--window-size=${size},${size}`, `--screenshot=${png}`, `--user-data-dir=${join(temp, "profile")}`, pathToFileURL(page).href], { stdio: "ignore", timeout: 60_000 });
    if (!existsSync(png)) throw new Error(`Chrome produced no PNG for ${size}px (exit ${run.status})`);
    const data = readFileSync(png);
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
    if (width !== size || height !== size) throw new Error(`Chrome drew ${width}x${height} for the ${size}px icon; the window is clamped`);
    entries.push({ size, data });
  }
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = entries.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size; entry[1] = size === 256 ? 0 : size; // 0 means 256
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(data.length, 8); entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  writeFileSync(out, Buffer.concat([head, ...dir, ...entries.map((entry) => entry.data)]));
  const preview = process.argv[2];
  if (preview) { mkdirSync(preview, { recursive: true }); for (const size of [256, 32]) copyFileSync(join(temp, `p${size}.png`), join(preview, `icon-${size}.png`)); }
  console.log(`${out} written: ${SIZES.join(", ")} px`);
} finally {
  // exact files, then the profile Chrome made, then the empty temp folder
  for (const file of made) rmSync(file, { force: true });
  rmSync(join(temp, "profile"), { recursive: true, force: true });
  try { rmdirSync(temp); } catch { /* not empty: leave it visible */ }
}
