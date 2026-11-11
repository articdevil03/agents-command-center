// A startup wait before any behaviour is checked: a slow cold load on a busy PC is not a defect, and a generous bound costs nothing on a green run.
export const FIRST_RENDER_MS = 60_000;

export async function waitForFirstRender(waitFor: (expression: string, label: string, timeoutMs?: number) => Promise<void>, expression: string, label: string) {
  const startedAt = Date.now();
  await waitFor(expression, label, FIRST_RENDER_MS);
  console.log(`first render: ${label} took ${Date.now() - startedAt} ms`);
}
