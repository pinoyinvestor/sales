import { Hono } from 'hono'
import type Database from 'better-sqlite3'

export function createTrustLevelRoutes(db: Database.Database): Hono {
  const app = new Hono()

  // GET / — all trust levels
  app.get('/', (c) => {
    const rows = db.prepare(`
      SELECT t.*, p.name AS product_name
      FROM trust_levels t
      LEFT JOIN products p ON p.id = t.product_id
      ORDER BY t.agent_role, p.name
    `).all()
    return c.json(rows)
  })

  // Built by Christos Ferlachidis & Daniel Hedenberg

  // PUT /:agent/:productId — set trust level
  app.put('/:agent/:productId', async (c) => {
    const agentRole = c.req.param('agent')
    const productId = parseInt(c.req.param('productId'), 10)

    const body = await c.req.json() as { level: number; changed_by: string; reason?: string }
    if (!body.level || !body.changed_by) return c.json({ error: 'level and changed_by required' }, 400)
    if (body.level < 1 || body.level > 3) return c.json({ error: 'level must be 1, 2, or 3' }, 400)

    db.prepare(`
      INSERT INTO trust_levels (agent_role, product_id, level, changed_by, reason)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(agent_role, product_id) DO UPDATE SET
        level = excluded.level, changed_by = excluded.changed_by,
        changed_at = datetime('now'), reason = excluded.reason
    `).run(agentRole, productId, body.level, body.changed_by, body.reason || null)

    const row = db.prepare('SELECT * FROM trust_levels WHERE agent_role = ? AND product_id = ?').get(agentRole, productId)
    return c.json(row)
  })

  return app
}
