import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, withPage, skipped, delay, deliverState, sentOf, press, J, type Page } from "./pack18-editor-harness.ts";

// Pack 26 Block 5 slice 2f1: a seat's name and picture are read-only facts. The seat card no longer renames or re-pictures a seat; the one
// picture editor left is the personal one (your own picture, kept in the client prefs). Both are proved on the real page (fixture "fixed", fake
// socket, every message recorded). Slice 2f2 removed the card's model and advisor buttons; the Model row is read-only.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const flush = () => delay(80);
const focusedOn = (ev: Page["ev"]): Promise<{ id: string | null; seat: string | null; tag: string | null; more: boolean; pic: boolean }> =>
  ev(`(()=>{const a=document.activeElement;return {id:a?.id||null,seat:a?.closest?.("[data-seat-id]")?.dataset.seatId??null,tag:a?.tagName??null,more:a?.hasAttribute?.("data-seat-more")??false,pic:a?.hasAttribute?.("data-seat-pic")??false}})()`);
// Everything the open card shows, read from the page.
const cardFacts = (ev: Page["ev"]): Promise<any> => ev(`(()=>{
  const pop=document.querySelector("#seatPop"); if(!pop||pop.hidden) return null;
  const row=(label)=>{const r=[...pop.querySelectorAll(".rowb")].find((x)=>x.firstElementChild?.textContent===label);return r?r.querySelector(".v")?.textContent??"":null};
  return {name:pop.querySelector(".top b span")?.textContent??null,role:pop.querySelector(".top small")?.textContent??null,pic:pop.querySelector(".top img")?.getAttribute("src")??null,
    model:pop.querySelector(".model-label")?.textContent??null,effort:pop.querySelector(".eff")?.textContent??null,
    usage:row("Usage"),context:row("Context"),access:row("Access"),
    rename:pop.querySelectorAll("[data-seat-rename],.pen").length,picture:pop.querySelectorAll("[data-seat-picture]").length,
    modelBtn:Boolean(pop.querySelector("[data-seat-model]")),advisorBtn:Boolean(pop.querySelector("[data-seat-advisor]")),
    chat:Boolean(pop.querySelector("[data-seat-chat]")),history:Boolean(pop.querySelector("[data-seat-history]")),watch:Boolean(pop.querySelector("[data-seat-watch]")),
    run:Boolean(pop.querySelector("[data-run-seat]")),buttons:[...pop.querySelectorAll("button")].map((b)=>b.getAttribute("aria-label")||b.textContent)}})()`);
