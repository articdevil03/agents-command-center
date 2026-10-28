import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

// build/icon.ico is the installer and desktop icon (package.json build.icon): the approved Orbit logo, rebuilt by scripts/make-icon.mjs.

// Every entry: the directory fields agree with the PNG's own header (256 is stored as 0), the PNG is RGBA 8-bit, and its pixel data inflates to exactly height x (1 + width x 4) bytes.
function checkIco(ico: Buffer): number[] {
  assert.equal(ico.readUInt16LE(0), 0, "reserved");
  assert.equal(ico.readUInt16LE(2), 1, "type 1 is an icon");
  const count = ico.readUInt16LE(4);
  assert.ok(count >= 4, `entries: ${count}`);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i, bytes = ico.readUInt32LE(at + 8), offset = ico.readUInt32LE(at + 12);
    assert.ok(offset + bytes <= ico.length, `entry ${i} lies inside the file`);
    const png = ico.subarray(offset, offset + bytes);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `entry ${i} is a PNG`);
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    assert.equal(ico[at], width === 256 ? 0 : width, `entry ${i}: directory width matches the PNG (${width})`);
    assert.equal(ico[at + 1], height === 256 ? 0 : height, `entry ${i}: directory height matches the PNG (${height})`);
    assert.equal(width, height, `entry ${i} is square`);
    assert.deepEqual([png[24], png[25], png[28]], [8, 6, 0], `entry ${i} is 8-bit RGBA, not interlaced, so the background is transparent`);
    const idat: Buffer[] = [];
    for (let chunk = 8; chunk + 8 <= png.length;) {
      const length = png.readUInt32BE(chunk), type = png.subarray(chunk + 4, chunk + 8).toString("latin1");
      if (type === "IDAT") idat.push(png.subarray(chunk + 8, chunk + 8 + length));
      chunk += 12 + length;
    }
    assert.ok(idat.length > 0, `entry ${i} has pixel data`);
    assert.equal(inflateSync(Buffer.concat(idat)).length, height * (1 + width * 4), `entry ${i}: the pixel data inflates to a full ${width}x${height} image`);
    sizes.push(width);
  }
  return sizes;
}

test("build/icon.ico is a valid ICO with PNG entries at 16, 32, 48 and 256 px", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  assert.equal(pkg.build.win.icon, "build/icon.ico");
  const sizes = checkIco(readFileSync(join(process.cwd(), pkg.build.win.icon)));
  for (const needed of [16, 32, 48, 256]) assert.ok(sizes.includes(needed), `missing ${needed} px; has ${sizes.join(", ")}`);
});

test("the icon check goes RED on a wrong directory width, including the 256 px entry stored as 0 (controls)", () => {
  const ico = readFileSync(join(process.cwd(), "build/icon.ico"));
  const count = ico.readUInt16LE(4);
  const at = (size: number) => { for (let i = 0; i < count; i++) { const entry = 6 + 16 * i; const png = ico.readUInt32LE(entry + 12); if (ico.readUInt32BE(png + 16) === size) return entry; } throw new Error(`no ${size} px entry`); };
  assert.equal(ico[at(256)], 0, "the real file stores 256 as 0");
  const wrong256 = Buffer.from(ico); wrong256[at(256)] = 255;
  assert.throws(() => checkIco(wrong256), /directory width matches the PNG \(256\)/, "256 stored as 255 is refused");
  const zero16 = Buffer.from(ico); zero16[at(16)] = 0;
  assert.throws(() => checkIco(zero16), /directory width matches the PNG \(16\)/, "a 16 px entry stored as 0 (which means 256) is refused");
  const swapped = Buffer.from(ico); swapped[at(32)] = 48;
  assert.throws(() => checkIco(swapped), /directory width matches the PNG \(32\)/, "a wrong non-zero width is refused");
});

test("the icon check goes RED on a corrupt PNG and on a wrong directory height (controls)", () => {
  const ico = readFileSync(join(process.cwd(), "build/icon.ico"));
  const first = 6 + 16 * 0, offset = ico.readUInt32LE(first + 12), bytes = ico.readUInt32LE(first + 8);
  const zeroed = Buffer.from(ico);
  // Zero the middle of the first entry's compressed data (inside its IDAT, after the header chunk).
  zeroed.fill(0, offset + 60, offset + Math.min(bytes - 20, 200));
  // zlib's own refusal of the damaged stream, not an assertion or a bug in this file's chunk walker.
  assert.throws(() => checkIco(zeroed), { name: "Error", code: "Z_DATA_ERROR", message: /invalid code -- missing end-of-block/ }, "a zeroed pixel stream is refused");
  const wrongHeight = Buffer.from(ico);
  wrongHeight[first + 1] = wrongHeight[first + 1] === 16 ? 32 : 16;
  assert.throws(() => checkIco(wrongHeight), /directory height/, "a directory height that disagrees with the PNG is refused");
});

