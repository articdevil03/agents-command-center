// A stand-in for headless Chrome for scripts/make-icon.mjs: records its argv (one JSON line per run in FAKE_CHROME_LOG),
// records the page it was given, makes the profile folder like Chrome does, and writes the screenshot. FAKE_CHROME_MODE: ok | nopng | wrongsize.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

const args = process.argv.slice(2);
if (process.env.FAKE_CHROME_LOG) appendFileSync(process.env.FAKE_CHROME_LOG, `${JSON.stringify(args)}\n`);
// FAKE_CHROME_PAGE_LOG: the page it was asked to draw (the last argument is its file URL), so a test can see what make-icon put on it.
if (process.env.FAKE_CHROME_PAGE_LOG) {
  const target = args.at(-1) ?? "";
  appendFileSync(process.env.FAKE_CHROME_PAGE_LOG, `${JSON.stringify({ url: target, html: target.startsWith("file:") ? readFileSync(fileURLToPath(target), "utf8") : null })}
`);
}
const flag = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const profile = flag("--user-data-dir");
if (profile) { mkdirSync(profile, { recursive: true }); writeFileSync(join(profile, "Local State"), "{}"); }
const mode = process.env.FAKE_CHROME_MODE ?? "ok";
const size = Number(flag("--window-size")?.split(",")[0]);
const shot = flag("--screenshot");

function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(height * (1 + width * 4)))), chunk("IEND", Buffer.alloc(0))]);
}
if (shot && mode === "ok") writeFileSync(shot, png(size, size));
if (shot && mode === "wrongsize") writeFileSync(shot, png(size - 1, size));
