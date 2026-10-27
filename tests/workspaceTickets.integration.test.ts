import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrations } from "../src/migrations.js";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { startWorkspaceTicketApp } from "./fixtures/workspaceTicketApp.js";

describe.skipIf(
  !process.env.TEST_DATABASE_URL || !process.env.TEST_S3_ENDPOINT,
)("workspace tickets over PostgreSQL and S3 HTTP", () => {
  let app: Awaited<ReturnType<typeof startWorkspaceTicketApp>>;
  beforeAll(async () => {
    app = await startWorkspaceTicketApp();
  }, 60000);
  afterAll(async () => {
    if (app) await app.close();
  });
  const request = (path: string, role = "admin", init?: RequestInit) =>
    fetch(`${app.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${role}`, ...init?.headers },
    });
  const upload = (
    code: string,
    expected: string,
    name = expected,
    batchId?: string,
    role = "admin",
  ) => {
    const body = new FormData();
    body.set("expectedFileName", expected);
    body.set(
      "file",
      new Blob(["ticket-test-content"], { type: "text/plain" }),
      name,
    );
    if (batchId) body.set("batchId", batchId);
    return request(`/processing-pipelines/${code}/files`, role, {
      method: "POST",
      body,
    });
  };

  it("serves web guidelines without changing the default processing requirements or access checks", async () => {
    const code = "aprm_voice_accrual";
    const all = await (
      await request(`/processing-pipelines/${code}/requirements`)
    ).json();
    const response = await request(
      `/processing-pipelines/${code}/requirements?purpose=web-upload`,
    );
    expect(response.status).toBe(200);
    const guidelines = (await response.json()).requirements;
    expect(
      all.requirements.some((file: { fileName: string }) =>
        /_output[.]txt$/i.test(file.fileName),
      ),
    ).toBe(true);
    expect(guidelines.length).toBeGreaterThan(0);
    expect(
      guidelines.some((file: { fileName: string }) =>
        /_output[.]txt$/i.test(file.fileName),
      ),
    ).toBe(false);
    expect(
      guidelines.map((file: { fileName: string }) => file.fileName),
    ).toEqual(
      all.requirements
        .filter(
          (file: { fileName: string }) =>
            !/_output[.]txt$/i.test(file.fileName),
        )
        .map((file: { fileName: string }) => file.fileName),
    );
    expect(
      (
        await request(
          `/processing-pipelines/${code}/requirements?purpose=web-upload`,
          "none",
        )
      ).status,
    ).toBe(403);
  });

  it("provisions a first Okta login with no implicit module or administrator access", async () => {
    // Provider enrichment is optional; this test avoids any live Okta request.
    const realFetch = globalThis.fetch;
    const intercepted = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) =>
        String(input).startsWith("https://example.okta.com/")
          ? Promise.resolve(new Response("{}", { status: 503 }))
          : realFetch(input, init),
      );
    try {
      const response = await request("/auth/me", "first-login");
      expect(response.status).toBe(200);
      expect((await response.json()).user).toMatchObject({
        isAdmin: false,
        modules: [],
      });
      expect(
        (await (await request("/processing-pipelines", "first-login")).json())
          .pipelines,
      ).toEqual([]);
      expect(
        (
          await request(
            "/processing-pipelines/bss_eom_glob/files",
            "first-login",
          )
        ).status,
      ).toBe(403);
      expect((await request("/admin/users", "first-login")).status).toBe(403);
    } finally {
      intercepted.mockRestore();
    }
  });

  it("allows only assigned modules and enforces revocation on the next API request", async () => {
    const catalog = await (
      await request("/processing-pipelines", "business")
    ).json();
    expect(
      catalog.pipelines.map((pipeline: { code: string }) => pipeline.code),
    ).toEqual(["bss_eom_glob"]);
    expect(
      (await request("/processing-pipelines/bss_eom_bayn/files", "business"))
        .status,
    ).toBe(403);
    expect((await request("/admin/users", "business")).status).toBe(403);
    await app.pool.query("DELETE FROM app_user_modules WHERE user_id = $1", [
      app.users.business,
    ]);
    expect(
      (await request("/processing-pipelines/bss_eom_glob/files", "business"))
        .status,
    ).toBe(403);
    await app.pool.query(
      "INSERT INTO app_user_modules(user_id,module_id) VALUES ($1,'bss_eom_glob')",
      [app.users.business],
    );
  });

  it("hides unsupported modules even from administrators without deleting pipeline data", async () => {
    const unsupported = ["iccbs_inov", "iccbs_bayn", "north"];
    const catalog = await (await request("/processing-pipelines")).json();
    expect(
      catalog.pipelines.some((pipeline: { code: string }) =>
        unsupported.includes(pipeline.code),
      ),
    ).toBe(false);
    for (const code of unsupported)
      expect(
        (await request(`/processing-pipelines/${code}/files`)).status,
      ).toBe(403);
    const stored = await app.pool.query(
      "SELECT code FROM processing_pipelines WHERE code = ANY($1::text[])",
      [unsupported],
    );
    expect(stored.rowCount).toBe(3);
  });

  it("orders EOM Globe guidelines as 307, 317, 324 before unconfirmed and SAP files", async () => {
    const data = await (
      await request("/processing-pipelines/bss_eom_glob/files")
    ).json();
    expect(
      data.files
        .slice(0, 3)
        .map((file: { expectedFileName: string }) =>
          file.expectedFileName.slice(0, 3),
        ),
    ).toEqual(["307", "317", "324"]);
  });

  it.each(["aprm_voice_accrual", "aprm_voice_delta"])(
    "excludes SAP output guidelines and rejects direct or disguised output uploads in %s",
    async (code) => {
      const files = (
        await (await request(`/processing-pipelines/${code}/files`)).json()
      ).files;
      expect(files.length).toBeGreaterThan(0);
      expect(
        files.some((file: { expectedFileName: string }) =>
          /_output\.txt$/i.test(file.expectedFileName),
        ),
      ).toBe(false);
      const output = code.endsWith("accrual")
        ? "ICEXT_BYN_A_VOICE_output.TXT"
        : "ICEXT_BYN_I_VOICE_P1_OUTPUT.TXT";
      expect((await upload(code, output)).status).toBe(400);
      expect(
        (await upload(code, files[0].expectedFileName, output)).status,
      ).toBe(400);
      expect((await upload(code, files[0].expectedFileName)).status).toBe(201);
    },
  );

  it.each(["", ".xlsx"])(
    "routes IBOB upload with extra extension '%s', listing, content and deletion through the actualization folder",
    async (extraExtension) => {
      const code = "isms_ibob_actzn",
        name = "ACT_ISMS_IB_OB_01.XLSX";
      const response = await upload(code, name, name + extraExtension);
      expect(response.status).toBe(201);
      const result = await response.json();
      expect(result.renamed).toBe(Boolean(extraExtension));
      const key = result.file.key;
      expect(key).toBe(`isms_ibob_actualization/inbound/${name}`);
      const listing = await (
        await request(`/processing-pipelines/${code}/files`)
      ).json();
      expect(
        listing.files.find((file: { key: string }) => file.key === key)
          ?.availability,
      ).toBe("present");
      expect(
        await (
          await request(
            `/processing-pipelines/${code}/files/content?${new URLSearchParams({ key })}`,
          )
        ).text(),
      ).toBe("ticket-test-content");
      expect(
        (
          await request(
            `/processing-pipelines/${code}/files?${new URLSearchParams({ key })}`,
            "admin",
            { method: "DELETE" },
          )
        ).status,
      ).toBe(204);
      expect(
        (
          await request(
            `/processing-pipelines/${code}/files?${new URLSearchParams({ key: `isms_ibob_actzn/inbound/${name}` })}`,
            "admin",
            { method: "DELETE" },
          )
        ).status,
      ).toBe(404);
    },
  );

  it("keeps historical IBOB keys readable and removable without routing new uploads there", async () => {
    const key = "isms_ibob_actzn/inbound/ACT_ISMS_IB_OB_02.XLSX";
    await fetch(
      `${process.env.TEST_S3_ENDPOINT}/${app.config.S3_BUCKET}/${key}`,
      { method: "PUT", body: "historical content" },
    );
    const query = new URLSearchParams({ key });
    const content = await request(
      `/processing-pipelines/isms_ibob_actzn/files/content?${query}`,
    );
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("historical content");
    expect(
      (
        await request(
          `/processing-pipelines/isms_ibob_actzn/files?${query}`,
          "admin",
          { method: "DELETE" },
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await request(
          `/processing-pipelines/bss_eom_glob/files/content?${query}`,
        )
      ).status,
    ).toBe(404);
  });

  it.each(["glob", "bayn", "inov"])(
    "deletes EOM %s files, preserves uploader/read timestamps, and permits re-upload",
    async (entity) => {
      const code = `bss_eom_${entity}`;
      const { files } = await (
        await request(`/processing-pipelines/${code}/files`)
      ).json();
      const created = await (
        await request(`/processing-pipelines/${code}/upload-batches`, "admin", {
          method: "POST",
        })
      ).json();
      const response = await upload(
        code,
        files[0].expectedFileName,
        undefined,
        created.batch.id,
      );
      expect(response.status).toBe(201);
      const key = (await response.json()).file.key;
      const before = (
        await (
          await request(`/processing-pipelines/${code}/upload-batches`)
        ).json()
      ).batches[0];
      expect(Number.isNaN(Date.parse(before.files[0].readAt))).toBe(false);
      expect(
        (
          await request(
            `/processing-pipelines/${code}/files?${new URLSearchParams({ key })}`,
            "none",
            { method: "DELETE" },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await request(
            `/processing-pipelines/${code}/files?${new URLSearchParams({ key })}`,
            "admin",
            { method: "DELETE" },
          )
        ).status,
      ).toBe(204);
      const after = (
        await (
          await request(`/processing-pipelines/${code}/upload-batches`)
        ).json()
      ).batches[0];
      expect(after.uploadedBy).toBe(before.uploadedBy);
      expect(after.files[0]).toMatchObject({
        readAt: before.files[0].readAt,
        objectKey: key,
        removedAt: expect.any(String),
      });
      expect((await upload(code, files[0].expectedFileName)).status).toBe(201);
    },
  );

  it("saves a shuffled Memo batch by date, retains every file, and lists/reads/removes later numbers", async () => {
    const code = "memo_sst";
    const selections = [
      {
        originalName: "3PComms_01022027.xlsx",
        expectedFileName: "3PComms_01.XLSX",
      },
      {
        originalName: "Dental_10152026.xlsx",
        expectedFileName: "Dental_01.XLSX",
      },
      {
        originalName: "3PComms_12312025.xlsx",
        expectedFileName: "3PComms_01.XLSX",
      },
      {
        originalName: "3PComms_02012026.xlsx",
        expectedFileName: "3PComms_01.XLSX",
      },
    ];
    const created = await request(
      `/processing-pipelines/${code}/upload-batches`,
      "admin",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: selections }),
      },
    );
    expect(created.status).toBe(201);
    const plan = await created.json();
    expect(
      plan.files.map(
        (file: { originalName: string; savedFileName: string }) => [
          file.originalName,
          file.savedFileName,
        ],
      ),
    ).toEqual([
      ["3PComms_12312025.xlsx", "3PComms_01.XLSX"],
      ["3PComms_02012026.xlsx", "3PComms_02.XLSX"],
      ["3PComms_01022027.xlsx", "3PComms_03.XLSX"],
      ["Dental_10152026.xlsx", "Dental_01.XLSX"],
    ]);
    // Upload in selection order to prove that the backend uses its plan.
    for (const file of selections) {
      const body = new FormData();
      body.set("expectedFileName", file.expectedFileName);
      body.set("batchId", plan.batch.id);
      body.set(
        "file",
        new Blob([file.originalName], { type: "text/plain" }),
        file.originalName,
      );
      const response = await request(
        `/processing-pipelines/${code}/files`,
        "admin",
        { method: "POST", body },
      );
      expect(response.status).toBe(201);
      expect((await response.json()).file.name).toBe(
        plan.files.find(
          (entry: { originalName: string }) =>
            entry.originalName === file.originalName,
        ).savedFileName,
      );
    }
    const batches = (
      await (
        await request(`/processing-pipelines/${code}/upload-batches`)
      ).json()
    ).batches;
    const batch = batches.find(
      (entry: { id: string }) => entry.id === plan.batch.id,
    );
    expect(batch.files).toHaveLength(4);
    const inventory = (
      await (await request(`/processing-pipelines/${code}/files`)).json()
    ).files;
    expect(
      inventory.filter(
        (file: { expectedFileName: string }) =>
          file.expectedFileName === "3PComms_01.XLSX",
      ),
    ).toHaveLength(3);
    const key = `${code}/inbound/3PComms_02.XLSX`;
    const query = new URLSearchParams({ key });
    const content = await request(
      `/processing-pipelines/${code}/files/content?${query}`,
    );
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("3PComms_02012026.xlsx");
    // A foreign owner, or a file absent from the plan, cannot write any object.
    await app.pool.query(
      "INSERT INTO app_user_modules (user_id,module_id) VALUES ($1,'memo_sst')",
      [app.users.business],
    );
    expect(
      (
        await upload(
          code,
          selections[0].expectedFileName,
          selections[0].originalName,
          plan.batch.id,
          "business",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await upload(
          code,
          selections[0].expectedFileName,
          "3PComms_10272026.xlsx",
          plan.batch.id,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await upload(
          code,
          selections[0].expectedFileName,
          selections[0].originalName,
          plan.batch.id,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/processing-pipelines/${code}/files?${query}`, "admin", {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    const after = (
      await (
        await request(`/processing-pipelines/${code}/upload-batches`)
      ).json()
    ).batches.find((entry: { id: string }) => entry.id === plan.batch.id);
    expect(after.files).toHaveLength(4);
    expect(
      after.files.find((file: { objectKey: string }) => file.objectKey === key)
        .removedAt,
    ).toEqual(expect.any(String));
    expect(
      after.files.filter(
        (file: { removedAt: string | null }) => !file.removedAt,
      ),
    ).toHaveLength(3);
  });

  it("continues Memo numbering across batches, preserves old objects, and resets after inbound is cleared", async () => {
    const code = "memo_sst";
    const files = ["Fuel_01022027.xlsx", "Fuel_12312025.xlsx"].map(
      (originalName) => ({ originalName, expectedFileName: "Fuel_01.XLSX" }),
    );
    const ids: string[] = [];
    for (const attempt of [0, 1]) {
      const created = await request(
        `/processing-pipelines/${code}/upload-batches`,
        "admin",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files }),
        },
      );
      expect(created.status).toBe(201);
      const plan = await created.json();
      ids.push(plan.batch.id);
      expect(
        plan.files.map((file: { savedFileName: string }) => file.savedFileName),
      ).toEqual(
        attempt
          ? ["Fuel_03.XLSX", "Fuel_04.XLSX"]
          : ["Fuel_01.XLSX", "Fuel_02.XLSX"],
      );
      for (const file of files) {
        const body = new FormData();
        body.set("expectedFileName", file.expectedFileName);
        body.set("batchId", plan.batch.id);
        body.set("replace", attempt ? "true" : "false");
        body.set(
          "file",
          new Blob([`${attempt}:${file.originalName}`], { type: "text/plain" }),
          file.originalName,
        );
        const response = await request(
          `/processing-pipelines/${code}/files`,
          "admin",
          { method: "POST", body },
        );
        expect(response.status).toBe(201);
        expect((await response.json()).replaced).toBe(false);
      }
    }
    expect(ids[0]).not.toBe(ids[1]);
    const batches = (
      await (
        await request(`/processing-pipelines/${code}/upload-batches`)
      ).json()
    ).batches;
    for (const id of ids) {
      expect(
        batches.find((batch: { id: string }) => batch.id === id).files,
      ).toHaveLength(2);
    }
    const query = new URLSearchParams({ key: `${code}/inbound/Fuel_01.XLSX` });
    const content = await request(
      `/processing-pipelines/${code}/files/content?${query}`,
    );
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("0:Fuel_12312025.xlsx");
    const later = await request(
      `/processing-pipelines/${code}/files/content?${new URLSearchParams({ key: `${code}/inbound/Fuel_03.XLSX` })}`,
    );
    expect(await later.text()).toBe("1:Fuel_12312025.xlsx");
    // Leave a gap: numbering must continue at 05, not reuse 01.
    await request(`/processing-pipelines/${code}/files?${query}`, "admin", {
      method: "DELETE",
    });
    const next = await (
      await request(`/processing-pipelines/${code}/upload-batches`, "admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      })
    ).json();
    expect(next.files[0].savedFileName).toBe("Fuel_05.XLSX");
    // Simulate the Step Function's move to a sibling directory outside inbound.
    for (const number of [2, 3, 4]) {
      const key = `${code}/inbound/Fuel_0${number}.XLSX`;
      await app.s3.send(
        new CopyObjectCommand({
          Bucket: app.config.S3_BUCKET,
          Key: `${code}/processed/Fuel_0${number}.XLSX`,
          CopySource: `${app.config.S3_BUCKET}/${key}`,
        }),
      );
      await app.s3.send(
        new DeleteObjectCommand({ Bucket: app.config.S3_BUCKET, Key: key }),
      );
    }
    const reset = await (
      await request(`/processing-pipelines/${code}/upload-batches`, "admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      })
    ).json();
    expect(
      reset.files.map((file: { savedFileName: string }) => file.savedFileName),
    ).toEqual(["Fuel_01.XLSX", "Fuel_02.XLSX"]);
    const resetUpload = await upload(
      code,
      "Fuel_01.XLSX",
      reset.files[0].originalName,
      reset.batch.id,
    );
    expect(resetUpload.status).toBe(201);
    expect((await resetUpload.json()).file.name).toBe("Fuel_01.XLSX");
    const single = await upload(code, "Fuel_01.XLSX", "Fuel_10272026.xlsx");
    expect(single.status).toBe(201);
    expect((await single.json()).file.name).toBe("Fuel_02.XLSX");
    expect((await request("/healthz")).status).toBe(200);
  });

  it("never overwrites Memo objects even when another batch took the planned name and replace=true", async () => {
    const code = "memo_sst",
      expected = "Security_01.XLSX",
      original = "Security_10272026.xlsx";
    const create = async () =>
      await (
        await request(`/processing-pipelines/${code}/upload-batches`, "admin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: [{ originalName: original, expectedFileName: expected }],
          }),
        })
      ).json();
    const first = await create(),
      second = await create();
    expect(
      (await upload(code, expected, original, first.batch.id)).status,
    ).toBe(201);
    const body = new FormData();
    body.set("file", new Blob(["must not replace existing content"]), original);
    body.set("expectedFileName", expected);
    body.set("batchId", second.batch.id);
    body.set("replace", "true");
    const collision = await request(
      `/processing-pipelines/${code}/files`,
      "admin",
      { method: "POST", body },
    );
    expect(collision.status).toBe(409);
    const query = new URLSearchParams({ key: `${code}/inbound/${expected}` });
    expect(
      await (
        await request(`/processing-pipelines/${code}/files/content?${query}`)
      ).text(),
    ).toBe("ticket-test-content");
    expect((await create()).files[0].savedFileName).toBe("Security_02.XLSX");
  });

  it("protects a Memo object with an atomic conditional write during concurrent requests", async () => {
    const Key = "memo_sst/inbound/Optical_01.XLSX";
    const results = await Promise.allSettled(
      ["first", "second"].map((Body) =>
        app.s3.send(
          new PutObjectCommand({
            Bucket: app.config.S3_BUCKET,
            Key,
            Body,
            IfNoneMatch: "*",
          }),
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const failed = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(failed.reason.name).toBe("PreconditionFailed");
    const object = await app.s3.send(
      new GetObjectCommand({ Bucket: app.config.S3_BUCKET, Key }),
    );
    const successfulIndex = results.findIndex(
      (result) => result.status === "fulfilled",
    );
    expect(await object.Body!.transformToString()).toBe(
      ["first", "second"][successfulIndex],
    );
  });

  it.each([
    "AUR.xlsx",
    "October 2026 AUR usage export.xlsx",
    "monthly_aur_10272026.XLSX",
  ])(
    "accepts an APRM Accrual AUR workbook named %s and saves the canonical name",
    async (name) => {
      const body = new FormData();
      body.set("file", new Blob([name]), name);
      body.set("expectedFileName", "AUR Extract FINAL_BILLING.XLSX");
      body.set("replace", "true");
      const response = await request(
        "/processing-pipelines/aprm_voice_accrual/files",
        "admin",
        { method: "POST", body },
      );
      expect(response.status).toBe(201);
      expect((await response.json()).file.name).toBe(
        "AUR Extract FINAL_BILLING.XLSX",
      );
    },
  );

  it.each(["Usage extract.xlsx", "AU_R.xlsx", "AUR.csv"])(
    "rejects a filename outside the AUR workbook rule: %s",
    async (name) => {
      expect(
        (
          await upload(
            "aprm_voice_accrual",
            "AUR Extract FINAL_BILLING.XLSX",
            name,
          )
        ).status,
      ).toBe(400);
    },
  );

  it("rejects invalid Memo batches before creating history", async () => {
    for (const names of [
      ["3PComms_02302026.xlsx"],
      ["Unknown_10272026.xlsx"],
      ["3PComms_10272026.xlsx", "3pcomms_10272026.XLSX.xlsx"],
    ]) {
      const response = await request(
        "/processing-pipelines/memo_sst/upload-batches",
        "admin",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: names.map((originalName) => ({
              originalName,
              expectedFileName: "3PComms_01.XLSX",
            })),
          }),
        },
      );
      expect(response.status).toBe(400);
    }
  });

  it("reruns migration 025 without changing assignments or deleting audit history", async () => {
    const before = await app.pool.query(
      "SELECT * FROM app_user_modules ORDER BY user_id,module_id",
    );
    const historyBefore = await app.pool.query(
      "SELECT * FROM audit_actions ORDER BY id",
    );
    await app.pool.query(
      migrations.find(
        (migration) => migration.id === "025_workspace_ticket_fixes",
      )!.sql,
    );
    expect(
      (
        await app.pool.query(
          "SELECT * FROM app_user_modules ORDER BY user_id,module_id",
        )
      ).rows,
    ).toEqual(before.rows);
    expect(historyBefore.rowCount).toBeGreaterThan(0);
    expect(
      (await app.pool.query("SELECT * FROM audit_actions ORDER BY id")).rows,
    ).toEqual(historyBefore.rows);
  });
});
