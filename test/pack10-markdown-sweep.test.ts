import test from "node:test";
import assert from "node:assert/strict";
import { appSource } from "./source-text.ts";
import { J, type Page, withPage, skipped, FENCE, history, summary } from "./pack10-markdown-helpers.ts";

// A seed with a failed run, a pending request, a sent request and an unconfirmed launch: every one carries model text with **.
const MARK = (word: string) => `**${word}** and \`code\``;
async function seedModelText(ev: (e: string) => Promise<any>, tabA: string, tabB: string) {
  await ev(`(()=>{const s=window.__ccSeed,tab=s.projects[0].tabs.find((x)=>x.id===${J(tabA)}),worker=tab.crew.find((x)=>!x.isLeader);
    tab.runs=[{runId:"run-md",seatSlotId:worker.slot,seatName:worker.name,seatIsLeader:false,status:"failed",label:${J(MARK("RunLabel"))},outcome:"failed",cli:"claude",model:"m",startedAt:Date.now()-5000,endedAt:Date.now(),crewGenerationId:tab.processState.crewGenerationId,folderPath:"C:/x"}];
    tab.notes={content:${J("# **Pack 10** is done\n- fixed `x` thing\n- **bold** note\n## **Next** up\n```\n")},path:tab.folder+"/.command-center/"+tab.id+"/RESUME.md",truncated:false};
    s.requests=[{id:"rq-in",fromTabId:${J(tabB)},toTabId:${J(tabA)},title:${J(MARK("ReqTitle"))},body:${J("**ReqBody** first\n- point **one**\n- point two")},status:"pending",createdAt:Date.now()},
      {id:"rq-out",fromTabId:${J(tabA)},toTabId:${J(tabB)},title:${J(MARK("SentTitle"))},body:${J(MARK("SentBody"))},status:"accepted",createdAt:Date.now()}];
    s.launchSafety={...(s.launchSafety||{}),uncertain:[],blocked:[],released:[],notices:[{id:7,pending:true,seatKey:tab.id+"."+worker.slot,seatName:worker.name,source:"Atlas",brief:${J(MARK("NoticeBrief"))}}]};
    __ccDeliver({...structuredClone(s),type:"state"});return true})()`);
}

test("handover panel: no raw ** in the summary or the rows, bold and code rendered", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, tabB, shot }) => {
    await seedModelText(ev, tabA, tabB);
    await ev(`document.querySelector("#side").hidden&&document.querySelector("#sideBtn").click();document.querySelector('[data-l="notes"]').click();true`);
    await waitFor(`document.querySelector("#lowerBody .resume p")?.textContent.includes("Pack 10")`, "the handover shows");
    const got = await ev(`(()=>{const b=document.querySelector("#lowerBody");return {summary:b.querySelector(".resume p").innerHTML,rows:[...b.querySelectorAll("[data-note-row]")].map((r)=>r.innerHTML)}})()`);
    assert.deepEqual(got, { summary: "<strong>Pack 10</strong> is done", rows: ["fixed <code>x</code> thing", "<strong>bold</strong> note", "<strong>Next</strong> up"] }, `matched: ${JSON.stringify(got)}`);
    await shot("c-handover-panel.png");
  });
});

test("handover panel: a fenced block shows as typed, an unclosed fence never hides what follows", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, tabB }) => {
    await seedModelText(ev, tabA, tabB);
    const notes = ["Summary **line**", "- before **bold**", FENCE + "js", "**literal** and `tick`", "- not a bullet **x**", FENCE, "- after **bold**", FENCE, "- tail **bold**"].join("\n");
    await ev(`(()=>{const s=window.__ccSeed,tab=s.projects[0].tabs.find((x)=>x.id===${J(tabA)});tab.notes.content=${J(notes)};__ccDeliver({...structuredClone(s),type:"state"});return true})()`);
    await ev(`document.querySelector("#side").hidden&&document.querySelector("#sideBtn").click();document.querySelector('[data-l="notes"]').click();true`);
    await waitFor(`document.querySelector("#lowerBody .resume p")?.textContent.includes("Summary")`, "the handover shows");
    const got = await ev(`(()=>{const b=document.querySelector("#lowerBody");return {summary:b.querySelector(".resume p").innerHTML,rows:[...b.querySelectorAll("[data-note-row]")].map((r)=>r.innerHTML)}})()`);
    assert.deepEqual(got, { summary: "Summary <strong>line</strong>", rows: ["before <strong>bold</strong>", "<code>**literal** and `tick`</code>", "<code>- not a bullet **x**</code>", "after <strong>bold</strong>", "tail <strong>bold</strong>"] }, `matched: ${JSON.stringify(got)}`);
  });
});

// ---- The sweep, built from the real list ----
// Every place in public/app/*.js that calls the renderer or a plain-label helper is found in the source (by "function(first argument"), and each one is matched below to the
// scene that makes the page show it. A call site nobody covers, or a scene that claims one the source no longer has, is a gap; so a place added, removed or bypassed goes red.
const APP_JS = appSource();
const pageSource = (source: string) => source.slice(source.indexOf("const ICONS")); // above the icon table are the renderer's own definitions, not call sites
function callSites(source: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const m of pageSource(source).matchAll(/\b(mdHtml|mdInline|plainMd|mdPlain)\(\s*([\w."?]+)/g)) found.set(`${m[1]}(${m[2]}`, (found.get(`${m[1]}(${m[2]}`) ?? 0) + 1);
  return found;
}

// Every esc(...) whose argument (balanced parentheses, so ??, ||, ternaries and templates are all inside it) still holds a model-text field once the wrapped calls are taken out.
const MODEL_FIELD = /\b(?:run|item\.run|selected|last|current|failed|stalled|row|item\.row|message|request|seat|member)\.(?:label|brief|title|body|task)\b/;
function bareModelEscapes(source: string): { bare: string[]; scanned: number } {
  const page = pageSource(source), bare: string[] = []; let scanned = 0;
  for (const m of page.matchAll(/\besc\(/g)) {
    let depth = 1, end = m.index! + m[0].length;
    while (end < page.length && depth > 0) { if (page[end] === "(") depth += 1; else if (page[end] === ")") depth -= 1; end += 1; }
    const argument = page.slice(m.index! + m[0].length, end - 1).replace(/\b(?:plainMd|mdPlain|mdHtml|mdInline)\([^()]*\)/g, "");
    scanned += 1;
    if (MODEL_FIELD.test(argument)) bare.push(`esc(${argument.slice(0, 80)})`);
  }
  return { bare, scanned };
}

type Scene = { id: string; covers: Record<string, number>; setup: string; act?: string; ready: string; read: string; words: string[]; rich?: string };
const ALL = (selector: string) => `__ccAll(${J(selector)})`;
const OPEN_NOTES = `document.querySelector("#side").hidden&&document.querySelector("#sideBtn").click();document.querySelector('[data-l="notes"]').click()`;
const OPEN_SEAT = `document.querySelector('[data-seat-open="'+W+'"]').click()`;
const TASK_SEAT = (word: string) => `worker.status="working";worker.task=${J(MARK(word))};tab.runs=[]`;
const FAILED_RUN = (word: string) => `tab.runs=[run("rf","failed",${J(MARK(word))})]`;
const LIVE_RUN = (id: string, word: string, extra = "") => `run(${J(id)},"working",${J(MARK(word))}${extra})`;
// One scene per place the page shows model text: how to put the page in that state, how to open it, what to read there, and the words that must survive.
const SCENES: Scene[] = [
  { id: "OS notification at the end of a run", covers: { "mdPlain(message.label": 1 }, words: ["NotifyWord"],
    setup: `window.__notes=[];window.Notification=Object.assign(class{constructor(title,options){window.__notes.push(title+" | "+options?.body)}},{permission:"granted"})`,
    act: `__ccDeliver({type:"runFail",tabId:tab.id,seatKey:tab.id+"."+W,runId:"nr",label:${J(MARK("NotifyWord"))},outcome:"failed",exitCode:1})`,
    ready: `window.__notes.length>0`, read: `window.__notes.join(" || ")` },
  { id: "crew rail line, tooltip and labels", covers: { "mdPlain(seat.isLeader": 1 }, words: ["RailTask"],
    setup: TASK_SEAT("RailTask"), ready: `document.querySelector('#crew [data-seat-id="'+W+'"]')`, read: `__ccAll('#crew [data-seat-id="'+W+'"]')` },
  { id: "seat stage head line", covers: {}, words: ["StageTask"],
    setup: TASK_SEAT("StageTask"), act: OPEN_SEAT, ready: `document.querySelector("#stagehead .vstat .vt")`, read: ALL("#stagehead .vstat") },
  { id: "seat card line", covers: {}, words: ["CardTask"],
    setup: TASK_SEAT("CardTask"), act: `document.querySelector('[data-seat-pic="'+W+'"]').click()`, ready: `document.querySelector("#seatPop .now")`, read: ALL("#seatPop .now") },
  { id: "status line, a worker's task", covers: { "mdPlain(seat.task": 1 }, words: ["PhraseTask"],
    setup: TASK_SEAT("PhraseTask"), ready: `document.querySelector("#statusBtn .pt")`, read: ALL("#statusBtn") },
  { id: "status line, failed run", covers: { "mdPlain(failed.label": 1 }, words: ["StatusFailed"],
    setup: FAILED_RUN("StatusFailed"), ready: `document.querySelector("#statusBtn .pt")`, read: ALL("#statusBtn") },
  { id: "status line, stalled run", covers: { "mdPlain(stalled.label": 1 }, words: ["StatusStalled"],
    setup: `tab.runs=[${LIVE_RUN("rs", "StatusStalled", ",{stalled:true}")}];worker.status="stalled"`, ready: `document.querySelector("#statusBtn .pt")`, read: ALL("#statusBtn") },
  { id: "leader message", covers: { "mdHtml(messageText": 1 }, words: ["LeaderWord"], rich: "#view .msg:not(.mine) .md",
    setup: ``, act: `window.__ccHistory[tab.id]=[{role:"assistant",text:${J(MARK("LeaderWord"))},at:1,revision:1}];window.__socket.history(tab.id)`,
    ready: `document.querySelector("#view .msg:not(.mine) .md")`, read: ALL("#view .msg:not(.mine)") },
  { id: "run tabs of a seat with several live runs", covers: { "plainMd(run.label": 2 }, words: ["TabOne", "TabTwo"],
    setup: `worker.status="working";tab.runs=[${LIVE_RUN("t1", "TabOne")},${LIVE_RUN("t2", "TabTwo")}]`, act: OPEN_SEAT, ready: `document.querySelector("#stagehead .runtabs")`, read: ALL("#stagehead .runtabs") },
  { id: "live run: doing now and the terminal bar", covers: { "mdPlain(current.label": 1, "plainMd(selected.label": 3 }, words: ["DoingWord"],
    setup: `worker.status="working";tab.runs=[${LIVE_RUN("d1", "DoingWord")}]`, act: OPEN_SEAT, ready: `document.querySelector("#view .term .tb")`, read: `${ALL("#stagehead .facts")}+" | "+${ALL("#view .term .tb")}` },
  { id: "last result of a seat", covers: { "plainMd(last.label": 2 }, words: ["LastWord"],
    setup: `worker.status="idle";tab.runs=[run("l1","done",${J(MARK("LastWord"))})]`, act: OPEN_SEAT, ready: `document.querySelector("#view .last")`, read: ALL("#view .last") },
  { id: "runs from earlier crews (the leader's Past sessions)", covers: { "mdPlain(run.label": 1, "plainMd(run.label": 1 }, words: ["RetiredWord"],
    setup: `worker.status="idle";tab.runs=[];tab.derived.runViews.retiredHistory=[run("old1","done",${J(MARK("RetiredWord"))})]`, act: `document.querySelector('[data-seat-pic="leader"]').click();document.querySelector("#seatPop [data-seat-history]").click()`,
    ready: `[...document.querySelectorAll("#view h3")].some((h)=>h.textContent.includes("earlier crews"))`, read: ALL("#view") },
  { id: "seat card: live run rows", covers: { "plainMd(run.label": 3 }, words: ["RowWord"],
    setup: `worker.status="working";tab.runs=[${LIVE_RUN("c1", "RowWord")}]`, act: `document.querySelector('[data-seat-pic="'+W+'"]').click()`, ready: `document.querySelector("#seatPop .sr")`, read: ALL("#seatPop .sr") },
  { id: "handover summary and rows", covers: { "mdInline(bare": 1 }, words: ["Pack 10", "bold", "Next"], rich: "#lowerBody",
    setup: ``, act: OPEN_NOTES, ready: `document.querySelector("#lowerBody .resume p")`, read: ALL("#lowerBody") },
  { id: "handover with nothing saved", covers: { 'mdInline("Nothing': 1 }, words: ["Nothing saved yet"],
    setup: `tab.notes.content=""`, act: OPEN_NOTES, ready: `document.querySelector("#lowerBody .resume p")`, read: ALL("#lowerBody .resume") },
  { id: "request cards, incoming and sent", covers: { "plainMd(request.title": 1, "mdHtml(request.body": 1 }, words: ["ReqTitle", "ReqBody", "point one", "SentTitle", "SentBody"], rich: "#inboxList .ncard.req",
    setup: ``, ready: `document.querySelector("#inboxList .ncard.req")&&document.querySelector("#reqList .ncard")`, read: `${ALL("#inboxList .ncard.req")}+" | "+${ALL("#reqList")}` },
  { id: "failed run card (Needs you)", covers: { "plainMd(item.run.label": 1 }, words: ["CardFailed"],
    setup: FAILED_RUN("CardFailed"), ready: `document.querySelector("#inboxList .ncard.bad")`, read: ALL("#inboxList .ncard.bad") },
  { id: "stalled run card (Needs you)", covers: { "plainMd(item.run.label": 1 }, words: ["CardStalled"],
    setup: `tab.runs=[${LIVE_RUN("cs", "CardStalled", ",{stalled:true}")}]`, ready: `document.querySelector("#inboxList .ncard.bad")`, read: ALL("#inboxList .ncard.bad") },
  { id: "stop not confirmed card (Needs you)", covers: { "plainMd(run.label": 1 }, words: ["UncertainRun"],
    setup: `tab.runs=[${LIVE_RUN("u1", "UncertainRun")}];s.launchSafety.uncertain=[{runId:"u1",seatKey:tab.id+"."+W,pid:4242}]`, ready: `[...document.querySelectorAll("#inboxList .ncard.bad")].some((c)=>c.textContent.includes("Stop not confirmed"))`, read: ALL("#inboxList .ncard.bad") },
  { id: "unconfirmed launch card (Needs you)", covers: { "plainMd(item.row.brief": 1 }, words: ["NoticeBrief"],
    setup: ``, ready: `document.querySelector("#inboxList")?.textContent.includes("NoticeBrief")`, read: ALL("#inboxList") },
  { id: "launch records", covers: { "plainMd(row.brief": 1 }, words: ["RecordBrief"],
    setup: `s.launchSafety.notices=[{id:9,pending:false,seatKey:tab.id+"."+W,seatName:worker.name,source:"Atlas",brief:${J(MARK("RecordBrief"))}}]`, ready: `document.querySelector("#inboxRecords")?.textContent.includes("RecordBrief")`, read: ALL("#inboxRecords") },
  { id: "streaming reply, first paint and repaint", covers: { "mdHtml(draft": 2 }, words: ["StreamFirst", "StreamLater"], rich: "#view [data-stream] .md",
    setup: ``, act: `(async()=>{const d=(text)=>__ccDeliver({type:"chatDelta",tabId:tab.id,text});d(${J(MARK("StreamFirst") + " ")});await new Promise((r)=>setTimeout(r,150));d(${J(MARK("StreamLater"))});await new Promise((r)=>setTimeout(r,150))})()`,
    ready: `document.querySelector("#view [data-stream] .md")?.textContent.includes("StreamLater")`, read: ALL("#view [data-stream]") },
];

// Each scene starts from the same base state, with the page back on the chat and no card open.
async function walkScene(page: Page, scene: Scene) {
  const { ev, waitFor, tabA } = page;
  const pre = `const s=window.__ccSeed,tab=s.projects[0].tabs.find((x)=>x.id===${J(tabA)}),worker=tab.crew.find((x)=>!x.isLeader),W=worker.slot,now=Date.now(),
    run=(id,status,label,extra={})=>({runId:id,seatSlotId:W,seatName:worker.name,seatIsLeader:false,status,label,outcome:status==="working"?undefined:status,cli:"claude",model:"m",startedAt:now-5000,...(status==="working"?{}:{endedAt:now}),crewGenerationId:tab.processState.crewGenerationId,folderPath:"C:/x",...extra});`;
  await ev(`(()=>{document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));document.querySelector("[data-back-chat],[data-chat-live]")?.click();window.__ccSeed=structuredClone(window.__ccBase);${pre}${scene.setup};__ccDeliver({...structuredClone(s),type:"state"});return true})()`);
  if (scene.act) await ev(`(async()=>{${pre}${scene.act};return true})()`);
  try { await waitFor(`(()=>{${pre}return Boolean(${scene.ready})})()`, `${scene.id}: the place shows`); }
  catch (error) { assert.fail(`${(error as Error).message}; the page had: ${JSON.stringify(await ev(`({errors:window.__ccErrors,seats:[...document.querySelectorAll("#crew [data-seat-id]")].map((e)=>e.dataset.seatId),crew:document.querySelector("#crew")?.innerHTML.slice(0,200),view:document.querySelector("#view")?.innerHTML.slice(0,300)})`))}`); }
  const text: string = await ev(`(()=>{${pre}return ${scene.read}})()`);
  assert.ok(text && text.trim(), `${scene.id}: the page showed something`);
  for (const word of scene.words) assert.ok(text.includes(word), `${scene.id} keeps "${word}"; matched: ${text.slice(0, 300)}`);
  for (const bad of ["**", "`", "\u0000"]) assert.ok(!text.includes(bad), `${scene.id} shows a raw ${JSON.stringify(bad)}; matched: ${text.slice(0, 300)}`);
  if (scene.rich) assert.ok(await ev(`document.querySelectorAll(${J(`${scene.rich} strong`)}).length>0`), `${scene.id} is formatted (bold) where it can be`);
}

