import { sql } from '@vercel/postgres'

// The lab notebook: durable, cross-epoch memory. Roles jot short notes
// (learnings, warnings, open questions) each turn; CI failures land here as
// system notes. Recent entries are injected into every epoch's shared context
// so knowledge compounds across epochs and role rotations instead of
// evaporating with each context window.

async function ensureTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS lab_notebook (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      experiment_id UUID NOT NULL,
      epoch_number INTEGER NOT NULL,
      author TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_notebook_experiment ON lab_notebook(experiment_id, created_at)`
}

export async function addNotebookNote(
  experimentId: string,
  epochNumber: number,
  author: string,
  note: string
): Promise<void> {
  const trimmed = (note || '').trim()
  if (!trimmed) return
  try {
    await ensureTable()
    await sql`
      INSERT INTO lab_notebook (experiment_id, epoch_number, author, note)
      VALUES (${experimentId}, ${epochNumber}, ${author}, ${trimmed.slice(0, 600)})
    `
  } catch (e) {
    console.warn('[notebook] write failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}

export interface NotebookEntry {
  epoch_number: number
  author: string
  note: string
}

export async function getRecentNotebook(experimentId: string, limit = 14): Promise<NotebookEntry[]> {
  try {
    await ensureTable()
    const result = await sql`
      SELECT epoch_number, author, note
      FROM lab_notebook
      WHERE experiment_id = ${experimentId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
    return (result.rows as unknown as NotebookEntry[]).reverse() // oldest first for reading order
  } catch {
    return []
  }
}
