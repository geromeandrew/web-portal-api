import { describe, expect, it } from "vitest";
import { LegacyLanding } from "../src/modules/prepaid/infrastructure/legacyLanding.js";
import {
  PrepaidStorage,
  sha256,
} from "../src/modules/prepaid/infrastructure/prepaidStorage.js";
import { fakeS3 } from "./fixtures/prepaidSource.js";

describe("Shared legacy landing safeguards", () => {
  const file = {
    name: "LOAD API_EG.xlsx",
    bytes: Buffer.from("exact upload"),
    sha256: sha256(Buffer.from("exact upload")),
  };
  function fixture() {
    const s3 = fakeS3();
    return { s3, landing: new LegacyLanding({ send: s3.send } as any, "test") };
  }
  it("uses conditional locking across independent clients and never steals another preparation's lock", async () => {
    const { s3, landing } = fixture(),
      other = new LegacyLanding({ send: s3.send } as any, "test");
    await landing.acquire("first");
    await landing.acquire("first");
    await expect(other.acquire("second")).rejects.toThrow(
      "Another extraction owns",
    );
    expect(s3.objects.get(landing.lockKey)!.bytes.toString()).toContain(
      "first",
    );
  });
  it("stages exact disposable copies idempotently, retains originals and conditionally deletes only owned copies", async () => {
    const { s3, landing } = fixture();
    s3.set("prepaid_reclass/sessions/original.xlsx", file.bytes);
    await landing.acquire("first");
    await landing.stage("first", "load_api_eg", [file]);
    await landing.stage("first", "load_api_eg", [file]);
    expect(s3.objects.get(landing.prefix + file.name)!.bytes).toEqual(
      file.bytes,
    );
    await landing.finish("first", "load_api_eg", [file]);
    expect(s3.objects.has(landing.lockKey)).toBe(false);
    expect(s3.objects.has("prepaid_reclass/sessions/original.xlsx")).toBe(true);
    expect(
      s3.send.mock.calls
        .filter(([c]: any) => c.constructor.name === "DeleteObjectCommand")
        .every(([c]: any) => c.input.IfMatch),
    ).toBe(true);
  });
  it("does not overwrite/delete a replaced or foreign object, even if its bytes match", async () => {
    const { s3, landing } = fixture();
    await landing.acquire("first");
    await landing.stage("first", "load_api_eg", [file]);
    s3.set(landing.prefix + file.name, file.bytes, {
      "portal-owner": "second",
      "portal-sha256": file.sha256,
    });
    await expect(
      landing.finish("first", "load_api_eg", [file]),
    ).rejects.toThrow("not owned");
    expect(s3.objects.has(landing.lockKey)).toBe(true);
    expect(s3.objects.has(landing.prefix + file.name)).toBe(true);
  });
  it("blocks extra wildcard 308 files rather than ingesting unrelated billing cycles", async () => {
    const { s3, landing } = fixture();
    await landing.acquire("first");
    s3.set(
      landing.prefix +
        "308. Billed Adjustments Monthly Summary Report_G_B99.xlsx",
      file.bytes,
    );
    await expect(
      landing.stage("first", "adjustments_308", [
        {
          ...file,
          name: "308. Billed Adjustments Monthly Summary Report_G_B01.xlsx",
        },
      ]),
    ).rejects.toThrow("Foreign files");
  });
  it("refuses filename traversal or wrong job input patterns", async () => {
    const { landing } = fixture();
    await landing.acquire("first");
    await expect(
      landing.stage("first", "load_api_eg", [
        { ...file, name: "../LOAD API_EG.xlsx" },
      ]),
    ).rejects.toThrow("filename");
  });
  it("blocks nested wildcard matches just like the unchanged Glue basename discovery", async () => {
    const { s3, landing } = fixture();
    await landing.acquire("first");
    s3.set(
      landing.prefix +
        "other/308. Billed Adjustments Monthly Summary Report_G_BC99.xlsx",
      file.bytes,
    );
    await expect(
      landing.stage("first", "adjustments_308", [
        {
          ...file,
          name: "308. Billed Adjustments Monthly Summary Report_G_BC01.xlsx",
        },
      ]),
    ).rejects.toThrow("Foreign files");
  });
  it("recovers immutable artifact writes but does not overwrite different content", async () => {
    const { s3 } = fixture(),
      storage = new PrepaidStorage({ send: s3.send } as any, "test");
    const prefix = "prepaid_reclass/sessions/test/",
      key = prefix + "artifact.json";
    await storage.putVerified(
      key,
      prefix,
      Buffer.from("one"),
      "application/json",
    );
    await expect(
      storage.putVerified(key, prefix, Buffer.from("one"), "application/json"),
    ).resolves.toMatchObject({ sha256: sha256(Buffer.from("one")) });
    await expect(
      storage.putVerified(key, prefix, Buffer.from("two"), "application/json"),
    ).rejects.toThrow("different content");
  });
});
