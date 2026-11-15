import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SettingsService } from "../server/settings/service.ts";
import { CLI_CATALOG } from "../server/settings/cli-catalog.ts";
import { fixture, serviceFixture, request, cancel } from "./pack29-cli-install.setup.ts";

test("registered WebSocket handler drives real service and canonical reconnect/close-warning state", async () => {
  const fx = serviceFixture({ hold: true }), previous = process.env.CC_DATA_DIR;
  process.env.CC_DATA_DIR = fx.data;
  const state = await import("../server/main/state.ts");
  const config = await import("../server/config.ts");
  const { ChatStore } = await import("../server/chat-store.ts");
  const { RequestsStore } = await import("../server/requests.ts");
  const { handleMessage } = await import("../server/main/messages/index.ts");
  const { stateMessage } = await import("../server/main/broadcast.ts");
  state.setWorkspaces({ projects: [], selectedTabId: "" } as any); state.setSelectedTabId("");
  state.setSettingsService(fx.service); state.setAcpClis([]);
  state.setChatStore(new ChatStore(join(fx.data, "chats"))); state.setRequestsStore(new RequestsStore(fx.data));
  state.setClientPrefs(config.readClientPrefs()); state.setLaunchSafety({ blocked: [], uncertain: [], released: [], notices: [] } as any);
  const replies: any[] = [], ws = { readyState: 1, send: (raw: string) => replies.push(JSON.parse(raw)) } as any;
  const waitFor = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const found = replies.find((reply) => reply.requestId === id && ["actionResult", "error"].includes(reply.type));
      if (found) return found;
      await new Promise((done) => setTimeout(done, 5));
    }
    assert.fail(`No handler reply for ${id}: ${JSON.stringify(replies)}`);
  };
  try {
    handleMessage(ws, JSON.stringify({ ...request("qwen", "bad"), command: "hostile" }));
    assert.equal((await waitFor("bad")).type, "error"); assert.equal(fx.calls.length, 0);
    handleMessage(ws, JSON.stringify({ ...request("qwen", "no_confirm"), confirm: false }));
    assert.equal((await waitFor("no_confirm")).type, "error"); assert.equal(fx.calls.length, 0);
    handleMessage(ws, JSON.stringify(request()));
    await new Promise((done) => setImmediate(done));
    assert.equal((stateMessage() as any).settings.catalogTools.qwen.action.status, "running");
    assert.ok((stateMessage() as any).globalWork.includes("an installation may still be running"));
    handleMessage(ws, JSON.stringify(cancel("grok")));
    assert.equal((await waitFor("cancel1")).type, "error");
    await assert.rejects(fx.service.loginCli("qwen", "cannot_login", null), /Another/);
    fx.release(); assert.equal((await waitFor("install1")).type, "actionResult");
    assert.equal((stateMessage() as any).settings.catalogTools.qwen.action.status, "done");
    assert.equal((stateMessage() as any).globalWork.includes("an installation may still be running"), false);

  } finally {
    fx.release(); await fx.service.installer.drain(); fx.close();
    if (previous === undefined) delete process.env.CC_DATA_DIR; else process.env.CC_DATA_DIR = previous;
  }
});
