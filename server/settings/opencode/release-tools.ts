// Fixed server-owned profiles, never supplied by the renderer.
export const RELEASE_TOOLS = {
  opencode: {
    repository: "anomalyco/opencode", folder: "opencode-v1", executable: "opencode.exe", label: "OpenCode 1",
    assets: { x64: "opencode-windows-x64-baseline.zip", arm64: "opencode-windows-arm64.zip" },
    downloadLimit: 128 * 1024 * 1024, expandedLimit: 512 * 1024 * 1024, singleEntry: false,
  },
  copilot: {
    repository: "github/copilot-cli", folder: "copilot", executable: "copilot.exe", label: "GitHub Copilot CLI",
    assets: { x64: "copilot-win32-x64.zip", arm64: "copilot-win32-arm64.zip" },
    downloadLimit: 192 * 1024 * 1024, expandedLimit: 256 * 1024 * 1024, singleEntry: true, timeoutMs: 1_500_000,
  },
} as const;
export type ReleaseTool = keyof typeof RELEASE_TOOLS;
