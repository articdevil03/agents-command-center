export function secretVariants(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean).flatMap((value) => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]))].sort((a, b) => b.length - a.length);
}
export function redactSecrets(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) if (secret) text = text.split(secret).join("[hidden]");
  return text;
}
