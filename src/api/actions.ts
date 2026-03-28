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

  // POST / — queue a new action
  app.post('/', async (c) => {
    const body = await c.req.json() as {
      agent_role: string; agent_name: string; product_id?: number
      action_type: string; action_data: string; priority?: string
    }
    if (!body.agent_role || !body.action_type || !body.action_data) {
      return c.json({ error: 'agent_role, action_type, and action_data required' }, 400)
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

  return app
}
