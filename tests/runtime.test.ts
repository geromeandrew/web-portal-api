import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPortalRuntime } from "../src/app/runtime.js";
import { runWithShutdown } from "../src/app/entrypoint.js";

describe("Default API + Prepaid worker lifecycle", () => {
  const server = {} as Server;
  function services() {
    return {
      startApi: vi.fn(async () => server),
      stopApi: vi.fn(async () => {}),
      runWorker: vi.fn(
        async (signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      ),
    };
  }
  it("starts both services and closes the API when the worker stops on shutdown", async () => {
    const controller = new AbortController(),
      runtime = services();
    const running = runPortalRuntime(controller.signal, runtime);
    await vi.waitFor(() => expect(runtime.runWorker).toHaveBeenCalledOnce());
    expect(runtime.startApi).toHaveBeenCalledOnce();
    expect(runtime.stopApi).not.toHaveBeenCalled();
    controller.abort();
    await running;
    expect(runtime.stopApi).toHaveBeenCalledExactlyOnceWith(server);
  });
  it("closes the API and fails if the worker cannot start", async () => {
    const runtime = services();
    runtime.runWorker.mockRejectedValueOnce(
      Error("Prepaid migrations missing"),
    );
    await expect(
      runPortalRuntime(new AbortController().signal, runtime),
    ).rejects.toThrow("Prepaid migrations missing");
    expect(runtime.stopApi).toHaveBeenCalledExactlyOnceWith(server);
  });
  it("does not leave an API-only process if the worker unexpectedly exits", async () => {
    const runtime = services();
    runtime.runWorker.mockResolvedValueOnce();
    await expect(
      runPortalRuntime(new AbortController().signal, runtime),
    ).rejects.toThrow("worker exited unexpectedly");
    expect(runtime.stopApi).toHaveBeenCalledOnce();
  });
  it("does not start a worker after HTTP startup fails", async () => {
    const runtime = services();
    runtime.startApi.mockRejectedValueOnce(Error("port in use"));
    await expect(
      runPortalRuntime(new AbortController().signal, runtime),
    ).rejects.toThrow("port in use");
    expect(runtime.runWorker).not.toHaveBeenCalled();
    expect(runtime.stopApi).not.toHaveBeenCalled();
  });
  it("does not start anything after shutdown was already requested", async () => {
    const runtime = services(),
      controller = new AbortController();
    controller.abort();
    await runPortalRuntime(controller.signal, runtime);
    expect(runtime.startApi).not.toHaveBeenCalled();
  });
  it("closes an HTTP server opened while shutdown was requested, without starting the worker", async () => {
    const runtime = services(),
      controller = new AbortController();
    runtime.startApi.mockImplementationOnce(async () => {
      controller.abort();
      return server;
    });
    await runPortalRuntime(controller.signal, runtime);
    expect(runtime.runWorker).not.toHaveBeenCalled();
    expect(runtime.stopApi).toHaveBeenCalledOnce();
  });
});

describe("Entrypoint signal ownership", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["SIGINT", "SIGTERM"] as const)(
    "forwards %s and removes its listeners after completion",
    async (signal) => {
      const before = process.listeners(signal),
        other = signal === "SIGINT" ? "SIGTERM" : "SIGINT";
      const otherBefore = process.listeners(other).length;
      let received: AbortSignal | undefined;
      const running = runWithShutdown(async (abort) => {
        received = abort;
        await new Promise<void>((resolve) =>
          abort.addEventListener("abort", () => resolve(), { once: true }),
        );
      });
      const handler = process
        .listeners(signal)
        .find((listener) => !before.includes(listener))!;
      expect(handler).toBeDefined();
      handler(signal);
      await running;
      expect(received!.aborted).toBe(true);
      expect(process.listeners(signal)).toEqual(before);
      expect(process.listeners(other).length).toBe(otherBefore);
    },
  );
  it("cleans up signal handlers after a startup failure", async () => {
    const before = process.listeners("SIGTERM");
    await expect(
      runWithShutdown(async () => {
        throw Error("startup failed");
      }),
    ).rejects.toThrow("startup failed");
    expect(process.listeners("SIGTERM")).toEqual(before);
  });
});