const openFromRail = async (ev: Page["ev"], slot: string) => {
  const found = await ev(`(()=>{const el=document.querySelector(${J(`#crew .seat[data-seat-id="${slot}"] [data-seat-pic]`)});if(!el)return false;el.focus();el.click();return true})()`);
  assert.equal(found, true, `the rail picture of seat ${slot} was found`);
  await flush();
};

test("FCFACTS seat card: name and picture are read-only facts, the rest of the card still works", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, page, discovered, fixed }) => {
    await deliverState(ev, discovered);
    await flush();
    const seats: any[] = await ev(`window.__ccSeed.projects[0].tabs[0].crew.map((s)=>({slot:s.slot,name:s.name,isLeader:Boolean(s.isLeader)}))`);
    const leader = seats.find((seat) => seat.isLeader), worker = seats.find((seat) => !seat.isLeader);
    assert.ok(leader && worker, `the fixture has a leader and a worker (${seats.length} seats)`);
    const expected = (slot: string) => ev(`(()=>{const tab=currentTab(),seat=seatFor(tab,${J(slot)});return {name:seat.name,role:seatRole(tab,seat),pic:seatPic(seat),model:formatModel(seat.cli,seat.model,tab),effort:modelSupportsEffort(seat.cli,seat.model)?seat.effort:null,usage:seatUsageText(tab,seat),context:seat.isLeader?contextLine(tab):null,access:seat.isLeader?null:accessText(tab,seat)}})()`);

    // The leader's card: its own name, picture, role, model, context and usage; no rename or picture control.
    await openFromRail(ev, leader.slot);
    const lead = await cardFacts(ev), leadWant = await expected(leader.slot);
    assert.ok(lead, "the leader's card opened");
    assert.equal(lead.name, leader.name, "the card shows the seat's current name");
    assert.equal(lead.name, leadWant.name);
    assert.ok(lead.role && lead.role.startsWith(leadWant.role), `the card shows its role (${lead.role})`);
    assert.match(String(lead.pic), /^\/avatars\/[a-z]+\.svg$/, "the card shows a preset picture");
    assert.equal(lead.pic, leadWant.pic, "it is the seat's own picture");
    assert.equal(lead.model, leadWant.model, "the card shows the seat's model");
    assert.equal(lead.effort === null ? null : String(lead.effort).replace(/^\W+\s*/, ""), leadWant.effort, "and its effort (or none)");
    assert.equal(lead.usage, leadWant.usage, "the card shows Usage");
    assert.ok(lead.context !== null && lead.context.length > 0, "the leader's card shows Context");
    assert.equal(lead.access, null, "the leader's card has no Access row");
    assert.deepEqual([lead.rename, lead.picture], [0, 0], "no rename or picture control is in the leader's card");
    assert.ok(lead.buttons.every((label: string) => !/^(Rename|Change picture)/.test(String(label))), `no button offers a rename or picture change: ${lead.buttons.join(" | ")}`);
    assert.notEqual(lead.model, null, "the leader's Model row was found");
    assert.deepEqual([lead.modelBtn, lead.advisorBtn, lead.chat, lead.history], [false, false, true, true], "the card has no model or advisor control; Chat and Past sessions are there");
    await press(page, "Escape");
    await flush();
    assert.equal(await ev(`document.querySelector("#seatPop").hidden`), true, "Escape closes the card");
    const back = await focusedOn(ev);
    assert.deepEqual([back.seat, back.pic], [leader.slot, true], "focus went back to the rail picture that opened the card");
    // Chat and Past sessions navigate.
    await openFromRail(ev, leader.slot);
    await ev(`document.querySelector("#seatPop [data-seat-history]").click();true`);
    await flush();
    assert.deepEqual(await ev(`({hidden:document.querySelector("#seatPop").hidden,view:selectedView,slot:selectedSeatByTab.get(currentTab().id)})`), { hidden: true, view: "history", slot: leader.slot }, "Past sessions closes the card and opens the leader's history");
    await openFromRail(ev, leader.slot);
    await ev(`document.querySelector("#seatPop [data-seat-chat]").click();true`);
    await flush();
    assert.deepEqual(await ev(`({hidden:document.querySelector("#seatPop").hidden,view:selectedView,focus:document.activeElement?.id})`), { hidden: true, view: "live", focus: "ci" }, "Chat closes the card and focuses the message box");

    // A worker's card: same facts, Access instead of Context, Watch navigates; its detail button names no editing.
    await openFromRail(ev, worker.slot);
    const work = await cardFacts(ev), workWant = await expected(worker.slot);
    assert.ok(work, "the worker's card opened");
    assert.equal(work.name, worker.name);
    assert.ok(work.role && work.role.startsWith(workWant.role), `the card shows the worker's role (${work.role})`);
    assert.equal(work.pic, workWant.pic, "the worker's own picture");
    assert.equal(work.model, workWant.model);
    assert.equal(work.usage, workWant.usage, "the worker's Usage");
    assert.equal(work.access, workWant.access, "the worker's Access");
    assert.equal(work.context, null, "a worker has no Context row");
    assert.deepEqual([work.rename, work.picture], [0, 0], "no rename or picture control is in the worker's card");
    assert.notEqual(work.model, null, "the worker's Model row was found");
    assert.deepEqual([work.modelBtn, work.advisorBtn, work.watch, work.run], [false, false, true, true], "the card has no model or advisor control; Watch and Run are there");
    await ev(`document.querySelector("#seatPop [data-seat-watch]").click();true`);
    await flush();
    assert.deepEqual(await ev(`({hidden:document.querySelector("#seatPop").hidden,view:selectedView,slot:selectedSeatByTab.get(currentTab().id)})`), { hidden: true, view: "live", slot: worker.slot }, "Watch closes the card and opens the worker's view");
    const more = await ev(`(()=>{const b=document.querySelector("#view [data-seat-more]");return b?{label:b.getAttribute("aria-label"),title:b.getAttribute("title")}:null})()`);
    assert.deepEqual(more, { label: `${worker.name}: seat details and launches`, title: "Seat details and launches" }, "the worker view's card button promises details and launches, not editing");
    await ev(`(()=>{const b=document.querySelector("#view [data-seat-more]");b.focus();b.click();return true})()`);
    await flush();
    assert.equal((await cardFacts(ev))?.name, worker.name, "that button opens the worker's read-only card");
    await press(page, "Escape");
    await flush();
    const moreBack = await focusedOn(ev);
    assert.equal(moreBack.more, true, "Escape returns focus to the button that opened the card");

    // No message edited a seat's name or picture, and the page has no sender for it.
    const sent: any[] = await ev(`window.__sent`);
    assert.deepEqual(sent.filter((m) => m.type === "updateSeat"), [], "no updateSeat was sent from the seat card");
    assert.deepEqual(await sentOf(ev, "updateSeat"), []);
    assert.equal(await ev(`typeof openSeatAvatar+"/"+typeof renderAvatarStatus+"/"+typeof avatarTarget`), "undefined/undefined/undefined", "the seat picture editor's functions and state are gone");
    assert.ok(fixed.id, "fixture tab id");
  }, { fixture: "fixed" });
});

