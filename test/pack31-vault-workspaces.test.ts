import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { withServer } from "./pack12-server-helpers.ts";
import { BROAD_VAULT_MESSAGE } from "../server/vault.ts";

// The real app registers its project and tab folders with the vault check when the workspaces load (server/main/state.ts).
// Only a real server shows that wiring: the project folder itself is refused as a vault, a sibling folder is accepted.
// (The parent of the work folder also holds this test server's home folder, so it would be refused for that reason alone; the project folder is refused only by the wiring.)
test("real server: a vault that is the project folder is refused, a sibling folder is accepted", { timeout: 60000 }, async () => {
  await withServer({}, async (server, c) => {
    const action = (requestId: string) => c.state().settings.preferenceAction?.requestId === requestId ? c.state().settings.preferenceAction : undefined;
    const sibling = join(dirname(server.work), "notes-vault");
    mkdirSync(sibling, { recursive: true });
    c.send({ type: "setNotesVault", requestId: "vault-project", path: server.work });
    await c.wait(() => action("vault-project")?.status === "failed", "project folder refused");
    assert.equal(action("vault-project")?.message, BROAD_VAULT_MESSAGE);
    assert.equal(c.state().settings.vault.path, null, "a refused vault is never saved");
    c.send({ type: "setNotesVault", requestId: "vault-sibling", path: sibling });
    await c.wait(() => c.state().settings.vault.path === sibling, "sibling folder connected");
    assert.equal(c.state().settings.vault.status, "connected");
  });
});
