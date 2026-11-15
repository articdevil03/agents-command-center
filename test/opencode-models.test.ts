import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseOpenCodeModelInfo, openCodeEfforts } from "../server/settings/opencode/models.ts";
import { modelOutput, noVendor } from "./opencode-models.setup.ts";

const raw = readFileSync(new URL("./fixtures/opencode-models-1.19.5.txt", import.meta.url), "utf8");
test("all 44 captured blocks match independently parsed metadata and exact variants", (t) => {
  noVendor(t);
  // Independent fixture oracle: column-zero closing braces delimit the vendor's
  // pretty-printed objects. The production parser walks strings and nesting.
  const blocks = raw.replace(/^\uFEFF/, "").trim().split(/\r?\n(?=[A-Za-z0-9._-]+\/)/);
  const expected = blocks.map((block) => {
    const newline = block.indexOf("\n"), value = block.slice(0, newline).trim();
    const body = JSON.parse(block.slice(newline + 1));
    return { value, providerID: body.providerID, modelID: body.id, displayName: body.name, variants: Object.keys(body.variants) };
  });
  assert.equal(expected.length, 44);
  assert.equal(expected.filter((item) => item.providerID === "opencode").length, 12);
  assert.equal(expected.filter((item) => item.providerID === "opencode-go").length, 32);
  assert.deepEqual(parseOpenCodeModelInfo(raw), expected);
  assert.deepEqual(parseOpenCodeModelInfo(`\uFEFF\x1b[32m${raw.replace(/^\uFEFF/, "")}\x1b[0m`), expected);
});
test("empty, truncated, malformed, poisoned and conflicting output rejects the entire catalogue", () => {
  const good = modelOutput();
  for (const bad of ["", " \n", "provider/model\n", good.slice(0, -3), good + "bad & echo poison\n",
    good.replace('"id": "model"', '"id": "different"'), good.replace('"providerID": "provider"', '"providerID": "other"'),
    good + modelOutput("provider/model", ["max"]), good.replace('"variants": {', '"variants": ['),
    good.replace('"none": {}', '"bad & variant": {}'), good + modelOutput("next/model").slice(0, -3),
    good + 'next/model\n{invalid json}\n']) {
    assert.equal(parseOpenCodeModelInfo(bad), null, bad.slice(-200));
  }
  assert.equal(parseOpenCodeModelInfo(good + good)?.length, 1);
});
test("no variants, literal none, tagged ids and braces in a name keep their meanings", () => {
  const models = parseOpenCodeModelInfo(modelOutput("provider/model:tag", []) + modelOutput())!;
  assert.ok(models);
  assert.deepEqual(openCodeEfforts(models, "provider/model:tag"), [""]);
  assert.deepEqual(openCodeEfforts(models, "provider/model"), ["", "none", "thinking"]);
  assert.deepEqual(openCodeEfforts(models, "custom/model"), [""]);
  assert.ok(parseOpenCodeModelInfo(modelOutput().replace('"name": "provider/model"', '"name": "braces { } and \\\"quoted\\\""')));
});
