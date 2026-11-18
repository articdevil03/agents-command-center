import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// The vendored template is read through module resolution, so this also works from a disposable copy of the repo.
const templates = join(dirname(createRequire(import.meta.url).resolve("app-builder-lib/package.json")), "templates", "nsis");

test("first install skips the process check, while upgrade, reinstall and uninstall keep it", () => {
  const hook = readFileSync("build/installer-lifecycle.nsh", "utf8").replace(/\r\n/g, "\n");
  const macro = hook.slice(hook.indexOf("!macro customCheckAppRunning"), hook.indexOf("!macroend"));
  const D = "$", B = String.fromCharCode(92); // dollar and backslash, written without escapes
  const guard = [D, "{If} ", D, "{FileExists} \"", D, "INSTDIR", B, D, "{APP_EXECUTABLE_FILENAME}\""].join("");
  assert.equal(macro.split(guard).length - 1, 1, "exact-path existence guard found once (data, not a prefix or a pattern)");
  const guardAt = macro.indexOf(guard), run = macro.indexOf("nsExec::ExecToStack");
  assert.ok(guardAt >= 0 && run > guardAt, "the PowerShell check sits inside the guard");
  assert.match(macro.slice(guardAt), /\n  \$\{EndIf\}\s*$/, "the guard closes the whole macro body");
  // The same macro serves install, reinstall over an existing install and uninstall through the template.
    assert.match(readFileSync(join(templates, "installSection.nsh"), "utf8"), /!insertmacro CHECK_APP_RUNNING/);
  assert.match(readFileSync(join(templates, "uninstaller.nsh"), "utf8"), /Function un\.checkAppRunning\s+!insertmacro CHECK_APP_RUNNING/);
  assert.match(macro, /SetErrorLevel 6\s+Quit/, "inspection failure still refuses when an app exists");
  assert.match(readFileSync("README.md", "utf8"), /Windows blocks the helper script, setup and uninstall stop without changing anything/);
});
