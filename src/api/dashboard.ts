import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type Database from 'better-sqlite3'
import type { SalesConfig } from '../utils/config.js'
import { getDashboardHtml } from './dashboard-html.js'
import { encrypt } from '../utils/crypto.js'
import { createEmailProvider } from '../providers/email-provider.js'
import { createActionRoutes } from './actions.js'
import { createTrustLevelRoutes } from './trust-levels.js'
import { createAgentTaskRoutes } from './agent-tasks.js'
import { cleanSnippet } from '../utils/email.js'

export function createDashboardApp(db: Database.Database, config: SalesConfig): Hono {
  const app = new Hono()

  app.use('*', cors({ origin: '*' }))

  // Serve dashboard UI
  app.get('/', (c) => c.html(getDashboardHtml()))

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
    const args = product ? [product] : []

    const leads      = db.prepare(`SELECT COUNT(*) AS count FROM leads      WHERE created_at >= ${since} ${productClause}`).get(...args) as { count: number }
    const drafts     = db.prepare(`SELECT COUNT(*) AS count FROM drafts     WHERE created_at >= ${since} ${productClause}`).get(...args) as { count: number }
    const activities = db.prepare(`SELECT COUNT(*) AS count FROM activity_log WHERE created_at >= ${since} ${productClause}`).get(...args) as { count: number }
    const opens      = db.prepare(`SELECT COUNT(*) AS count FROM email_tracking WHERE type = 'open' AND triggered_at IS NOT NULL AND created_at >= ${since}`).get() as { count: number }
    const clicks     = db.prepare(`SELECT COUNT(*) AS count FROM email_tracking WHERE type = 'click' AND triggered_at IS NOT NULL AND created_at >= ${since}`).get() as { count: number }

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

  // GET /api/dashboard/channel-products
  app.get('/api/dashboard/channel-products', (c) => {
    const rows = db.prepare(`SELECT channel_id, product_id FROM channel_products`).all()
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

  // POST /api/dashboard/templates
  // Built by Christos Ferlachidis & Daniel Hedenberg
  app.post('/api/dashboard/templates', async (c) => {
    try {
      const body = await c.req.json() as {
        product?: string; name?: string; type?: string;
        subject?: string; content?: string; language?: string;
      }
      if (!body.name || !body.content) {
        return c.json({ error: 'name and content are required' }, 400)
      }

      let productId: number | null = null
      if (body.product) {
        const productRow = db.prepare('SELECT id FROM products WHERE name = ?').get(body.product) as { id: number } | undefined
        if (!productRow) return c.json({ error: `Product "${body.product}" not found` }, 404)
        productId = productRow.id
      }

      db.prepare(`
        INSERT INTO templates (product_id, name, type, subject, content, language)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(product_id, name) DO UPDATE SET
          subject  = excluded.subject,
          content  = excluded.content,
          type     = excluded.type,
          language = excluded.language
      `).run(
        productId, body.name, body.type ?? 'email',
        body.subject ?? null, body.content, body.language ?? 'sv'
      )

      const template = db.prepare(`
        SELECT t.*, p.name AS product_name
        FROM templates t
        LEFT JOIN products p ON p.id = t.product_id
        WHERE t.product_id = ? AND t.name = ?
      `).get(productId, body.name)

      return c.json(template, 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
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

  // ═══════════════════════════════════════════════════════════════════════════
  // WRITE ENDPOINTS — Channels, Products, Leads, Drafts, Email, Recommendations, Brain
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Channel CRUD ─────────────────────────────────────────────────────────

  // POST /api/dashboard/channels
  app.post('/api/dashboard/channels', async (c) => {
    try {
      const body = await c.req.json() as {
        type?: string; name?: string; credentials?: string;
        config?: string; enabled?: boolean; product_ids?: number[];
      }
      if (!body.type || !body.name) {
        return c.json({ error: 'type and name are required' }, 400)
      }

      const creds = body.credentials ? encrypt(body.credentials) : null
      const cfg = body.config ?? '{}'
      const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1

      const result = db.prepare(
        `INSERT INTO channels (type, name, credentials, config, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`
      ).run(body.type, body.name, creds, cfg, enabled)

      const channelId = result.lastInsertRowid as number

      if (body.product_ids?.length) {
        const linkStmt = db.prepare(
          `INSERT OR IGNORE INTO channel_products (channel_id, product_id) VALUES (?, ?)`
        )
        for (const pid of body.product_ids) {
          linkStmt.run(channelId, pid)
        }
      }

      const channel = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(channelId)
      return c.json(channel, 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // PUT /api/dashboard/channels/:id
  app.put('/api/dashboard/channels/:id', async (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const existing = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(id)
      if (!existing) return c.json({ error: 'Channel not found' }, 404)

      const body = await c.req.json() as {
        name?: string; credentials?: string; config?: string;
        enabled?: boolean; product_ids?: number[];
      }

      const sets: string[] = []
      const args: (string | number | null)[] = []

      if (body.name !== undefined) { sets.push('name = ?'); args.push(body.name) }
      if (body.credentials !== undefined) { sets.push('credentials = ?'); args.push(encrypt(body.credentials)) }
      if (body.config !== undefined) { sets.push('config = ?'); args.push(body.config) }
      if (body.enabled !== undefined) { sets.push('enabled = ?'); args.push(body.enabled ? 1 : 0) }

      if (sets.length) {
        args.push(id)
        db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...args)
      }

      if (body.product_ids !== undefined) {
        db.prepare(`DELETE FROM channel_products WHERE channel_id = ?`).run(id)
        const linkStmt = db.prepare(
          `INSERT OR IGNORE INTO channel_products (channel_id, product_id) VALUES (?, ?)`
        )
        for (const pid of body.product_ids) {
          linkStmt.run(id, pid)
        }
      }

      const updated = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(id)
      return c.json(updated)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // Built by Christos Ferlachidis & Daniel Hedenberg

  // DELETE /api/dashboard/channels/:id
  app.delete('/api/dashboard/channels/:id', (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const existing = db.prepare(`SELECT id FROM channels WHERE id = ?`).get(id)
      if (!existing) return c.json({ error: 'Channel not found' }, 404)

      db.prepare(`DELETE FROM channel_products WHERE channel_id = ?`).run(id)
      db.prepare(`DELETE FROM channels WHERE id = ?`).run(id)

      return c.json({ ok: true, deleted: id })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // ── Product CRUD ─────────────────────────────────────────────────────────

  // POST /api/dashboard/products
  app.post('/api/dashboard/products', async (c) => {
    try {
      const body = await c.req.json() as {
        name?: string; display_name?: string; description?: string;
        pitch?: string; features?: string; pricing?: string;
        url?: string; language?: string;
      }
      if (!body.name || !body.display_name) {
        return c.json({ error: 'name and display_name are required' }, 400)
      }

      const result = db.prepare(
        `INSERT INTO products (name, display_name, description, pitch, features, pricing, url, language, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(
        body.name, body.display_name, body.description ?? null,
        body.pitch ?? null, body.features ?? null, body.pricing ?? null,
        body.url ?? null, body.language ?? 'sv'
      )

      const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(result.lastInsertRowid)
      return c.json(product, 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // PUT /api/dashboard/products/:id
  app.put('/api/dashboard/products/:id', async (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const existing = db.prepare(`SELECT id FROM products WHERE id = ?`).get(id)
      if (!existing) return c.json({ error: 'Product not found' }, 404)

      const body = await c.req.json() as {
        display_name?: string; description?: string; pitch?: string;
        features?: string; pricing?: string; url?: string; language?: string;
      }

      const sets: string[] = []
      const args: (string | number | null)[] = []

      if (body.display_name !== undefined) { sets.push('display_name = ?'); args.push(body.display_name) }
      if (body.description !== undefined) { sets.push('description = ?'); args.push(body.description) }
      if (body.pitch !== undefined) { sets.push('pitch = ?'); args.push(body.pitch) }
      if (body.features !== undefined) { sets.push('features = ?'); args.push(body.features) }
      if (body.pricing !== undefined) { sets.push('pricing = ?'); args.push(body.pricing) }
      if (body.url !== undefined) { sets.push('url = ?'); args.push(body.url) }
      if (body.language !== undefined) { sets.push('language = ?'); args.push(body.language) }

      if (!sets.length) return c.json({ error: 'No fields to update' }, 400)

      sets.push("updated_at = datetime('now')")
      args.push(id)
      db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...args)

      const updated = db.prepare(`SELECT * FROM products WHERE id = ?`).get(id)
      return c.json(updated)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // ── Lead Management ──────────────────────────────────────────────────────

  // POST /api/dashboard/leads
  app.post('/api/dashboard/leads', async (c) => {
    try {
      const body = await c.req.json() as {
        email?: string; name?: string; company?: string; phone?: string;
        product_id?: number; source?: string; status?: string;
        notes?: string; tags?: string;
      }
      if (!body.email) return c.json({ error: 'email is required' }, 400)

      const result = db.prepare(
        `INSERT INTO leads (email, name, company, phone, product_id, source, status, notes, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(
        body.email, body.name ?? null, body.company ?? null, body.phone ?? null,
        body.product_id ?? null, body.source ?? 'manual', body.status ?? 'new',
        body.notes ?? null, body.tags ?? null
      )

      db.prepare(
        `INSERT INTO activity_log (product_id, lead_id, action, details, created_at)
         VALUES (?, ?, 'lead_created', ?, datetime('now'))`
      ).run(body.product_id ?? null, result.lastInsertRowid, JSON.stringify({ source: body.source ?? 'manual' }))

      const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(result.lastInsertRowid)
      return c.json(lead, 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // PUT /api/dashboard/leads/:id
  app.put('/api/dashboard/leads/:id', async (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const existing = db.prepare(`SELECT id FROM leads WHERE id = ?`).get(id)
      if (!existing) return c.json({ error: 'Lead not found' }, 404)

      const body = await c.req.json() as {
        name?: string; company?: string; status?: string;
        notes?: string; tags?: string; phone?: string;
      }

      const sets: string[] = []
      const args: (string | number | null)[] = []

      if (body.name !== undefined) { sets.push('name = ?'); args.push(body.name) }
      if (body.company !== undefined) { sets.push('company = ?'); args.push(body.company) }
      if (body.status !== undefined) { sets.push('status = ?'); args.push(body.status) }
      if (body.notes !== undefined) { sets.push('notes = ?'); args.push(body.notes) }
      if (body.tags !== undefined) { sets.push('tags = ?'); args.push(body.tags) }
      if (body.phone !== undefined) { sets.push('phone = ?'); args.push(body.phone) }

      if (!sets.length) return c.json({ error: 'No fields to update' }, 400)

      sets.push("updated_at = datetime('now')")
      args.push(id)
      db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...args)

      const updated = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id)
      return c.json(updated)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // ── Draft Actions ────────────────────────────────────────────────────────

  // POST /api/dashboard/drafts/:id/approve
  app.post('/api/dashboard/drafts/:id/approve', (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const draft = db.prepare(`SELECT * FROM drafts WHERE id = ?`).get(id) as { id: number; status: string; product_id?: number } | undefined
      if (!draft) return c.json({ error: 'Draft not found' }, 404)
      if (draft.status !== 'pending') return c.json({ error: `Draft is already ${draft.status}` }, 400)

      db.prepare(`UPDATE drafts SET status = 'approved' WHERE id = ?`).run(id)

      db.prepare(
        `INSERT INTO activity_log (product_id, draft_id, action, details, created_at)
         VALUES (?, ?, 'draft_approved', NULL, datetime('now'))`
      ).run(draft.product_id ?? null, id)

      const updated = db.prepare(`SELECT * FROM drafts WHERE id = ?`).get(id)
      return c.json(updated)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // POST /api/dashboard/drafts/:id/reject
  app.post('/api/dashboard/drafts/:id/reject', (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const draft = db.prepare(`SELECT * FROM drafts WHERE id = ?`).get(id) as { id: number; status: string; product_id?: number } | undefined
      if (!draft) return c.json({ error: 'Draft not found' }, 404)
      if (draft.status !== 'pending') return c.json({ error: `Draft is already ${draft.status}` }, 400)

      db.prepare(`UPDATE drafts SET status = 'rejected' WHERE id = ?`).run(id)

      db.prepare(
        `INSERT INTO activity_log (product_id, draft_id, action, details, created_at)
         VALUES (?, ?, 'draft_rejected', NULL, datetime('now'))`
      ).run(draft.product_id ?? null, id)

      const updated = db.prepare(`SELECT * FROM drafts WHERE id = ?`).get(id)
      return c.json(updated)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // PUT /api/dashboard/drafts/:id
  app.put('/api/dashboard/drafts/:id', async (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const existing = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id)
      if (!existing) return c.json({ error: 'Draft not found' }, 404)
      const body = await c.req.json()
      const sets: string[] = [], args: unknown[] = []
      if (body.title !== undefined) { sets.push('title = ?'); args.push(body.title) }
      if (body.content !== undefined) { sets.push('content = ?'); args.push(body.content) }
      if (!sets.length) return c.json({ error: 'No fields' }, 400)
      args.push(id)
      db.prepare(`UPDATE drafts SET ${sets.join(', ')} WHERE id = ?`).run(...args)
      return c.json(db.prepare('SELECT * FROM drafts WHERE id = ?').get(id))
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // ── Email Sending & Listing ──────────────────────────────────────────────

  // POST /api/dashboard/emails/send
  app.post('/api/dashboard/emails/send', async (c) => {
    try {
      const body = await c.req.json() as {
        to?: string; subject?: string; body?: string;
        product_id?: number; channel_id?: number;
      }
      if (!body.to || !body.subject || !body.body) {
        return c.json({ error: 'to, subject and body are required' }, 400)
      }

      const emailProvider = createEmailProvider(config.email)
      const result = await emailProvider.sendEmail({
        to: body.to,
        subject: body.subject,
        html: body.body,
      })

      db.prepare(
        `INSERT INTO activity_log (product_id, channel_id, action, details, created_at)
         VALUES (?, ?, 'email_sent', ?, datetime('now'))`
      ).run(
        body.product_id ?? null,
        body.channel_id ?? null,
        JSON.stringify({ to: body.to, subject: body.subject, messageId: result.messageId })
      )

      return c.json({ ok: true, messageId: result.messageId })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // GET /api/dashboard/emails?product=&limit=
  app.get('/api/dashboard/emails', (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 500)
    const product = c.req.query('product')

    if (product) {
      const rows = db.prepare(`
        SELECT a.*, p.name AS product_name
        FROM activity_log a
        LEFT JOIN products p ON p.id = a.product_id
        WHERE a.action = 'email_sent' AND p.name = ?
        ORDER BY a.created_at DESC
        LIMIT ?
      `).all(product, limit)
      return c.json(rows)
    }

    const rows = db.prepare(`
      SELECT a.*, p.name AS product_name
      FROM activity_log a
      LEFT JOIN products p ON p.id = a.product_id
      WHERE a.action = 'email_sent'
      ORDER BY a.created_at DESC
      LIMIT ?
    `).all(limit)
    return c.json(rows)
  })

  // ── Recommendations ──────────────────────────────────────────────────────

  // GET /api/dashboard/recommendations?status=pending&product=wpilot
  app.get('/api/dashboard/recommendations', (c) => {
    const status = c.req.query('status')
    const product = c.req.query('product')

    const conditions: string[] = []
    const args: string[] = []

    if (status) { conditions.push('r.status = ?'); args.push(status) }
    if (product) { conditions.push('p.name = ?'); args.push(product) }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

    const rows = db.prepare(`
      SELECT r.*, p.name AS product_name
      FROM recommendations r
      LEFT JOIN products p ON p.id = r.product_id
      ${where}
      ORDER BY CASE r.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, r.created_at DESC
    `).all(...args)
    return c.json(rows)
  })

  // POST /api/dashboard/recommendations
  app.post('/api/dashboard/recommendations', async (c) => {
    try {
      const body = await c.req.json() as {
        product_id?: number; agent_role?: string; priority?: string;
        title?: string; description?: string; action_type?: string; action_data?: string;
      }
      if (!body.agent_role || !body.title || !body.description) {
        return c.json({ error: 'agent_role, title and description are required' }, 400)
      }

      const result = db.prepare(
        `INSERT INTO recommendations (product_id, agent_role, priority, title, description, action_type, action_data, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`
      ).run(
        body.product_id ?? null, body.agent_role, body.priority ?? 'medium',
        body.title, body.description, body.action_type ?? null, body.action_data ?? null
      )

      const rec = db.prepare(`SELECT * FROM recommendations WHERE id = ?`).get(result.lastInsertRowid)
      return c.json(rec, 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // POST /api/dashboard/recommendations/:id/accept
  app.post('/api/dashboard/recommendations/:id/accept', (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const rec = db.prepare(`SELECT * FROM recommendations WHERE id = ?`).get(id) as { id: number; status: string } | undefined
      if (!rec) return c.json({ error: 'Recommendation not found' }, 404)
      if (rec.status !== 'pending') return c.json({ error: `Recommendation is already ${rec.status}` }, 400)

      db.prepare(`UPDATE recommendations SET status = 'accepted' WHERE id = ?`).run(id)
      const updated = db.prepare(`SELECT * FROM recommendations WHERE id = ?`).get(id)
      return c.json(updated)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // POST /api/dashboard/recommendations/:id/dismiss
  app.post('/api/dashboard/recommendations/:id/dismiss', (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const rec = db.prepare(`SELECT * FROM recommendations WHERE id = ?`).get(id) as { id: number; status: string } | undefined
      if (!rec) return c.json({ error: 'Recommendation not found' }, 404)
      if (rec.status !== 'pending' && rec.status !== 'accepted') return c.json({ error: `Recommendation is already ${rec.status}` }, 400)

      db.prepare(`UPDATE recommendations SET status = 'dismissed' WHERE id = ?`).run(id)
      const updated = db.prepare(`SELECT * FROM recommendations WHERE id = ?`).get(id)
      return c.json(updated)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // ── Brain Crawl ──────────────────────────────────────────────────────────

  // POST /api/dashboard/brain/crawl
  app.post('/api/dashboard/brain/crawl', async (c) => {
    try {
      const body = await c.req.json() as { url?: string; product_id?: number }
      if (!body.url) return c.json({ error: 'url is required' }, 400)

      const response = await fetch(body.url)
      if (!response.ok) {
        return c.json({ error: `Failed to fetch URL: ${response.status} ${response.statusText}` }, 502)
      }

      const html = await response.text()

      // Extract text: strip tags, collapse whitespace
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-zA-Z]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      // Extract title from <title> tag
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
      const title = titleMatch ? titleMatch[1].trim() : body.url

      const result = db.prepare(
        `INSERT INTO knowledge (product_id, type, title, content, source_url, created_at, updated_at)
         VALUES (?, 'webpage', ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(body.product_id ?? null, title, text, body.url)

      const entry = db.prepare(`SELECT * FROM knowledge WHERE id = ?`).get(result.lastInsertRowid)
      return c.json(entry, 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // ── Agents CRUD ──────────────────────────────────────────────────────────

  app.get('/api/dashboard/agents', (c) => {
    const rows = db.prepare('SELECT * FROM agents ORDER BY id').all()
    return c.json(rows)
  })

  // POST /api/dashboard/agents
  app.post('/api/dashboard/agents', async (c) => {
    try {
      const body = await c.req.json() as {
        role?: string; name?: string; avatar?: string;
        description?: string; focus?: string;
      }
      if (!body.role || !body.name) {
        return c.json({ error: 'role and name are required' }, 400)
      }

      const result = db.prepare(
        `INSERT INTO agents (role, name, avatar, description, focus, status, last_action, last_action_at)
         VALUES (?, ?, ?, ?, ?, 'idle', NULL, NULL)`
      ).run(body.role, body.name, body.avatar ?? null, body.description ?? null, body.focus ?? null)

      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(result.lastInsertRowid)
      return c.json(agent, 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // PUT /api/dashboard/agents/:id
  app.put('/api/dashboard/agents/:id', async (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(id)
      if (!existing) return c.json({ error: 'Agent not found' }, 404)

      const body = await c.req.json() as {
        name?: string; avatar?: string; description?: string;
        focus?: string; status?: string;
      }

      const sets: string[] = []
      const args: (string | number | null)[] = []

      if (body.name !== undefined) { sets.push('name = ?'); args.push(body.name) }
      if (body.avatar !== undefined) { sets.push('avatar = ?'); args.push(body.avatar) }
      if (body.description !== undefined) { sets.push('description = ?'); args.push(body.description) }
      if (body.focus !== undefined) { sets.push('focus = ?'); args.push(body.focus) }
      if (body.status !== undefined) { sets.push('status = ?'); args.push(body.status) }

      if (!sets.length) return c.json({ error: 'No fields to update' }, 400)

      args.push(id)
      db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...args)

      const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(id)
      return c.json(updated)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // DELETE /api/dashboard/agents/:id
  app.delete('/api/dashboard/agents/:id', (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(id)
      if (!existing) return c.json({ error: 'Agent not found' }, 404)

      db.prepare('DELETE FROM agents WHERE id = ?').run(id)
      return c.json({ ok: true, deleted: id })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // ── Admin Profile ───────────────────────────────────────────────────────

  // Ensure settings table exists
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`)

  // GET /api/dashboard/profile
  app.get('/api/dashboard/profile', (c) => {
    const nameRow = db.prepare("SELECT value FROM settings WHERE key = 'admin_name'").get() as { value: string } | undefined
    const avatarRow = db.prepare("SELECT value FROM settings WHERE key = 'admin_avatar'").get() as { value: string } | undefined

    return c.json({
      name: nameRow?.value ?? 'Christos',
      role: 'admin',
      avatar: avatarRow?.value ?? '👤',
    })
  })

  // PUT /api/dashboard/profile
  app.put('/api/dashboard/profile', async (c) => {
    try {
      const body = await c.req.json() as { name?: string; avatar?: string }

      if (body.name !== undefined) {
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_name', ?)").run(body.name)
      }
      if (body.avatar !== undefined) {
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_avatar', ?)").run(body.avatar)
      }

      const nameRow = db.prepare("SELECT value FROM settings WHERE key = 'admin_name'").get() as { value: string } | undefined
      const avatarRow = db.prepare("SELECT value FROM settings WHERE key = 'admin_avatar'").get() as { value: string } | undefined

      return c.json({
        name: nameRow?.value ?? 'Christos',
        role: 'admin',
        avatar: avatarRow?.value ?? '👤',
      })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // ── Discussions ───────────────────────────────────────────────────────────

  app.get('/api/dashboard/discussions', (c) => {
    const topic = c.req.query('topic')
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200)

    if (topic) {
      const rows = db.prepare('SELECT * FROM discussions WHERE topic = ? ORDER BY created_at ASC LIMIT ?').all(topic, limit)
      return c.json(rows)
    }

    const rows = db.prepare('SELECT * FROM discussions ORDER BY created_at DESC LIMIT ?').all(limit)
    return c.json(rows)
  })

  app.get('/api/dashboard/discussions/topics', (c) => {
    const rows = db.prepare(`
      SELECT topic, COUNT(*) as message_count, MAX(created_at) as last_message_at
      FROM discussions WHERE topic IS NOT NULL
      GROUP BY topic ORDER BY last_message_at DESC
    `).all()
    return c.json(rows)
  })

  app.post('/api/dashboard/discussions', async (c) => {
    let body: { author_role: string; author_name: string; message: string; product_id?: number; topic?: string }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

    const { author_role, author_name, message, product_id, topic } = body
    if (!author_role || !author_name || !message) {
      return c.json({ error: 'author_role, author_name, and message required' }, 400)
    }

    // Validate product_id exists if provided
    let validProductId: number | null = null
    if (product_id) {
      const product = db.prepare('SELECT id FROM products WHERE id = ?').get(product_id)
      if (!product) {
        return c.json({ error: `Product with id ${product_id} not found` }, 400)
      }
      validProductId = product_id
    }

    const result = db.prepare(
      'INSERT INTO discussions (author_role, author_name, message, product_id, topic) VALUES (?, ?, ?, ?, ?)'
    ).run(author_role, author_name, message, validProductId, topic || null)

    return c.json({ success: true, id: result.lastInsertRowid })
  })

  // ── Google Places Search ────────────────────────────────────────────────

  app.get('/api/dashboard/places/search', async (c) => {
    const query = c.req.query('query')
    const type = c.req.query('type') || 'restaurant'
    const location = c.req.query('location') || ''
    const radius = c.req.query('radius') || '10000'

    if (!query && !location) {
      return c.json({ error: 'Provide query or location' }, 400)
    }

    const keyRow = db.prepare("SELECT value FROM settings WHERE key = 'google_places_key'").get() as { value: string } | undefined
    if (!keyRow?.value) {
      return c.json({ error: 'Google Places API key not configured' }, 400)
    }

    try {
      const searchQuery = query || `${type} in ${location}`
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(searchQuery)}&type=${type}&key=${keyRow.value}`
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
      const data = await res.json() as { results?: Array<{ name: string; formatted_address: string; place_id: string; rating?: number; user_ratings_total?: number; business_status?: string; types?: string[]; geometry?: { location: { lat: number; lng: number } } }>; status: string; error_message?: string }

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        return c.json({ error: data.error_message || data.status }, 400)
      }

      const places = (data.results || []).map(p => ({
        name: p.name,
        address: p.formatted_address,
        place_id: p.place_id,
        rating: p.rating || null,
        reviews: p.user_ratings_total || 0,
        status: p.business_status || 'UNKNOWN',
        types: p.types || [],
        lat: p.geometry?.location?.lat,
        lng: p.geometry?.location?.lng,
      }))

      return c.json({ query: searchQuery, count: places.length, places })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // Get place details (phone, website, opening hours)
  app.get('/api/dashboard/places/details', async (c) => {
    const placeId = c.req.query('place_id')
    if (!placeId) return c.json({ error: 'place_id required' }, 400)

    const keyRow = db.prepare("SELECT value FROM settings WHERE key = 'google_places_key'").get() as { value: string } | undefined
    if (!keyRow?.value) return c.json({ error: 'Google Places API key not configured' }, 400)

    try {
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,formatted_address,formatted_phone_number,website,opening_hours,rating,reviews,url&key=${keyRow.value}`
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
      const data = await res.json() as { result?: { name: string; formatted_address: string; formatted_phone_number?: string; website?: string; opening_hours?: { weekday_text?: string[] }; rating?: number; reviews?: Array<{ text: string; rating: number }>; url?: string }; status: string }

      if (data.status !== 'OK') return c.json({ error: data.status }, 400)

      const p = data.result
      return c.json({
        name: p?.name,
        address: p?.formatted_address,
        phone: p?.formatted_phone_number || null,
        website: p?.website || null,
        maps_url: p?.url || null,
        rating: p?.rating || null,
        hours: p?.opening_hours?.weekday_text || [],
        reviews: (p?.reviews || []).slice(0, 3).map(r => ({ text: r.text, rating: r.rating })),
      })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // Import place as lead
  app.post('/api/dashboard/places/import', async (c) => {
    let body: { name: string; address: string; phone?: string; website?: string; place_id: string; product_id: number }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

    const { name, address, phone, website, place_id, product_id } = body
    if (!name || !product_id) return c.json({ error: 'name and product_id required' }, 400)

    const result = db.prepare(
      `INSERT OR IGNORE INTO leads (email, name, company, phone, product_id, source, status, notes, consent_given)
       VALUES (?, ?, ?, ?, ?, 'google_places', 'new', ?, 0)`
    ).run(
      `${place_id}@places.google`,
      name,
      name,
      phone || null,
      product_id,
      JSON.stringify({ address, website, place_id })
    )

    if (result.changes) {
      db.prepare('INSERT INTO activity_log (product_id, action, details) VALUES (?, ?, ?)').run(
        product_id, 'lead_created', `Imported from Google Places: ${name} (${address})`
      )
    }

    return c.json({ success: true, imported: result.changes > 0, lead_id: result.lastInsertRowid })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // MEETINGS / CALENDAR
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /api/dashboard/meetings/upcoming?days=7
  app.get('/api/dashboard/meetings/upcoming', (c) => {
    try {
      const days = parseInt(c.req.query('days') || '7', 10)
      const rows = db.prepare(`
        SELECT m.*, p.display_name AS product_name, l.name AS lead_name, l.email AS lead_email
        FROM meetings m
        LEFT JOIN products p ON p.id = m.product_id
        LEFT JOIN leads l ON l.id = m.lead_id
        WHERE m.status IN ('confirmed', 'proposed')
          AND m.date BETWEEN date('now') AND date('now', '+' || ? || ' days')
        ORDER BY m.date ASC, m.time ASC
      `).all(days)
      return c.json(rows)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // GET /api/dashboard/meetings?status=&product=&from=&to=&limit=50
  app.get('/api/dashboard/meetings', (c) => {
    try {
      const status = c.req.query('status')
      const product = c.req.query('product')
      const from = c.req.query('from')
      const to = c.req.query('to')
      const limit = parseInt(c.req.query('limit') || '50', 10)

      const clauses: string[] = []
      const args: (string | number)[] = []

      if (status) { clauses.push('m.status = ?'); args.push(status) }
      if (product) { clauses.push('p.name = ?'); args.push(product) }
      if (from) { clauses.push('m.date >= ?'); args.push(from) }
      if (to) { clauses.push('m.date <= ?'); args.push(to) }

      const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''

      // Built by Christos Ferlachidis & Daniel Hedenberg
      const rows = db.prepare(`
        SELECT m.*, p.display_name AS product_name, l.name AS lead_name, l.email AS lead_email
        FROM meetings m
        LEFT JOIN products p ON p.id = m.product_id
        LEFT JOIN leads l ON l.id = m.lead_id
        ${where}
        ORDER BY m.date ASC, m.time ASC
        LIMIT ?
      `).all(...args, limit)
      return c.json(rows)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // GET /api/dashboard/meetings/:id
  app.get('/api/dashboard/meetings/:id', (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const row = db.prepare(`
        SELECT m.*, p.display_name AS product_name, l.name AS lead_name, l.email AS lead_email
        FROM meetings m
        LEFT JOIN products p ON p.id = m.product_id
        LEFT JOIN leads l ON l.id = m.lead_id
        WHERE m.id = ?
      `).get(id)
      if (!row) return c.json({ error: 'Meeting not found' }, 404)
      return c.json(row)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // POST /api/dashboard/meetings
  app.post('/api/dashboard/meetings', async (c) => {
    try {
      const body = await c.req.json() as {
        title?: string; description?: string; product_id?: number; lead_id?: number;
        contact_name?: string; contact_email?: string; contact_phone?: string;
        meeting_type?: string; location?: string; meeting_url?: string;
        date?: string; time?: string; duration_minutes?: number; notes?: string;
      }
      if (!body.title || !body.date || !body.time) {
        return c.json({ error: 'title, date, and time are required' }, 400)
      }

      const result = db.prepare(`
        INSERT INTO meetings (title, description, product_id, lead_id, contact_name, contact_email, contact_phone, meeting_type, location, meeting_url, date, time, duration_minutes, notes, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', datetime('now'), datetime('now'))
      `).run(
        body.title, body.description ?? null, body.product_id ?? null, body.lead_id ?? null,
        body.contact_name ?? null, body.contact_email ?? null, body.contact_phone ?? null,
        body.meeting_type ?? 'video', body.location ?? null, body.meeting_url ?? null,
        body.date, body.time, body.duration_minutes ?? 30, body.notes ?? null
      )

      db.prepare(
        `INSERT INTO activity_log (product_id, lead_id, action, details, created_at) VALUES (?, ?, 'meeting_created', ?, datetime('now'))`
      ).run(body.product_id ?? null, body.lead_id ?? null, JSON.stringify({ title: body.title, date: body.date, time: body.time }))

      const meeting = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(result.lastInsertRowid)
      return c.json(meeting, 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // PUT /api/dashboard/meetings/:id
  app.put('/api/dashboard/meetings/:id', async (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const existing = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id) as { id: number; status: string; product_id?: number; lead_id?: number; title?: string } | undefined
      if (!existing) return c.json({ error: 'Meeting not found' }, 404)

      const body = await c.req.json() as {
        title?: string; description?: string; date?: string; time?: string;
        duration_minutes?: number; status?: string; location?: string;
        meeting_url?: string; notes?: string;
      }

      const sets: string[] = []
      const args: (string | number | null)[] = []

      if (body.title !== undefined) { sets.push('title = ?'); args.push(body.title) }
      if (body.description !== undefined) { sets.push('description = ?'); args.push(body.description) }
      if (body.date !== undefined) { sets.push('date = ?'); args.push(body.date) }
      if (body.time !== undefined) { sets.push('time = ?'); args.push(body.time) }
      if (body.duration_minutes !== undefined) { sets.push('duration_minutes = ?'); args.push(body.duration_minutes) }
      if (body.status !== undefined) { sets.push('status = ?'); args.push(body.status) }
      if (body.location !== undefined) { sets.push('location = ?'); args.push(body.location) }
      if (body.meeting_url !== undefined) { sets.push('meeting_url = ?'); args.push(body.meeting_url) }
      if (body.notes !== undefined) { sets.push('notes = ?'); args.push(body.notes) }

      if (!sets.length) return c.json({ error: 'No fields to update' }, 400)

      sets.push("updated_at = datetime('now')")
      args.push(id)
      db.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`).run(...args)

      if (body.status && body.status !== existing.status) {
        if (body.status === 'confirmed') {
          db.prepare(
            `INSERT INTO activity_log (product_id, lead_id, action, details, created_at) VALUES (?, ?, 'meeting_confirmed', ?, datetime('now'))`
          ).run(existing.product_id ?? null, existing.lead_id ?? null, JSON.stringify({ meeting_id: id, title: existing.title }))
        } else if (body.status === 'cancelled') {
          db.prepare(
            `INSERT INTO activity_log (product_id, lead_id, action, details, created_at) VALUES (?, ?, 'meeting_cancelled', ?, datetime('now'))`
          ).run(existing.product_id ?? null, existing.lead_id ?? null, JSON.stringify({ meeting_id: id, title: existing.title }))
        }
      }

      const updated = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id)
      return c.json(updated)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // DELETE /api/dashboard/meetings/:id
  app.delete('/api/dashboard/meetings/:id', (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const existing = db.prepare(`SELECT id FROM meetings WHERE id = ?`).get(id)
      if (!existing) return c.json({ error: 'Meeting not found' }, 404)

      db.prepare(`DELETE FROM meetings WHERE id = ?`).run(id)
      return c.json({ ok: true, deleted: id })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // --- Agent Skills & Research ---

  // GET /api/dashboard/agents/:role/skills
  app.get('/api/dashboard/agents/:role/skills', (c) => {
    const role = c.req.param('role')
    const rows = db.prepare(`SELECT * FROM agent_skills WHERE agent_role = ? ORDER BY skill_name`).all(role)
    return c.json(rows)
  })

  // POST /api/dashboard/agents/:role/skills
  app.post('/api/dashboard/agents/:role/skills', async (c) => {
    try {
      const role = c.req.param('role')
      const body = await c.req.json()
      const { skill_name, skill_level, description } = body
      if (!skill_name) return c.json({ error: 'skill_name required' }, 400)
      // Built by Christos Ferlachidis & Daniel Hedenberg
      db.prepare(`INSERT OR REPLACE INTO agent_skills (agent_role, skill_name, skill_level, description, last_practiced) VALUES (?, ?, ?, ?, datetime('now'))`)
        .run(role, skill_name, skill_level || 'intermediate', description || null)
      return c.json({ ok: true, agent_role: role, skill_name })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // GET /api/dashboard/agents/research
  app.get('/api/dashboard/agents/research', (c) => {
    const role = c.req.query('role')
    const limit = parseInt(c.req.query('limit') || '20', 10)
    if (role) {
      const rows = db.prepare(`SELECT * FROM agent_research WHERE agent_role = ? ORDER BY created_at DESC LIMIT ?`).all(role, limit)
      return c.json(rows)
    }
    const rows = db.prepare(`SELECT * FROM agent_research ORDER BY created_at DESC LIMIT ?`).all(limit)
    return c.json(rows)
  })

  // POST /api/dashboard/agents/research
  app.post('/api/dashboard/agents/research', async (c) => {
    try {
      const body = await c.req.json()
      const { agent_role, topic, findings, source_url, shared_with } = body
      if (!agent_role || !topic || !findings) return c.json({ error: 'agent_role, topic, findings required' }, 400)
      const result = db.prepare(`INSERT INTO agent_research (agent_role, topic, findings, source_url, shared_with) VALUES (?, ?, ?, ?, ?)`)
        .run(agent_role, topic, findings, source_url || null, shared_with || null)
      return c.json({ ok: true, id: result.lastInsertRowid })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // GET /api/dashboard/agents/cross-learning
  app.get('/api/dashboard/agents/cross-learning', (c) => {
    const rows = db.prepare(`SELECT * FROM agent_research WHERE shared_with IS NOT NULL ORDER BY created_at DESC LIMIT 20`).all()
    return c.json(rows)
  })

  // ── New API routes (Phase 1) ────────────────────────────────────────────
  app.route('/api/dashboard/actions', createActionRoutes(db, config))
  app.route('/api/dashboard/trust-levels', createTrustLevelRoutes(db))
  app.route('/api/dashboard/agent-tasks', createAgentTaskRoutes(db))

  // GET /api/dashboard/agent-profiles — list all 16 agent profiles
  app.get('/api/dashboard/agent-profiles', (c) => {
    const rows = db.prepare('SELECT * FROM agent_profiles ORDER BY team, name').all()
    return c.json(rows)
  })

  // GET /api/dashboard/inbox — formatted inbox from activity_log
  app.get('/api/dashboard/inbox', (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100)
    const rows = db.prepare(`
      SELECT id, details, created_at FROM activity_log
      WHERE action = 'email_received' AND details IS NOT NULL
      ORDER BY created_at DESC LIMIT ?
    `).all(limit) as { id: number; details: string; created_at: string }[]

    const emails: { id: number; date: string; from: string; subject: string; snippet: string; body: string }[] = []
    for (const r of rows) {
      try {
        const d = JSON.parse(r.details) as { date?: string; from?: string; subject?: string; snippet?: string }
        emails.push({
          id: r.id,
          date: d.date || r.created_at,
          from: d.from || 'unknown',
          subject: d.subject || '(inget ämne)',
          snippet: cleanSnippet(d.snippet || '').substring(0, 150),
          body: cleanSnippet(d.snippet || ''),
        })
      } catch { /* skip unparseable */ }
    }

    return c.json(emails)
  })

  return app
}
