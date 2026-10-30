// Per-session maps grow with every message; the oldest entries go first (a duplicate event only ever arrives close to the original).
const MAP_LIMIT = 4000;
export function trimOldest(collection: Map<string, unknown> | Set<string>): void {
  while (collection.size > MAP_LIMIT) collection.delete(collection.keys().next().value as string);
}
