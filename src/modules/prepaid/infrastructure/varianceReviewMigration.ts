export function prepaidVarianceReviewMigrationSql(schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema");
  const s = `"${schema}"`;
  const isCalculatedVariance =
    "f->>'code' = 'LAYOUT_VARIANCE' AND f->>'amount' IS NOT NULL";

  return `
ALTER FUNCTION ${s}.prepaid_review_validation(uuid)
  RENAME TO prepaid_review_legacy_validation;

CREATE FUNCTION ${s}.prepaid_review_variance(p_revision uuid) RETURNS void
LANGUAGE sql AS $$
  UPDATE ${s}.prepaid_validation_results v
  SET findings = reviewed.findings, valid = reviewed.valid
  FROM (
    SELECT
      jsonb_agg(CASE WHEN ${isCalculatedVariance}
        THEN f || '{"severity":"warning"}'::jsonb ELSE f END ORDER BY position) AS findings,
      bool_and(coalesce(f->>'severity', 'error') = 'warning' OR (${isCalculatedVariance})) AS valid
    FROM ${s}.prepaid_validation_results old
    CROSS JOIN LATERAL jsonb_array_elements(old.findings) WITH ORDINALITY AS finding(f, position)
    WHERE old.revision_id = p_revision
    HAVING bool_or(${isCalculatedVariance})
  ) AS reviewed
  WHERE v.revision_id = p_revision;
$$;

CREATE FUNCTION ${s}.prepaid_review_validation(p_revision uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ${s}.prepaid_review_legacy_validation(p_revision);
  PERFORM ${s}.prepaid_review_variance(p_revision);
END;
$$;

SELECT ${s}.prepaid_review_variance(v.revision_id)
FROM ${s}.prepaid_validation_results v
JOIN ${s}.prepaid_region_revisions r ON r.id = v.revision_id
WHERE r.status = 'draft'
  AND EXISTS (SELECT FROM jsonb_array_elements(v.findings) f WHERE ${isCalculatedVariance});
`;
}
