import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type Database from 'better-sqlite3'
import type { SalesConfig } from '../utils/config.js'

export function createDashboardApp(db: Database.Database, config: SalesConfig): Hono {
  const app = new Hono()

  app.use('*', cors({ origin: '*' }))

  // Auth middleware
  app.use('/api/*', async (c, next) => {
    const key = c.req.header('x-admin-key')
    if (key !== config.dashboard_api.admin_key) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    await next()
  })

  // GET /api/dashboard/products
  app.get('/api/dashboard/products', (c) => {
    const rows = db.prepare(`SELECT * FROM products ORDER BY name`).all()
    return c.json(rows)
  })

  // Built by Weblease

  // GET /api/dashboard/stats?product=&period=today|week|month|all
  app.get('/api/dashboard/stats', (c) => {
    const product = c.req.query('product')
    const period = c.req.query('period') || 'all'

    const periodFilter: Record<string, string> = {
      today: "datetime('now', 'start of day')",
      week:  "datetime('now', '-7 days')",
      month: "datetime('now', '-30 days')",
      all:   "datetime('1970-01-01')",
    }
    const since = periodFilter[period] ?? periodFilter['all']

    const productClause = product ? `AND product_id = (SELECT id FROM products WHERE name = ?)` : ''
    const args = product ? [since, product] : [since]

    const leads      = db.prepare(`SELECT COUNT(*) AS count FROM leads      WHERE created_at >= ${since} ${productClause}`).get(...args) as { count: number }
    const drafts     = db.prepare(`SELECT COUNT(*) AS count FROM drafts     WHERE created_at >= ${since} ${productClause}`).get(...args) as { count: number }
    const activities = db.prepare(`SELECT COUNT(*) AS count FROM activity_log WHERE created_at >= ${since} ${productClause}`).get(...args) as { count: number }
    const opens      = db.prepare(`SELECT COUNT(*) AS count FROM email_tracking WHERE type = 'open' AND triggered_at IS NOT NULL AND created_at >= ${since}`).get(since) as { count: number }
    const clicks     = db.prepare(`SELECT COUNT(*) AS count FROM email_tracking WHERE type = 'click' AND triggered_at IS NOT NULL AND created_at >= ${since}`).get(since) as { count: number }

    return c.json({
      period,
      leads:      leads.count,
      drafts:     drafts.count,
      activities: activities.count,
      email_opens:  opens.count,
      email_clicks: clicks.count,
    })
  })

  // GET /api/dashboard/activity?limit=50&product=
  app.get('/api/dashboard/activity', (c) => {
    const limit   = Math.min(parseInt(c.req.query('limit') || '50', 10), 500)
    const product = c.req.query('product')

    if (product) {
      const rows = db.prepare(`
        SELECT a.*, p.name AS product_name
        FROM activity_log a
        LEFT JOIN products p ON p.id = a.product_id
        WHERE p.name = ?
        ORDER BY a.created_at DESC
        LIMIT ?
      `).all(product, limit)
      return c.json(rows)
    }

    const rows = db.prepare(`
      SELECT a.*, p.name AS product_name
      FROM activity_log a
      LEFT JOIN products p ON p.id = a.product_id
      ORDER BY a.created_at DESC
      LIMIT ?
    `).all(limit)
    return c.json(rows)
  })

  // GET /api/dashboard/leads?product=&status=&limit=50
  app.get('/api/dashboard/leads', (c) => {
    const limit   = Math.min(parseInt(c.req.query('limit') || '50', 10), 500)
    const product = c.req.query('product')
    const status  = c.req.query('status')

    const conditions: string[] = []
    const args: (string | number)[] = []

    if (product) {
      conditions.push(`p.name = ?`)
      args.push(product)
    }
    if (status) {
      conditions.push(`l.status = ?`)
      args.push(status)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = db.prepare(`
      SELECT l.*, p.name AS product_name
      FROM leads l
      LEFT JOIN products p ON p.id = l.product_id
      ${where}
      ORDER BY l.created_at DESC
      LIMIT ?
    `).all(...args, limit)

    return c.json(rows)
  })

  // GET /api/dashboard/drafts?product=&status=&limit=20
  app.get('/api/dashboard/drafts', (c) => {
    const limit   = Math.min(parseInt(c.req.query('limit') || '20', 10), 200)
    const product = c.req.query('product')
    const status  = c.req.query('status')

    const conditions: string[] = []
    const args: (string | number)[] = []

    if (product) {
      conditions.push(`p.name = ?`)
      args.push(product)
    }
    if (status) {
      conditions.push(`d.status = ?`)
      args.push(status)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = db.prepare(`
      SELECT d.*, p.name AS product_name
      FROM drafts d
      LEFT JOIN products p ON p.id = d.product_id
      ${where}
      ORDER BY d.created_at DESC
      LIMIT ?
    `).all(...args, limit)

    return c.json(rows)
  })

  // GET /api/dashboard/channels
  app.get('/api/dashboard/channels', (c) => {
    const rows = db.prepare(`SELECT * FROM channels ORDER BY type, name`).all()
    return c.json(rows)
  })

  // GET /api/dashboard/sequences?product=
  app.get('/api/dashboard/sequences', (c) => {
    const product = c.req.query('product')

    if (product) {
      const rows = db.prepare(`
        SELECT s.*, p.name AS product_name
        FROM sequences s
        LEFT JOIN products p ON p.id = s.product_id
        WHERE p.name = ?
        ORDER BY s.name
      `).all(product)
      return c.json(rows)
    }

    const rows = db.prepare(`
      SELECT s.*, p.name AS product_name
      FROM sequences s
      LEFT JOIN products p ON p.id = s.product_id
      ORDER BY s.name
    `).all()
    return c.json(rows)
  })

  // GET /api/dashboard/templates?product=
  app.get('/api/dashboard/templates', (c) => {
    const product = c.req.query('product')

    if (product) {
      const rows = db.prepare(`
        SELECT t.*, p.name AS product_name
        FROM templates t
        LEFT JOIN products p ON p.id = t.product_id
        WHERE p.name = ?
        ORDER BY t.type, t.name
      `).all(product)
      return c.json(rows)
    }

    const rows = db.prepare(`
      SELECT t.*, p.name AS product_name
      FROM templates t
      LEFT JOIN products p ON p.id = t.product_id
      ORDER BY t.type, t.name
    `).all()
    return c.json(rows)
  })

  // GET /api/dashboard/brain/knowledge?product=
  app.get('/api/dashboard/brain/knowledge', (c) => {
    const product = c.req.query('product')

    if (product) {
      const rows = db.prepare(`
        SELECT k.*, p.name AS product_name
        FROM knowledge k
        LEFT JOIN products p ON p.id = k.product_id
        WHERE p.name = ?
        ORDER BY k.type, k.created_at DESC
      `).all(product)
      return c.json(rows)
    }

    const rows = db.prepare(`
      SELECT k.*, p.name AS product_name
      FROM knowledge k
      LEFT JOIN products p ON p.id = k.product_id
      ORDER BY k.type, k.created_at DESC
    `).all()
    return c.json(rows)
  })

  // GET /api/dashboard/brain/learnings?product=
  app.get('/api/dashboard/brain/learnings', (c) => {
    const product = c.req.query('product')

    if (product) {
      const rows = db.prepare(`
        SELECT l.*, p.name AS product_name
        FROM learnings l
        LEFT JOIN products p ON p.id = l.product_id
        WHERE p.name = ?
        ORDER BY l.confidence DESC, l.updated_at DESC
      `).all(product)
      return c.json(rows)
    }

    const rows = db.prepare(`
      SELECT l.*, p.name AS product_name
      FROM learnings l
      LEFT JOIN products p ON p.id = l.product_id
      ORDER BY l.confidence DESC, l.updated_at DESC
    `).all()
    return c.json(rows)
  })

  // GET /api/dashboard/gdpr?email=
  app.get('/api/dashboard/gdpr', (c) => {
    const email = c.req.query('email')

    if (!email) {
      return c.json({ error: 'email query param required' }, 400)
    }

    const log  = db.prepare(`SELECT * FROM gdpr_log WHERE email = ? ORDER BY created_at DESC`).all(email)
    const lead = db.prepare(`SELECT * FROM leads WHERE email = ?`).all(email)

    return c.json({ email, gdpr_log: log, leads: lead })
  })

  // POST /api/dashboard/tracking/event — { trackingId, type: 'open'|'click', url? }
  app.post('/api/dashboard/tracking/event', async (c) => {
    let body: { trackingId?: string; type?: string; url?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const { trackingId, type, url } = body

    if (!trackingId || !type) {
      return c.json({ error: 'trackingId and type are required' }, 400)
    }

    if (type !== 'open' && type !== 'click') {
      return c.json({ error: 'type must be open or click' }, 400)
    }

    const result = db.prepare(`
      UPDATE email_tracking
      SET triggered_at = datetime('now')
      WHERE tracking_id = ? AND triggered_at IS NULL
    `).run(trackingId)

    if (result.changes === 0) {
      return c.json({ ok: false, message: 'Not found or already triggered' })
    }

    return c.json({ ok: true, trackingId, type, url: url ?? null })
  })

  return app
}
