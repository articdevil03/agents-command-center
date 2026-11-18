// A vendor's own error text can hold a route, an id or a response body: the user sees a plain message, and the private log gets only a fixed reason token.
export function plainFailure(label: string, raw: string, fixed: ReadonlyArray<string | RegExp>, fallback: string, reason: string): string {
  console.warn(`[${label}] Run stopped`, { reason });
  return fixed.some((known) => typeof known === "string" ? known === raw : known.test(raw)) ? raw : fallback;
}

// Recognize only known remedies. Never echo a vendor's message or sign-in instructions.
export function vendorRemedy(name: string, raw: string, authRequired = false): string | null {
  if (authRequired || /not (?:signed|logged) in|authentication required|^\s*unauthori[sz]ed\s*$|\b401\b|invalid (?:api[ -]?key|credentials?|token\b(?!\s+count\b))|missing (?:api[ -]?key|credentials?|token\b)|sign[ -]?in required/i.test(raw))
    return `${name} is not signed in. Open Settings and check the tool's sign-in or key settings, then try again.`;
  if (/usage limit|rate[ _-]?limit|insufficient_quota|too many requests/i.test(raw) || (!/\b(?:disk|storage)\b/i.test(raw) && /\b(?:usage|requests?|rate|api)\b/i.test(raw) && /\bquota (?:exceeded|reached)\b/i.test(raw)))
    return `${name} has reached its usage limit. Try again later.`;
  return null;
}
