import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestsStore } from "../server/requests.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "cc-requests-test-"));
  return { root, store: new RequestsStore(root), close: () => removeWithRetry(root) };
}

const exists = (id: string) => ["alpha-development", "beta-development"].includes(id);

test("requests persist, resolve once, and count pending items only for their destination", () => {
  const h = harness();
  try {
    const first = h.store.send({ fromTabId: "alpha-development", toTabId: "beta-development", title: "Review this", body: "Please inspect the change." }, exists, 10);
    assert.equal(first.status, "pending");
    assert.equal(h.store.pendingCount("alpha-development"), 0);
    assert.equal(h.store.pendingCount("beta-development"), 1);
    const accepted = h.store.resolve(first.id, "accepted", "beta-development", exists, 20);
    assert.deepEqual([accepted.status, accepted.resolvedAt], ["accepted", 20]);
    assert.equal(h.store.pendingCount("beta-development"), 0);
    assert.throws(() => h.store.resolve(first.id, "declined", "beta-development", exists), /no longer pending/);

    const second = h.store.send({ fromTabId: "beta-development", toTabId: "alpha-development", title: "Check", body: "Can you check?" }, exists, 30);
    const declined = h.store.resolve(second.id, "declined", "alpha-development", exists, 40);
    assert.equal(declined.status, "declined");
    assert.deepEqual(new RequestsStore(h.root).list(), [accepted, declined]);
  } finally { h.close(); }
});

test("requests validate tabs, distinct destinations, title and UTF-8 body size before writing", () => {
  const h = harness();
  try {
    const good = { fromTabId: "alpha-development", toTabId: "beta-development", title: "Title", body: "Body" };
    assert.throws(() => h.store.send({ ...good, fromTabId: "../outside" }, exists), /source and destination tabs/);
    assert.throws(() => h.store.send({ ...good, toTabId: "alpha-development" }, exists), /another tab/);
    assert.throws(() => h.store.send({ ...good, toTabId: "missing-development" }, exists), /destination tab does not exist/);
    assert.throws(() => h.store.send({ ...good, title: "  " }, exists), /request title/);
    assert.throws(() => h.store.send({ ...good, title: "x".repeat(201) }, exists), /request title/);
    assert.throws(() => h.store.send({ ...good, body: "é".repeat(12 * 1024 + 1) }, exists), /24576 bytes/);
    assert.equal(h.store.list().length, 0, "invalid requests never persist");
  } finally { h.close(); }
});

test("requests cannot be resolved from another tab and become destinationRemoved when the target disappears", () => {
  const h = harness();
  try {
    const row = h.store.send({ fromTabId: "alpha-development", toTabId: "beta-development", title: "Targeted", body: "Only beta can resolve this." }, exists, 1);
    assert.throws(() => h.store.resolve(row.id, "accepted", "alpha-development", exists), /not addressed to this tab/);
    assert.equal(h.store.pendingCount("beta-development"), 1);

    assert.equal(h.store.markDestinationRemoved("beta-development", 2), 1);
    assert.equal(h.store.list()[0].status, "destinationRemoved");
    assert.equal(h.store.list()[0].resolvedAt, 2);
    assert.equal(new RequestsStore(h.root).list()[0].status, "destinationRemoved");
    assert.throws(() => h.store.resolve(row.id, "accepted", "beta-development", () => false), /destination tab does not exist/);
  } finally { h.close(); }
});

test("a tab cannot hold more than 50 pending requests and refuses the 51st without writing", () => {
  const h = harness();
  try {
    const good = { fromTabId: "alpha-development", toTabId: "beta-development", title: "Title", body: "Body" };
    for (let index = 0; index < 50; index++) h.store.send(good, exists, index);
    assert.throws(() => h.store.send(good, exists, 99), /too many pending requests from this tab \(limit 50\)/);
    assert.equal(h.store.list().length, 50);
    assert.equal(new RequestsStore(h.root).list().length, 50, "the refused request never persists");
    h.store.send({ ...good, fromTabId: "beta-development", toTabId: "alpha-development" }, exists, 100);
    const first = h.store.list()[0];
    h.store.resolve(first.id, "declined", "beta-development", exists, 101);
    h.store.send(good, exists, 102);
    assert.equal(h.store.list().filter((row) => row.fromTabId === "alpha-development" && row.status === "pending").length, 50);
  } finally { h.close(); }
});

test("only the newest 200 resolved requests are kept and pending ones are never trimmed", () => {
  const h = harness();
  try {
    const toBeta = { fromTabId: "alpha-development", toTabId: "beta-development", title: "Title", body: "Body" };
    const fromBeta = { fromTabId: "beta-development", toTabId: "alpha-development", title: "Title", body: "Body" };
    const keep = h.store.send(toBeta, exists, 0);
    const resolvedIds: string[] = [];
    for (let index = 0; index < 205; index++) {
      const row = h.store.send(fromBeta, exists, index + 1);
      h.store.resolve(row.id, "declined", "alpha-development", exists, index + 1);
      resolvedIds.push(row.id);
    }
    h.store.send(fromBeta, exists, 999);
    const rows = h.store.list();
    assert.equal(rows.filter((row) => row.status !== "pending").length, 200);
    assert.equal(rows.some((row) => row.id === resolvedIds[0]), false, "the oldest resolved row is trimmed");
    assert.equal(rows.some((row) => row.id === resolvedIds[204]), true, "the newest resolved row stays");
    assert.equal(rows.some((row) => row.id === keep.id && row.status === "pending"), true, "a pending row is never trimmed");
    assert.equal(new RequestsStore(h.root).list().length, rows.length);
  } finally { h.close(); }
});

test("incoming (the leader's view) lists a declined request without its body and keeps the other bodies", () => {
  const h = harness();
  try {
    const good = { fromTabId: "alpha-development", toTabId: "beta-development", title: "Title", body: "secret instructions" };
    const declined = h.store.send({ ...good, title: "No" }, exists, 1);
    const accepted = h.store.send({ ...good, title: "Yes" }, exists, 2);
    const pending = h.store.send({ ...good, title: "Wait" }, exists, 3);
    h.store.resolve(declined.id, "declined", "beta-development", exists, 4);
    h.store.resolve(accepted.id, "accepted", "beta-development", exists, 5);
    const seen = h.store.incoming("beta-development");
    assert.deepEqual(seen.map((row) => [row.title, row.status, row.body]), [["No", "declined", ""], ["Yes", "accepted", "secret instructions"], ["Wait", "pending", "secret instructions"]]);
    assert.equal(h.store.list().find((row) => row.id === declined.id)!.body, "secret instructions", "The user's own list keeps the body");
    assert.equal(pending.status, "pending");
  } finally { h.close(); }
});
