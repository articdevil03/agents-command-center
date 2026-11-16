const store = "electron/cli-credentials.js", panel = "public/first-run/key-panel.js";
export const pack32UiMutations = [
  ["p32-ui-plaintext", store, 'if (!available()) throw new Error("Credential encryption unavailable.");', 'if (!available()) { io.writeFileSync(file, json); return; }'],
  ["p32-ui-atomic", store, 'io.renameSync(temp, file);', 'io.writeFileSync(file, encrypted); io.unlinkSync(temp);'],
  ["p32-ui-tool-validation", store, 'if (!toolValid(tool)) throw new Error("Invalid credential tool.");', '/* mutation: accepts unvalidated tools */'],
  ["p32-ui-record-log", store, 'available = store.available() === true;', 'console.log(message.record); available = store.available() === true;'],
  ["p32-ui-clear", panel, 'clearSecrets(panel); // Clear secrets before the send boundary, including failed or throwing sends.', '/* mutation: input retained through send */'],
  ["p32-ui-once", panel, 'if (busy(cli)) return;\n      const fields = {};', '/* mutation: repeated send admitted */\n      const fields = {};'],
  ["p32-ui-draft", panel, 'clearSecrets(panel); // Clear secrets before the send boundary, including failed or throwing sends.', 'localStorage.setItem("key-draft", JSON.stringify(fields)); clearSecrets(panel);'],
  ["p32-ui-connect", "server/settings/catalog-acp.ts", 'return sameProfile(cli, catalogProfile(entry)) && status?.installed === true', 'return status?.signedIn === true && sameProfile(cli, catalogProfile(entry)) && status?.installed === true'],
  ["p32-ui-key-focus", "public/first-run/key-panel.js", "input.dataset.focusKey = `${surface}-key-${cli}-${field.id}`;", "/* mutation: no key input focus key */"],
  ["p32-ui-failure-fields", "public/first-run/key-panel.js", "clearSecrets(panel); // Clear secrets before the send boundary, including failed or throwing sends.", "clear(panel); // mutation: loses non-secret fields on failure"],
  ["p32-ui-parent-link", "electron/cli-credentials.js", "if (io.realpathSync(parent).toLowerCase() !== parent.toLowerCase()) throw new Error(\"Unsafe credential directory.\");", "/* mutation: parent link accepted */"],
  ["p32-ui-stale-temp", "electron/cli-credentials.js", "if (stat.isFile() && !stat.isSymbolicLink()) io.unlinkSync(stale);", "/* mutation: stale temp retained */"],
  ["p32-fix-get-failure", store, 'if (error?.code === "ENOENT") return null;\n        throw new Error("Could not read credential safely.");', 'return null;'],
  ["p32-fix-locked-sweep", store, 'catch { /* A locked leftover must not block the save. */ }', 'catch (error) { throw error; }'],
  ["p32-fix-stale-link", store, "if (stat.isFile() && !stat.isSymbolicLink()) io.unlinkSync(stale);", "if (stat.isFile() || stat.isSymbolicLink()) io.unlinkSync(stale);"],
  ["p32-fix-placeholder", panel, "if (field.placeholder) input.placeholder = field.placeholder;", "/* mutation: no placeholder */"],
  ["p32-fix-panel-trim", panel, 'input.dataset.secret || input.tagName === "SELECT" ? input.value : input.value.trim();', "input.value;"],
  ["p32-fix-key-saved-text", "public/app/11-settings-render.js", 'tool.keySaved === true && tool.signedIn !== true ? "Installed · Key saved" : ', ""],
];
export const pack32UiCatchMap = Object.fromEntries(pack32UiMutations.map(([id]) => [id, id === "p32-ui-connect" ? "test/pack32-key-connect.test.ts" : ["p32-ui-clear", "p32-ui-once", "p32-ui-draft"].includes(id) ? "test/pack32-key-page.test.ts" : "test/pack32-key-electron.test.ts"]));

Object.assign(pack32UiCatchMap, {"p32-ui-key-focus": "test/pack32-key-page.test.ts", "p32-ui-failure-fields": "test/pack32-key-page.test.ts", "p32-ui-parent-link": "test/pack32-key-electron.test.ts", "p32-ui-stale-temp": "test/pack32-key-electron.test.ts"});

Object.assign(pack32UiCatchMap, {"p32-fix-get-failure": "test/pack32-key-electron.test.ts", "p32-fix-locked-sweep": "test/pack32-key-electron.test.ts", "p32-fix-stale-link": "test/pack32-key-electron.test.ts", "p32-fix-placeholder": "test/pack32-key-page.test.ts", "p32-fix-panel-trim": "test/pack32-key-page.test.ts", "p32-fix-key-saved-text": "test/pack32-key-page.test.ts"});
