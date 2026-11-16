import test from "node:test";
import assert from "node:assert/strict";
import { installEnv } from "../server/settings/cli-runner.ts";
import { notReadyMessage } from "../server/first-run/complete.ts";

// Owner-approved small fixes after the Pack 29 to 36 audit (items #17 and #21).
const SECRET = "synthetic-secret-value";
const base = { PATH: "C:\\bin", OPENAI_API_KEY: SECRET, GEMINI_API_KEY: SECRET, CC_APP_KEY: SECRET };

test("installEnv lets a proxy address through, in either letter case, and never a secret", () => {
  const env = installEnv({ ...base, HTTPS_PROXY: "http://proxy.local:8080", http_proxy: "proxy.local:3128", ALL_PROXY: "socks5://proxy.local:1080", NO_PROXY: "localhost,127.0.0.1" });
  assert.equal(env.HTTPS_PROXY, "http://proxy.local:8080");
  assert.equal(env.http_proxy, "proxy.local:3128");
  assert.equal(env.ALL_PROXY, "socks5://proxy.local:1080");
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1");
  assert.equal(env.PATH, "C:\\bin");
  for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "CC_APP_KEY"]) assert.equal(env[key], undefined, key);
});

test("installEnv drops a proxy address that carries sign-in details or is not just an address", () => {
  for (const value of ["http://user:pw" + "@proxy.local:8080","http://proxy.local:8080/path?x=1", "http://proxy.local:8080?token=SECRET", "http://proxy.local:8080#pw=x", "user:password", "token=abc123secret", "http://a b", "", "proxy.local:8080 --flag", "http://proxy.local:8080\n"]) {
    const env = installEnv({ ...base, HTTPS_PROXY: value, https_proxy: value });
    assert.equal(env.HTTPS_PROXY, undefined, JSON.stringify(value));
    assert.equal(env.https_proxy, undefined, JSON.stringify(value));
  }
});

test("installEnv keeps Kimi's Git Bash path only when it names a bash.exe", () => {
  const good = "D:\\Tools\\Git\\bin\\bash.exe";
  assert.equal(installEnv({ KIMI_CODE_GIT_BASH_PATH: good }).KIMI_CODE_GIT_BASH_PATH, good);
  for (const value of ["D:\\Tools\\evil.exe", "D:\\Tools\\bash.exe.bat", "", "bash"]) assert.equal(installEnv({ KIMI_CODE_GIT_BASH_PATH: value }).KIMI_CODE_GIT_BASH_PATH, undefined, value);
  assert.equal(installEnv({ kimi_code_git_bash_path: good }).kimi_code_git_bash_path, undefined, "the name is matched exactly");
});

test("a start refused for lack of a leader model names the tool, not its internal id", () => {
  assert.equal(notReadyMessage("acp:qwen", { name: "Qwen Code" }), "Qwen Code is not ready: no supported leader model");
  assert.equal(notReadyMessage("opencode"), "opencode is not ready: no supported leader model");
  assert.doesNotMatch(notReadyMessage("acp:qwen", { name: "Qwen Code" }), /acp:/);
});
