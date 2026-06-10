export function upsertBy<T>(
  items: T[],
  next: T,
  keyOf: (item: T) => string,
): T[] {
  const key = keyOf(next);
  const exists = items.some((item) => keyOf(item) === key);
  return exists
    ? items.map((item) => (keyOf(item) === key ? next : item))
    : [next, ...items];
}

export function omitKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}
