/** 007 preserves prior execution records; new AWS input and backend-only
 * context are deliberately separate. No raw/financial data is rewritten.
 */
export function prepaidSourceBackendMigrationSql(schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema");
  return `ALTER TABLE "${schema}".prepaid_source_extractions ADD COLUMN context jsonb;`;
}