test("FCPERSONAL avatar: your own picture still has presets and upload with the same limits, and sends nothing about a seat", { timeout: editorTestMs(150_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, page, discovered }) => {
    await deliverState(ev, discovered);
    await flush();
    const avatarPrefs = () => sentOf(ev, "updateClientPref").then((all) => all.filter((m) => m.key === "avatar"));
    const dialog = () => ev(`(()=>{const m=document.querySelector("#avModal");return {hidden:m.hidden,title:document.querySelector("#avTitle").textContent,status:document.querySelector("#avatarStatus").textContent,
      presets:document.querySelectorAll("#avgrid [data-avatar]").length,upload:Boolean(document.querySelector("#avUpload")),input:Boolean(document.querySelector("#avUp")),
      checked:[...document.querySelectorAll("#avgrid [data-avatar][aria-checked=true]")].map((b)=>b.dataset.avatar)}})()`);
    const open = async () => {
      assert.equal(await ev(`(()=>{const b=document.querySelector("#meBtn");if(!b)return false;b.focus();b.click();return true})()`), true, "the meBtn was found");
      await flush();
    };
    await open();
    const first = await dialog();
    assert.equal(first.hidden, false, "meBtn opens the picture dialog");
    assert.deepEqual([first.title, first.presets, first.upload, first.input], ["Your picture", 20, true, true], "your picture: twenty presets, the upload button and its input");
    assert.equal(first.status, "Any PNG, JPEG or WebP picture. It stays on this PC.");
    const before = await ev(`me.av`);
    assert.deepEqual(first.checked, [String(before).replace(/\.svg$/, "")], "the current picture is ticked");

    // A preset: one avatar preference with the chosen file.
    const pick = (await ev(`AVATAR_PRESETS`) as string[]).find((name) => `${name}.svg` !== before)!;
    assert.equal(await ev(`(()=>{const b=document.querySelector(${J(`#avgrid [data-avatar="${pick}"]`)});if(!b)return false;b.click();return true})()`), true, `the preset ${pick} was found`);
    await flush();
    const sentPrefs = await avatarPrefs();
    assert.equal(sentPrefs.length, 1, `choosing a preset sends one avatar preference (${JSON.stringify(sentPrefs)})`);
    assert.deepEqual({ type: sentPrefs[0].type, key: sentPrefs[0].key, value: sentPrefs[0].value }, { type: "updateClientPref", key: "avatar", value: `${pick}.svg` });
    assert.equal(await ev(`me.av`), `${pick}.svg`, "the personal picture changed");
    assert.equal(await ev(`document.querySelector("#meImg").getAttribute("src")`), `/avatars/${pick}.svg`, "and the top bar shows it");
    assert.deepEqual((await dialog()).checked, [pick], "the new preset is ticked");
    // The server confirms; reopening still ticks it.
    await deliverState(ev, discovered, `state.clientPrefs={...(state.clientPrefs||{}),avatar:${J(`${pick}.svg`)}}`);
    await flush();
    await press(page, "Escape");
    await flush();
    assert.equal((await dialog()).hidden, true, "Escape closes the dialog");
    assert.equal((await focusedOn(ev)).id, "meBtn", "focus went back to meBtn");
    await open();
    assert.deepEqual((await dialog()).checked, [pick], "after the confirmation, reopening ticks the chosen preset");
    await press(page, "Escape");
    await flush();

    // Uploads. The input's own change listener runs; the reader and the decoder are fixed seams so each outcome is deterministic.
    const seam = (decodes: boolean) => ev(`(()=>{
      window.__real={FileReader:window.FileReader,Image:window.Image,fetch:window.fetch};window.__readers=[];window.__fetches=[];
      window.FileReader=class{readAsDataURL(file){this.file=file;window.__readers.push(this)}};
      window.Image=class{set src(v){this._s=v;setTimeout(()=>{if(${decodes}){this.naturalWidth=1;this.onload&&this.onload()}else this.onerror&&this.onerror()},0)}get src(){return this._s}};
      window.fetch=function(url,...rest){window.__fetches.push(String(url));return window.__real.fetch.call(this,url,...rest)};return true})()`);
    const unseam = () => ev(`(()=>{if(window.__real){window.FileReader=window.__real.FileReader;window.Image=window.__real.Image;window.fetch=window.__real.fetch;delete window.__real}return true})()`);
    const choose = (type: string) => ev(`(()=>{const input=document.querySelector("#avUp");const file=new File(["x"],"p",{type:${J(type)}});Object.defineProperty(input,"files",{value:[file],configurable:true});input.dispatchEvent(new Event("change"));return window.__readers.length})()`);
    const finish = (result: string) => ev(`(async()=>{const reader=window.__readers.at(-1);reader.result=${J(result)};await reader.onload();return true})()`);
    const settled = async (label: string) => {
      const prior = await ev(`me.av`);
      const prefs = (await avatarPrefs()).length;
      return { prior, prefs, check: async (statusPart: RegExp) => {
        assert.equal(await ev(`me.av`), prior, `${label}: the old picture stays`);
        assert.equal((await avatarPrefs()).length, prefs, `${label}: no avatar preference was sent`);
        assert.match((await dialog()).status, statusPart, `${label}: the dialog says why`);
        assert.equal((await dialog()).hidden, false, `${label}: the dialog stays open`);
      } };
    };
    try {
      await open();
      // A decode failure keeps the old picture.
      await seam(false);
      assert.equal(await choose("image/png"), 1, "the input's listener started one read");
      const bad = await settled("undecodable");
      await finish("data:image/png;base64,AAAA");
      await flush();
      await bad.check(/did not decode as a picture, so the old one stays/);
      // An oversized picture that does decode is refused by its length, not accepted.
      await unseam(); await seam(true);
      await choose("image/png");
      const big = await settled("oversized");
      const oversized = `data:image/png;base64,${"A".repeat(600_000)}`;
      await finish(oversized);
      await big.check(/too large to keep \(limit 512 KB\), so the old one stays/);
      assert.ok(String(await ev(`me.av`)).length < 600_000, "an oversized picture was not accepted");
      // A file that is not an image never starts a read.
      const reads = await ev(`window.__readers.length`);
      await choose("text/plain");
      assert.equal(await ev(`window.__readers.length`), reads, "a non-image file starts no read");
      assert.equal((await avatarPrefs()).length, big.prefs);
      // A reader error is reported and changes nothing.
      await choose("image/png");
      await ev(`(()=>{window.__readers.at(-1).onerror();return true})()`);
      await flush();
      assert.equal(await ev(`me.av`), big.prior, "a reader error keeps the old picture");
      assert.equal((await avatarPrefs()).length, big.prefs);
      assert.deepEqual(await ev(`window.__fetches.filter((u)=>/\\/api\\/avatar/.test(u))`), [], "no /api/avatar request was made");
    } finally { await unseam(); }
    // One real control with the real reader and decoder: a small PNG is accepted, sent once and closes the dialog.
    const prefsBefore = (await avatarPrefs()).length;
    await ev(`(()=>{const bytes=Uint8Array.from(atob(${J(PNG)}),(c)=>c.charCodeAt(0));const input=document.querySelector("#avUp");const file=new File([bytes],"p.png",{type:"image/png"});Object.defineProperty(input,"files",{value:[file],configurable:true});input.dispatchEvent(new Event("change"));return true})()`);
    for (let waited = 0; waited < 4000 && !(await ev(`me.av.startsWith("data:image/png")`)); waited += 100) await delay(100);
    assert.equal(await ev(`me.av`), `data:image/png;base64,${PNG}`, "a valid small PNG becomes the personal picture");
    const prefs = await avatarPrefs();
    assert.equal(prefs.length, prefsBefore + 1, "and sends exactly one avatar preference");
    assert.equal(prefs.at(-1).value, `data:image/png;base64,${PNG}`);
    assert.equal((await dialog()).hidden, true, "the dialog closes after a good upload");
    assert.equal((await focusedOn(ev)).id, "meBtn", "focus is back on meBtn");

    // Nothing in any of this touched a seat.
    assert.deepEqual(await sentOf(ev, "updateSeat"), [], "no seat was changed");
  }, { fixture: "fixed" });
});
