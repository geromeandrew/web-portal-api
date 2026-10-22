import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrations } from "../src/migrations.js";
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

  it("reruns migration 025 without changing assignments or deleting audit history", async () => {
    const before = await app.pool.query(
      "SELECT * FROM app_user_modules ORDER BY user_id,module_id",
    );
    const historyBefore = await app.pool.query(
      "SELECT * FROM audit_actions ORDER BY id",
    );
    await app.pool.query(migrations.at(-1)!.sql);
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