const OFFLINE_FLAGS = ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", "--no-default-browser-check", "--disable-features=OptimizationHints,MediaRouter", "--proxy-server=127.0.0.1:9", "--proxy-bypass-list=<-loopback>"];

// Runs the REAL scripts/make-icon.mjs with the fake Chrome, a test-owned TEMP folder and its own output file (the real build/icon.ico is never touched).
function runMakeIcon(mode: string) {
  const own = mkdtempSync(join(tmpdir(), "cc-icon-test-"));
  const temp = join(own, "tmp"), out = join(own, "out.ico"), log = join(own, "chrome.log"), pageLog = join(own, "pages.log");
  mkdirSync(temp);
  try {
    const run = spawnSync(process.execPath, ["scripts/make-icon.mjs"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, CHROME_PATH: join(process.cwd(), "test/fake-chrome.mjs"), FAKE_CHROME_MODE: mode, FAKE_CHROME_LOG: log, FAKE_CHROME_PAGE_LOG: pageLog, CC_ICON_OUT: out, TEMP: temp, TMP: temp, TMPDIR: temp },
    });
    const calls: string[][] = existsSync(log) ? readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
    const pages: Array<{ url: string; html: string | null }> = existsSync(pageLog) ? readFileSync(pageLog, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
    return { status: run.status, stderr: run.stderr, calls, pages, ico: existsSync(out) ? readFileSync(out) : null, leftovers: readdirSync(temp) };
  } finally { removeWithRetry(own); }
}

test("make-icon: every Chrome run carries every offline flag and the dead proxy, and the ICO it writes is valid", () => {
  const run = runMakeIcon("ok");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.calls.length, 7, "one Chrome run per icon size");
  for (const args of run.calls) for (const flag of OFFLINE_FLAGS) assert.ok(args.includes(flag), `Chrome was started without ${flag}: ${args.join(" ")}`);
  assert.deepEqual(checkIco(run.ico!), [16, 24, 32, 48, 64, 128, 256]);
});

test("make-icon cleans up every temp file and folder it made, on success and on a failed Chrome", () => {
  for (const [mode, message] of [["ok", null], ["nopng", /Chrome produced no PNG for 16px/], ["wrongsize", /Chrome drew 15x16 for the 16px icon/]] as const) {
    const run = runMakeIcon(mode);
    assert.deepEqual(run.leftovers, [], `${mode}: nothing is left in TEMP`);
    if (message) { assert.notEqual(run.status, 0, `${mode}: the run fails`); assert.match(run.stderr, message, `${mode}: it says why`); assert.equal(run.ico, null, `${mode}: no half-written icon`); }
    else assert.equal(run.status, 0, run.stderr);
  }
});

test("make-icon runs Chrome with networking off and a dead proxy, so nothing leaves the PC", () => {
  const script = readFileSync(join(process.cwd(), "scripts/make-icon.mjs"), "utf8");
  for (const flag of ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", "--no-default-browser-check", "--disable-features=OptimizationHints,MediaRouter", "--proxy-server=127.0.0.1:9", "--proxy-bypass-list=<-loopback>"]) assert.ok(script.includes(flag), `make-icon.mjs passes ${flag}`);
});

test("make-icon registers each temp file for cleanup before it writes it", () => {
  const script = readFileSync(join(process.cwd(), "scripts/make-icon.mjs"), "utf8");
  const registered = script.indexOf("made.push(page, png)"), written = script.indexOf("writeFileSync(page,");
  assert.ok(registered > 0 && written > 0 && registered < written, `registered at ${registered}, written at ${written}`);
});

// ---- the picture itself ----

const ORBIT = readFileSync(join(process.cwd(), "build/icon-source.svg"), "utf8");

test("make-icon: every page Chrome is asked to draw carries the Orbit mark (a blank page cannot pass)", () => {
  const run = runMakeIcon("ok");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.pages.length, 7, "one page per icon size");
  // The mark's own path, dot and gradient colours, read from the approved logo file.
  const parts = [/ d="([^"]+)"/.exec(ORBIT)?.[1], /<circle[^>]*>/.exec(ORBIT)?.[0], ...[...ORBIT.matchAll(/stop-color="(#[0-9a-f]{6})"/g)].map((m) => m[1])];
  assert.ok(parts.length === 4 && parts.every(Boolean), `found the path, the dot and two gradient colours in the logo file: ${JSON.stringify(parts)}`);
  for (const page of run.pages) {
    assert.ok(page.html, `Chrome was given a page file: ${page.url}`);
    for (const part of parts) assert.ok(page.html!.includes(part!), `the page for ${page.url} holds ${part!.slice(0, 50)}`);
  }
});

