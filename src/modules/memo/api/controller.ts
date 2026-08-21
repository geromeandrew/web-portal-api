import type { RequestHandler } from "express";
import { toCsv } from "../../shared/domain/csv.js";
import type { MemoService } from "../application/memoService.js";

export function createMemoController(service: MemoService): {
  getState: RequestHandler;
  downloadErrors: RequestHandler;
} {
  return {
    getState: async (request, response) => {
      response.json(await service.getState(request.auth!.userId));
    },
    downloadErrors: async (request, response) => {
      const errors = await service.getErrorCsv(request.auth!.userId);
      response
        .attachment("memoapp-exceptions.csv")
        .type("text/csv")
        .send(toCsv(errors.headers, errors.rows));
    },
  };
}
