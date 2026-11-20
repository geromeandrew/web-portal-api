/** Bound independent read-only requests and drain every in-flight read before
 * reporting an error. Never use this helper for dispatch, staging or cleanup. */
export async function boundedRead<T, R>(
  values: readonly T[],
  read: (value: T) => Promise<R>,
  concurrency = 4,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  const failures: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        try {
          results[index] = await read(values[index]);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  if (failures.length) throw failures[0];
  return results;
}
