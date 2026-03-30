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

  // ── Public Inbound Lead Capture (no admin key needed, uses HMAC) ───────────
  // POST /api/inbound/lead — called by weblease.se contact form
  app.post('/api/inbound/lead', async (c) => {
    const inboundKey = c.req.header('x-inbound-key')
    if (inboundKey !== config.dashboard_api.admin_key) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const body = await c.req.json() as {
      email?: string; name?: string; company?: string; phone?: string;
      message?: string; product?: string; source?: string;
    }

    if (!body.email) {
      return c.json({ error: 'email is required' }, 400)
    }

    // Check for existing lead
    const existing = db.prepare('SELECT id, status FROM leads WHERE email = ?').get(body.email) as { id: number; status: string } | undefined

    if (existing) {
      // Update existing lead with new info
      db.prepare(`UPDATE leads SET
        name = COALESCE(?, name),
        company = COALESCE(?, company),
        phone = COALESCE(?, phone),
        notes = COALESCE(notes || '\n' || ?, notes),
        source_detail = 'inbound_form',
        updated_at = datetime('now')
        WHERE id = ?`
      ).run(body.name ?? null, body.company ?? null, body.phone ?? null, body.message ?? null, existing.id)

      db.prepare(`INSERT INTO activity_log (lead_id, action, details, created_at)
        VALUES (?, 'inbound_lead_updated', ?, datetime('now'))`
      ).run(existing.id, JSON.stringify({ source: body.source ?? 'contact_form', message: body.message?.substring(0, 200) }))

      return c.json({ status: 'updated', lead_id: existing.id })
    }

    // Resolve product
    let productId: number | null = null
    if (body.product) {
      const prod = db.prepare('SELECT id FROM products WHERE name = ?').get(body.product) as { id: number } | undefined
      productId = prod?.id ?? null
    }

    // Create new lead
    const result = db.prepare(`INSERT INTO leads (email, name, company, phone, product_id, source, source_detail, status, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'inbound', ?, 'new', ?, datetime('now'), datetime('now'))`
    ).run(body.email, body.name ?? null, body.company ?? null, body.phone ?? null, productId, body.source ?? 'contact_form', body.message ?? null)

    const leadId = result.lastInsertRowid

    db.prepare(`INSERT INTO activity_log (lead_id, action, details, created_at)
      VALUES (?, 'inbound_lead_created', ?, datetime('now'))`
    ).run(leadId, JSON.stringify({ source: body.source ?? 'contact_form', product: body.product }))

    // Create high-priority recommendation for follow-up
    db.prepare(`INSERT INTO recommendations (product_id, agent_role, priority, title, description, action_type, action_data, status, created_at)
      VALUES (?, 'outreach', 'high', ?, ?, 'follow_up', ?, 'pending', datetime('now'))`
    ).run(
      productId,
      `Inbound lead: ${body.name || body.email}`,
      `Kontaktade oss via formulär${body.message ? ': "' + body.message.substring(0, 100) + '"' : ''}`,
      JSON.stringify({ lead_id: leadId, email: body.email })
    )

    // Telegram notification
    const { sendTelegram } = await import('../providers/telegram.js')
    sendTelegram(`🎯 <b>INBOUND LEAD!</b>\n\n${body.name || body.email}\n${body.company || ''}\n${body.product ? `Produkt: ${body.product}` : ''}\n${body.message ? `"${body.message.substring(0, 150)}"` : ''}`).catch(() => {})

    return c.json({ status: 'created', lead_id: leadId })
  })

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
    const limit   = Math.min(parseInt(c.req.query('limit') || '50', 10), 2000)
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
    const limit   = Math.min(parseInt(c.req.query('limit') || '50', 10), 2000)
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

  // GET /api/dashboard/channels?product=name
  app.get('/api/dashboard/channels', (c) => {
    const product = c.req.query('product')
    if (product) {
      const prod = db.prepare('SELECT id FROM products WHERE name = ?').get(product) as any
      if (prod) {
        const rows = db.prepare(`
          SELECT c.* FROM channels c
          INNER JOIN channel_products cp ON cp.channel_id = c.id
          WHERE cp.product_id = ?
          ORDER BY c.type, c.name
        `).all(prod.id)
        return c.json(rows)
      }
    }
    const rows = db.prepare(`SELECT * FROM channels ORDER BY type, name`).all() as any[]
    // Attach product names to each channel
    const cpRows = db.prepare(`
      SELECT cp.channel_id, p.id AS product_id, p.name, p.display_name
      FROM channel_products cp
      JOIN products p ON p.id = cp.product_id
    `).all() as { channel_id: number; product_id: number; name: string; display_name: string }[]
    const cpMap: Record<number, { id: number; name: string; display_name: string }[]> = {}
    for (const cp of cpRows) {
      if (!cpMap[cp.channel_id]) cpMap[cp.channel_id] = []
      cpMap[cp.channel_id].push({ id: cp.product_id, name: cp.name, display_name: cp.display_name })
    }
    return c.json(rows.map(r => ({ ...r, products: cpMap[r.id] || [] })))
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

  // GET /api/dashboard/leads/:id/activity
  app.get('/api/dashboard/leads/:id/activity', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const rows = db.prepare(`
      SELECT a.*, p.name AS product_name
      FROM activity_log a
      LEFT JOIN products p ON p.id = a.product_id
      WHERE a.lead_id = ?
      ORDER BY a.created_at DESC
      LIMIT 50
    `).all(id)
    return c.json(rows)
  })

  // GET /api/dashboard/leads/:id/conversations
  app.get('/api/dashboard/leads/:id/conversations', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const lead = db.prepare('SELECT email, name, company FROM leads WHERE id = ?').get(id) as any
    if (!lead) return c.json([])

    // Get all email activity for this lead (sent + received)
    const rawEmails = db.prepare(`
      SELECT a.id, a.action, a.details, a.created_at
      FROM activity_log a
      WHERE (a.lead_id = ? OR a.details LIKE ?)
        AND a.action IN ('email_sent', 'email_received', 'sequence_email_sent')
      ORDER BY a.created_at ASC
    `).all(id, `%${lead.email}%`) as any[]

    // Enrich with template content and decoded snippets
    const emails = rawEmails.map((e: any) => {
      let detail: any = {}
      try { detail = JSON.parse(e.details || '{}') } catch {}

      const enriched: any = {
        id: e.id,
        action: e.action,
        created_at: e.created_at,
        subject: detail.subject || null,
        to: detail.to || null,
        from: detail.from || null,
        template_name: detail.template || null,
        template_content: null,
        reply_text: null,
        message_id: detail.messageId || null,
      }

      // If sent via sequence/template, load the actual template HTML
      if (detail.template) {
        const tmpl = db.prepare('SELECT content, subject FROM templates WHERE name = ?').get(detail.template) as any
        if (tmpl) {
          // Replace variables in template
          let html = tmpl.content
          if (lead.name) html = html.replace(/\{\{name\}\}/g, lead.name)
          if (lead.company) html = html.replace(/\{\{company\}\}/g, lead.company)
          html = html.replace(/\{\{unsubscribe_url\}\}/g, '#')
          enriched.template_content = html
        }
      }

      // If received, try to get readable text from snippet
      if (e.action === 'email_received' && detail.snippet) {
        let text = detail.snippet

        // Check if it's already readable text (ASCII-heavy)
        const nonAscii = text.split('').filter((c: string) => c.charCodeAt(0) > 127).length
        const isReadable = (nonAscii / Math.max(text.length, 1)) < 0.3

        if (!isReadable) {
          // Try base64 decode
          try {
            const decoded = Buffer.from(text, 'base64').toString('utf-8')
            const decodedNonAscii = decoded.split('').filter((c: string) => c.charCodeAt(0) > 127).length
            if ((decodedNonAscii / Math.max(decoded.length, 1)) < 0.3) {
              text = decoded
            } else {
              text = '[Innehåll kunde inte avkodas]'
            }
          } catch {
            text = '[Innehåll kunde inte avkodas]'
          }
        }

        // Clean HTML tags
        text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        enriched.reply_text = text
      }

      return enriched
    })

    return c.json({ emails, lead_email: lead.email, lead_name: lead.name })
  })

  // GET /api/dashboard/leads/:id/research
  app.get('/api/dashboard/leads/:id/research', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const rows = db.prepare(`
      SELECT * FROM agent_research
      WHERE findings LIKE '%"lead_id":' || ? || '%'
      ORDER BY created_at DESC
      LIMIT 10
    `).all(id)
    return c.json(rows)
  })

  // DELETE /api/dashboard/leads/:id
  app.delete('/api/dashboard/leads/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const existing = db.prepare('SELECT id FROM leads WHERE id = ?').get(id)
    if (!existing) return c.json({ error: 'Lead not found' }, 404)
    db.prepare('DELETE FROM leads WHERE id = ?').run(id)
    return c.json({ deleted: true, id })
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

  // GET /api/dashboard/emails/all — unified inbox: sent + received + templates
  app.get('/api/dashboard/emails/all', (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 2000)

    const rows = db.prepare(`
      SELECT a.id, a.action, a.details, a.lead_id, a.created_at
      FROM activity_log a
      WHERE a.action IN ('email_sent', 'email_received', 'sequence_email_sent')
      ORDER BY a.created_at DESC
      LIMIT ?
    `).all(limit) as any[]

    const emails = rows.map((r: any) => {
      let d: any = {}
      try { d = JSON.parse(r.details || '{}') } catch {}

      const isSent = r.action === 'email_sent' || r.action === 'sequence_email_sent'

      // Decode base64 snippet for received
      let bodyText: string | null = null
      if (!isSent && d.snippet) {
        bodyText = d.snippet
        const nonAsc = bodyText.split('').filter((c: string) => c.charCodeAt(0) > 127).length
        if ((nonAsc / Math.max(bodyText.length, 1)) >= 0.3) {
          try {
            const dec = Buffer.from(bodyText, 'base64').toString('utf-8')
            const decNonAsc = dec.split('').filter((c: string) => c.charCodeAt(0) > 127).length
            bodyText = (decNonAsc / Math.max(dec.length, 1)) < 0.3 ? dec : '[Innehåll kunde inte avkodas]'
          } catch { bodyText = '[Innehåll kunde inte avkodas]' }
        }
        bodyText = bodyText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      }

      // Load template HTML for sent
      let templateHtml: string | null = null
      if (isSent && d.template) {
        const tmpl = db.prepare('SELECT content FROM templates WHERE name = ?').get(d.template) as any
        if (tmpl) {
          let html = tmpl.content
          // Try to fill in lead variables
          if (r.lead_id) {
            const lead = db.prepare('SELECT name, company FROM leads WHERE id = ?').get(r.lead_id) as any
            if (lead) {
              html = html.replace(/\{\{name\}\}/g, lead.name || '')
              html = html.replace(/\{\{company\}\}/g, lead.company || '')
            }
          }
          html = html.replace(/\{\{unsubscribe_url\}\}/g, '#')
          html = html.replace(/\{\{name\}\}/g, d.to || '')
          html = html.replace(/\{\{company\}\}/g, '')
          templateHtml = html
        }
      }

      // Get lead info
      let leadName: string | null = null
      const fromEmail = d.from || null
      if (fromEmail) {
        const lead = db.prepare('SELECT name, company FROM leads WHERE email = ?').get(fromEmail) as any
        if (lead) leadName = lead.name || lead.company
      }
      if (!leadName && r.lead_id) {
        const lead = db.prepare('SELECT name, company FROM leads WHERE id = ?').get(r.lead_id) as any
        if (lead) leadName = lead.name || lead.company
      }

      return {
        id: r.id,
        type: isSent ? 'sent' : 'received',
        action: r.action,
        date: d.date || r.created_at,
        from: isSent ? 'info@weblease.se' : (d.from || 'unknown'),
        to: d.to || null,
        subject: d.subject || '(inget ämne)',
        template_name: d.template || null,
        template_html: templateHtml,
        body_text: bodyText,
        lead_name: leadName,
        lead_id: r.lead_id,
      }
    })

    return c.json(emails)
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
    const limit = Math.min(parseInt(c.req.query('limit') || '500', 10), 500)

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
      FROM discussions WHERE topic IS NOT NULL AND archived = 0
      GROUP BY topic ORDER BY last_message_at DESC
    `).all()
    return c.json(rows)
  })

  // Archive a topic — saves all messages to brain as learnings, then hides from list
  // Built by Christos Ferlachidis & Daniel Hedenberg
  app.delete('/api/dashboard/discussions/topics/:topic', async (c) => {
    const topic = decodeURIComponent(c.req.param('topic'))
    const messages = db.prepare('SELECT * FROM discussions WHERE topic = ? ORDER BY created_at ASC').all(topic) as any[]

    if (messages.length === 0) {
      return c.json({ error: 'Topic not found' }, 404)
    }

    // Save conversation summary to brain
    const summary = messages
      .filter((m: any) => m.author_role !== 'error')
      .map((m: any) => `${m.author_name} (${m.author_role}): ${m.message}`)
      .join('\n')

    if (summary.length > 0) {
      db.prepare(`INSERT INTO knowledge (product_id, type, title, content, source_url) VALUES (?, ?, ?, ?, ?)`)
        .run(
          messages[0].product_id || null,
          'meeting_archive',
          `Meeting: ${topic}`,
          summary.substring(0, 10000),
          'archived_meeting'
        )
    }

    // Mark as archived (soft delete)
    db.prepare('UPDATE discussions SET archived = 1 WHERE topic = ?').run(topic)

    return c.json({ success: true, archived: messages.length, saved_to_brain: true })
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
      const product = c.req.query('product')
      const productClause = product ? `AND p.name = ?` : ''
      const args: (string | number)[] = product ? [days, product] : [days]
      const rows = db.prepare(`
        SELECT m.*, p.display_name AS product_name, l.name AS lead_name, l.email AS lead_email
        FROM meetings m
        LEFT JOIN products p ON p.id = m.product_id
        LEFT JOIN leads l ON l.id = m.lead_id
        WHERE m.status IN ('confirmed', 'proposed')
          AND m.date BETWEEN date('now') AND date('now', '+' || ? || ' days')
          ${productClause}
        ORDER BY m.date ASC, m.time ASC
      `).all(...args)
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

  // POST /api/dashboard/brain/learnings — save a learning from agents
  app.post('/api/dashboard/brain/learnings', async (c) => {
    const body = await c.req.json() as {
      agent_role?: string; category?: string; insight?: string
      source?: string; product?: string
    }
    if (!body.category || !body.insight) return c.json({ error: 'category and insight required' }, 400)
    let productId: number | null = null
    if (body.product) {
      const p = db.prepare('SELECT id FROM products WHERE name = ?').get(body.product) as { id: number } | undefined
      if (p) productId = p.id
    }
    const existing = db.prepare(
      'SELECT id, confidence FROM learnings WHERE agent_role IS ? AND product_id IS ? AND category = ? AND insight = ?'
    ).get(body.agent_role || null, productId, body.category, body.insight) as { id: number; confidence: number } | undefined
    if (existing) {
      const newConf = Math.min(1.0, existing.confidence + 0.1)
      db.prepare('UPDATE learnings SET confidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newConf, existing.id)
      return c.json({ id: existing.id, reinforced: true, confidence: newConf })
    }
    const result = db.prepare(
      'INSERT INTO learnings (agent_role, product_id, category, insight, confidence, source) VALUES (?, ?, ?, ?, 0.5, ?)'
    ).run(body.agent_role || null, productId, body.category, body.insight, body.source || 'manual')
    return c.json({ id: result.lastInsertRowid, reinforced: false, confidence: 0.5 }, 201)
  })

  // GET /api/dashboard/agent-profiles
  app.get('/api/dashboard/agent-profiles', (c) => {
    const rows = db.prepare('SELECT * FROM agent_profiles ORDER BY team, name').all()
    return c.json(rows)
  })

  // PUT /api/dashboard/agent-profiles/:role — rename or update agent
  app.put('/api/dashboard/agent-profiles/:role', async (c) => {
    const role = c.req.param('role')
    const existing = db.prepare('SELECT * FROM agent_profiles WHERE role = ?').get(role)
    if (!existing) return c.json({ error: 'Agent not found' }, 404)
    const body = await c.req.json() as { name?: string; avatar?: string; personality?: string; status?: string }
    const sets: string[] = []
    const args: (string | number)[] = []
    if (body.name !== undefined) { sets.push('name = ?'); args.push(body.name) }
    if (body.avatar !== undefined) { sets.push('avatar = ?'); args.push(body.avatar) }
    if (body.personality !== undefined) { sets.push('personality = ?'); args.push(body.personality) }
    if (body.status !== undefined) { sets.push('status = ?'); args.push(body.status) }
    if (!sets.length) return c.json({ error: 'No fields to update' }, 400)
    args.push(role)
    db.prepare(`UPDATE agent_profiles SET ${sets.join(', ')} WHERE role = ?`).run(...args)
    return c.json(db.prepare('SELECT * FROM agent_profiles WHERE role = ?').get(role))
  })

  // GET /api/dashboard/inbox — formatted inbox from activity_log
  app.get('/api/dashboard/inbox', (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100)
    const product = c.req.query('product')
    const productClause = product ? `AND product_id = (SELECT id FROM products WHERE name = ?)` : ''
    const args: (string | number)[] = product ? [product, limit] : [limit]
    const rows = db.prepare(`
      SELECT id, details, created_at FROM activity_log
      WHERE action = 'email_received' AND details IS NOT NULL ${productClause}
      ORDER BY created_at DESC LIMIT ?
    `).all(...args) as { id: number; details: string; created_at: string }[]

    const emails: { id: number; date: string; from: string; subject: string; snippet: string; body: string; lead_id: number | null; lead_name: string | null }[] = []
    for (const r of rows) {
      try {
        const d = JSON.parse(r.details) as { date?: string; from?: string; subject?: string; snippet?: string }

        // Smart decode snippet
        let bodyText = d.snippet || ''
        const nonAsc2 = bodyText.split('').filter((c: string) => c.charCodeAt(0) > 127).length
        if ((nonAsc2 / Math.max(bodyText.length, 1)) >= 0.3) {
          try {
            const dec2 = Buffer.from(bodyText, 'base64').toString('utf-8')
            const decNonAsc2 = dec2.split('').filter((c: string) => c.charCodeAt(0) > 127).length
            bodyText = (decNonAsc2 / Math.max(dec2.length, 1)) < 0.3 ? dec2 : '[Innehåll kunde inte avkodas]'
          } catch { bodyText = '[Innehåll kunde inte avkodas]' }
        }
        bodyText = cleanSnippet(bodyText)

        // Match to lead by from-email
        let leadId: number | null = null
        let leadName: string | null = null
        if (d.from) {
          const lead = db.prepare('SELECT id, name, company FROM leads WHERE email = ?').get(d.from) as any
          if (lead) {
            leadId = lead.id
            leadName = lead.name || lead.company || null
          }
        }

        emails.push({
          id: r.id,
          date: d.date || r.created_at,
          from: d.from || 'unknown',
          subject: d.subject || '(inget ämne)',
          snippet: bodyText.substring(0, 200),
          body: bodyText,
          lead_id: leadId,
          lead_name: leadName,
        })
      } catch { /* skip unparseable */ }
    }

    return c.json(emails)
  })

  // ── Telegram Config ──────────────────────────────────────────────────

  app.get('/api/dashboard/telegram', (c) => {
    const tg = config.telegram || { bot_token: '', chat_id: '', enabled: false }
    return c.json({
      bot_token: tg.bot_token ? '***' + tg.bot_token.slice(-6) : '',
      chat_id: tg.chat_id,
      enabled: tg.enabled,
    })
  })

  app.post('/api/dashboard/telegram', async (c) => {
    const body = await c.req.json() as { bot_token?: string; chat_id?: string; enabled?: boolean }
    const { readFileSync, writeFileSync } = await import('fs')
    const { join } = await import('path')

    const { dirname: pathDirname } = await import('path')
    const { fileURLToPath } = await import('url')
    const base = process.env.SALES_MCP_BASE ||
      pathDirname(pathDirname(pathDirname(fileURLToPath(import.meta.url))))
    const configPath = join(base, 'config.json')
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    if (!raw.telegram) raw.telegram = { bot_token: '', chat_id: '', enabled: false }

    if (body.bot_token !== undefined) raw.telegram.bot_token = body.bot_token
    if (body.chat_id !== undefined) raw.telegram.chat_id = body.chat_id
    if (body.enabled !== undefined) raw.telegram.enabled = body.enabled

    writeFileSync(configPath, JSON.stringify(raw, null, 2))

    // Update runtime config
    if (!config.telegram) (config as any).telegram = { bot_token: '', chat_id: '', enabled: false }
    Object.assign(config.telegram!, raw.telegram)

    return c.json({ ok: true, enabled: raw.telegram.enabled })
  })

  app.post('/api/dashboard/telegram/test', async (c) => {
    const { sendTelegram } = await import('../providers/telegram.js')
    const ok = await sendTelegram('🔔 <b>Test</b>\n\nSales MCP Telegram-notifieringar fungerar!')
    return c.json({ ok, message: ok ? 'Test skickat!' : 'Misslyckades — kolla token och chat_id' })
  })

  // ── Daily Reports ────────────────────────────────────────────────────

  app.get('/api/dashboard/reports', (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200)
    const product = c.req.query('product')
    const agent = c.req.query('agent')

    const conditions: string[] = []
    const args: (string | number)[] = []

    if (product) {
      conditions.push('r.product_id = (SELECT id FROM products WHERE name = ?)')
      args.push(product)
    }
    if (agent) {
      conditions.push('r.agent_role = ?')
      args.push(agent)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = db.prepare(`
      SELECT r.*, ap.name AS agent_name, ap.avatar
      FROM daily_reports r
      LEFT JOIN agent_profiles ap ON ap.role = r.agent_role
      ${where}
      ORDER BY r.created_at DESC
      LIMIT ?
    `).all(...args, limit)

    return c.json(rows)
  })

  // ── Bulk Operations ──────────────────────────────────────────────────

  // DELETE /api/dashboard/reports/bulk — clear old reports
  app.delete('/api/dashboard/reports/bulk', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { before?: string }
    if (body.before) {
      const result = db.prepare('DELETE FROM daily_reports WHERE created_at < ?').run(body.before)
      return c.json({ deleted: result.changes })
    }
    const result = db.prepare("DELETE FROM daily_reports WHERE created_at < datetime('now', '-7 days')").run()
    return c.json({ deleted: result.changes })
  })

  // DELETE /api/dashboard/recommendations/bulk — clear old recommendations
  app.delete('/api/dashboard/recommendations/bulk', async (c) => {
    const result = db.prepare("DELETE FROM recommendations WHERE status = 'pending' AND created_at < datetime('now', '-2 days')").run()
    return c.json({ deleted: result.changes })
  })

  // ── Sequence Assignment ──────────────────────────────────────────────

  // POST /api/dashboard/leads/:id/sequence — assign lead to sequence
  app.post('/api/dashboard/leads/:id/sequence', async (c) => {
    const leadId = parseInt(c.req.param('id'), 10)
    const body = await c.req.json() as { sequence_id: number | null }

    const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(leadId)
    if (!lead) return c.json({ error: 'Lead not found' }, 404)

    if (body.sequence_id === null) {
      db.prepare("UPDATE leads SET sequence_id = NULL, sequence_step = 0, sequence_paused = 0, updated_at = datetime('now') WHERE id = ?").run(leadId)
    } else {
      const seq = db.prepare('SELECT id FROM sequences WHERE id = ?').get(body.sequence_id)
      if (!seq) return c.json({ error: 'Sequence not found' }, 404)
      db.prepare("UPDATE leads SET sequence_id = ?, sequence_step = 0, sequence_paused = 0, updated_at = datetime('now') WHERE id = ?").run(body.sequence_id, leadId)
    }

    const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId)
    return c.json(updated)
  })

  // ── Email Tracking Stats ─────────────────────────────────────────────

  app.get('/api/dashboard/tracking/stats', (c) => {
    const sent = (db.prepare("SELECT COUNT(*) as c FROM email_tracking WHERE type = 'sent'").get() as { c: number }).c
    const opened = (db.prepare("SELECT COUNT(*) as c FROM email_tracking WHERE type = 'open'").get() as { c: number }).c
    const clicked = (db.prepare("SELECT COUNT(*) as c FROM email_tracking WHERE type = 'click'").get() as { c: number }).c
    const openRate = sent > 0 ? Math.round((opened / sent) * 100) : 0
    const clickRate = sent > 0 ? Math.round((clicked / sent) * 100) : 0

    return c.json({ sent, opened, clicked, open_rate: openRate, click_rate: clickRate })
  })

  // ── Email Stats (comprehensive) ────────────────────────────────────────
  // Built by Christos Ferlachidis & Daniel Hedenberg

  app.get('/api/dashboard/email-stats', (c) => {
    const q = (sql: string) => (db.prepare(sql).get() as { c: number }).c

    const autoReplyFrom = ['MAILER-DAEMON', 'noreply', 'no-reply', 'postmaster', 'zendesk.com', 'notification.support', 'info@weblease.se', 'mail@weblease.se']
    const autoReplySubj = ['ticket', 'autosvar', 'autoreply', 'auto-reply', 'automatische antwort', 'automatisch antwoord', 'out of office', 'abwesenheit', 'semester', 'account created', 'aktivera ditt', 'eingangsbestätigung', 'mottaget', 'received', 'ticket received']

    const totalSent = q("SELECT COUNT(*) as c FROM activity_log WHERE action IN ('email_sent', 'sequence_email_sent')")
    const totalReceived = q("SELECT COUNT(*) as c FROM activity_log WHERE action = 'email_received'")
    const totalBounced = q("SELECT COUNT(*) as c FROM leads WHERE status = 'bounced'")
    const totalOpened = q("SELECT COUNT(*) as c FROM email_tracking WHERE type = 'open' AND triggered_at IS NOT NULL")
    const totalClicked = q("SELECT COUNT(*) as c FROM email_tracking WHERE type = 'click' AND triggered_at IS NOT NULL")

    // Real replies (same logic as overview-stats)
    const allReceived = db.prepare(
      "SELECT details FROM activity_log WHERE action = 'email_received' AND details IS NOT NULL"
    ).all() as { details: string }[]
    let realReplies = 0
    for (const r of allReceived) {
      try {
        const d = JSON.parse(r.details)
        const from = (d.from || '').toLowerCase()
        const subj = (d.subject || '').toLowerCase()
        if (autoReplyFrom.some(p => from.includes(p.toLowerCase()))) continue
        if (autoReplySubj.some(p => subj.includes(p.toLowerCase()))) continue
        realReplies++
      } catch { /* skip */ }
    }

    const replyRate = totalSent > 0 ? Math.round((realReplies / totalSent) * 10000) / 100 : 0
    const bounceRate = totalSent > 0 ? Math.round((totalBounced / totalSent) * 10000) / 100 : 0
    const openRate = totalSent > 0 ? Math.round((totalOpened / totalSent) * 10000) / 100 : 0

    // Best template: find from sequence_email_sent details which template has most opens/clicks
    let bestTemplate: string | null = null
    try {
      const rows = db.prepare(
        "SELECT details FROM activity_log WHERE action = 'sequence_email_sent' AND details IS NOT NULL"
      ).all() as { details: string }[]

      const templateScores: Record<string, number> = {}
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.details)
          if (parsed.template) {
            templateScores[parsed.template] = (templateScores[parsed.template] || 0) + 1
          }
        } catch { /* skip malformed */ }
      }

      // Weight by opens and clicks if possible
      const entries = Object.entries(templateScores)
      if (entries.length > 0) {
        bestTemplate = entries.sort((a, b) => b[1] - a[1])[0][0]
      }
    } catch { /* ignore */ }

    return c.json({
      total_sent: totalSent,
      total_received: totalReceived,
      total_bounced: totalBounced,
      total_opened: totalOpened,
      total_clicked: totalClicked,
      reply_rate: replyRate,
      bounce_rate: bounceRate,
      open_rate: openRate,
      real_replies: realReplies,
      best_template: bestTemplate,
      generated_at: new Date().toISOString(),
    })
  })

  // ── Overview Stats (single source of truth) ────────────────────────────

  app.get('/api/dashboard/overview-stats', (c) => {
    const q = (sql: string) => (db.prepare(sql).get() as { c: number }).c

    const autoReplyFrom = ['MAILER-DAEMON', 'noreply', 'no-reply', 'postmaster', 'zendesk.com', 'notification.support', 'info@weblease.se', 'mail@weblease.se']
    const autoReplySubj = ['ticket', 'autosvar', 'autoreply', 'auto-reply', 'automatische antwort', 'automatisch antwoord', 'out of office', 'abwesenheit', 'semester', 'account created', 'aktivera ditt', 'eingangsbestätigung', 'mottaget', 'received', 'ticket received']

    // Leads
    const totalLeads = q('SELECT COUNT(*) as c FROM leads')
    const wordpress = q("SELECT COUNT(*) as c FROM leads WHERE tags LIKE '%wordpress%'")
    const contacted = q("SELECT COUNT(*) as c FROM leads WHERE status = 'contacted'")
    const interested = q("SELECT COUNT(*) as c FROM leads WHERE response_status = 'interested'")
    const qualified = q("SELECT COUNT(*) as c FROM leads WHERE status = 'qualified'")
    const converted = q("SELECT COUNT(*) as c FROM leads WHERE status = 'converted'")
    const bounced = q("SELECT COUNT(*) as c FROM leads WHERE status = 'bounced'")
    const declined = q("SELECT COUNT(*) as c FROM leads WHERE response_status = 'declined'")
    const lost = q("SELECT COUNT(*) as c FROM leads WHERE status = 'lost'")
    const newLeads = q("SELECT COUNT(*) as c FROM leads WHERE status = 'new'")

    // Emails
    const totalSent = q("SELECT COUNT(*) as c FROM activity_log WHERE action IN ('email_sent', 'sequence_email_sent')")
    const totalReceived = q("SELECT COUNT(*) as c FROM activity_log WHERE action = 'email_received'")

    // Real replies (filter out auto-replies)
    const allReceived = db.prepare(
      "SELECT details FROM activity_log WHERE action = 'email_received' AND details IS NOT NULL"
    ).all() as { details: string }[]

    let realReplies = 0
    for (const r of allReceived) {
      try {
        const d = JSON.parse(r.details)
        const from = (d.from || '').toLowerCase()
        const subj = (d.subject || '').toLowerCase()
        if (autoReplyFrom.some(p => from.includes(p.toLowerCase()))) continue
        if (autoReplySubj.some(p => subj.includes(p.toLowerCase()))) continue
        realReplies++
      } catch { /* skip */ }
    }

    const responseRate = contacted > 0 ? Math.round(((interested + declined) / contacted) * 10000) / 100 : 0
    const replyRate = totalSent > 0 ? Math.round((realReplies / totalSent) * 10000) / 100 : 0
    const bounceRate = totalSent > 0 ? Math.round((bounced / totalSent) * 10000) / 100 : 0

    return c.json({
      leads: { total: totalLeads, wordpress, new: newLeads, contacted, interested, qualified, converted, bounced, declined, lost },
      emails: { sent: totalSent, received: totalReceived, real_replies: realReplies, bounced, reply_rate: replyRate, bounce_rate: bounceRate, response_rate: responseRate },
      pipeline: { new: newLeads, contacted, interested, qualified, converted },
    })
  })

  // ── Template Stats ─────────────────────────────────────────────────────

  app.get('/api/dashboard/template-stats', (c) => {
    // Get all templates
    const templates = db.prepare(
      `SELECT t.id, t.name, t.type, t.product_id, p.name AS product_name
       FROM templates t
       LEFT JOIN products p ON p.id = t.product_id
       ORDER BY t.name`
    ).all() as { id: number; name: string; type: string; product_id: number | null; product_name: string | null }[]

    // Parse activity_log for template usage
    const sentRows = db.prepare(
      "SELECT details FROM activity_log WHERE action IN ('email_sent', 'sequence_email_sent') AND details IS NOT NULL"
    ).all() as { details: string }[]

    const templateSent: Record<string, number> = {}
    const templateTrackingIds: Record<string, string[]> = {}
    for (const row of sentRows) {
      try {
        const parsed = JSON.parse(row.details)
        const tplName = parsed.template || parsed.templateName
        if (tplName) {
          templateSent[tplName] = (templateSent[tplName] || 0) + 1
          if (parsed.trackingId) {
            if (!templateTrackingIds[tplName]) templateTrackingIds[tplName] = []
            templateTrackingIds[tplName].push(parsed.trackingId)
          }
        }
      } catch { /* skip */ }
    }

    // Count replies per template (from email_received where lead was previously sent template)
    const replyRows = db.prepare(
      "SELECT lead_id FROM activity_log WHERE action = 'email_received' AND lead_id IS NOT NULL AND details NOT LIKE '%MAILER-DAEMON%'"
    ).all() as { lead_id: number }[]
    const replyLeadIds = new Set(replyRows.map(r => r.lead_id))

    // For each template, count opens and clicks from tracking
    const stats = templates.map(t => {
      const sent = templateSent[t.name] || 0
      let opens = 0
      let clicks = 0

      const trackingIds = templateTrackingIds[t.name] || []
      if (trackingIds.length > 0) {
        // Check open/click tracking for these tracking IDs
        for (const tid of trackingIds) {
          const openRow = db.prepare(
            "SELECT COUNT(*) as c FROM email_tracking WHERE tracking_id = ? AND type = 'open' AND triggered_at IS NOT NULL"
          ).get(tid + ':open') as { c: number }
          opens += openRow.c

          const clickRow = db.prepare(
            "SELECT COUNT(*) as c FROM email_tracking WHERE tracking_id = ? AND type = 'click' AND triggered_at IS NOT NULL"
          ).get(tid + ':click') as { c: number }
          clicks += clickRow.c
        }
      }

      // Replies: count leads that both received this template AND replied
      let replies = 0
      if (trackingIds.length > 0) {
        for (const tid of trackingIds) {
          const sentTrack = db.prepare(
            "SELECT lead_id FROM email_tracking WHERE tracking_id LIKE ? AND type = 'sent'"
          ).get(tid + '%') as { lead_id: number } | undefined
          if (sentTrack && replyLeadIds.has(sentTrack.lead_id)) {
            replies++
          }
        }
      }

      return {
        template_name: t.name,
        product_name: t.product_name,
        type: t.type,
        sent,
        opens,
        clicks,
        replies,
      }
    })

    return c.json(stats)
  })

  // ── POST /api/dashboard/run-agents — Manual agent chain (on-demand, no background tokens) ──
  app.post('/api/dashboard/run-agents', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      task?: string; agents?: string[]; product?: string
    }

    const task = body.task || 'find_leads'
    const product = body.product || 'wpilot'

    const chains: Record<string, string[]> = {
      find_leads:    ['scout', 'outreach'],
      review_drafts: ['copywriter', 'strategist'],
      full_cycle:    ['scout', 'outreach', 'copywriter', 'closer', 'analyst'],
      analyze:       ['analyst', 'strategist', 'coo'],
    }

    const agentRoles = body.agents || chains[task] || chains['find_leads']

    const products = db.prepare('SELECT * FROM products').all() as { id: number; name: string; display_name: string; description: string | null }[]
    const targetProduct = products.find(p => p.name === product)
    const productId = targetProduct?.id || null

    const leadStats = db.prepare('SELECT status, COUNT(*) as count FROM leads GROUP BY status').all()
    const existingEmails = db.prepare('SELECT email FROM leads').all().map((r: any) => r.email)
    const existingDomains = new Set(existingEmails.map((e: string) => e.split('@')[1]).filter(Boolean))
    const recentLearnings = db.prepare(
      'SELECT agent_role, category, insight FROM learnings WHERE confidence >= 0.4 ORDER BY updated_at DESC LIMIT 20'
    ).all() as { agent_role: string; category: string; insight: string }[]
    const knowledge = db.prepare(
      'SELECT title, content FROM knowledge WHERE product_id = ? ORDER BY type LIMIT 5'
    ).all(productId) as { title: string; content: string }[]

    const chainResults: { role: string; name: string; output: string; actions: number }[] = []

    // Uses spawn (not exec) — safe from shell injection
    const { spawn } = await import('child_process')

    function runClaude(prompt: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const proc = spawn('/home/christaras9126/.local/bin/claude', [
          '-p', prompt, '--max-turns', '3', '--model', 'haiku',
        ], {
          env: { ...process.env, HOME: '/home/christaras9126' },
          timeout: 90000,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        proc.stdin.end()
        let out = '', err = ''
        proc.stdout.on('data', (d: Buffer) => { out += d })
        proc.stderr.on('data', (d: Buffer) => { err += d })
        proc.on('close', (code: number | null) => {
          if (code === 0 && out.trim()) resolve(out.trim())
          else reject(new Error(err || `exit ${code}`))
        })
        proc.on('error', reject)
      })
    }

    function parseActions(response: string): { type: string; data: Record<string, unknown> }[] {
      const actions: { type: string; data: Record<string, unknown> }[] = []
      const regex = /ACTION:(\w+)\s*(\{[^}]+\})/g
      let match: RegExpExecArray | null
      while ((match = regex.exec(response)) !== null) {
        try { actions.push({ type: match[1], data: JSON.parse(match[2]) }) } catch {}
      }
      return actions
    }

    for (const role of agentRoles) {
      const profile = db.prepare('SELECT name, system_prompt FROM agent_profiles WHERE role = ?').get(role) as { name: string; system_prompt: string } | undefined
      if (!profile) continue

      const previousWork = chainResults.length > 0
        ? '\n\nTIDIGARE AGENTER (bygg vidare!):\n' +
          chainResults.map(r => `--- ${r.name} (${r.role}) ${r.actions} actions ---\n${r.output.substring(0, 400)}`).join('\n\n')
        : ''

      const systemPrompt = profile.system_prompt
        .replace('{{PRODUCT_CONTEXT}}', `\nFOKUS: ${targetProduct?.display_name || product}\n${targetProduct?.description || ''}`)
        .replace('{{LEARNINGS}}', recentLearnings.map(l => `[${l.agent_role}/${l.category}] ${l.insight}`).join('\n'))
        .replace('{{TEAM_KNOWLEDGE}}', knowledge.map(k => `${k.title}: ${k.content.substring(0, 200)}`).join('\n'))
        .replace('{{CURRENT_CONTEXT}}', '')

      const taskDesc = task === 'find_leads'
        ? `Lista MINST 20 DOMÄNER till WordPress-byråer, WooCommerce-butiker och WordPress-utvecklare.

Du har tränats på miljontals webbsidor. Ge mig RIKTIGA domäner du vet existerar.
Vi har redan ${existingDomains.size} domäner — vi kollar dubbletter automatiskt, du behöver inte oroa dig

KATEGORIER (blanda!):
- WordPress-byråer (Sverige, UK, Tyskland, Frankrike, NL, Spanien, Italien, Polen, USA, Kanada, Australien)
- WooCommerce-butiker
- WordPress theme/plugin-företag
- Digitala byråer som jobbar med WordPress

SVARA EXAKT SÅ HÄR — en domän per rad, inget annat:
DOMAIN:example-agency.com
DOMAIN:another-wp-shop.de
DOMAIN:wordpress-bureau.nl

GE MINST 20 DOMÄNER. Inga förklaringar, inga introduktioner — BARA DOMAIN-rader.`
        : task === 'review_drafts' ? 'Granska senaste email-drafts och förbättra copy/subject lines.'
        : task === 'analyze' ? 'Analysera funnel-data och ge konkreta förbättringsförslag.'
        : 'Full säljcykel: researcha, skriv outreach, förbered deals.'

      const prompt = `${systemPrompt}
${previousWork}

UPPGIFT: ${taskDesc}

LEAD-STATUS: ${JSON.stringify(leadStats)}
BEFINTLIGA DOMÄNER (skippa!): ${[...existingDomains].slice(0, 50).join(', ')}... (${existingDomains.size} totalt)

LEARNINGS:
${recentLearnings.map(l => `- ${l.insight}`).join('\n') || '(inga)'}

ACTION-FORMAT:
- ACTION:create_lead{"email":"x@y.com","name":"Namn","company":"Företag","product_id":${productId},"source":"agent_${role}","tags":"wordpress","notes":"..."}
- ACTION:save_learning{"category":"...","insight":"..."}
- ACTION:create_draft{"type":"email","title":"Ämne","content":"<p>...</p>","recipient_email":"x@y.com","product_id":${productId}}

REGLER: Konkret. Riktiga sidor, riktiga emails. Spara learnings. Max 500 ord. Svenska.`

      try {
        const output = await runClaude(prompt)
        let actionsExecuted = 0

        // Parse DOMAIN: lines from agent output — then verify each one
        const domainRegex = /DOMAIN:([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g
        let domainMatch: RegExpExecArray | null
        const agentDomains: string[] = []
        while ((domainMatch = domainRegex.exec(output)) !== null) {
          const d = domainMatch[1].toLowerCase()
          if (!existingDomains.has(d)) agentDomains.push(d)
        }

        // Verify each domain — check WordPress + extract email
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
        const skipEmailDomains = new Set(['sentry.io','gravatar.com','w3.org','schema.org','wordpress.org','wordpress.com','google.com','facebook.com','twitter.com','github.com','cloudflare.com','googleapis.com','gstatic.com','jquery.com','wp.com','amazon.com','stripe.com','linkedin.com','instagram.com'])
        const bizPrefixes = ['info','hello','contact','hi','hej','kontakt','sales','support','team','mail','office','hey','hola','post']

        async function fetchUrl(url: string): Promise<string | null> {
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 12000)
          try {
            const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' })
            const txt = await res.text()
            clearTimeout(timer)
            return txt
          } catch { clearTimeout(timer); return null }
        }

        function findEmail(html: string): string | null {
          const raw = (html.match(emailRegex) || []).map(e => e.toLowerCase())
            .filter(e => !skipEmailDomains.has(e.split('@')[1]) && !e.includes('example') && !e.includes('domain.com') && !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.webp') && !e.endsWith('.svg') && !e.includes('noreply') && e.length < 60 && e.length > 5)
          const good = [...new Set(raw)].filter(e => bizPrefixes.some(p => e.startsWith(p + '@')))
          return good[0] || [...new Set(raw)].filter(e => !e.startsWith('admin@'))[0] || null
        }

        if (agentDomains.length > 0) {
          console.log(`[run-agents] Agent found ${agentDomains.length} domains to verify`)
          for (const d of agentDomains.slice(0, 30)) {
            let html = await fetchUrl('https://' + d)
            if (!html) html = await fetchUrl('https://www.' + d)
            if (!html) continue

            const isWP = html.includes('wp-content') || html.includes('wp-includes') || html.includes('wp-json') || html.includes('wordpress')
            let email = findEmail(html)
            if (!email) {
              for (const p of ['/contact', '/contact-us', '/kontakt', '/about']) {
                const ph = await fetchUrl('https://' + d + p)
                if (ph) { email = findEmail(ph); if (email) break; }
              }
            }

            if (email && !existingEmails.includes(email)) {
              const name = d.split('.')[0].charAt(0).toUpperCase() + d.split('.')[0].slice(1)
              const tags = ['wordpress', isWP ? 'wp-verified' : 'unverified'].join(',')
              db.prepare("INSERT OR IGNORE INTO leads (email, name, company, product_id, source, status, tags, notes, score, created_at, updated_at) VALUES (?, ?, ?, ?, 'agent_verified', 'new', ?, ?, ?, datetime('now'), datetime('now'))")
                .run(email, name, d, productId, tags, `Agent-found | ${isWP ? 'WordPress verified' : 'Not WP'} | ${d}`, isWP ? 10 : 0)
              existingEmails.add(email)
              existingDomains.add(d)
              actionsExecuted++
              console.log(`[run-agents] ${isWP ? '✓' : '~'} ${d} > ${email}`)
            }
            await new Promise(r => setTimeout(r, 600))
          }
        }

        // Also parse ACTION: lines (for save_learning, create_draft etc)
        const actions = parseActions(output)
        for (const action of actions) {
          try {
            if (action.type === 'save_learning' && action.data.insight) {
              db.prepare('INSERT INTO learnings (agent_role, product_id, category, insight, confidence, source) VALUES (?, ?, ?, ?, 0.5, ?)')
                .run(role, productId, action.data.category ?? 'general', action.data.insight, 'agent_chain')
              actionsExecuted++
            } else if (action.type === 'create_draft' && action.data.content) {
              db.prepare("INSERT INTO drafts (product_id, type, title, content, recipient_email, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))")
                .run(productId, action.data.type ?? 'email', action.data.title ?? null, action.data.content, action.data.recipient_email ?? null)
              actionsExecuted++
            }
          } catch (err) { console.error(`[run-agents] Action failed:`, (err as Error).message) }
        }

        db.prepare(`INSERT INTO daily_reports (product_id, report_type, agent_role, content, period_start, period_end)
          VALUES (?, 'manual_run', ?, ?, datetime('now'), datetime('now'))`)
          .run(productId, role, output)
        db.prepare('UPDATE agent_profiles SET last_action = ?, last_action_at = datetime(\'now\') WHERE role = ?')
          .run(`Chain: ${task} (${actionsExecuted} actions)`, role)

        chainResults.push({ role, name: profile.name, output, actions: actionsExecuted })
        console.log(`[run-agents] ${profile.name} (${role}): ${actionsExecuted} actions`)
      } catch (err) {
        chainResults.push({ role, name: profile.name, output: `ERROR: ${(err as Error).message}`, actions: 0 })
      }
    }

    return c.json({
      task, product,
      agents_run: chainResults.length,
      total_actions: chainResults.reduce((s, r) => s + r.actions, 0),
      results: chainResults.map(r => ({ role: r.role, name: r.name, actions: r.actions, summary: r.output.substring(0, 300) })),
    })
  })

  return app
}
