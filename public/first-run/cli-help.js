// Official setup guides for the tools. In-app Install is the primary route.
"use strict";
window.CC_FIRST_RUN_HELP = Object.freeze({
  // Order is the order the screen lists them, and the order the default leader is picked in.
  order: Object.freeze(["claude", "codex", "opencode"]),
  tools: Object.freeze({
    claude: { about: "Claude Code is Anthropic's AI coding tool.", page: "https://code.claude.com/docs/en/setup" },
    codex: { about: "Codex is OpenAI's AI coding tool.", page: "https://developers.openai.com/codex/cli" },
    // OpenCode uses the verified in-app installer and masked key panel.
    opencode: { about: "OpenCode is an open source AI coding tool that works with many AI providers.", page: "https://opencode.ai/v1/docs/",
      steps: Object.freeze(["Press Install to install OpenCode 1.", "Press Sign in, then Get my key. Paste your OpenCode Go API key and press Save key.", "Key saved. OpenCode will check it when you first chat."]) },
  }),
  steps: Object.freeze([
    "Visit the official setup guide at the address below.",
    "Follow the maker's setup guide, then return here and press Check again.",
  ]),
  stillMissing: "Still says Not found? Close and reopen Command Center once, then press Check again.",
  // Tools with their own install row are separate from models used through OpenCode. The wizard has no model field.
  models: "A tool is the program on this computer. The model is the AI it uses. Install one tool below and sign in. Models that have no tool of their own run through OpenCode: they are listed under Models used through OpenCode.",
  providers: Object.freeze({ label: "OpenCode provider guide", page: "https://opencode.ai/docs/providers/" }),
});
