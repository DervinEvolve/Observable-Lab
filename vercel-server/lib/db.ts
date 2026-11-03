import { sql } from '@vercel/postgres'

// Re-export sql for direct queries
export { sql }

// Helper for single row queries
export async function queryOne<T>(
  query: TemplateStringsArray,
  ...values: unknown[]
): Promise<T | null> {
  const result = await sql(query, ...values)
  return (result.rows[0] as T) || null
}

// Helper for multi-row queries
export async function queryMany<T>(
  query: TemplateStringsArray,
  ...values: unknown[]
): Promise<T[]> {
  const result = await sql(query, ...values)
  return result.rows as T[]
}

// Transaction helper
export async function transaction<T>(
  fn: (sql: typeof import('@vercel/postgres').sql) => Promise<T>
): Promise<T> {
  // Note: Vercel Postgres doesn't support true transactions in serverless
  // For critical operations, use advisory locks or optimistic concurrency
  return fn(sql)
}
