import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * `column = any($1::uuid[])` with the whole id list bound as ONE parameter.
 *
 * drizzle `inArray(col, ids)` renders `IN ($1, ..., $n)`; pg_stat_statements hashes
 * the query tree, so every distinct list length becomes its own row (GEM-1667 measured
 * 159 variants of the label lookup, up to 12KB each). One array param keeps a single row.
 */
export function uuidAny(column: AnyColumn, ids: readonly string[]): SQL {
  return sql`${column} = any(${sql.param([...ids])}::uuid[])`;
}
