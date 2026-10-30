import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { appSource } from "./source-text.ts";
import { J, type Page, withPage, skipped, FENCE, REPLY, history, summary } from "./pack10-markdown-helpers.ts";

test("a leader reply shows its formatting as real tags, every supported construct, and no raw ** outside a code block", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, shot }) => {
    await ev(history(tabA, [{ role: "user", text: "hi", at: 1_700_000_000_000, revision: 1 }, { role: "assistant", text: REPLY, at: 1_700_000_001_000, revision: 2 }]));
    await waitFor(`document.querySelectorAll("#view .msg").length===2`, "both messages render");
    const got = await ev(summary);
    assert.deepEqual({ ...got, text: undefined }, {
      headings: ["Where we are"], strong: ["built", "this"], em: ["tested"], inlineCode: ["public/app.js", "code"], fenced: ['const x = "**not bold** <b>x</b>";'], lists: 2, nested: 1,
      numbered: ["First step", "Second step"], quote: ["a quoted note"], links: [["https://example.com/a_b_c?x=1&y=2", "_blank", "noopener noreferrer", "the docs"]], stars: false, text: undefined,
    }, `matched: ${JSON.stringify(got)}`);
    assert.ok(got.text.includes("snake_case_name stays and so does C:/a/_b_/c"), `words with underscores and paths stay as typed: ${got.text}`);
    assert.equal(await ev(`document.querySelectorAll("#view .msg:not(.mine) .md em").length`), 1, "the only italic is the one asked for (snake_case, paths and URLs made none)");
    await shot("a-leader-reply-light.png");
    await ev(`document.body.classList.remove("light");true`);
    await shot("b-leader-reply-dark.png");
    await ev(`document.body.classList.add("light");true`);
  });
});

test("model text never becomes live html; a user message with ** stays exactly as typed", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    const hostile = [
      "<script>window.__pwn=1</script>", "<img src=x onerror=window.__pwn=2>", "[x](javascript:alert(1))", '<a href="https://evil.example">click</a>', "<!-- hidden -->",
      "[data](data:text/html,hi) [rel](//evil.example) [file](file:///c:/x)", FENCE, "**no** <b>x</b> [l](https://e.example)", FENCE, "",
    ].join("\n");
    await ev(history(tabA, [{ role: "user", text: "**x** and `y` and <b>z</b>", at: 1_700_000_000_000, revision: 1 }, { role: "assistant", text: hostile, at: 1_700_000_001_000, revision: 2 }]));
    await waitFor(`document.querySelectorAll("#view .msg").length===2`, "both render");
    const got = await ev(`(()=>{const m=document.querySelector("#view .msg:not(.mine) .md");return {script:m.querySelectorAll("script").length,img:m.querySelectorAll("img").length,a:m.querySelectorAll("a").length,
      tags:[...m.querySelectorAll("*")].map((e)=>e.tagName.toLowerCase()).filter((n,i,all)=>all.indexOf(n)===i).sort(),comment:m.innerHTML.includes("<!--"),pwn:window.__pwn??null,text:m.textContent,
      fencedInert:m.querySelector("pre.md-code code").children.length,fenced:m.querySelector("pre.md-code code").textContent}})()`);
    assert.deepEqual([got.script, got.img, got.a, got.comment, got.pwn, got.fencedInert], [0, 0, 0, false, null, 0], `matched: ${JSON.stringify(got)}`);
    assert.deepEqual(got.tags, ["br", "code", "p", "pre"], `only fixed tags exist; matched: ${JSON.stringify(got.tags)}`);
    for (const text of ["<script>window.__pwn=1</script>", "<img src=x onerror=window.__pwn=2>", "[x](javascript:alert(1))", '<a href="https://evil.example">click</a>', "<!-- hidden -->", "[data](data:text/html,hi)", "[rel](//evil.example)", "[file](file:///c:/x)"]) assert.ok(got.text.includes(text), `${text} stays inert text; matched: ${got.text}`);
    assert.equal(got.fenced, "**no** <b>x</b> [l](https://e.example)", "markdown inside a code block is shown as typed");
    const mine = await ev(`(()=>{const p=document.querySelector("#view .msg.mine .bubble p");return {text:p.textContent,kids:p.children.length}})()`);
    assert.deepEqual(mine, { text: "**x** and `y` and <b>z</b>", kids: 0 }, "your own message is plain text exactly as typed");
  });
});

