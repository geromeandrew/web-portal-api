import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratePrepaid } from "../src/modules/prepaid/infrastructure/migrationRunner.js";

const url = process.env.PREPAID_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (
    target.hostname !== "127.0.0.1" ||
    target.port !== "55479" ||
    target.username !== "prepaid_test"
  )
    throw Error(
      "Accounting tests require the disposable prepaid_test cluster on port 55479.",
    );
}

describe.skipIf(!url)(
  "Versioned legacy accounting (isolated PostgreSQL)",
  () => {
    const schema = `prepaid_accounting_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    const actor = randomUUID(),
      workspace = randomUUID();
    const key = {
      period: "2023-09",
      cost_element: "123",
      brand: "GP",
      cfu: "CM",
      revenue_type: "MT",
      sub_product: "SUB",
    };
    const ke = {
      ...key,
      profit_center: "P1",
      amount: "100",
      quantity: "10",
      reference_document: "1",
      uom: "EA",
    };
    const ref = {
      ...key,
      client: "300",
      company: "GLOB",
      tax_rate: "0.12",
      average_rate: "10",
      uom: "EA",
      posting_key: "50",
    };
    beforeAll(async () => {
      await pool.query(
        `CREATE SCHEMA "${schema}"; CREATE TABLE app_user(id uuid PRIMARY KEY); CREATE TABLE workspaces(id uuid PRIMARY KEY)`,
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await migratePrepaid(client, schema, schema + "_raw");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      await pool.query("INSERT INTO app_user VALUES($1);", [actor]);
      await pool.query("INSERT INTO workspaces VALUES($1);", [workspace]);
    });
    afterAll(async () => {
      await pool.query(
        `DROP SCHEMA "${schema}_raw" CASCADE; DROP SCHEMA "${schema}" CASCADE`,
      );
      await pool.end();
    });
    let period = 0;
    async function fixture(
      ke24: object[],
      reference: object[],
      legacy = true,
      region = "eg",
      referencePolicy = false,
    ) {
      const run = randomUUID(),
        snapshot = randomUUID(),
        revision = randomUUID();
      const config = legacy
        ? {
            accountingProfile: "legacy_sql_v1",
            ...(referencePolicy
              ? {
                  referenceValidationPolicy: "legacy_all_matches",
                  referenceExport: { approved: true },
                }
              : {}),
          }
        : {};
      await pool.query(
        "INSERT INTO prepaid_runs(id,workspace_id,period,created_by,configuration) VALUES($1,$2,$3,$4,$5)",
        [
          run,
          workspace,
          `${2030 + Math.floor(period / 12)}-${String((period++ % 12) + 1).padStart(2, "0")}`,
          actor,
          config,
        ],
      );
      await pool.query(
        "INSERT INTO prepaid_source_snapshots(id,run_id,status,source_files,configuration) VALUES($1,$2,'pending','[]',$3)",
        [snapshot, run, config],
      );
      for (const [name, rows] of [
        ["ke24", ke24],
        ["reference", reference],
      ] as const)
        await pool.query(
          `INSERT INTO prepaid_stage_${name}(snapshot_id,row_number,data) SELECT $1,ordinality,value FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY`,
          [snapshot, JSON.stringify(rows)],
        );
      await pool.query(
        "UPDATE prepaid_source_snapshots SET status='ready' WHERE id=$1",
        [snapshot],
      );
      await pool.query(
        "INSERT INTO prepaid_region_revisions(id,run_id,region,revision,status,source_snapshot_id,imported) VALUES($1,$2,$3,1,'draft',$4,true)",
        [revision, run, region, snapshot],
      );
      await pool.query("SELECT prepaid_initialize_layout($1)", [revision]);
      await pool.query(
        "UPDATE prepaid_layout_rows SET gp_mt_gross=112,hy_mt_gross=0,gp_bb_gross=0 WHERE revision_id=$1 AND layout_number=18",
        [revision],
      );
      await pool.query(
        "UPDATE prepaid_layout_rows SET total_gross=0 WHERE revision_id=$1 AND layout_number=27",
        [revision],
      );
      return { run, snapshot, revision };
    }
    async function build(revision: string) {
      await pool.query("SELECT prepaid_build_outputs($1)", [revision]);
      const rows = (
        await pool.query(
          "SELECT * FROM prepaid_allocations WHERE revision_id=$1 ORDER BY profit_center,denominator,allocation_type",
          [revision],
        )
      ).rows;
      const findings = (
        await pool.query(
          "SELECT findings FROM prepaid_validation_results WHERE revision_id=$1",
          [revision],
        )
      ).rows[0].findings;
      const valid = (
        await pool.query(
          "SELECT valid FROM prepaid_validation_results WHERE revision_id=$1",
          [revision],
        )
      ).rows[0].valid;
      return { rows, codes: findings.map((f: any) => f.code), findings, valid };
    }
    it("keeps historical whole-period allocation while reproducing C012/C013 profit-centre denominator fan-out in the new profile", async () => {
      const input = [
        { ...ke, amount: "60" },
        { ...ke, profit_center: "P2", amount: "40" },
      ];
      const old = await fixture(input, [ref], false),
        current = await fixture(input, [ref]);
      const before = await build(old.revision),
        after = await build(current.revision);
      const sum = (rows: any[]) =>
        rows
          .filter((r) => r.revenue_type === "GP_EG_MT")
          .reduce((a, r) => a + Number(r.amount2), 0);
      expect(sum(before.rows)).toBe(100);
      // C013 joins C012 on RevenueType alone. This literal legacy behaviour is
      // deliberately visible, not silently changed to a different accounting rule.
      expect(sum(after.rows)).toBeCloseTo(416.67, 2);
      expect(after.codes).toContain("RECONCILIATION_DIFFERENCE");
      expect(before.codes).not.toContain("RECONCILIATION_DIFFERENCE");
    });
    it("preserves posting-key multiplicity from C014 instead of choosing an arbitrary reference row", async () => {
      const f = await fixture([ke], [ref, { ...ref, posting_key: "40" }]);
      const output = await build(f.revision);
      expect(
        output.rows.find((r) => r.revenue_type === "GP_EG_MT").amount2,
      ).toBe("200.00");
      expect(output.codes).toContain("RECONCILIATION_DIFFERENCE");
      expect(output.codes).not.toContain("REFERENCE_MAPPING_AMBIGUOUS");
    });
    it("suppresses fallback only for the same posting key and removes exact UNION duplicates", async () => {
      const f = await fixture(
        [ke],
        [
          {
            ...ref,
            cfu: "CB",
            revenue_type: "BB",
            posting_key: "40",
            tax_rate: "0.10",
          },
          {
            ...ref,
            cfu: "CB",
            revenue_type: "BB",
            posting_key: "40",
            tax_rate: "0.10",
          },
          { ...ref, cfu: "SG", revenue_type: "BB", posting_key: "50" },
        ],
      );
      const rows = (
        await pool.query(
          "SELECT posting_key,tax_rate::text FROM prepaid_legacy_reference_expanded WHERE snapshot_id=$1 AND cfu='SG' AND revenue_type='BB' ORDER BY posting_key",
          [f.snapshot],
        )
      ).rows;
      expect(rows).toEqual([
        { posting_key: "40", tax_rate: "0.10" },
        { posting_key: "50", tax_rate: "0.12" },
      ]);
    });
    it("matches source keys case-insensitively and ignores ambiguity in unused reference keys", async () => {
      const f = await fixture(
        [{ ...ke, sub_product: "sub" }],
        [
          ref,
          { ...ref, sub_product: "OTHER" },
          { ...ref, sub_product: "OTHER", average_rate: "20" },
        ],
      );
      const output = await build(f.revision);
      expect(output.codes).not.toContain("REFERENCE_MAPPING_MISSING");
      expect(output.codes).not.toContain("REFERENCE_MAPPING_AMBIGUOUS");
      expect(
        output.rows.find((r) => r.revenue_type === "GP_EG_MT").amount2,
      ).toBe("100.00");
    });
    it("continues to block used ambiguous rates, zero rates and missing mappings", async () => {
      const f = await fixture(
        [ke, { ...ke, cost_element: "999" }],
        [ref, { ...ref, average_rate: "0" }],
      );
      const output = await build(f.revision);
      expect(output.codes).toEqual(
        expect.arrayContaining([
          "REFERENCE_MAPPING_AMBIGUOUS",
          "REFERENCE_MAPPING_MISSING",
          "AVERAGE_RATE_ZERO",
        ]),
      );
      await expect(
        pool.query("SELECT prepaid_freeze_layout($1,$2)", [f.revision, actor]),
      ).rejects.toThrow("PREPAID_VALIDATION_FAILED");
    });
    it("uses the authoritative zero rate as C133 zero quantity only under the explicit policy", async () => {
      const strict = await fixture([ke], [{ ...ref, average_rate: "0" }]);
      expect((await build(strict.revision)).valid).toBe(false);
      const current = await fixture(
        [ke],
        [{ ...ref, average_rate: "0" }],
        true,
        "eg",
        true,
      );
      const output = await build(current.revision);
      expect(output.valid).toBe(true);
      expect(
        output.rows.find((r) => r.revenue_type === "GP_EG_MT"),
      ).toMatchObject({ average_rate: "0", hits2: "0", amount2: "100.00" });
      expect(output.findings).toContainEqual({
        code: "AVERAGE_RATE_ZERO",
        severity: "warning",
        policy: "legacy_all_matches",
      });
      await pool.query("SELECT prepaid_freeze_layout($1,$2)", [
        current.revision,
        actor,
      ]);
      await expect(build(current.revision)).rejects.toThrow(
        "PREPAID_DRAFT_REQUIRED",
      );
    });
    it("keeps all authoritative conflicting rates and blocks any resulting reconciliation difference", async () => {
      const current = await fixture(
        [ke],
        [ref, { ...ref, average_rate: "20" }],
        true,
        "eg",
        true,
      );
      const output = await build(current.revision);
      expect(
        output.rows
          .filter((r) => r.revenue_type === "GP_EG_MT")
          .map((r) => r.average_rate)
          .sort(),
      ).toEqual(["10", "20"]);
      expect(output.findings).toContainEqual({
        code: "REFERENCE_MAPPING_AMBIGUOUS",
        severity: "warning",
        policy: "legacy_all_matches",
      });
      expect(output.codes).toContain("RECONCILIATION_DIFFERENCE");
      expect(output.valid).toBe(false);
      await expect(
        pool.query("SELECT prepaid_freeze_layout($1,$2)", [
          current.revision,
          actor,
        ]),
      ).rejects.toThrow("PREPAID_VALIDATION_FAILED");
    });
    it("explains only conserved legacy cutoff/rounding differences while retaining their exact amounts", async () => {
      const input = [
        { ...ke, amount: "100.01" },
        { ...ke, sub_product: "ADJUSTMENT", amount: "-0.01" },
      ];
      const references = [ref, { ...ref, sub_product: "ADJUSTMENT" }];
      const strict = await fixture(input, references);
      expect((await build(strict.revision)).valid).toBe(false);
      const current = await fixture(input, references, true, "eg", true);
      const output = await build(current.revision);
      expect(output.valid).toBe(true);
      const finding = output.findings.find(
        (f: any) => f.code === "RECONCILIATION_DIFFERENCE",
      );
      expect(finding).toMatchObject({
        severity: "warning",
        basis: "legacy_threshold_and_rounding",
        details: [
          {
            revenueType: "GP_EG_MT",
            difference: "-0.01",
            legacyExplained: true,
            clippedRows: 1,
          },
        ],
      });
      expect(
        output.rows
          .filter((r) => r.revenue_type === "GP_EG_MT")
          .map((r) => r.amount2),
      ).toEqual(expect.arrayContaining(["100.01", "0.00"]));
      await pool.query("SELECT prepaid_freeze_layout($1,$2)", [
        current.revision,
        actor,
      ]);
    });
    it("still blocks layout variance even when legacy cutoff differences are explained", async () => {
      const current = await fixture(
        [
          { ...ke, amount: "100.01" },
          { ...ke, sub_product: "ADJUSTMENT", amount: "-0.01" },
        ],
        [ref, { ...ref, sub_product: "ADJUSTMENT" }],
        true,
        "eg",
        true,
      );
      await pool.query(
        "UPDATE prepaid_layout_rows SET total_gross=1 WHERE revision_id=$1 AND layout_number=27",
        [current.revision],
      );
      const output = await build(current.revision);
      expect(output.codes).toContain("LAYOUT_VARIANCE");
      expect(output.valid).toBe(false);
      await expect(
        pool.query("SELECT prepaid_freeze_layout($1,$2)", [
          current.revision,
          actor,
        ]),
      ).rejects.toThrow("PREPAID_VALIDATION_FAILED");
    });
    it("never converts missing mappings into warnings with the authoritative policy", async () => {
      const current = await fixture(
        [ke, { ...ke, cost_element: "999" }],
        [{ ...ref, average_rate: "0" }],
        true,
        "eg",
        true,
      );
      const output = await build(current.revision);
      expect(output.codes).toContain("REFERENCE_MAPPING_MISSING");
      expect(
        output.findings.find((f: any) => f.code === "REFERENCE_MAPPING_MISSING")
          .severity,
      ).toBeUndefined();
      expect(output.valid).toBe(false);
    });
    it("retains fractional broadband destination quantities exactly as C145/C146", async () => {
      const f = await fixture(
        [
          { ...ke, cfu: "CB", revenue_type: "BB" },
          { ...ke, cfu: "SG", revenue_type: "BB" },
        ],
        [{ ...ref, cfu: "CB", revenue_type: "BB" }],
      );
      await pool.query(
        "UPDATE prepaid_layout_rows SET gp_mt_gross=0,gp_bb_gross=22.40 WHERE revision_id=$1 AND layout_number=18",
        [f.revision],
      );
      await pool.query(
        "UPDATE prepaid_layout_rows SET gp_bb_gross=CASE layout_number WHEN 23 THEN -5.60 ELSE -16.80 END WHERE revision_id=$1 AND layout_number IN(23,24)",
        [f.revision],
      );
      const output = await build(f.revision);
      expect(
        Number(output.rows.find((r) => r.allocation_type === "GP_CB_BB").hits2),
      ).toBe(0.5);
      expect(
        Number(output.rows.find((r) => r.allocation_type === "GP_SG_BB").hits2),
      ).toBe(1.5);
    });
    it("expands a full-sized reference snapshot once within a bounded query timeout", async () => {
      const reference = Array.from({ length: 13_000 }, (_, index) => [
        { ...ref, cfu: "CB", revenue_type: "BB", sub_product: `SUB${index}` },
        { ...ref, cfu: "SG", revenue_type: "BB", sub_product: `SUB${index}` },
      ]).flat();
      const f = await fixture([ke], reference);
      const db = await pool.connect();
      try {
        await db.query("BEGIN READ ONLY");
        await db.query("SET LOCAL statement_timeout='5s'");
        const rows = (
          await db.query(
            "SELECT count(*)::int n FROM prepaid_legacy_reference_expanded WHERE snapshot_id=$1",
            [f.snapshot],
          )
        ).rows;
        expect(rows[0].n).toBe(39_000);
      } finally {
        await db.query("ROLLBACK");
        db.release();
      }
    }, 15_000);
    it("cannot rebuild a frozen revision", async () => {
      const f = await fixture([ke], [ref]);
      const before = await build(f.revision);
      await pool.query("SELECT prepaid_freeze_layout($1,$2)", [
        f.revision,
        actor,
      ]);
      await expect(build(f.revision)).rejects.toThrow("PREPAID_DRAFT_REQUIRED");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM prepaid_allocations WHERE revision_id=$1",
            [f.revision],
          )
        ).rows[0].n,
      ).toBe(before.rows.length);
    });
  },
);
