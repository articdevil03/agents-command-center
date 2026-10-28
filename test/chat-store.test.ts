import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import realFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatMessageEvent, chatRequestErrorDetails, ChatStore, readChatRequestId } from "../server/chat-store.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

function tempDir(): string { return mkdtempSync(join(tmpdir(), "cc-chat-test-")); }

test("server chat request ids echo, persist for history, identify refusals, and reject invalid values", () => {
  const dir = tempDir();
  try {
    const requestId = readChatRequestId("send_0123456789abcdef");
    assert.equal(requestId, "send_0123456789abcdef");
    assert.equal(readChatRequestId(undefined), undefined);
    assert.throws(() => readChatRequestId("../escape"), /invalid request id/);
    assert.throws(() => readChatRequestId("x".repeat(65)), /invalid request id/);

    const first = new ChatStore(dir);
    const message = first.appendMessage("alpha-tab", "user", "hello", [], 100, requestId);
    assert.deepEqual(chatMessageEvent(message), { type: "chatMessage", ...message });
    assert.deepEqual(new ChatStore(dir).snapshot("alpha-tab").messages, [message]);
    assert.deepEqual(chatRequestErrorDetails({ type: "chat", tabId: "alpha-tab", requestId }), {
      action: "chat", tabId: "alpha-tab", requestId,
    });
    assert.deepEqual(chatRequestErrorDetails({ type: "chat", tabId: "alpha-tab", requestId: "../escape" }), {
      action: "chat", tabId: "alpha-tab",
    });
  } finally { removeWithRetry(dir); }
});

test("per-tab JSONL transcript, revision, and saved revision survive a new store instance", () => {
  const dir = tempDir();
  try {
    const first = new ChatStore(dir);
    first.appendMessage("alpha-tab", "user", "hello", [], 100);
    first.appendMessage("alpha-tab", "assistant", "answer", [], 101);
    first.markSaved("alpha-tab", 2, 102);
    first.appendMessage("beta-tab", "user", "different tab", [], 103);
    const restarted = new ChatStore(dir);
    assert.deepEqual(restarted.snapshot("alpha-tab"), {
      messages: [
        { tabId: "alpha-tab", revision: 1, role: "user", text: "hello", at: 100 },
        { tabId: "alpha-tab", revision: 2, role: "assistant", text: "answer", at: 101 },
      ],
      revision: 2,
      savedRevision: 2,
    });
    assert.equal(restarted.snapshot("beta-tab").revision, 1);
    assert.match(readFileSync(join(dir, "alpha-tab.jsonl"), "utf8"), /"type":"saved"/);
  } finally { removeWithRetry(dir); }
});

test("Clear appends a reset event, advances revision, and does not erase another tab", () => {
  const dir = tempDir();
  try {
    const store = new ChatStore(dir);
    store.appendMessage("alpha-tab", "user", "old", [], 1);
    store.markSaved("alpha-tab", 1, 2);
    store.appendMessage("beta-tab", "user", "keep", [], 3);
    assert.deepEqual(store.clear("alpha-tab"), { messages: [], revision: 2, savedRevision: 0 });
    const restarted = new ChatStore(dir);
    assert.deepEqual(restarted.snapshot("alpha-tab"), { messages: [], revision: 2, savedRevision: 0 });
    assert.equal(restarted.snapshot("beta-tab").messages[0].text, "keep");
  } finally { removeWithRetry(dir); }
});

test("Clear Undo restores the exact transcript and revisions after reload", () => {
  const dir = tempDir();
  try {
    const store = new ChatStore(dir);
    store.appendMessage("alpha-tab", "user", "old request", ["C:/isolated/image.png"], 1);
    store.appendMessage("alpha-tab", "assistant", "old answer", [], 2);
    store.markSaved("alpha-tab", 1, 3);
    store.appendMessage("beta-tab", "user", "keep", [], 4);
    const before = store.snapshot("alpha-tab");
    store.clear("alpha-tab", 5);
    store.appendMessage("alpha-tab", "user", "fresh", [], 6);

    assert.deepEqual(store.restore("alpha-tab", before, 7), before);
    const restarted = new ChatStore(dir);
    assert.deepEqual(restarted.snapshot("alpha-tab"), before);
    assert.equal(restarted.snapshot("beta-tab").messages[0].text, "keep");
  } finally { removeWithRetry(dir); }
});

test("transcript paths accept only globally safe tab slugs", () => {
  const dir = tempDir();
  try {
    const store = new ChatStore(dir);
    assert.throws(() => store.snapshot("../escape"), /unsafe tab id/);
    assert.throws(() => store.snapshot("Uppercase"), /unsafe tab id/);
  } finally { removeWithRetry(dir); }
});

const line = (revision: number, text: string) => JSON.stringify({ type: "message", tabId: "alpha-tab", revision, role: "user", text, at: revision });

