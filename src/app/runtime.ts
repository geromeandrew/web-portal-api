import type { Server } from "node:http";
import { startServer, stopServer } from "./server.js";
import { runPrepaidWorker } from "../prepaidRuntime.js";
interface RuntimeServices {
  startApi(): Promise<Server>;
  stopApi(server: Server): Promise<void>;
  runWorker(signal: AbortSignal): Promise<void>;
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
    await services.runWorker(signal);
    if (!signal.aborted)
      throw Error(
        "Prepaid worker exited unexpectedly; stopping the API so the deployment can restart both.",
      );
  } finally {
    await services.stopApi(server);
  }
}
