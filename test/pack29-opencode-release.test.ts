import test from "node:test";
import assert from "node:assert/strict";
import { selectRelease, defaultTransport, DOWNLOAD_LIMIT, ReleaseFailure } from "../server/settings/opencode/releases.ts";
import { release, installFixture } from "./pack29-opencode-install.setup.ts";
import { managedCli, managedRoot } from "../server/settings/opencode/paths.ts";
import { existsSync, readdirSync } from "node:fs";

test("asset origin checks reject the exact allowed path on unsafe addresses", async () => {
  const good = release("1.2.3");
  assert.equal((await selectRelease(async () => Response.json([good]), new AbortController().signal, "x64")).version, "1.2.3");
  for (const change of [(u: URL) => { u.hostname = "evil.example"; }, (u: URL) => { u.protocol = "http:"; },
    (u: URL) => { u.username = "user"; }, (u: URL) => { u.password = "password"; },
    (u: URL) => { u.port = "444"; }, (u: URL) => { u.hash = "fragment"; }]) {
    const row = release("1.2.3"), url = new URL(row.assets[0].browser_download_url); change(url);
    row.assets[0].browser_download_url = url.href; let calls = 0;
    await assert.rejects(selectRelease(async () => { calls++; return Response.json([row]); }, new AbortController().signal, "x64"), ReleaseFailure, url.href);
    assert.equal(calls, 1, "metadata reached with valid asset path " + url.pathname);
  }
});

test("only an exact v1 tag is eligible, including when prefixed tags precede it", async (t) => {
  const rejected = ["daemon-v1.2.3", "vv1.2.3", "x1.2.3"];
  const fx = await installFixture(t);
  try {
    for (const tag of rejected) {
      const rows = [release("1.2.3", undefined, { tag_name: tag }), release("1.1.0")];
      const result = await selectRelease(async () => Response.json(rows), new AbortController().signal, "x64").then(
        (value) => ({ tag: `v${value.version}`, rejected: rows.filter((row) => row.tag_name !== `v${value.version}`).map((row) => row.tag_name) }),
        () => ({ tag: null, rejected: [] }),
      );
      assert.deepEqual(result, { tag: "v1.1.0", rejected: [tag] }, `exact tag selection rejects ${tag}`);
    }
  } finally { await fx.close(); }
});

test("a valid JSON metadata page over 16 MiB fails installation before download or activation", async (t) => {
  const row = { ...release("1.19.5"), padding: "x".repeat(16 * 1024 * 1024) };
  const fx = await installFixture(t, { pages: [[row]] });
  try {
    await assert.rejects(fx.service.installCli(fx.request), /Installation failed/, "oversized valid metadata must be refused");
    assert.deepEqual(fx.requests, ["/releases?per_page=100&page=1"]);
    assert.equal(managedCli(fx.env), null);
    if (existsSync(managedRoot(fx.env)!)) assert.deepEqual(readdirSync(managedRoot(fx.env)!), []);
    assert.equal(fx.calls.some((call) => call.bin !== "opencode"), false);
  } finally { await fx.close(); }
});

test("release selection completes pagination and chooses semantic v1 maximum, excluding every other tag family", async (t) => {
  const page = [release("1.9.99"), release("2.99.0"), release("1.99.0", undefined, { draft: true }),
    release("1.98.0", undefined, { prerelease: true }), release("1.97.0", undefined, { tag_name: "process-daemon-v1.97.0" }),
    release("1.96.0", undefined, { tag_name: "v1.96.0-beta" })];
  while (page.length < 100) page.push(release("2.0.0"));
  const fx = await installFixture(t, { pages: [page, [release("1.20.0"), release("1.10.0")]] });
  try {
    const selected = await selectRelease(fx.transport, new AbortController().signal, "x64");
    assert.equal(selected.version, "1.20.0");
    assert.match(selected.url, /v1\.20\.0\/opencode-windows-x64-baseline.zip$/);
    assert.deepEqual(fx.requests, ["/releases?per_page=100&page=1", "/releases?per_page=100&page=2"]);
    assert.equal(fx.fetched.mock.callCount(), 0); assert.equal(fx.spawned.mock.callCount(), 0);
  } finally { await fx.close(); }
});

