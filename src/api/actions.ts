import { Hono } from 'hono'
import type Database from 'better-sqlite3'
import type { SalesConfig } from '../utils/config.js'

interface ActionRow {
  id: number
  status: string
  agent_role: string
  product_id: number | null
  action_type: string
  action_data: string
}

export function createActionRoutes(db: Database.Database, _config: SalesConfig): Hono {
  const app = new Hono()

  // GET / — list actions with filters
  app.get('/', (c) => {
    const status = c.req.query('status')
    const agent = c.req.query('agent')
    const product = c.req.query('product')
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200)

    const conditions: string[] = []
    const args: (string | number)[] = []

    if (status) { conditions.push('a.status = ?'); args.push(status) }
    if (agent) { conditions.push('a.agent_role = ?'); args.push(agent) }
    if (product) { conditions.push('p.name = ?'); args.push(product) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    // Built by Christos Ferlachidis & Daniel Hedenberg
    const rows = db.prepare(`
      SELECT a.*, p.name AS product_name
      FROM action_queue a
      LEFT JOIN products p ON p.id = a.product_id
      ${where}
      ORDER BY
        CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        a.created_at DESC
      LIMIT ?
    `).all(...args, limit)

    return c.json(rows)
  })

  // POST / — queue a new action (with dedup)
  app.post('/', async (c) => {
    const body = await c.req.json() as {
      agent_role: string; agent_name: string; product_id?: number
      action_type: string; action_data: string; priority?: string
    }
    if (!body.agent_role || !body.action_type || !body.action_data) {
      return c.json({ error: 'agent_role, action_type, and action_data required' }, 400)
    }

    // Ensure action_data is a string
    if (typeof body.action_data !== 'string') {
      body.action_data = JSON.stringify(body.action_data)
    }

    // Hard limit: max 1 pending action per agent — must be approved/rejected first
    const pendingForAgent = db.prepare(
      `SELECT COUNT(*) as c FROM action_queue WHERE agent_role = ? AND status = 'pending'`
    ).get(body.agent_role) as { c: number }
    if (pendingForAgent.c >= 3) {
      return c.json({
        blocked: true,
        message: `${body.agent_name || body.agent_role} har redan ${pendingForAgent.c} väntande actions (max 3). Godkänn eller avslå först.`,
        pending_count: pendingForAgent.c,
      }, 200)
    }

    // Built by Christos Ferlachidis & Daniel Hedenberg
    // Dedup: check for similar pending action (same type + similar title/description)
    let actionTitle = ''
    try {
      const parsed = JSON.parse(body.action_data)
      actionTitle = (parsed.title || parsed.description || '').toLowerCase().trim()
    } catch { /* not json, skip dedup */ }

    if (actionTitle && actionTitle.length > 10) {
      const pending = db.prepare(
        `SELECT id, action_data FROM action_queue WHERE action_type = ? AND status = 'pending'`
      ).all(body.action_type) as { id: number; action_data: string }[]

      for (const existing of pending) {
        try {
          const existingData = JSON.parse(existing.action_data)
          const existingTitle = (existingData.title || existingData.description || '').toLowerCase().trim()
          if (!existingTitle) continue
          // Check if titles share 60%+ words
          const newWords = new Set(actionTitle.split(/\s+/).filter((w: string) => w.length > 2))
          const existingWords = new Set(existingTitle.split(/\s+/).filter((w: string) => w.length > 2))
          if (newWords.size === 0 || existingWords.size === 0) continue
          let overlap = 0
          for (const w of newWords) { if (existingWords.has(w)) overlap++ }
          const similarity = overlap / Math.max(newWords.size, existingWords.size)
          if (similarity >= 0.6) {
            return c.json({ deduplicated: true, existing_id: existing.id, message: 'Similar action already pending' }, 200)
          }
        } catch { continue }
      }
    }

    const result = db.prepare(`
      INSERT INTO action_queue (agent_role, agent_name, product_id, action_type, action_data, priority, requires_approval)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(
      body.agent_role, body.agent_name || body.agent_role,
      body.product_id || null, body.action_type, body.action_data,
      body.priority || 'medium'
    )

    const action = db.prepare('SELECT * FROM action_queue WHERE id = ?').get(result.lastInsertRowid)
    return c.json(action, 201)
  })

  // POST /:id/approve
  app.post('/:id/approve', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const action = db.prepare('SELECT * FROM action_queue WHERE id = ?').get(id) as ActionRow | undefined
    if (!action) return c.json({ error: 'Action not found' }, 404)
    if (action.status !== 'pending') return c.json({ error: `Action is ${action.status}` }, 400)

    let body: { approved_by?: string } = {}
    try { body = await c.req.json() } catch { /* empty body ok */ }

    db.prepare(`
      UPDATE action_queue SET status = 'approved', approved_by = ?, approved_at = datetime('now')
      WHERE id = ?
    `).run(body.approved_by || 'admin', id)

    const updated = db.prepare('SELECT * FROM action_queue WHERE id = ?').get(id)
    return c.json(updated)
  })

  // POST /:id/reject
  app.post('/:id/reject', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const action = db.prepare('SELECT * FROM action_queue WHERE id = ?').get(id) as ActionRow | undefined
    if (!action) return c.json({ error: 'Action not found' }, 404)
    if (action.status !== 'pending') return c.json({ error: `Action is ${action.status}` }, 400)

    let body: { feedback?: string } = {}
    try { body = await c.req.json() } catch { /* empty body ok */ }

    db.prepare('UPDATE action_queue SET status = ?, feedback = ? WHERE id = ?')
      .run('rejected', body.feedback || null, id)

    // Save feedback as learning for the agent
    if (body.feedback) {
      db.prepare(`
        INSERT INTO learnings (agent_role, product_id, category, insight, confidence, source)
        VALUES (?, ?, 'user_feedback', ?, 0.7, 'user_feedback')
      `).run(action.agent_role, action.product_id, body.feedback)
    }

    const updated = db.prepare('SELECT * FROM action_queue WHERE id = ?').get(id)
    return c.json(updated)
  })

  // POST /:id/execute
  app.post('/:id/execute', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const action = db.prepare('SELECT * FROM action_queue WHERE id = ?').get(id) as ActionRow | undefined
    if (!action) return c.json({ error: 'Action not found' }, 404)
    if (action.status !== 'approved') return c.json({ error: `Must be approved first (is ${action.status})` }, 400)

    db.prepare("UPDATE action_queue SET status = 'executed', executed_at = datetime('now') WHERE id = ?").run(id)

    const updated = db.prepare('SELECT * FROM action_queue WHERE id = ?').get(id)
    return c.json(updated)
  })

  // DELETE /:id
  app.delete('/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const existing = db.prepare('SELECT id FROM action_queue WHERE id = ?').get(id)
    if (!existing) return c.json({ error: 'Action not found' }, 404)
    db.prepare('DELETE FROM action_queue WHERE id = ?').run(id)
    return c.json({ deleted: true, id })
  })

  return app
}
