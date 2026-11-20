/** Allow durable jobs to finish their tick, within the container shutdown grace. */
export async function runWithShutdown(
  run: (signal: AbortSignal) => Promise<void>,
) {
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    deadline = setTimeout(() => {
      console.error(
        "Graceful shutdown exceeded 25 seconds; durable jobs will be recovered on restart.",
      );
      process.exit(1);
    }, 25000);
    deadline.unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await run(controller.signal);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (deadline) clearTimeout(deadline);
  }
}
