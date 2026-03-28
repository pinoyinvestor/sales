import { Hono } from 'hono'
import type Database from 'better-sqlite3'

export function createAgentTaskRoutes(db: Database.Database): Hono {
  const app = new Hono()

  // GET / — list agent tasks
  app.get('/', (c) => {
    const status = c.req.query('status')
    const agent = c.req.query('agent')
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200)

    const conditions: string[] = []
    const args: (string | number)[] = []

    // Built by Christos Ferlachidis & Daniel Hedenberg
    if (status) { conditions.push('status = ?'); args.push(status) }
    if (agent) { conditions.push('(to_agent = ? OR from_agent = ?)'); args.push(agent, agent) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = db.prepare(`SELECT * FROM agent_tasks ${where} ORDER BY created_at DESC LIMIT ?`).all(...args, limit)
    return c.json(rows)
  })

  // POST / — create agent task
  app.post('/', async (c) => {
    const body = await c.req.json() as {
      from_agent: string; to_agent: string; product_id?: number
      title: string; description?: string; priority?: string; due_at?: string
    }
    if (!body.from_agent || !body.to_agent || !body.title) {
      return c.json({ error: 'from_agent, to_agent, and title required' }, 400)
    }

    const result = db.prepare(`
      INSERT INTO agent_tasks (from_agent, to_agent, product_id, title, description, priority, due_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.from_agent, body.to_agent, body.product_id || null,
      body.title, body.description || null, body.priority || 'medium', body.due_at || null
    )

    const task = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(result.lastInsertRowid)
    return c.json(task, 201)
  })

  // PUT /:id — update agent task
  app.put('/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const existing = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id)
    if (!existing) return c.json({ error: 'Task not found' }, 404)

    const body = await c.req.json() as { status?: string; result?: string }

    const sets: string[] = []
    const args: (string | number | null)[] = []

    if (body.status) { sets.push('status = ?'); args.push(body.status) }
    if (body.result) { sets.push('result = ?'); args.push(body.result) }
    if (body.status === 'completed') { sets.push("completed_at = datetime('now')") }

    if (!sets.length) return c.json({ error: 'No fields to update' }, 400)

    args.push(id)
    db.prepare(`UPDATE agent_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args)

    const updated = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id)
    return c.json(updated)
  })

  return app
}