test("a lone ** while streaming is shown as text and never swallows the rest of the reply", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await ev(history(tabA, [{ role: "user", text: "go", at: 1_700_000_000_000, revision: 1 }]));
    await waitFor(`document.querySelectorAll("#view .msg").length===1`, "history");
    const delta = (text: string) => ev(`__ccDeliver({type:"chatDelta",tabId:${J(tabA)},text:${J(text)}});true`);
    await delta("Half **bold");
    await waitFor(`document.querySelector("#view [data-stream] .md")?.textContent==="Half **bold"`, "an unclosed marker is shown as text");
    assert.equal(await ev(`document.querySelectorAll("#view [data-stream] .md strong").length`), 0, "no bold from a lone **");
    await delta(`

- item one
- item **two**

${FENCE}
code **here**`);
    await waitFor(`document.querySelectorAll("#view [data-stream] .md li").length===2`, "the list after an unclosed marker still renders");
    assert.equal(await ev(`document.querySelector("#view [data-stream] .md").textContent.includes(${J(FENCE)})`), true, "an unclosed fence stays as text");
    assert.equal(await ev(`document.querySelectorAll("#view [data-stream] .md pre").length`), 0, "no code block from an unclosed fence");
  });
});

test("the streaming reply renders exactly like the final message", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await ev(history(tabA, [{ role: "user", text: "go", at: 1_700_000_000_000, revision: 1 }]));
    await waitFor(`document.querySelectorAll("#view .msg").length===1`, "history");
    const delta = (text: string) => ev(`__ccDeliver({type:"chatDelta",tabId:${J(tabA)},text:${J(text)}});true`);
    const full = "Half **bold more**\n\n- item one\n- item **two**\n\n" + REPLY;
    await delta(full.slice(0, 40)); await delta(full.slice(40));
    await waitFor(`document.querySelector("#view [data-stream] .md")?.textContent.includes("snake_case_name")`, "the whole draft is painted");
    const streamed = await ev(`document.querySelector("#view [data-stream] .md").innerHTML`);
    await ev(`__ccDeliver({type:"chatMessage",tabId:${J(tabA)},role:"assistant",text:${J(full)},at:1_700_000_002_000,revision:2});__ccDeliver({type:"chatDone",tabId:${J(tabA)},revision:2,savedRevision:2});true`);
    await waitFor(`document.querySelector("#view [data-stream]")===null&&document.querySelectorAll("#view .msg").length===2`, "the final message replaces the draft");
    const final = await ev(`document.querySelector("#view .msg:not(.mine) .md").innerHTML`);
    assert.ok(streamed.includes("<strong>") && streamed.includes("<ul>") && streamed.includes("<pre"), `the draft has real tags: ${streamed.slice(0, 120)}`);
    assert.equal(final, streamed, "the final message has exactly the draft's html");
  });
});

const EDGE = [
  "Match **/*.js and **/*.ts, then *.js and test*.ts, or C:\\foo\\*bar*\\x.", "",
  "Run [run `npm test`](https://example.com/a?x=1) or [plain](https://example.com/`b`).", "",
  "3. third", "4. fourth", "", "## C#", "", "## Title ##",
].join("\n");

test("globs and paths keep their stars, a link label can hold code, a list keeps its first number, a heading keeps its #", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA, shot }) => {
    await ev(history(tabA, [{ role: "user", text: "hi", at: 1_700_000_000_000, revision: 1 }, { role: "assistant", text: EDGE, at: 1_700_000_001_000, revision: 2 }]));
    await waitFor(`document.querySelectorAll("#view .msg").length===2`, "both messages render");
    const got = await ev(`(()=>{const m=[...document.querySelectorAll("#view .msg:not(.mine) .md")].at(-1);return {html:m.innerHTML,text:m.textContent,nul:m.innerHTML.includes("\\u0000"),
      links:[...m.querySelectorAll("a")].map((a)=>[a.getAttribute("href"),a.innerHTML]),ol:[...m.querySelectorAll("ol")].map((o)=>[o.getAttribute("start"),o.textContent]),heads:[...m.querySelectorAll(".md-h")].map((h)=>h.textContent)}})()`);
    assert.ok(got.text.includes("Match **/*.js and **/*.ts, then *.js and test*.ts, or C:\\foo\\*bar*\\x."), `glob and path stars stay as typed: ${got.text}`);
    assert.ok(!/<(?:strong|em)>/.test(got.html.split("<ol")[0].split("</p>")[0]), `no bold or italic made inside the glob line: ${got.html.slice(0, 300)}`);
    assert.equal(got.nul, false, "no placeholder character reaches the page");
    assert.deepEqual(got.links, [["https://example.com/a?x=1", "run <code>npm test</code>"], ["https://example.com/`b`", "plain"]], `link label parsed on its own, URL exactly as written; matched: ${JSON.stringify(got.links)}`);
    assert.deepEqual(got.ol, [["3", "thirdfourth"]], `the list starts at 3; matched: ${JSON.stringify(got.ol)}`);
    assert.deepEqual(got.heads, ["C#", "Title"], `closing hashes go only after a space; matched: ${JSON.stringify(got.heads)}`);
    await shot("d-fixes.png");
  });
});

