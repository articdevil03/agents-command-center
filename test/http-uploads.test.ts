import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { BASE_ORIGIN, serverStderr, removeTree, root, request, openWs, nextMessages } from "./http-helpers.ts";

test("GET /api/avatar still serves a historical image from avatars, and POST /api/avatar is retired and writes nothing", async () => {
  const image = Buffer.from("historical avatar bytes");
  const filename = "avatar-00000000-0000-4000-8000-000000000002.png";
  const avatarsDir = join(root, "data", "avatars");
  const historical = join(avatarsDir, filename);
  mkdirSync(avatarsDir, { recursive: true });
  writeFileSync(historical, image);
  try {
    const served = await request({ path: `/api/avatar/${filename}`, headers: { Origin: BASE_ORIGIN } });
    assert.equal(served.status, 200);
    assert.equal(served.body, image.toString());
    const traversal = await request({ path: "/api/avatar/..%2fserver%2findex.ts", headers: { Origin: BASE_ORIGIN } });
    assert.equal(traversal.status, 403);
    writeFileSync(join(root, "outside.png"), "outside avatar target");
    const imageTraversal = await request({ path: "/api/avatar/..%2foutside.png", headers: { Origin: BASE_ORIGIN } });
    assert.equal(imageTraversal.status, 403, "an allowed image extension outside avatars is still refused");

    const avatarsBefore = readdirSync(avatarsDir).sort(), scratchBefore = readdirSync(join(root, "data", "scratch")).sort();
    const retired = await request({ method: "POST", path: "/api/avatar", headers: {
      Origin: BASE_ORIGIN, "Content-Type": "image/png", "X-Request-Id": "avatar_retired_post",
    }, body: Buffer.from("new avatar bytes") });
    assert.equal(retired.status, 405, `the retired route is refused: ${retired.body}`);
    assert.deepEqual(readdirSync(avatarsDir).sort(), avatarsBefore, "the retired route writes nothing to avatars");
    assert.deepEqual(readdirSync(join(root, "data", "scratch")).sort(), scratchBefore, "the retired route writes nothing to scratch");
    assert.deepEqual(readFileSync(historical), image, "the historical image is unchanged");
    const ws = await openWs();
    try {
      const initial = nextMessages(ws, 2);
      ws.send(JSON.stringify({ type: "hello" }));
      const [state] = await initial;
      assert.equal(state.settings.uploads.avatar_retired_post, undefined, "the retired route records no upload status");
    } finally { ws.close(); }
  } finally { rmSync(historical, { force: true }); }
});

test("a vendored .woff2 font is served as font/woff2", async () => {
  const font = await request({ path: "/fonts/geist-latin-400-normal.woff2", headers: { Origin: BASE_ORIGIN } });
  assert.equal(font.status, 200);
  assert.match(font.contentType, /^font\/woff2/);
});

test("GET /api/avatar refuses a generated route redirected outside avatars by a directory junction", async () => {
  const avatarDir = join(root, "data", "avatars");
  const outside = join(root, "outside-avatars");
  const filename = "avatar-00000000-0000-4000-8000-000000000001.png";
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, filename), "outside avatar");
  removeTree(avatarDir);
  symlinkSync(outside, avatarDir, "junction");
  try {
    const response = await request({ path: `/api/avatar/${filename}`, headers: { Origin: BASE_ORIGIN } });
    assert.equal(response.status, 403);
    assert.equal(response.body, "forbidden avatar path");
  } finally {
    removeTree(avatarDir);
    mkdirSync(avatarDir, { recursive: true });
  }
});

