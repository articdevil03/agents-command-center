import { loginProfile, UNSUPPORTED_MESSAGE } from "./cli-login-policy.js";
import type { SeatCli } from "../process-types.ts";
// Server-owned recipes. Vendor documentation verifies command text, not installed compatibility.
type BuiltinKind = Exclude<SeatCli, `acp:${string}`>; // the built-in leader kinds, taken from the one capability table
export type Verification = "verified" | "candidate" | "NOT VERIFIED";
export type CatalogRecipe =
  | { kind: "opencode" | "copilot"; command: string }
  | { kind: "powershell"; url: string; command: string }
  | { kind: "npm"; package: string; command: string }
  | { kind: "uv"; package: string; command: string }
  | { kind: "winget"; id: string; command: string }
  | { kind: "ordered"; steps: CatalogRecipe[]; command: string };
export type CatalogLeader = {
  kind: "builtin" | "acp" | "provider"; builtin?: BuiltinKind;
  start?: { program: string; args: string[] }; verified: Verification; qualified: boolean;
  registrationName?: string;
  authenticate?: true; limitation: string;
};
export type CatalogEntry = {
  id: string; displayName: string; vendor: string; platforms: string[]; wave: number;
  recipe: CatalogRecipe | null; prerequisites: string[];
  detection: { program: string; args: string[]; supportedMajor?: number } | null;
  signIn: { command: string | null; verified: Verification; guidance: string; managed: boolean; unsupportedMessage: string | null };
  leader: CatalogLeader; sources: string[]; guidance?: string; limitation: string;
  verified: Verification;
};
const ps = (url: string, command = `irm ${url} | iex`): CatalogRecipe => ({ kind: "powershell", url, command });
const npm = (pkg: string): CatalogRecipe => ({ kind: "npm", package: pkg, command: `npm install -g ${pkg}` });
const builtin = (kind: BuiltinKind): CatalogLeader => ({ kind: "builtin", builtin: kind, verified: "verified", qualified: false, limitation: "Existing built-in adapter" });
const acp = (program: string, args: string[], verified: Verification, limitation: string, authenticate?: true): CatalogLeader =>
  ({ kind: "acp", start: { program, args }, verified, qualified: false, limitation, ...(authenticate ? { authenticate } : {}) });
const login = (command: string | null, guidance: string, verified: Verification = "verified") => ({ command, guidance, verified, managed: false, unsupportedMessage: UNSUPPORTED_MESSAGE });
const tool = (id: string, displayName: string, vendor: string, recipe: CatalogRecipe, prerequisites: string[], program: string,
  signIn: CatalogEntry["signIn"], leader: CatalogLeader, sources: string[], limitation = "Installation and Command Center compatibility NOT VERIFIED"): CatalogEntry =>
  ({ id, displayName, vendor, platforms: ["win32"], wave: 1, recipe, prerequisites,
    detection: { program, args: ["--version"], ...(id === "opencode" ? { supportedMajor: 1 } : {}) },
    signIn: { ...signIn, managed: loginProfile(id).managed, unsupportedMessage: loginProfile(id).managed ? null : UNSUPPORTED_MESSAGE }, leader: leader.kind === "acp" ? { ...leader, registrationName: `Command Center ${displayName}` } : leader, sources, limitation, verified: "NOT VERIFIED" });
const provider = (id: string, displayName: string, vendor: string, guidance: string, limitation: string, sources: string[]): CatalogEntry =>
  ({ id, displayName, vendor, platforms: [], wave: 1, recipe: null, prerequisites: [], detection: null,
    signIn: login(null, guidance, "NOT VERIFIED"), leader: { kind: "provider", verified: "NOT VERIFIED", qualified: false, limitation },
    sources, guidance, limitation, verified: "NOT VERIFIED" });

