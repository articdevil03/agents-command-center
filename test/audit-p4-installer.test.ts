import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { tmpdir } from "node:os";

const source = readFileSync(process.env.CC_P4_INSTALLER_SOURCE ?? "build/installer.nsh", "utf8").replaceAll("\r\n", "\n");
const cache = process.env.CC_P4_NSIS_DIR ?? join(process.env.LOCALAPPDATA!, "electron-builder/Cache/nsis-3.0.4.1");
function findCompiler(folder: string): string | undefined {
  if (!existsSync(folder)) return;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const file = join(folder, entry.name);
    if (entry.name.toLowerCase() === "makensis.exe") return file;
    if (entry.isDirectory()) { const found = findCompiler(file); if (found) return found; }
  }
}
const compiler = process.platform === "win32" ? findCompiler(cache) : undefined;
let temp: string, exe: string;
// Exact owned entries only; refuse links rather than traversing them during cleanup.
function clean(folder: string) {
  assert.ok(!lstatSync(folder).isSymbolicLink());
  for (const leaf of readdirSync(folder)) {
    const file = join(folder, leaf), info = lstatSync(file);
    assert.ok(!info.isSymbolicLink(), `unexpected cleanup link: ${file}`);
    if (info.isDirectory()) clean(file); else unlinkSync(file);
  }
  assert.deepEqual(readdirSync(folder), []); rmdirSync(folder);
}
before(() => {
  if (!compiler) return;
  temp = mkdtempSync(join(tmpdir(), "cc-p4-installer-test-")); exe = join(temp, "guard.exe");
  // Retarget a real ancestor at the boundary between the two production checks.
  const swap = String.raw`
  ReadEnvStr $R8 CC_P4_SWAP
  ${"${If}"} $R8 != ""
    System::Call 'kernel32::RemoveDirectoryW(w R8) i.R7'
    System::Call 'kernel32::MoveFileW(w "$R8-next", w R8) i.R7'
  ${"${EndIf}"}
  ReadEnvStr $R8 CC_P4_INJECT_LINK
  ${"${If}"} $R8 != ""
    ReadEnvStr $R7 CC_P4_STAGED_LINK
    System::Call 'kernel32::MoveFileW(w R7, w R8) i.R7'
  ${"${EndIf}"}
`;
  const resolutionFailure = [
    '  ReadEnvStr $4 CC_P4_FAIL_RESOLVE', '  ${If} $4 == "1"', '    StrCpy $3 0', '  ${EndIf}',
    '  ${If} $3 == 0',
  ].join("\n");
  writeFileSync(join(temp, "installer.nsh"), source.replaceAll('$APPDATA\\${APP_PACKAGE_NAME}', '$R9\\${APP_PACKAGE_NAME}')
    .replace('  ; Pin both resolved roots', swap + '  ; Pin both resolved roots')
    // Fake only the native API failure result; execute the real refusal branch.
    .replace('  ${If} $3 == 0', resolutionFailure)
    .replace('  Pop $2\n  ${If} $3 == -1', '  Pop $2\n  ReadEnvStr $1 CC_P4_FAIL_ATTRIBUTES\n  ${If} $1 == "1"\n    StrCpy $3 -1\n    StrCpy $2 5\n  ${EndIf}\n  ${If} $3 == -1')
    .replace('  FindFirst $1 $2 "$0\\*"', '  FindFirst $1 $2 "$0\\*"\n  ReadEnvStr $3 CC_P4_FAIL_FIND\n  ${If} $3 == "1"\n    FindClose $1\n    SetErrors\n  ${EndIf}')
    .replace('  Pop $R0\n  Push $R1', '  Pop $R0\n  ReadEnvStr $R8 CC_P4_EMPTY_ROOT\n  ${If} $R8 == "install"\n    StrCpy $R0 ""\n  ${EndIf}\n  Push $R1')
    .replace('  Pop $R1\n  ${If} $ccUnsafeInstall', '  Pop $R1\n  ReadEnvStr $R8 CC_P4_EMPTY_ROOT\n  ${If} $R8 == "data"\n    StrCpy $R1 ""\n  ${EndIf}\n  ${If} $ccUnsafeInstall'));

  writeFileSync(join(temp, "guard.nsi"), String.raw`
Unicode true
!define APP_PACKAGE_NAME "command-center-p29test"
!include "${join(temp, "installer.nsh")}"
Name "P4 disposable guard"
OutFile "${exe}"
RequestExecutionLevel user
SilentInstall silent
Function .onInit
  ReadEnvStr $INSTDIR CC_P4_INSTALL
  ReadEnvStr $R9 CC_P4_DATA
  ReadEnvStr $R8 CC_P4_RESOLVE_ONLY
  ${"${If}"} $R8 == "1"
    Push $INSTDIR
    Call ccResolveInstallPath
    Pop $R7
    ReadEnvStr $R8 CC_P4_LOG
    FileOpen $R8 $R8 w
    FileWrite $R8 $R7
    FileClose $R8
    SetErrorLevel 0
    Quit
  ${"${EndIf}"}
  !insertmacro customInit
  SetErrorLevel 0
  Quit
FunctionEnd
Section
SectionEnd
`);
  const compiled = spawnSync(compiler, ["/V2", join(temp, "guard.nsi")], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});
after(() => { if (temp) clean(temp); });

test("installer resolves both roots with native handles and preserves link-safe uninstall", () => {
  assert.match(source, /GetFinalPathNameByHandleW/);
  assert.match(source, /Call ccResolveInstallPath\s+Pop \$R0/);
  assert.match(source, /Call ccResolveInstallPath\s+Pop \$R1/);
  assert.match(source, /Call ccCheckInstallTree/);
  assert.match(source, /\$R4 != \$R0/);
  assert.match(source, /\$R5 != \$R1/);
  const hook = readFileSync("build/installer-lifecycle.nsh", "utf8");
  const tools = readFileSync("build/installer-tools.ps1", "utf8");
  assert.match(hook, /-File "\$PLUGINSDIR\\installer-tools\.ps1"/);
  assert.match(tools, /\$record.owner -cne 'com.agents.command-center'/);
  assert.match(tools, /\$record.entry -cne \$entry.Name/);
  assert.match(tools, /if \(\$item.Attributes -band \[IO.FileAttributes\]::ReparsePoint\)\s*\{\s*if \(\$item.PSIsContainer\) \{ \[IO.Directory\]::Delete\(\$Path, \$false\)/);
  assert.doesNotMatch(source + hook + tools, /cmd\.exe|rd \/s|Remove-Item[^\r\n]*-Recurse/i);
  assert.doesNotMatch(tools, /\$env:APPDATA\b|command-center[\\/]/);
});

const cases = [
  ["linked ancestor above a missing install leaf succeeds", "ancestor", 0],
  ["missing future data and install leaves succeed", "missing", 0],
  ["case-insensitive aliased equal data root is refused", "equal", 3],
  ["aliased child of saved data is refused", "inside", 3],
  ["saved-data alias hiding equal real install is refused", "data-alias", 3],
  ["saved-data alias hiding containing real install is refused", "data-containing", 3],
  ["resolved install containing saved data is refused", "contains", 3],
  ["similarly prefixed sibling is allowed", "sibling", 0],
  ["link at install root is refused", "root-link", 3],
  ["link inside existing install is refused", "inner-link", 3],
  ["link replacing managed tools does not block app setup", "tools-link", 0],
  ["link replacing managed app folder does not block app setup", "app-link", 0],
  ["changed ancestor root between checks is refused", "root-change", 3],
  ["changed saved-data ancestor between checks is refused", "data-root-change", 3],
  ["link inserted between tree checks is refused", "tree-change", 3],
  ["native path resolution failure refuses safely", "resolution-failure", 3],
  ["install enumeration failure refuses safely", "find-failure", 3],
  ["empty resolved install root refuses safely", "empty-install", 3],
  ["empty resolved data root refuses safely", "empty-data", 3],
  ["install attribute access failure refuses safely", "attribute-failure", 3],
  ["install tree entry budget refuses safely", "entry-budget", 3],
] as const;
for (const [title, mode, expected] of cases) test(title, { skip: !compiler && "cached Windows NSIS compiler unavailable" }, () => {
  const folder = join(temp, mode); mkdirSync(folder);
  const target = join(folder, "target"); mkdirSync(target);
  const sentinel = join(target, "SENTINEL"); writeFileSync(sentinel, "external target survives");
  const roaming = join(folder, "roaming"), local = join(folder, "local"); mkdirSync(roaming); mkdirSync(local);
  const data = join(roaming, "command-center-p29test"); mkdirSync(data);
  const alias = join(folder, "alias"); symlinkSync(roaming, alias, "junction");
  let install = join(folder, "installed");
  const links = [alias];
  try {
    if (mode === "ancestor") install = join(alias, "installed");
    if (mode === "equal") install = join(alias, "COMMAND-CENTER-P29TEST");
    if (mode === "inside") install = join(alias, "command-center-p29test", "future", "leaf");
    if (mode === "data-alias") install = data;
    if (mode === "data-containing") install = roaming;
    if (mode === "contains") install = roaming;
    if (mode === "sibling") install = join(alias, "command-center-p29test Other");
    if (mode === "missing") { rmdirSync(data); install = join(folder, "future", "leaf"); }
    if (mode === "root-change") { install = join(alias, "installed"); symlinkSync(target, alias + "-next", "junction"); links.push(alias + "-next"); }
    if (mode === "data-root-change") { symlinkSync(target, alias + "-next", "junction"); links.push(alias + "-next"); }
    if (mode === "root-link") { symlinkSync(target, install, "junction"); links.push(install); }
    if (mode === "inner-link") { mkdirSync(install); const link = join(install, "linked"); symlinkSync(target, link, "junction"); links.push(link); }
    if (mode === "tools-link") {
      mkdirSync(join(local, "Command Center")); const link = join(local, "Command Center", "tools");
      symlinkSync(target, link, "junction"); links.push(link);
    }
    if (mode === "app-link") { const link = join(local, "Command Center"); symlinkSync(target, link, "junction"); links.push(link); }
    if (mode === "tree-change") {
      mkdirSync(install); const link = join(install, "inserted");
      // Keep the staged link OUTSIDE the first tree traversal.
      const staged = join(folder, "staged-next");
      symlinkSync(target, staged, "junction");
      links.push(staged, link);
    }
    if (mode === "entry-budget") { mkdirSync(install); for (let i = 0; i < 5001; i++) writeFileSync(join(install, `inert-${i}`), ""); }
    if (mode === "find-failure") mkdirSync(install);
    const log = join(folder, "command-center-setup.log");
    writeFileSync(log, "earlier refusal\r\n");
    const result = spawnSync(exe, ["/S"], { env: { ...process.env, CC_P4_INSTALL: install,
      CC_P4_DATA: mode.startsWith("data-") ? alias : roaming, CC_P4_SWAP: ["root-change", "data-root-change"].includes(mode) ? alias : "",
      TEMP: folder, TMP: folder, CC_P4_FAIL_FIND: mode === "find-failure" ? "1" : "",
      CC_P4_EMPTY_ROOT: mode.startsWith("empty-") ? mode.slice(6) : "",
      CC_P4_FAIL_RESOLVE: mode === "resolution-failure" ? "1" : "", CC_P4_LOG: log,
      CC_P4_FAIL_ATTRIBUTES: mode === "attribute-failure" ? "1" : "",
      CC_P4_STAGED_LINK: mode === "tree-change" ? join(folder, "staged-next") : "",
      CC_P4_INJECT_LINK: mode === "tree-change" ? join(install, "inserted") : "", LOCALAPPDATA: local }, windowsHide: true, timeout: 20000 });
    assert.equal(result.status, expected, `${title}: exit=${result.status}, error=${result.error?.message}`);
    if (expected !== 0) {
      assert.ok(existsSync(log), "silent refusal detail log FOUND");
      const lines = readFileSync(log, "utf8").trim().split(/\r?\n/);
      assert.equal(lines[0], "earlier refusal", "refusal log appends instead of replacing earlier records");
      assert.ok(lines.slice(1).some((line) => /Setup stopped|too many files/.test(line)), "real guard wrote a plain silent refusal log line");
      if (mode.startsWith("empty-")) assert.match(lines[1], /^Command Center could not check this install folder safely/, "empty resolution refuses before the second traversal");
      assert.ok(lines.slice(1).every((line) => !line.includes(folder)), "log text contains no user path");
    }
  } finally {
    assert.equal(readFileSync(sentinel, "utf8"), "external target survives");
    for (const link of links.reverse()) {
      if (!existsSync(link)) continue;
      assert.ok(lstatSync(link).isSymbolicLink()); rmdirSync(link);
      assert.equal(readFileSync(sentinel, "utf8"), "external target survives");
    }
    clean(folder);
  }
});

test("missing top-level install folder resolves against the drive root", { skip: !compiler && "cached Windows NSIS compiler unavailable" }, () => {
  const root = parse(temp).root, missing = join(root, `cc-p4-missing-${process.pid}`), log = join(temp, "drive-root.log");
  assert.equal(existsSync(missing), false);
  const result = spawnSync(exe, ["/S"], { env: { ...process.env, CC_P4_INSTALL: missing,
    CC_P4_RESOLVE_ONLY: "1", CC_P4_LOG: log, TEMP: temp, TMP: temp }, windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0);
  assert.equal(readFileSync(log, "utf8").toLowerCase(), (`\\\\?\\${missing}`).toLowerCase());
  assert.equal(existsSync(missing), false, "resolver never creates anything at the drive root");
});