test("POST uploads refuse a scratch directory junctioned outside the data root", async () => {
  const dataDir = join(root, "data");
  const outsideRoot = mkdtempSync(join(tmpdir(), "cc-http-outside-"));
  try {
  const outsideForImage = join(outsideRoot, "outside-image-upload");
  const outsideForFile = join(outsideRoot, "outside-file-upload");
  const withJunction = async (storage: string, outside: string, requestUpload: () => Promise<{ status: number }>) => {
    mkdirSync(outside, { recursive: true });
    removeTree(storage);
    symlinkSync(outside, storage, "junction");
    try {
      const response = await requestUpload();
      return { response, outsideFiles: readdirSync(outside) };
    } finally {
      removeTree(storage);
      mkdirSync(storage, { recursive: true });
    }
  };

  const image = await withJunction(join(dataDir, "scratch"), outsideForImage, () =>
    request({ method: "POST", path: "/api/paste-image", headers: {
      Origin: BASE_ORIGIN, "Content-Type": "image/png", "X-Request-Id": "junction_image_upload",
    }, body: "outside image" }));
  assert.ok(image.response.status >= 400 && image.response.status < 500, `paste-image refused junction target, received ${image.response.status}`);
  assert.deepEqual(image.outsideFiles, [], "paste-image must not write through scratch junction");

  const file = await withJunction(join(dataDir, "scratch"), outsideForFile, () =>
    request({ method: "POST", path: "/api/paste-file", headers: {
      Origin: BASE_ORIGIN, "Content-Type": "text/plain", "X-File-Name": "source.txt", "X-Request-Id": "junction_file_upload",
    }, body: "outside file" }));
  assert.ok(file.response.status >= 400 && file.response.status < 500, `paste-file refused junction target, received ${file.response.status}`);
  assert.deepEqual(file.outsideFiles, [], "paste-file must not write through scratch junction");
  } finally { removeWithRetry(outsideRoot); }
});

test("POST /api/paste-file enforces id, extension, name traversal and size, then stores generated files in scratch", async () => {
  const contents = Buffer.from("export const ok = true;\n");
  const uploaded = await request({ method: "POST", path: "/api/paste-file", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "text/plain", "X-File-Name": "source.ts", "X-Request-Id": "file_upload_1",
  }, body: contents });
  assert.equal(uploaded.status, 200);
  const result = JSON.parse(uploaded.body);
  assert.deepEqual([result.name, result.requestId], ["source.ts", "file_upload_1"]);
  assert.equal(dirname(result.path), join(root, "data", "scratch"));
  assert.equal(readFileSync(result.path).toString(), contents.toString());

  const traversal = await request({ method: "POST", path: "/api/paste-file", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "text/plain", "X-File-Name": "%2E%2E%2Fprivate.txt", "X-Request-Id": "file_traversal",
  }, body: "private" });
  assert.equal(traversal.status, 415);
  assert.equal(JSON.parse(traversal.body).requestId, "file_traversal");
  const unsafeExtension = await request({ method: "POST", path: "/api/paste-file", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "text/plain", "X-File-Name": "payload.exe", "X-Request-Id": "file_bad_extension",
  }, body: "unsafe" });
  assert.equal(unsafeExtension.status, 415);
  assert.equal(JSON.parse(unsafeExtension.body).requestId, "file_bad_extension");
  const missingId = await request({ method: "POST", path: "/api/paste-file", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "text/plain", "X-File-Name": "source.txt",
  }, body: "no id" });
  assert.equal(missingId.status, 400);
  assert.deepEqual(JSON.parse(missingId.body), { error: "a valid X-Request-Id header is required" });

  const oversize = await request({ method: "POST", path: "/api/paste-file", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "text/plain", "X-File-Name": "large.txt", "X-Request-Id": "file_too_large",
  }, body: Buffer.alloc(20 * 1024 * 1024 + 1, 0x78), deadlineMs: 15_000 });
  assert.equal(oversize.status, 413);
  assert.equal(JSON.parse(oversize.body).requestId, "file_too_large");
});

test("GET /api/paste-image returns an uploaded image and rejects paths outside scratch", async () => {
  const uploaded = await request({ method: "POST", path: "/api/paste-image",
    headers: { Origin: BASE_ORIGIN, "Content-Type": "image/png", "X-Request-Id": "upload_transcript" }, body: "transcript image" });
  assert.equal(uploaded.status, 200);
  const saved = JSON.parse(uploaded.body).path;
  const image = await request({ path: `/api/paste-image?path=${encodeURIComponent(saved)}`, headers: { Origin: BASE_ORIGIN } });
  assert.equal(image.status, 200, `generated scratch image path matched ${saved}`);
  assert.equal(image.body, "transcript image", "GET returned the exact uploaded bytes");
  const outside = await request({ path: `/api/paste-image?path=${encodeURIComponent(join(root, "outside.png"))}`, headers: { Origin: BASE_ORIGIN } });
  assert.equal(outside.status, 403, `outside path was rejected: ${outside.status}`);
});

