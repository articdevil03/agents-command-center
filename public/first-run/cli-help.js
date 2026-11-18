// In-app setup guidance for tools, plus the external provider reference.
"use strict";
window.CC_FIRST_RUN_HELP = Object.freeze({
  // Order is the order the screen lists them, and the order the default leader is picked in.
  order: Object.freeze(["claude", "codex", "opencode"]),
  tools: Object.freeze({
    claude: { about: "Claude Code is Anthropic's AI coding tool." },
    codex: { about: "Codex is OpenAI's AI coding tool." },
    // OpenCode uses the verified in-app installer and masked key panel.
    opencode: { about: "OpenCode is an open source AI coding tool that works with many AI providers.",
      steps: Object.freeze(["Press Install to install OpenCode 1.", "Press Sign in, then Get my key. Paste your OpenCode Go API key and press Save key.", "Key saved. OpenCode will check it when you first chat."]) },
  }),
  steps: Object.freeze([
    "Press Install here to set up this tool. Use Cancel if you need to stop.",
    "If installation fails, choose Try again. Then press Check again to refresh.",
  ]),
  stillMissing: "Still says Not found? Close and reopen Command Center once, then press Check again.",
  // Tools with their own install row are separate from models used through OpenCode. The wizard has no model field.
  models: "A tool is the program on this computer. The model is the AI it uses. Install one tool below and sign in. Models that have no tool of their own run through OpenCode: they are listed under Models used through OpenCode.",
  providers: Object.freeze({ label: "OpenCode provider guide", page: "https://opencode.ai/docs/providers/" }),
});
