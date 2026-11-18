import test from "node:test";
import assert from "node:assert/strict";
import { plainOpencodeFailure, readApiResponse } from "../server/leader-opencode/errors.ts";

test("OpenCode failures never return response bodies or internal routes", async () => {
  const privateBody = "POST /session/ses_private credential-body";
  assert.equal(plainOpencodeFailure(privateBody, "prompt"), "OpenCode could not finish this turn. Try again.");
  await assert.rejects(readApiResponse(new Response(privateBody, { status: 500 }), "POST", "/session"),
    (error: Error) => { assert.equal(error.message, "OpenCode could not finish this turn. Try again."); return true; });
  assert.equal(await readApiResponse(new Response(null, { status: 204 }), "POST", "/session"), null);
});
