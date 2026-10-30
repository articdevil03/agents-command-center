// The page-driving functions chromeDialogAudit builds once and hands to each group of probes.
export type DialogPage = {
  evaluate: (expression: string) => Promise<any>;
  sendPage: (method: string, params?: Record<string, unknown>) => Promise<any>;
  waitForPage: (expression: string, label: string, timeoutMs?: number) => Promise<any>;
  delay: (ms: number) => Promise<unknown>;
};
