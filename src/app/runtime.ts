import type { Server } from "node:http";
import { addAbortListener } from "node:events";
import { prepaidBatchEnabled, startServer, stopServer, waitForPrepaidStartup } from "./server.js";
import { runPrepaidWorker } from "../prepaidRuntime.js";
interface RuntimeServices {
  startApi(): Promise<Server>;
  stopApi(server: Server): Promise<void>;
  runWorker(signal: AbortSignal, batchEnabled?: boolean): Promise<void>;
}
/** API + worker in one watched/managed process. No detached child workers. */
export async function runPortalRuntime(
  signal: AbortSignal,
  services: RuntimeServices = {
    startApi: startServer,
    stopApi: stopServer,
    runWorker: runPrepaidWorker,
  },
) {
  if (signal.aborted) return;
  const server = await services.startApi();
  try {
    if (signal.aborted) return;
    let stopWaiting!: (ready: boolean) => void;
    const shutdown = new Promise<boolean>((resolve) => {
      stopWaiting = resolve;
    });
    const listener = addAbortListener(signal, () => stopWaiting(false));
    try {
      if (!(await Promise.race([waitForPrepaidStartup(server), shutdown])))
        return;
    } finally {
      listener[Symbol.dispose]();
    }
    if (signal.aborted) return;
    await services.runWorker(signal, prepaidBatchEnabled(server));
    if (!signal.aborted)
      throw Error(
        "Prepaid worker exited unexpectedly; stopping the API so the deployment can restart both.",
      );
  } finally {
    await services.stopApi(server);
  }
}