// Nested emphasis whose closers touch: one run of 3 closes a 1 and a 2. Each input is checked as html (a leader reply) and as a plain label (the crew rail).
// Third column: the same text as a plain label. A triple opener closed in two steps, and a dotfile in bold, count here too.
const NESTED: [string, string, string][] = [
  ["**bold *italic***", "<strong>bold <em>italic</em></strong>", "bold italic"],
  ["*italic **bold***", "<em>italic <strong>bold</strong></em>", "italic bold"],
  ["__bold _italic___", "<strong>bold <em>italic</em></strong>", "bold italic"],
  ["***both***", "<strong><em>both</em></strong>", "both"],
  ["**bold with *italic* inside**", "<strong>bold with <em>italic</em> inside</strong>", "bold with italic inside"],
  ["***bold** italic*", "<em><strong>bold</strong> italic</em>", "bold italic"],
  ["***bold* more**", "<strong><em>bold</em> more</strong>", "bold more"],
  ["**bold***", "<strong>bold</strong>*", "bold*"],
  ["**.env** and **.gitignore**", "<strong>.env</strong> and <strong>.gitignore</strong>", ".env and .gitignore"],
  ["*.gitignore* is ignored", "<em>.gitignore</em> is ignored", ".gitignore is ignored"],
];

test("nested emphasis with adjacent closers renders balanced tags, in a reply and as plain words in a label", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    const messages = [{ role: "user", text: "hi", at: 1, revision: 1 }, ...NESTED.map(([text], index) => ({ role: "assistant", text, at: 2 + index, revision: 2 + index }))];
    await ev(history(tabA, messages));
    await waitFor(`document.querySelectorAll("#view .msg").length===${messages.length}`, "all replies render");
    const got = await ev(`[...document.querySelectorAll("#view .msg:not(.mine) .md")].map((m)=>m.innerHTML)`);
    assert.deepEqual(got, NESTED.map(([, html]) => `<p>${html}</p>`), `matched: ${JSON.stringify(got)}`);
    const plain = await ev(`(()=>{const s=window.__ccSeed,tab=s.projects[0].tabs.find((x)=>x.id===${J(tabA)}),worker=tab.crew.find((x)=>!x.isLeader);worker.status="working";tab.runs=[];
      const out=[];for(const text of ${J(NESTED.map(([text]) => text))}){worker.task=text;__ccDeliver({...structuredClone(s),type:"state"});out.push(document.querySelector('#statusBtn .pt')?.textContent??null)}return out})()`);
    assert.equal(plain.length, NESTED.length);
    for (const [index, label] of plain.entries()) assert.ok(typeof label === "string" && label.endsWith(` ${NESTED[index][2]}`), `${NESTED[index][0]} as a plain label keeps its words and shows no marker; matched: ${JSON.stringify(label)}`);
  });
});

// The renderer's emphasis pass, cut out of the page source and run here: random strings of markers, letters and spaces must never throw and always give balanced, properly nested strong/em tags.
function emphasisPass(): (text: string, plain: boolean) => string {
  const source = appSource();
  const start = source.indexOf("const mdSpace"), end = source.indexOf("// Code spans and links");
  assert.ok(start > 0 && end > start, `control: the emphasis pass was found (${start}..${end})`);
  return new Function(`${source.slice(start, end)};return mdEmphasis;`)() as (text: string, plain: boolean) => string;
}

test("emphasis opens before a dot but wildcards and dotted runs stay as typed (the renderer run directly)", () => {
  const emphasis = emphasisPass();
  const literal = ["*.js and test*.ts", "**/*.js", "src/**/*.ts", "C:\\foo\\*bar*\\x", "*.{js,ts}", "ver.*beta*", "**.js and test**.ts"];
  for (const text of literal) assert.equal(emphasis(text, false), text, `${text} stays as typed`);
  assert.equal(emphasis("I said *this*.", false), "I said <em>this</em>.", "a closer before a sentence dot still closes");
  assert.equal(emphasis("**.env** and **.gitignore**", true), ".env and .gitignore");
});

