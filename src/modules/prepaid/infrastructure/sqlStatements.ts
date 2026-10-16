/** Data API accepts one statement/request. Preserve PL/pgSQL dollar bodies,
 * quoted identifiers/strings and nested comments. Reject unfinished input.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0,
    i = 0,
    quote = "",
    dollar = "",
    block = 0,
    line = false,
    escape = false;
  while (i < sql.length) {
    const c = sql[i],
      next = sql[i + 1];
    if (line) {
      if (c === "\n") line = false;
      i++;
      continue;
    }
    if (block) {
      if (c === "/" && next === "*") {
        block++;
        i += 2;
      } else if (c === "*" && next === "/") {
        block--;
        i += 2;
      } else i++;
      continue;
    }
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        i += dollar.length;
        dollar = "";
      } else i++;
      continue;
    }
    if (quote) {
      if (escape && c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) {
        if (next === quote) {
          i += 2;
          continue;
        }
        quote = "";
        escape = false;
      }
      i++;
      continue;
    }
    if (c === "-" && next === "-") {
      line = true;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      block = 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      escape =
        c === "'" &&
        /[eE]/.test(sql[i - 1] ?? "") &&
        !/[\w$]/.test(sql[i - 2] ?? "");
      i++;
      continue;
    }
    if (c === "$" && !/[\w$]/.test(sql[i - 1] ?? "")) {
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (tag) {
        dollar = tag;
        i += tag.length;
        continue;
      }
    }
    if (c === ";") {
      const statement = sql.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
    i++;
  }
  if (quote || dollar || block) throw new Error("Unterminated migration SQL");
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}
