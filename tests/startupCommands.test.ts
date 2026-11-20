import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const read = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
describe("Run/deployment command contracts", () => {
  it("starts the combined runtime for normal npm/pnpm commands, retaining explicit separate commands", () => {
    const scripts = JSON.parse(read("package.json")).scripts;
    expect(scripts.local).toContain("src/index.ts");
    expect(scripts.start).toBe("node --env-file-if-exists=.env dist/index.js");
    expect(scripts["start:api"]).toBe("node dist/api.js");
    expect(scripts["local:api"]).toContain("src/api.ts");
    expect(scripts["worker:prepaid"]).toContain("dist/prepaidWorker.js");
    expect(scripts["worker:prepaid:local"]).toContain("src/prepaidWorker.ts");
    expect(read("src/index.ts")).toContain("runWithShutdown(runPortalRuntime)");
  });
  it.each(["Dockerfile", "Dockerfile-local"])(
    "uses the combined Node entrypoint in %s",
    (file) => {
      expect(read(file)).toContain('CMD ["node", "dist/index.js"]');
    },
  );
  it("starts the local Compose API and worker after ordered migrations", () => {
    // EKS uses the image entrypoint checked above. The legacy optional
    // compose.deploy.yml is not the deployed EKS pod specification.
    const content = read("compose.yml");
    expect(content).not.toContain("profiles:");
    expect(content).toContain('command: ["node", "dist/api.js"]');
    expect(content).toContain('command: ["node", "dist/prepaidWorker.js"]');
    expect(content).toMatch(
      /prepaid-migrate:[\s\S]*?depends_on:\s*\n\s+migrate:\s*\n\s+condition: service_completed_successfully/,
    );
    expect(content).toMatch(
      /prepaid-worker:[\s\S]*?depends_on:\s*\n\s+prepaid-migrate:\s*\n\s+condition: service_completed_successfully/,
    );
    expect(content).toContain("DATABASE_SSL: ${DATABASE_SSL:-true}");
  });
  it("includes the streaming parser required by the worker in the local image", () => {
    expect(read("Dockerfile-local")).toContain(
      "infrastructure/prepaid/workbook_stream.py",
    );
    expect(read("Dockerfile-local")).toContain(
      "infrastructure/prepaid/eg_report_adapter.py",
    );
  });
});