// Decodes an 8-bit RGBA PNG (no new dependency): inflate, then undo the per-row filters.
function decodePng(png: Buffer): { width: number; height: number; rgba: Buffer } {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), idat: Buffer[] = [];
  for (let chunk = 8; chunk + 8 <= png.length;) {
    const length = png.readUInt32BE(chunk);
    if (png.subarray(chunk + 4, chunk + 8).toString("latin1") === "IDAT") idat.push(png.subarray(chunk + 8, chunk + 8 + length));
    chunk += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * 4, rgba = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0, up = y ? rgba[(y - 1) * stride + x] : 0, upLeft = y && x >= 4 ? rgba[(y - 1) * stride + x - 4] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : (() => { const p = left + up - upLeft, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upLeft); return a <= b && a <= c ? left : b <= c ? up : upLeft; })();
      rgba[y * stride + x] = (row[x] + predictor) & 255;
    }
  }
  return { width, height, rgba };
}
const png256 = (ico: Buffer): Buffer => {
  for (let i = 0; i < ico.readUInt16LE(4); i++) { const at = 6 + 16 * i; if (ico[at] === 0) return ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8)); }
  throw new Error("no 256 px entry");
};
// The Orbit mark: a blue-violet ring (#a3aeff to #5a5fe0) with a yellow dot (#ffc94d) on a transparent background.
function checkMarkPixels(ico: Buffer): { opaque: number; yellow: number; blue: number } {
  const { width, height, rgba } = decodePng(png256(ico));
  assert.equal(rgba[3], 0, "the corner is transparent");
  let opaque = 0, yellow = 0, blue = 0;
  for (let i = 0; i < width * height; i++) {
    const [r, g, b, a] = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]];
    if (a < 250) continue;
    opaque++;
    if (Math.abs(r - 255) < 16 && Math.abs(g - 201) < 16 && Math.abs(b - 77) < 24) yellow++;
    if (b > 200 && r >= 80 && r <= 175 && g >= 85 && g <= 185 && b - r > 40) blue++;
  }
  assert.ok(opaque > 0.25 * width * height * 0.5, `a drawn mark, not an empty picture: ${opaque} opaque pixels`);
  assert.ok(yellow > 1500, `the yellow dot is there: ${yellow} pixels`);
  assert.ok(blue > 8000, `the blue ring is there: ${blue} pixels`);
  return { opaque, yellow, blue };
}

test("the shipped build/icon.ico holds the Orbit mark in its colours at 256 px, and a transparent icon fails the same check (control)", () => {
  const ico = readFileSync(join(process.cwd(), "build/icon.ico"));
  const found = checkMarkPixels(ico);
  console.log(`icon 256 px: ${JSON.stringify(found)}`);
  // Control: a valid ICO whose 256 px picture is fully transparent.
  const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type, "latin1"), data]); const piece = Buffer.alloc(12 + data.length); piece.writeUInt32BE(data.length, 0); body.copy(piece, 4); piece.writeUInt32BE(crc32(body), 8 + data.length); return piece; };
  const header = Buffer.alloc(13); header.writeUInt32BE(256, 0); header.writeUInt32BE(256, 4); header.set([8, 6, 0, 0, 0], 8);
  const blank = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(256 * (1 + 256 * 4)))), chunk("IEND", Buffer.alloc(0))]);
  const head = Buffer.alloc(22); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(blank.length, 14); head.writeUInt32LE(22, 18);
  const fake = Buffer.concat([head, blank]);
  assert.throws(() => checkMarkPixels(fake), /a drawn mark|yellow dot|blue ring/, "a fully transparent 256 px icon is refused");
});