// The control: the same comparison on the real list with one claimed place taken away (or one call taken out of the source) must show a gap.
function inventoryGaps(found: Map<string, number>, scenes: Scene[]): string[] {
  const claimed = new Map<string, number>();
  for (const scene of scenes) for (const [key, count] of Object.entries(scene.covers)) claimed.set(key, (claimed.get(key) ?? 0) + count);
  return [...new Set([...found.keys(), ...claimed.keys()])].filter((key) => (found.get(key) ?? 0) !== (claimed.get(key) ?? 0)).map((key) => `${key}: source has ${found.get(key) ?? 0}, scenes cover ${claimed.get(key) ?? 0}`);
}

test("sweep: every call site of the renderer and the plain-label helpers is covered by a scene, and the control catches a missing one", () => {
  const found = callSites(APP_JS);
  assert.ok([...found.values()].reduce((sum, count) => sum + count, 0) >= 30, `the scan found the call sites: ${JSON.stringify([...found])}`);
  assert.deepEqual(inventoryGaps(found, SCENES), [], "every call site has exactly the scenes that cover it");
  for (const scene of SCENES.filter((item) => Object.keys(item.covers).length)) assert.ok(inventoryGaps(found, SCENES.filter((item) => item !== scene)).length > 0, `control: without "${scene.id}" the inventory shows a gap`);
  const first = [...found.keys()][0], removed = APP_JS.replace(first, "removedCall(");
  assert.ok(inventoryGaps(callSites(removed), SCENES).length > 0, `control: taking ${first} out of the source shows a gap`);
});

