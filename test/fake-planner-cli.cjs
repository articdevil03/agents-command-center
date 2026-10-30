// A fake planner CLI for the pack 18 end-to-end test: a node script standing in for any agent CLI. It does what a real agent does with the crew tools:
// reads CC_CREW_URL and CC_CREW_TOKEN from its environment and calls the real bridge over HTTP (JSON-RPC tools/call).
// argv[2] is the folder that holds <tab folder name>.plan.json (the plan), and receives .session.json (url, token: written first) and .result.json (after every step).
// A step is { call, args, save? } | { parallel: [steps] } | { sleep: ms }; "{{TOKEN}}" and "{{RUN:name}}" in the arguments are filled in.
const fs = require("fs");
const path = require("path");
const url = process.env.CC_CREW_URL, token = process.env.CC_CREW_TOKEN;
const base = path.join(process.argv[2], path.basename(process.cwd()));
if (!fs.existsSync(base + ".plan.json")) process.exit(0);
fs.writeFileSync(base + ".session.json", JSON.stringify({ url, token }));
const plan = JSON.parse(fs.readFileSync(base + ".plan.json", "utf8"));
const results = [], named = {};
let nextId = 1;
const save = () => fs.writeFileSync(base + ".result.json", JSON.stringify(results));
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body, text };
}
const sub = (v) => typeof v === "string" ? v.replace(/\{\{TOKEN\}\}/g, token).replace(/\{\{RUN:(\w+)\}\}/g, (_, n) => named[n] ?? "missing")
  : Array.isArray(v) ? v.map(sub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v;
async function one(step) {
  const res = await rpc("tools/call", { name: step.call, arguments: sub(step.args ?? {}) });
  const text = res.body?.result?.content?.[0]?.text ?? res.text;
  if (step.save) named[step.save] = /as run (\S+)/.exec(text)?.[1];
  return { call: step.call, status: res.status, isError: res.body?.result?.isError === true, text };
}
(async () => {
  for (const step of plan) {
    if (step.sleep) await nap(step.sleep);
    else if (step.parallel) results.push(...await Promise.all(step.parallel.map(one)));
    else results.push(await one(step));
    save();
  }
})().catch((e) => { results.push({ error: String(e) }); save(); });
