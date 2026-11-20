/** Wall-clock time for one durable preparation job. Polls and process restarts
 * reuse its persisted created_at; a newly queued attempt gets its own timer.
 * Includes queue/preflight/waiting time, never the sum of parallel runtimes.
 */
export function preparationTiming(
  queuedAt: Date | string | null | undefined,
  tickStartedAt: number,
  now = Date.now(),
) {
  const parsed =
    queuedAt instanceof Date
      ? queuedAt.getTime()
      : typeof queuedAt === "string"
        ? Date.parse(queuedAt)
        : NaN;
  const totalStartedAt = Number.isFinite(parsed) ? parsed : tickStartedAt;
  const totalElapsedMs = Math.max(0, now - totalStartedAt);
  const tickElapsedMs = Math.max(0, now - tickStartedAt);
  const seconds = Math.floor(totalElapsedMs / 1000);
  const totalElapsed = [
    Math.floor(seconds / 3600),
    Math.floor((seconds % 3600) / 60),
    seconds % 60,
  ]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return {
    preparationQueuedAt: new Date(totalStartedAt).toISOString(),
    totalElapsedMs,
    totalElapsed,
    tickElapsedMs,
    // Keep existing log fields available to saved searches/dashboards.
    elapsedMs: tickElapsedMs,
    preparationElapsedMs: totalElapsedMs,
  };
}