export const CLI_CATALOG: readonly CatalogEntry[] = [
  tool("claude", "Claude Code", "Anthropic", ps("https://claude.ai/install.ps1"), ["Native Windows; Git optional"], "claude",
    login("claude auth login", "Browser sign-in"), builtin("claude"), ["https://code.claude.com/docs/en/setup"]),
  tool("codex", "Codex", "OpenAI", ps("https://chatgpt.com/codex/install.ps1", 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'),
    ["No external Node required by this route"], "codex", login("codex login --device-auth", "ChatGPT login or API credentials"), builtin("codex"), ["https://github.com/openai/codex#installing-and-running-codex-cli"]),
  tool("opencode", "OpenCode 1", "OpenCode project", { kind: "opencode", command: "Install verified OpenCode 1" }, ["Windows account installation"], "opencode",
    login("opencode auth login", "Provider selection may require interaction"), builtin("opencode"), ["https://opencode.ai/v1/docs/", "https://opencode.ai/v1/docs/cli/#auth"], "V1 and V2 share a command name. Unsupported major versions are not leader candidates. OpenCode 2 NOT VERIFIED"),
  tool("grok", "Grok Build", "xAI", ps("https://x.ai/cli/install.ps1"), ["None stated for released binary"], "grok",
    login("grok login --device-auth", "Browser and device authentication", "candidate"), acp("grok", ["agent", "stdio"], "candidate", "Real Command Center session NOT VERIFIED; authenticate before session/new", true),
    ["https://github.com/xai-org/grok-build#installing-the-released-binary", "https://docs.x.ai/build/cli/reference", "https://docs.x.ai/build/cli/headless-scripting"]),
  tool("gemini", "Gemini CLI", "Google", npm("@google/gemini-cli"), ["Node 20+", "Windows 11 24H2 minimum"], "gemini",
    login(null, "Google OAuth, API key or Vertex"), acp("gemini", ["--acp"], "verified", "Documented stdio mode; real Command Center session NOT VERIFIED"),
    ["https://geminicli.com/docs/get-started/installation/", "https://github.com/google-gemini/gemini-cli#authentication-options", "https://geminicli.com/docs/cli/acp-mode/"]),
  tool("copilot", "GitHub Copilot CLI", "GitHub", { kind: "copilot", command: "Install verified GitHub Copilot CLI" },
    ["Windows account installation"], "copilot", login("copilot login --device-code", "Browser sign-in"), acp("copilot", ["--acp"], "verified", "ACP preview; qualify with updates disabled. Real session NOT VERIFIED"),
    ["https://github.com/github/copilot-cli#installation", "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference", "https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server"], "Managed installs do not update automatically. Installation and real sessions NOT VERIFIED"),
  tool("qwen", "Qwen Code", "Alibaba Qwen", ps("https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1"),
    ["Standalone route; npm alternative requires Node 22+", "Automatic fallback behavior NOT VERIFIED"], "qwen",
    login(null, "Interactive /auth, then Qwen account OAuth or provider key. Hidden OAuth login command NOT VERIFIED", "NOT VERIFIED"),
    acp("qwen", ["--acp"], "candidate", "Windows installer behavior NOT VERIFIED; qwen serve HTTP/SSE is not the stdio adapter"),
    ["https://github.com/QwenLM/qwen-code#installation", "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/", "https://qwenlm.github.io/qwen-code-docs/en/users/integration-zed/"]),
  tool("kimi", "Kimi Code", "Moonshot AI", ps("https://code.kimi.com/kimi-code/install.ps1"), ["Git for Windows including Git Bash; validate custom shell location"], "kimi",
    login("kimi login", "Device-code flow without TUI; /login also exists"), acp("kimi", ["acp"], "verified", "Real Command Center session NOT VERIFIED"),
    ["https://github.com/MoonshotAI/kimi-code#install", "https://moonshotai.github.io/kimi-code/en/reference/kimi-command#kimi-login", "https://moonshotai.github.io/kimi-code/en/reference/kimi-acp"]),
  tool("mimo", "MiMo Code", "Xiaomi", ps("https://mimo.xiaomi.com/install.ps1", 'powershell -ep Bypass -c "irm https://mimo.xiaomi.com/install.ps1 | iex"'),
    ["None stated for released installer"], "mimo", login(null, "First-launch Xiaomi OAuth or provider credentials; hidden flow NOT VERIFIED", "NOT VERIFIED"),
    acp("mimo", ["acp"], "candidate", "Source-level candidate; released Windows support and executable NOT VERIFIED"),
    ["https://github.com/XiaomiMiMo/MiMo-Code#quick-start", "https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/cli/src/index.ts", "https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/cli/src/cli/cmd/acp.ts"]),
  tool("mistral", "Mistral Vibe", "Mistral AI", { kind: "ordered", command: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex", then uv tool install mistral-vibe',
    steps: [ps("https://astral.sh/uv/install.ps1", 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'), { kind: "uv", package: "mistral-vibe", command: "uv tool install mistral-vibe" }] },
    ["uv", "Python 3.12+; uv can download Python when needed"], "vibe", login(null, "Mistral browser account or API key through setup; hidden setup NOT VERIFIED", "NOT VERIFIED"),
    acp("vibe-acp", [], "verified", "Separate executable must resolve; real Command Center session NOT VERIFIED"),
    ["https://github.com/mistralai/mistral-vibe#get-started", "https://docs.mistral.ai/vibe/code/cli/install-setup", "https://docs.astral.sh/uv/guides/install-python/", "https://github.com/mistralai/mistral-vibe/blob/main/docs/acp-setup.md"]),
  tool("minimax", "MiniMax Code", "MiniMax", ps("https://filecdn.minimax.chat/public/install.ps1"), ["Installer prepares compatible Node when needed"], "mcode",
    login("mcode login --region global", "Domestic account uses mcode login"), acp("mcode", ["acp"], "candidate", "Installed release compatibility NOT VERIFIED; Windows launcher is .cmd/.ps1"),
    ["https://platform.minimax.io/docs/m-plan/minimax-code", "https://github.com/MiniMax-AI/minimax-code#quick-start", "https://github.com/MiniMax-AI/minimax-code#entry-points"]),
  provider("deepseek", "DeepSeek", "DeepSeek", "Use DeepSeek through OpenCode or a supported Claude Code configuration.", "Offer the OpenCode installation and provider guide. Vendor integration is documented.", ["https://api-docs.deepseek.com/quick_start/agent_integrations/opencode/"]),
  provider("glm", "GLM / Z.ai", "Z.ai", "Same guidance with the Z.ai provider route.", "ZCode exists, but a supported end-user installation recipe was not established.", ["https://docs.z.ai/devpack/tool/opencode", "https://github.com/zai-org/ZCode"]),
  provider("nemotron", "Nemotron / NVIDIA", "NVIDIA", "Guide to OpenCode’s NVIDIA provider.", "That provider’s Nemotron route is documented; an independent coding CLI is not established.", ["https://opencode.ai/v1/docs/providers/#nvidia"]),
  provider("perplexity", "Perplexity", "Perplexity", "Guidance only; provider compatibility remains NOT VERIFIED.", "Its official pplx CLI is a search utility, not a proven Command Center leader.", ["https://docs.perplexity.ai/docs/cli/overview"]),
  provider("muse", "Muse", "Muse", "No verified official installation or supported provider connection yet.", "Keep the provider guide available without promising Muse support. Never recommend the unofficial community agent.", ["https://agentclientprotocol.com/get-started/agents"]),
];