test("release metadata fails closed on incomplete pagination, bad asset facts, duplicates and unsupported architectures", async (t) => {
  const bad: unknown[][][] = [
    Array.from({ length: 50 }, () => Array.from({ length: 100 }, () => release("2.0.0"))),
    [[release("1.2.3"), release("1.2.3")]], [[release("1.2.3", undefined, { assets: [] })]],
  ];
  for (const change of [
    (a: any) => { delete a.digest; }, (a: any) => { a.digest = "sha256:bad"; },
    (a: any) => { a.size = DOWNLOAD_LIMIT + 1; }, (a: any) => { a.size = -1; },
    (a: any) => { a.browser_download_url = "https://evil.example/x"; },
    (a: any) => { a.browser_download_url = a.browser_download_url.replace("v1.2.3", "v2.2.3"); },
  ]) { const row = release("1.2.3"); change(row.assets[0]); bad.push([[row]]); }
  const duplicate = release("1.2.3"); duplicate.assets.push({ ...duplicate.assets[0] }); bad.push([[duplicate]]);
  for (const pages of bad) {
    const fx = await installFixture(t, { pages });
    try {
      await assert.rejects(selectRelease(fx.transport, new AbortController().signal, "x64"), ReleaseFailure);
      assert.equal(fx.requests.some((url) => url === "/asset"), false);
      assert.equal(fx.calls.length, 0);
    } finally { await fx.close(); }
  }
  const fx = await installFixture(t);
  try {
    await assert.rejects(selectRelease(fx.transport, new AbortController().signal, "ia32"));
    assert.equal(fx.requests.length, 0);
    const row = release("1.2.3"); row.assets[0].name = "opencode-windows-arm64.zip";
    row.assets[0].browser_download_url = row.assets[0].browser_download_url.replace("x64-baseline", "arm64");
    const selected = await selectRelease(async () => Response.json([row]), new AbortController().signal, "arm64");
    assert.match(selected.url, /windows-arm64.zip$/);
  } finally { await fx.close(); }
});

test("metadata streamed limits, unreadable responses and unsafe redirects cannot select a release", async (t) => {
  const fx = await installFixture(t);
  try {
    for (const response of [new Response("invalid"), Response.json({}), new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
      new Response(new ReadableStream({ start(c) { for (let i = 0; i < 17; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close(); } }))]) {
      await assert.rejects(selectRelease(async () => response, new AbortController().signal, "x64"));
    }
    assert.equal(fx.calls.length, 0); assert.equal(fx.fetched.mock.callCount(), 0);
  } finally { await fx.close(); }
});

test("default transport refuses host AND injected fake modes with a throwing fetch beneath the gates", async (t) => {
  const fx = await installFixture(t), previous = process.env.CC_TEST_FAKE_CLI;
  try {
    for (const source of ["injected", "host"]) {
      process.env.CC_TEST_FAKE_CLI = source === "host" ? "1" : "";
      const transport = defaultTransport(source === "injected" ? { CC_TEST_FAKE_CLI: "1" } : {});
      await assert.rejects(async () => transport("https://api.github.com/repos/anomalyco/opencode/releases", {
        signal: new AbortController().signal, redirect: "manual", headers: {},
      }));
      assert.equal(fx.fetched.mock.callCount(), 0, `${source}: outer spy must never be reached`);
    }
  } finally { if (previous === undefined) delete process.env.CC_TEST_FAKE_CLI; else process.env.CC_TEST_FAKE_CLI = previous; await fx.close(); }
});

test("aggregate metadata bound applies across pages and short pages with next links do not terminate selection", async (t) => {
  const fx = await installFixture(t);
  try {
    let pages = 0;
    const rows = Array.from({ length: 100 }, () => ({ tag_name: "v2.0.0", draft: false, prerelease: false }));
    Object.assign(rows[0], { padding: "x".repeat(14 * 1024 * 1024) });
    await assert.rejects(selectRelease(async () => { pages++; return Response.json(rows); }, new AbortController().signal, "x64"));
    assert.equal(pages, 5, "64 MiB aggregate bound stops the fifth sub-16 MiB response");
    pages = 0;
    const picked = await selectRelease(async () => {
      pages++;
      return pages === 1 ? Response.json([release("1.0.0")], { headers: { link: '<https://api.github.com/repos/anomalyco/opencode/releases?per_page=100&page=2>; rel="next"' } }) : Response.json([release("1.20.0")]);
    }, new AbortController().signal, "x64");
    assert.equal(picked.version, "1.20.0"); assert.equal(pages, 2);
    assert.equal(fx.fetched.mock.callCount(), 0); assert.equal(fx.spawned.mock.callCount(), 0);
  } finally { await fx.close(); }
});