test("sweep: every scene, walked from the real page, shows no raw ** or backtick and keeps the words", async (t) => {
  if (skipped(t)) return;
  await withPage(async (page) => {
    await seedModelText(page.ev, page.tabA, page.tabB);
    await page.ev(`window.__ccBase=structuredClone(window.__ccSeed);window.__ccAll=(sel)=>[...document.querySelectorAll(sel)].map((el)=>[el,...el.querySelectorAll("*")].map((n)=>(n===el?n.textContent:"")+" "+n.getAttributeNames().filter((a)=>a!=="class"&&a!=="style").map((a)=>n.getAttribute(a)).join(" ")).join(" ")).join(" | ");true`);
    const walked: string[] = [];
    for (const scene of SCENES) { await walkScene(page, scene); walked.push(scene.id); }
    assert.deepEqual(walked, SCENES.map((scene) => scene.id), "every scene was walked");
  });
});

test("sweep (source): no model-text field (label, brief, title, body, task) reaches the page through a bare esc(), in any expression", () => {
  const { bare, scanned } = bareModelEscapes(APP_JS);
  assert.deepEqual(bare, [], "these still print model text with only esc()");
  // The control: the scan reads esc() calls (an empty scan from a renamed helper goes red), and it flags every shape a field can hide in.
  assert.ok(scanned >= 150, `the scan read ${scanned} esc() calls`);
  for (const shape of ["esc(row.brief ?? \"\")", "esc(item.run.label || \"a run\")", "esc(run ? run.label : \"\")", "esc(`${seat.name} · ${run.label}`)", "esc(selected.label)", "esc(seat.task)", "esc(request.title)"]) {
    assert.equal(bareModelEscapes(`const ICONS = 1;${shape}`).bare.length, 1, `control: the scan flags ${shape}`);
  }
  assert.equal(bareModelEscapes("const ICONS = 1;esc(`${run.seatName} · ${mdPlain(run.label)}`)").bare.length, 0, "control: a wrapped field is not flagged");
});
