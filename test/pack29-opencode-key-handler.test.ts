import test from "node:test";
import assert from "node:assert/strict";
import { api, setup } from "./pack29-first-run.setup.ts";
import { keyFixture, KEY, begin, until } from "./pack29-opencode-key.setup.ts";

test("registered handlers keep key and capability private across two sockets and action recording", async (t) => {
  const ctx = setup(), fx = await keyFixture(t), other: any[] = [];
  const socket = [...api.state.clients][0];
  api.state.clients.add({ readyState: 1, bufferedAmount: 0, send: (raw: string) => other.push(JSON.parse(raw)) } as any);
  api.state.setSettingsService(fx.service);
  const dispatch = (message: any) => api.messages.handleMessage(socket, JSON.stringify(message));
  try {
    dispatch(begin());
    await until(() => ctx.replies.some((r) => r.type === "cliLoginState" && r.phase === "waitingKey"));
    assert.equal(fx.spawns.length, 0);
    const privateEvent = ctx.replies.find((r) => r.type === "cliLoginState" && r.loginId);
    const loginId = privateEvent.loginId;
    for (const invalid of [
      { type: "replaceCliLogin", requestId: "bad-replace", cli: "opencode", confirm: false },
      { type: "submitCliLoginKey", requestId: "bad-extra", cli: "opencode", loginId, apiKey: KEY, url: "bad" },
      { type: "submitCliLoginKey", requestId: "bad-owner", cli: "opencode", loginId: "f".repeat(48), apiKey: KEY },
      { type: "submitCliLoginKey", requestId: "bad-tool", cli: "codex", loginId, apiKey: KEY },
    ]) {
      dispatch(invalid);
      await until(() => ctx.replies.some((r) => r.type === "error" && r.requestId === invalid.requestId));
      assert.equal(fx.spawns.length, 0); assert.equal(fx.requests.length, 0);
      if (["bad-extra", "bad-tool", "bad-replace"].includes(invalid.requestId)) assert.equal(api.state.requestActions[invalid.requestId], undefined);
    }
    dispatch({ type: "getCliLoginState", requestId: "reload-key", cli: "opencode", loginId });
    dispatch({ type: "openCliLogin", requestId: "open-key", cli: "opencode", loginId });
    await until(() => ctx.replies.some((r) => r.type === "actionResult" && r.requestId === "open-key"));
    dispatch({ type: "submitCliLoginKey", requestId: "save-key", cli: "opencode", loginId, apiKey: KEY });
    await until(() => ctx.replies.some((r) => r.type === "actionResult" && r.requestId === "save-key"));
    assert.equal(fx.requests.length, 5);
    assert.equal(api.state.requestActions["save-key"].status, "done");
    assert.equal(other.some((r) => r.type === "cliLoginState"), false);
    assert.equal(JSON.stringify(other).includes(loginId), false);
    const allVisible = JSON.stringify([ctx.replies, other, api.state.requestActions, fx.service.snapshot()]);
    for (const secret of fx.secretValues()) assert.equal(allVisible.includes(secret), false, "no synthetic secret in emitted events/actions");
    dispatch({ type: "submitCliLoginKey", requestId: "terminal-key", cli: "opencode", loginId, apiKey: KEY });
    await until(() => ctx.replies.some((r) => r.type === "error" && r.requestId === "terminal-key"));
    assert.equal(fx.spawns.length, 1);
  } finally { await fx.close(); }
});
