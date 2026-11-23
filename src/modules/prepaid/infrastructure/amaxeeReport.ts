import type { PoolClient } from "pg";

export const amaxeeHeaders = [
  "Cycle_Code",
  "Customer Type",
  "Charge Code/Tax Code",
  "Amount",
] as const;

export async function readAmaxeeRows(
  db: PoolClient,
  startedAt: string,
  filenames: string[],
) {
  await db.query("SELECT set_config('esatp.prepaid_billing_scope', $1, true)", [
    JSON.stringify({ started_at: startedAt, filenames }),
  ]);
  // Fetch one row beyond the four-column workbook limit so export rejects oversized results.
  const { rows } = await db.query(
    `WITH adjustments AS (
      SELECT h.cycle_code, l."Customer Type", l."Subscriber Type",
             upper(l."Adjustment Code") AS code,
             sum(l.amount::double precision)::numeric(33, 2) AS amount
      FROM sdbtdir1_prepaid_dbo.billed_adjustments_header_cycle_ssis h
      JOIN sdbtdir1_prepaid_dbo.billed_adjustments_lineitem_cycle_ssis l USING (cyclenumber)
      WHERE h.cyclenumber BETWEEN 1 AND 10 AND upper(l."Adjustment Code") = 'AMAXCEP'
      GROUP BY h.cyclenumber, h.cycle_code, l."Customer Type", l."Subscriber Type", upper(l."Adjustment Code")
    ), charges AS (
      SELECT h.cycle_code, l."Customer Type", l."Subscriber Type",
             l."Charge Code/Tax Code" AS code,
             sum(l."Total Amount"::double precision)::numeric(33, 2) AS amount
      FROM sdbtdir1_prepaid_dbo.billed_charges_header_cycle_ssis h
      JOIN sdbtdir1_prepaid_dbo.billed_charges_lineitem_cycle_ssis l USING (cyclenumber)
      WHERE h.cyclenumber BETWEEN 1 AND 10 AND upper(l."Charge Code/Tax Code") = 'AMAXCEP'
      GROUP BY h.cyclenumber, h.cycle_code, l."Customer Type", l."Subscriber Type", l."Charge Code/Tax Code"
    )
    SELECT c.cycle_code AS "Cycle_Code", c."Customer Type",
           c.code AS "Charge Code/Tax Code",
           (coalesce(c.amount, 0) + coalesce(a.amount, 0))::text AS "Amount"
    FROM charges c FULL OUTER JOIN adjustments a
      ON c.cycle_code = a.cycle_code
      AND upper(c."Customer Type") = upper(a."Customer Type")
      AND upper(c."Subscriber Type") = upper(a."Subscriber Type")
      AND upper(c.code) = a.code
    ORDER BY c.cycle_code::integer NULLS FIRST, c."Customer Type" NULLS FIRST, c.code NULLS FIRST
    LIMIT 62500`,
  );
  return rows;
}