test("a chat write that fails half way cannot swallow the next message", () => {
  const dir = tempDir(), real = realFs.appendFileSync;
  try {
    const store = new ChatStore(dir);
    store.appendMessage("alpha-tab", "user", "first", [], 100);
    // The disk takes the first bytes of the next line, then fails.
    realFs.appendFileSync = ((file: string, data: string, options: any) => { real(file, String(data).slice(0, 20), options); throw new Error("disk full"); }) as typeof realFs.appendFileSync;
    syncBuiltinESMExports();
    assert.throws(() => store.appendMessage("alpha-tab", "user", "lost", [], 101), /disk full/);
    realFs.appendFileSync = real; syncBuiltinESMExports();
    store.appendMessage("alpha-tab", "assistant", "after", [], 102);
    assert.deepEqual(new ChatStore(dir).snapshot("alpha-tab").messages.map((message) => message.text), ["first", "after"], "the next message starts on a fresh line and survives a restart");
  } finally { realFs.appendFileSync = real; syncBuiltinESMExports(); removeWithRetry(dir); }
});

test("chat store skips a torn middle line and a torn last line, loads the good ones and reports each file once", () => {
  const dir = tempDir();
  const reported: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { reported.push(args.join(" ")); };
  try {
    writeFileSync(join(dir, "alpha-tab.jsonl"), [line(1, "first"), '{"type":"message","tabId":"alpha-tab","revi', line(2, "second"), line(3, "third").slice(0, 25)].join("\n"));
    const store = new ChatStore(dir);
    assert.deepEqual(store.snapshot("alpha-tab").messages.map((message) => message.text), ["first", "second"]);
    store.snapshot("alpha-tab"); store.snapshot("alpha-tab");
    assert.equal(reported.length, 1, `reported once per file: ${JSON.stringify(reported)}`);
    assert.match(reported[0], /alpha-tab\.jsonl: skipped 2 unreadable line\(s\) \(line 2, 4\)/);
    // The torn last line had no newline: the next message must not be glued onto it.
    store.appendMessage("alpha-tab", "assistant", "after the tear", [], 9);
    assert.deepEqual(new ChatStore(dir).snapshot("alpha-tab").messages.map((message) => message.text), ["first", "second", "after the tear"]);
  } finally { console.error = original; removeWithRetry(dir); }
});

test("chat store loads when a saved marker names a revision lost in a torn line (clamped), but still refuses it when no line was torn", () => {
  const dir = tempDir();
  const original = console.error;
  console.error = () => {};
  try {
    const saved = JSON.stringify({ type: "saved", tabId: "alpha-tab", savedRevision: 2, at: 3 });
    writeFileSync(join(dir, "alpha-tab.jsonl"), [line(1, "first"), line(2, "second").slice(0, 30), saved, ""].join("\n"));
    const snapshot = new ChatStore(dir).snapshot("alpha-tab");
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.savedRevision, 1, "clamped to the revision that loaded");
    writeFileSync(join(dir, "alpha-tab.jsonl"), [line(1, "first"), saved, ""].join("\n"));
    assert.throws(() => new ChatStore(dir).snapshot("alpha-tab"), /invalid saved revision/);
  } finally { console.error = original; removeWithRetry(dir); }
});

test("chat store keeps the newline repair when the write that needed it fails", () => {
  const dir = tempDir();
  const file = join(dir, "alpha-tab.jsonl");
  const original = console.error;
  console.error = () => {};
  try {
    writeFileSync(file, [line(1, "first"), line(2, "second").slice(0, 30)].join("\n"));
    const store = new ChatStore(dir);
    store.snapshot("alpha-tab");
    chmodSync(file, 0o444);
    assert.throws(() => store.appendMessage("alpha-tab", "user", "lost", [], 5));
    chmodSync(file, 0o666);
    store.appendMessage("alpha-tab", "user", "good", [], 6);
    assert.deepEqual(new ChatStore(dir).snapshot("alpha-tab").messages.map((message) => message.text), ["first", "good"], "the good message is not glued onto the torn line");
  } finally { console.error = original; try { chmodSync(file, 0o666); } catch { /* already writable */ } removeWithRetry(dir); }
});

test("chat store still refuses a well-formed row that is invalid (only unparsable lines and unknown roles are skipped)", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "alpha-tab.jsonl"), '{"type":"message","tabId":"alpha-tab","revision":1,"role":"user","text":5,"at":1}\n');
    assert.throws(() => new ChatStore(dir).snapshot("alpha-tab"), /invalid chat message alpha-tab\.jsonl at line 1/);
  } finally { removeWithRetry(dir); }
});