test("emphasis never throws and always makes balanced, properly nested tags (100000 random strings)", () => {
  const emphasis = emphasisPass();
  const pieces = ["*", "**", "***", "_", "__", "a", "b", " ", "a", " "];
  let seed = 12345, made = 0, tagged = 0;
  const random = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let round = 0; round < 100_000; round += 1) {
    let text = ""; for (let n = 1 + random(14); n > 0; n -= 1) text += pieces[random(pieces.length)];
    const html = emphasis(text, false), label = emphasis(text, true);
    const open: string[] = [];
    for (const [, slash, name] of html.matchAll(/<(\/?)(strong|em)>/g)) {
      if (!slash) open.push(name); else assert.equal(open.pop(), name, `tags nest properly for ${JSON.stringify(text)}: ${html}`);
    }
    assert.equal(open.length, 0, `every tag closes for ${JSON.stringify(text)}: ${html}`);
    assert.ok(!/<|>/.test(label) && label.replace(/[*_]/g, "") === html.replace(/<[^>]+>/g, "").replace(/[*_]/g, ""), `the plain label has no tags and the same words for ${JSON.stringify(text)}: ${label}`);
    made += 1; if (html !== text) tagged += 1;
  }
  assert.equal(made, 100_000);
  assert.ok(tagged > 10_000, `control: many random strings really got emphasis (${tagged})`);
});

// The finished message's html is kept: String.prototype.split("\n") on a reply holding the probe word is the renderer's first step, so it counts renders of that message.
test("a finished message is not rendered again by a later repaint (the per-message html cache hits)", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await ev(`window.__splits=0;const __split=String.prototype.split;String.prototype.split=function(sep,...rest){if(sep==="\\n"&&this.includes("CacheProbeWord"))window.__splits+=1;return __split.call(this,sep,...rest)};true`);
    await ev(history(tabA, [{ role: "user", text: "go", at: 1, revision: 1 }, { role: "assistant", text: "A **CacheProbeWord** reply", at: 2, revision: 2 }]));
    await waitFor(`document.querySelectorAll("#view .msg").length===2`, "history");
    const first = await ev("window.__splits");
    assert.ok(first >= 1, `control: the first paint of the reply counted (${first})`);
    const bold = `document.querySelector("#view .msg:not(.mine) .md strong")?.textContent==="CacheProbeWord"`;
    for (let round = 0; round < 3; round += 1) {
      await ev(`__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});__ccDeliver({type:"chatDelta",tabId:${J(tabA)},text:"streaming ${round} "});true`);
      await waitFor(`document.querySelector("#view [data-stream] .md")?.textContent.includes("streaming ${round}")`, `repaint ${round}`);
    }
    assert.equal(await ev(bold), true, "the reply is still on the page");
    assert.equal(await ev("window.__splits"), first, "state updates and streaming repaints left the finished reply's html alone");
  });
});

// Unmatched markers by the tens of thousands: the old lazy regexes took ~0.4 s per 16k on this input and grew with its square.
test("emphasis parsing is linear: tens of thousands of unmatched markers paint in well under the bound", async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, tabA }) => {
    await ev(history(tabA, [{ role: "user", text: "go", at: 1_700_000_000_000, revision: 1 }]));
    await waitFor(`document.querySelectorAll("#view .msg").length===1`, "history");
    const cases: [string, string][] = [
      ["open markers", "**a ".repeat(64_000)],
      ["closers with no opener of their size", "*a ".repeat(32_000) + "b** ".repeat(32_000)],
      ["half-written links", "[a](http://b".repeat(32_000)],
      ["underscores", "_a ".repeat(64_000)],
    ];
    const times: string[] = [];
    for (const [name, text] of cases) {
      const got = await ev(`(()=>{const tab=${J(tabA)};const t0=performance.now();window.__ccHistory[tab]=[{role:"user",text:"go",at:1,revision:1},{role:"assistant",text:${J(text)},at:2,revision:2}];window.__socket.history(tab);
        return {ms:performance.now()-t0,rendered:document.querySelectorAll("#view .msg").length}})()`);
      times.push(`${name}: ${Math.round(got.ms)} ms`);
      assert.equal(got.rendered, 2, `${name}: the reply painted inside the measured call`);
      assert.ok(got.ms < 1500, `${name}: ${text.length} characters took ${Math.round(got.ms)} ms (bound 1500); all: ${times.join(", ")}`);
    }
    t.diagnostic(times.join("; "));
  });
});