test("GET missing transcript image ends with 404 without an unhandled rejection or broadcast", async () => {
  const ws = await openWs();
  const broadcasts: any[] = [];
  const beforeStderr = serverStderr.length;
  ws.on("message", (data) => broadcasts.push(JSON.parse(data.toString())));
  try {
    const missing = join(root, "data", "scratch", "paste-abcdef01-2345-6789-abcd-0123456789ab.png");
    const response = await request({ path: `/api/paste-image?path=${encodeURIComponent(missing)}`, headers: { Origin: BASE_ORIGIN } });
    assert.equal(response.status, 404);
    assert.equal(response.body, "not found");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.deepEqual(broadcasts, [], `missing image must not broadcast: ${JSON.stringify(broadcasts)}`);
    assert.doesNotMatch(serverStderr.slice(beforeStderr), /unhandled|rejection/i, "missing image must not cause an unhandled rejection");
  } finally { ws.close(); }
});

test("POST /api/paste-image refuses a non-image content type and stores nothing", async () => {
  const scratch = join(root, "data", "scratch");
  const before = readdirSync(scratch).length;
  for (const type of ["text/plain", "application/octet-stream", "image/svg+xml", ""]) {
    const refused = await request({ method: "POST", path: "/api/paste-image", headers: {
      Origin: BASE_ORIGIN, "Content-Type": type, "X-Request-Id": "image_bad_type",
    }, body: Buffer.from("not an image") });
    assert.equal(refused.status, 415, `content type "${type}"`);
    assert.deepEqual(JSON.parse(refused.body), { error: "unsupported image type", requestId: "image_bad_type" });
  }
  assert.equal(readdirSync(scratch).length, before);
});

test("POST /api/paste-image refuses an oversized body (413) and keeps its request id", async () => {
  const oversized = await request({ method: "POST", path: "/api/paste-image", headers: {
    Origin: BASE_ORIGIN, "Content-Type": "image/png", "X-Request-Id": "image_too_large",
  }, body: Buffer.alloc(12 * 1024 * 1024 + 1, 0x78), deadlineMs: 15_000 });
  assert.equal(oversized.status, 413);
  assert.equal(JSON.parse(oversized.body).requestId, "image_too_large");
});

test("uploads refused for a bad Host or Origin leave no status in state, and cannot overwrite a real upload's status", async () => {
  const ok = await request({ method: "POST", path: "/api/paste-image", headers: { Origin: BASE_ORIGIN, "Content-Type": "image/png", "X-Request-Id": "real_upload_kept" }, body: Buffer.from("real") });
  assert.equal(ok.status, 200);
  for (let index = 0; index < 40; index++) {
    const refused = await request({ method: "POST", path: "/api/paste-image", headers: { Host: "evil.example", Origin: BASE_ORIGIN, "Content-Type": "image/png", "X-Request-Id": `refused_host_${index}` }, body: "x" });
    assert.equal(refused.status, 403);
  }
  const overwrite = await request({ method: "POST", path: "/api/paste-image", headers: { Origin: "https://evil.example", "Content-Type": "image/png", "X-Request-Id": "real_upload_kept" }, body: "x" });
  assert.equal(overwrite.status, 403);
  const ws = await openWs();
  try {
    const initial = nextMessages(ws, 2);
    ws.send(JSON.stringify({ type: "hello" }));
    const [state] = await initial;
    const ids = Object.keys(state.settings.uploads);
    assert.equal(ids.some((id) => id.startsWith("refused_host_")), false, "a refused Host must not record status");
    assert.equal(state.settings.uploads.real_upload_kept.status, "done", "a refused request cannot overwrite a real upload");
    assert.ok(ids.length <= 32);
  } finally { ws.close(); }
});
