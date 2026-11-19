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
  it("stages and verifies original files above the old 4.5 MB ceiling", async () => {
    const { s3, landing } = fixture();
    const bytes = Buffer.alloc(5_000_000, "x");
    const larger = { ...file, bytes, sha256: sha256(bytes) };
    await landing.acquire("larger");
    await landing.stage("larger", "load_api_eg", [larger]);
    await landing.stage("larger", "load_api_eg", [larger]);
    expect(s3.objects.get(landing.prefix + file.name)!.bytes.length).toBe(
      5_000_000,
    );
    await landing.finish("larger", "load_api_eg", [larger]);
    expect(s3.objects.has(landing.lockKey)).toBe(false);
  });
  it("reuses exact unmanaged files without taking ownership, overwriting or deleting them", async () => {
    const { s3, landing } = fixture();
    s3.set(landing.prefix + file.name, file.bytes);
    await landing.acquire("first");
    s3.send.mockClear();
    await landing.stage("first", "load_api_eg", [file]);
    await landing.stage("first", "load_api_eg", [file]);
    await landing.finish("first", "load_api_eg", [file]);
    expect(
      s3.objects.get(landing.prefix + file.name)!.metadata,
    ).toBeUndefined();
    expect(
      s3.send.mock.calls.filter(
        ([c]: any) => c.constructor.name === "PutObjectCommand",
      ),
    ).toHaveLength(0);
    expect(
      s3.send.mock.calls
        .filter(([c]: any) => c.constructor.name === "DeleteObjectCommand")
        .map(([c]: any) => c.input.Key),
    ).toEqual([landing.lockKey]);
  });
  it("recognizes unmanaged wildcard files with uppercase extensions without staging duplicate keys", async () => {
    const { s3, landing } = fixture();
    const name = "308. Billed Adjustments Monthly Summary Report_G_BC21.xlsx";
    s3.set(landing.prefix + name.toUpperCase(), file.bytes);
    await landing.acquire("first");
    await landing.stage("first", "adjustments_308", [{ ...file, name }]);
    expect(s3.objects.has(landing.prefix + name)).toBe(false);
    await landing.finish("first", "adjustments_308", [{ ...file, name }]);
    expect(s3.objects.has(landing.prefix + name.toUpperCase())).toBe(true);
  });
  it("rejects unmanaged mismatching bytes with the exact object key for diagnosis", async () => {
    const { s3, landing } = fixture();
    s3.set(landing.prefix + file.name, Buffer.from("different source"));
    await landing.acquire("first");
    await expect(
      landing.stage("first", "load_api_eg", [file]),
    ).rejects.toMatchObject({
      name: "SharedExtractionBusy",
      details: {
        key: landing.prefix + file.name,
        reason: "source_bytes_conflict",
      },
    });
    expect(s3.objects.get(landing.prefix + file.name)!.bytes.toString()).toBe(
      "different source",
    );
  });
  it("rejects duplicate case-insensitive wildcard matches even with identical bytes", async () => {
    const { s3, landing } = fixture();
    const name = "308. Billed Adjustments Monthly Summary Report_G_BC21.xlsx";
    s3.set(landing.prefix + name, file.bytes);
    s3.set(landing.prefix + name.toUpperCase(), file.bytes);
    await landing.acquire("first");
    await expect(
      landing.stage("first", "adjustments_308", [{ ...file, name }]),
    ).rejects.toMatchObject({
      details: { reason: "unexpected_or_duplicate_input" },
    });
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
  it("retains the exact unowned original before conditionally adapting its working copy", async () => {
    const { s3, landing } = fixture();
    const original = { bytes: file.bytes, sha256: file.sha256 };
    const bytes = Buffer.from("adapted native workbook");
    const adapted = { ...file, bytes, sha256: sha256(bytes), original };
    const key = landing.prefix + file.name;
    s3.set(key, original.bytes);
    await landing.acquire("first");
    await expect(
      landing.stage("first", "load_api_eg", [adapted]),
    ).rejects.toThrow("checksum/size");
    const egFile = { ...adapted, name: "CALLCARD_EG.xlsx" };
    const egKey = landing.prefix + egFile.name;
    s3.set(egKey, original.bytes);
    await landing.stage("first", "callcard_eg", [egFile]);
    const backup = `prepaid_reclass/portal-coordination/input-backups/first/${original.sha256}/${egFile.name}`;
    expect(s3.objects.get(backup)?.bytes).toEqual(original.bytes);
    expect(s3.objects.get(egKey)?.bytes).toEqual(bytes);
    const replace = s3.send.mock.calls.find(
      ([c]: any) =>
        c.constructor.name === "PutObjectCommand" && c.input.Key === egKey,
    );
    expect((replace![0] as any).input.IfMatch).toBeTruthy();
    await landing.stage("first", "callcard_eg", [egFile]);
    await landing.finish("first", "callcard_eg", [egFile]);
    expect(s3.objects.has(backup)).toBe(true);
    expect(s3.objects.has(key)).toBe(true);
  });
  it("never adapts an unrelated or other-owner object even with original provenance supplied", async () => {
    const { s3, landing } = fixture();
    const bytes = Buffer.from("adapted");
    const adapted = {
      name: "CALLCARD_EG.xlsx",
      bytes,
      sha256: sha256(bytes),
      original: { bytes: file.bytes, sha256: file.sha256 },
    };
    const key = landing.prefix + adapted.name;
    await landing.acquire("first");
    s3.set(key, Buffer.from("unrelated source"));
    await expect(
      landing.stage("first", "callcard_eg", [adapted]),
    ).rejects.toThrow();
    expect(s3.objects.get(key)?.bytes.toString()).toBe("unrelated source");
    s3.set(key, file.bytes, {
      "portal-owner": "second",
      "portal-sha256": file.sha256,
    });
    await expect(
      landing.stage("first", "callcard_eg", [adapted]),
    ).rejects.toThrow("not owned");
    expect(s3.objects.get(key)?.metadata?.["portal-owner"]).toBe("second");
  });
  it("cleans an owned adapted case-variant key while keeping its retained original", async () => {
    const { s3, landing } = fixture();
    const bytes = Buffer.from("adapted"),
      name = "CALLCARD_EG.xlsx",
      actual = "CALLCARD_EG.XLSX";
    const adapted = {
      name,
      bytes,
      sha256: sha256(bytes),
      original: { bytes: file.bytes, sha256: file.sha256 },
    };
    const key = landing.prefix + actual;
    s3.set(key, file.bytes);
    await landing.acquire("first");
    await landing.stage("first", "callcard_eg", [adapted]);
    await landing.finish("first", "callcard_eg", [adapted]);
    expect(s3.objects.has(key)).toBe(false);
    expect(
      s3.objects.has(
        `prepaid_reclass/portal-coordination/input-backups/first/${file.sha256}/${actual}`,
      ),
    ).toBe(true);
  });
  it("leaves the shared original untouched when retaining its backup fails", async () => {
    const { s3, landing } = fixture();
    const bytes = Buffer.from("adapted"),
      name = "CALLCARD_EG.xlsx";
    const key = landing.prefix + name;
    s3.set(key, file.bytes);
    await landing.acquire("first");
    const send = s3.send.getMockImplementation()!;
    s3.send.mockImplementation(async (command: any) => {
      if (
        command.constructor.name === "PutObjectCommand" &&
        command.input.Key.includes("/input-backups/")
      ) {
        throw Error("Backup storage unavailable");
      }
      return send(command);
    });
    await expect(
      landing.stage("first", "callcard_eg", [
        {
          name,
          bytes,
          sha256: sha256(bytes),
          original: { bytes: file.bytes, sha256: file.sha256 },
        },
      ]),
    ).rejects.toThrow("Backup storage unavailable");
    expect(s3.objects.get(key)?.bytes).toEqual(file.bytes);
    expect(s3.objects.get(key)?.metadata?.["portal-owner"]).toBeUndefined();
  });
});
