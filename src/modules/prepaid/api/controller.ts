import type { RequestHandler } from "express";
import { z } from "zod";
import type { PrepaidService } from "../application/prepaidService.js";

const regionSchema = z.enum(["eg", "sg"]);

export function createPrepaidController(service: PrepaidService): {
  getState: RequestHandler;
  process: RequestHandler;
  resetLayout: RequestHandler;
  importLayout: RequestHandler;
  freezeLayout: RequestHandler;
  validateAllocation: RequestHandler;
  downloadReport: RequestHandler;
} {
  return {
    getState: async (request, response) => {
      response.json(await service.getState(request.auth!.userId));
    },
    process: async (request, response) => {
      response
        .status(201)
        .json({ run: await service.process(request.auth!.userId) });
    },
    resetLayout: async (request, response) => {
      const region = regionSchema.parse(request.params.region);
      response.json({
        layout: await service.resetLayout(request.auth!.userId, region),
      });
    },
    importLayout: async (request, response) => {
      const region = regionSchema.parse(request.params.region);
      response.json({
        layout: await service.importLayout(request.auth!.userId, region),
        message:
          "Layout state was refreshed from the current workflow snapshot.",
      });
    },
    freezeLayout: async (request, response) => {
      const region = regionSchema.parse(request.params.region);
      const { frozen } = z.object({ frozen: z.boolean() }).parse(request.body);
      response.json({
        layout: await service.freezeLayout(
          request.auth!.userId,
          region,
          frozen,
        ),
      });
    },
    validateAllocation: async (request, response) => {
      response.json({
        validation: await service.validateAllocation(request.auth!.userId),
      });
    },
    downloadReport: async (request, response) => {
      const report = await service.getReport(request.auth!.userId);
      response
        .attachment("prepaid-reclass-report.csv")
        .type("text/csv")
        .send(report.csv);
    },
  };
}
