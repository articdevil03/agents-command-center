export const UNSUPPORTED_MESSAGE = "This tool has no verified sign-in flow in Command Center yet.";
const unsupported = Object.freeze({ managed: false, hosts: [], paths: [], prompt: null, codePrompt: null, code: null, paste: false });
const profiles = Object.freeze({
  opencode: { managed: true, hosts: ["opencode.ai"], paths: ["/auth"], prompt: null, codePrompt: null, code: null, paste: false },
  claude: { managed: true, hosts: ["claude.com", "platform.claude.com"], paths: ["/oauth/", "/cai/oauth/"],
    prompt: /(?:Opening browser to sign in|If the browser didn't open, visit:)/i, codePrompt: null, code: null, paste: true },
  codex: { managed: true, hosts: ["auth.openai.com"], paths: ["/codex/device"],
    prompt: /Open this link in your browser/i, codePrompt: /Enter this one-time code[^\n]*\n\s*(\S+)/, code: /^[A-Z0-9]{4}-[A-Z0-9]{5}$/, paste: false },
  copilot: { managed: true, hosts: ["github.com"], paths: ["/login/device"],
    prompt: /To authenticate, visit/i, codePrompt: /enter code\s+(\S+)/i, code: /^[A-Z0-9]{4}-[A-Z0-9]{4}$/, paste: false },
  // Candidate: exact vendor wording still needs native qualification.
  grok: { managed: true, hosts: ["auth.x.ai"], paths: ["/"],
    prompt: /(?:device (?:code|authorization)|(?:authenticate|sign in|login)[^\n]*https:|(?:visit|open)[^\n]*https:)/i,
    codePrompt: /(?:user code|device code|enter (?:this )?code)\s*[:\n]?\s*(\S+)/i, code: /^[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?$/, paste: false },
});
export function loginProfile(cli) { return Object.hasOwn(profiles, cli) ? profiles[cli] : unsupported; }
export function validateLoginUrl(cli, value) {
  if (typeof value !== "string" || value.length > 4096 || /[\s\u0000-\u001f\u007f\\]/.test(value)) return null;
  try {
    if (cli === "opencode") return value === "https://opencode.ai/auth" ? value : null;
    const url = new URL(value), policy = loginProfile(cli);
    if (!policy.managed || url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    if (!policy.hosts.includes(url.hostname) || !policy.paths.some((path) => path.endsWith("/") ? url.pathname.startsWith(path) : url.pathname === path)) return null;
    // Encoded path separators/dot segments must not escape the reviewed prefix.
    if (/%(?:2f|5c|2e)/i.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}
export function validLoginCode(value) {
  return typeof value === "string" && /^[\x20-\x7e]{1,2048}$/.test(value) && !/(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|mailto|file|data|javascript):|www\.)/i.test(value);
}