test("a notice line (Command Center's own heads-up) is saved with the chat, survives a reload and a Clear Undo; a line with a role from a newer version is skipped, not fatal", () => {
  const dir = tempDir(), original = console.error;
  console.error = () => {};
  try {
    const store = new ChatStore(dir);
    store.appendMessage("alpha-tab", "user", "hi", [], 1);
    store.appendMessage("alpha-tab", "notice", "Heads up: x.", [], 2);
    const roles = (value: ChatStore) => value.snapshot("alpha-tab").messages.map((message) => message.role);
    assert.deepEqual(roles(new ChatStore(dir)), ["user", "notice"], "kept in the transcript across a reload");
    const before = store.snapshot("alpha-tab");
    store.clear("alpha-tab", 3);
    store.restore("alpha-tab", before, 4);
    assert.deepEqual(roles(new ChatStore(dir)), ["user", "notice"], "and through Clear + Undo");
    appendFileSync(join(dir, "alpha-tab.jsonl"), '{"type":"message","tabId":"alpha-tab","revision":9,"role":"banner","text":"from the future","at":5}\n');
    let loaded: string[] = [];
    assert.doesNotThrow(() => { loaded = roles(new ChatStore(dir)); }, "a line with an unknown role does not make the chat unreadable");
    assert.deepEqual(loaded, ["user", "notice"], "it is skipped and the rest loads");
  } finally { console.error = original; removeWithRetry(dir); }
});

test("a Clear Undo restore holding a message with a role from a newer version loads without it; a non-string role still refuses", () => {
  const dir = tempDir(), original = console.error;
  console.error = () => {};
  try {
    const row = (value: object) => JSON.stringify({ tabId: "alpha-tab", at: 1, ...value }) + "\n";
    const user = { tabId: "alpha-tab", revision: 1, role: "user", text: "hi", at: 1 };
    const future = { tabId: "alpha-tab", revision: 2, role: "banner", text: "from the future", at: 2 };
    const file = join(dir, "alpha-tab.jsonl");
    writeFileSync(file, row({ type: "message", ...user }) + row({ type: "message", ...future }) + row({ type: "clear", revision: 3 })
      + row({ type: "restore", messages: [user, future], revision: 4, savedRevision: 2 }));
    let loaded = { messages: [] as { text: string }[], revision: 0, savedRevision: 0 };
    assert.doesNotThrow(() => { loaded = new ChatStore(dir).snapshot("alpha-tab"); }, "an unknown role inside a restore does not make the chat unreadable");
    assert.deepEqual(loaded.messages.map((message) => message.text), ["hi"]);
    assert.equal(loaded.revision, 4);
    assert.equal(loaded.savedRevision, 2);
    writeFileSync(file, row({ type: "restore", messages: [{ ...user, role: 5 }], revision: 4, savedRevision: 0 }));
    assert.throws(() => new ChatStore(dir).snapshot("alpha-tab"), /invalid transcript restore/);
  } finally { console.error = original; removeWithRetry(dir); }
});

test("chat store refuses a transcript row tagged for a different tab", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "alpha-tab.jsonl"), JSON.stringify({ type: "message", tabId: "beta-tab", revision: 1, role: "user", text: "foreign", at: 1 }) + "\n");
    assert.throws(() => new ChatStore(dir).snapshot("alpha-tab"), /invalid chat transcript alpha-tab\.jsonl at line 1/);
  } finally { removeWithRetry(dir); }
});

test("chat store reload preserves uploaded image paths on their message", () => {
  const dir = tempDir();
  try {
    const first = new ChatStore(dir);
    first.appendMessage("alpha-tab", "user", "look", ["C:/isolated/scratch/image.png"], 1);
    const restarted = new ChatStore(dir);
    assert.deepEqual(restarted.snapshot("alpha-tab").messages[0].images, ["C:/isolated/scratch/image.png"]);
  } finally { removeWithRetry(dir); }
});

test("chat store reload and restore preserve uploaded non-image attachment paths", () => {
  const dir = tempDir();
  try {
    const first = new ChatStore(dir);
    const files = ["C:/isolated/scratch/file-00000000-0000-4000-8000-000000000001.ts"];
    first.appendMessage("alpha-tab", "user", "review this", [], 1, "file_request_1", files);
    const snapshot = first.snapshot("alpha-tab");
    assert.deepEqual(new ChatStore(dir).snapshot("alpha-tab").messages[0].files, files);
    first.clear("alpha-tab", 2);
    first.restore("alpha-tab", snapshot, 3);
    assert.deepEqual(new ChatStore(dir).snapshot("alpha-tab").messages[0], snapshot.messages[0]);
  } finally { removeWithRetry(dir); }
});

test("chat store rejects malformed image lists and saved revisions beyond the transcript", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "alpha-tab.jsonl");
    writeFileSync(path, JSON.stringify({ type: "message", tabId: "alpha-tab", revision: 1, role: "user", text: "bad image", images: [7], at: 1 }) + "\n");
    assert.throws(() => new ChatStore(dir).snapshot("alpha-tab"), /invalid chat message/);
    writeFileSync(path, [
      JSON.stringify({ type: "message", tabId: "alpha-tab", revision: 1, role: "user", text: "saved", at: 1 }),
      JSON.stringify({ type: "saved", tabId: "alpha-tab", savedRevision: 2, at: 2 }),
    ].join("\n") + "\n");
    assert.throws(() => new ChatStore(dir).snapshot("alpha-tab"), /invalid saved revision/);
  } finally { removeWithRetry(dir); }
});
