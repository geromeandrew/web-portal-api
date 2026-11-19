import { describe, expect, it } from "vitest";
import { preparationTiming } from "../src/modules/prepaid/domain/preparationTiming.js";
const queued = Date.parse("2026-10-29T04:00:00.000Z");
describe("Durable preparation log timing", () => {
  it("distinguishes the whole elapsed duration from the current poll", () => {
    const now = queued + 2_225_999;
    expect(preparationTiming(new Date(queued), now - 1750, now)).toEqual({
      preparationQueuedAt: "2026-10-29T04:00:00.000Z",
      totalElapsedMs: 2_225_999,
      totalElapsed: "00:37:05",
      tickElapsedMs: 1750,
      elapsedMs: 1750,
      preparationElapsedMs: 2_225_999,
    });
  });
  it("retains the original start across a new poll or process", () => {
    const before = preparationTiming(
      new Date(queued),
      queued + 1000,
      queued + 2000,
    );
    const after = preparationTiming(
      new Date(queued).toISOString(),
      queued + 60_000,
      queued + 60_500,
    );
    expect(after.totalElapsedMs).toBe(60_500);
    expect(after.totalElapsedMs).toBeGreaterThan(before.totalElapsedMs);
    expect(after.tickElapsedMs).toBe(500);
    expect(after.preparationQueuedAt).toBe(before.preparationQueuedAt);
  });
  it("does not wrap elapsed hours at midnight", () => {
    expect(
      preparationTiming(new Date(queued), queued, queued + 176_523_900)
        .totalElapsed,
    ).toBe("49:02:03");
  });
  it.each([undefined, null, "invalid", new Date(NaN)])(
    "handles an unavailable legacy timestamp: %s",
    (value) => {
      const timing = preparationTiming(value, queued, queued + 1500);
      expect(timing.totalElapsedMs).toBe(1500);
      expect(timing.totalElapsed).toBe("00:00:01");
    },
  );
  it("clamps negative durations after a clock correction", () => {
    const timing = preparationTiming(
      new Date(queued + 1000),
      queued + 500,
      queued,
    );
    expect(timing.totalElapsedMs).toBe(0);
    expect(timing.tickElapsedMs).toBe(0);
    expect(timing.totalElapsed).toBe("00:00:00");
  });
});
