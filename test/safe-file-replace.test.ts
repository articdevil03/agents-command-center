import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = fileURLToPath(new URL("../server/", import.meta.url));

test("publishConfigFile replaces a file 200 times while another process reads it", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cc-replace-")), target = join(root, "target.json");
  const previous = { CC_DATA_DIR: process.env.CC_DATA_DIR, CC_TEST_FORCE_PACKAGED: process.env.CC_TEST_FORCE_PACKAGED };
  process.env.CC_DATA_DIR = root; process.env.CC_TEST_FORCE_PACKAGED = "1";
  let reader: ReturnType<typeof spawn> | undefined;
  try {
    const { publishConfigFile } = await import("../server/config-files.ts");
    writeFileSync(target, "initial");
    // Tight read bursts release the file between bursts: the retry handles temporary readers, not a permanent lock.
    reader = spawn(process.execPath, ["--input-type=commonjs", "-e", `
      const { openSync, readSync, closeSync } = require("node:fs");
      const buffer = Buffer.alloc(128);
      let reads = 0, stopped = false;
      process.on("message", () => { stopped = true; process.send({ reads }, () => process.exit(0)); });
      function read() {
        const end = Date.now() + 100;
        do {
          const fd = openSync(process.argv[1], "r");
          try { readSync(fd, buffer); reads++; } finally { closeSync(fd); }
          if (reads === 1) process.send({ ready: true, reads });
        } while (Date.now() < end);
        if (!stopped) setTimeout(read, 100);
      }
      read();
    `, target], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    reader.stderr!.on("data", (chunk) => console.error(String(chunk)));
    const exited = once(reader, "exit");
    await new Promise<void>((ok, no) => {
      const timer = setTimeout(() => no(new Error("reader never became ready")), 10_000);
      reader!.once("message", () => { clearTimeout(timer); ok(); });
      reader!.once("error", no);
      reader!.once("exit", () => { clearTimeout(timer); no(new Error("reader exited before ready")); });
    });
    let writes = 0;
    try { for (; writes < 200; writes++) publishConfigFile(`contents-${writes}`, target, true); }
    finally { console.log(`writes=${writes}`); }
    const counted = once(reader, "message");
    reader.send("stop");
    const [message] = await counted as [{ reads: number }];
    await exited;
    console.log(`writes=${writes} reads=${message.reads}`);
    assert.ok(message.reads > 1, `reader must keep reading during writes: ${message.reads}`);
    assert.equal(writes, 200);
    assert.equal(readFileSync(target, "utf8"), "contents-199");
  } finally {
    if (reader && reader.exitCode === null && reader.signalCode === null) { const exited = once(reader, "exit"); reader.kill(); await exited; }
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    try { unlinkSync(target); } finally { rmdirSync(root); }
  }
});

test("all server rename-over-file saves use replaceFile", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
    }
  };
  walk(serverDir);
  console.log(`scanned ${files.length} server TypeScript files`);
  assert.ok(files.length > 50, `server scan found only ${files.length} files`);
  const calls = files.filter((path) => /\brenameSync\s*\(/.test(readFileSync(path, "utf8"))).map((path) => relative(serverDir, path));
  assert.deepEqual(calls, ["safe-file.ts"], `renameSync callers: ${calls.join(", ")}`);
});

