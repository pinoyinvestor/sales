import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import Database from 'better-sqlite3'

export function registerLeadTools(server: McpServer, db: Database.Database) {

  // ── Tool 1: get_leads ─────────────────────────────────────────────────────

  server.tool(
    'get_leads',
    'Get leads filtered by product, status, source, or free-text search',
    {
      product: z.string().optional().describe('Product name to filter by'),
      status:  z.string().optional().describe('Lead status (new, contacted, replied, converted, lost)'),
      source:  z.string().optional().describe('Lead source (manual, website, social, import, etc.)'),
      limit:   z.number().optional().default(50).describe('Maximum number of leads to return (default 50)'),
      search:  z.string().optional().describe('Free-text search across email, name, and company'),
    },
    async (params) => {
      const conditions: string[] = []
      const args: unknown[]      = []

      if (params.product) {
        conditions.push('p.name = ?')
        args.push(params.product)
      }

      if (params.status) {
        conditions.push('l.status = ?')
        args.push(params.status)
      }

      if (params.source) {
        conditions.push('l.source = ?')
        args.push(params.source)
      }

      if (params.search) {
        conditions.push('(l.email LIKE ? OR l.name LIKE ? OR l.company LIKE ?)')
        const like = `%${params.search}%`
        args.push(like, like, like)
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

      // Built by Christos Ferlachidis & Daniel Hedenberg

      const rows = db.prepare(`
        SELECT
          l.id, l.email, l.name, l.company, l.phone,
          l.source, l.status, l.notes, l.tags,
          l.consent_given, l.consent_date,
          l.sequence_id, l.sequence_step, l.sequence_paused,
          l.last_contacted_at, l.created_at, l.updated_at,
          p.name AS product, p.display_name AS product_display_name
        FROM leads l
        LEFT JOIN products p ON p.id = l.product_id
        ${where}
        ORDER BY l.created_at DESC
        LIMIT ?
      `).all(...args, params.limit ?? 50)

      return { content: [{ type: 'text' as const, text: JSON.stringify(rows) }] }
    }
  )

  // ── Tool 2: save_lead ─────────────────────────────────────────────────────

  server.tool(
    'save_lead',
    'Create or update a lead. Enforces GDPR consent for website/social sources.',
    {
      email:   z.string().email().describe('Lead email address (required)'),
      name:    z.string().optional().describe('Full name'),
      company: z.string().optional().describe('Company name'),
      phone:   z.string().optional().describe('Phone number'),
      product: z.string().describe('Product name (required)'),
      source:  z.string().optional().default('manual').describe('Lead source (default: manual)'),
      tags:    z.string().optional().describe('Comma-separated tags'),
      consent: z.boolean().optional().describe('GDPR consent flag (required true for website/social sources)'),
    },
    async (params) => {
      const source = params.source ?? 'manual'

      // GDPR enforcement
      if ((source === 'website' || source === 'social') && params.consent !== true) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'GDPR_CONSENT_REQUIRED',
              message: `consent must be true for source "${source}"`,
            }),
          }],
        }
      }

      // Resolve product
      const product = db.prepare('SELECT id FROM products WHERE name = ?').get(params.product) as { id: number } | undefined
      if (!product) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'PRODUCT_NOT_FOUND', message: `Product "${params.product}" does not exist` }),
          }],
        }
      }
      const productId = product.id

      // Upsert: insert or ignore, then update
      db.prepare(`
        INSERT OR IGNORE INTO leads (email, name, company, phone, product_id, source, tags, consent_given, consent_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.email,
        params.name    ?? null,
        params.company ?? null,
        params.phone   ?? null,
        productId,
        source,
        params.tags    ?? null,
        params.consent ? 1 : 0,
        params.consent ? new Date().toISOString() : null,
      )

      db.prepare(`
        UPDATE leads SET
          name          = COALESCE(?, name),
          company       = COALESCE(?, company),
          phone         = COALESCE(?, phone),
          source        = ?,
          tags          = COALESCE(?, tags),
          consent_given = CASE WHEN ? = 1 THEN 1 ELSE consent_given END,
          consent_date  = CASE WHEN ? = 1 AND consent_date IS NULL THEN ? ELSE consent_date END,
          updated_at    = CURRENT_TIMESTAMP
        WHERE email = ? AND product_id = ?
      `).run(
        params.name    ?? null,
        params.company ?? null,
        params.phone   ?? null,
        source,
        params.tags    ?? null,
        params.consent ? 1 : 0,
        params.consent ? 1 : 0,
        new Date().toISOString(),
        params.email,
        productId,
      )

      const lead = db.prepare(`
        SELECT l.*, p.name AS product FROM leads l
        LEFT JOIN products p ON p.id = l.product_id
        WHERE l.email = ? AND l.product_id = ?
      `).get(params.email, productId) as Record<string, unknown>

      // Log activity
      db.prepare(`
        INSERT INTO activity_log (product_id, lead_id, action, details)
        VALUES (?, ?, 'lead_created', ?)
      `).run(productId, lead.id, JSON.stringify({ email: params.email, source }))

      return { content: [{ type: 'text' as const, text: JSON.stringify(lead) }] }
    }
  )

  // ── Tool 3: update_lead ───────────────────────────────────────────────────

  server.tool(
    'update_lead',
    'Update an existing lead by ID or by email + product combination',
    {
      id:      z.number().optional().describe('Lead ID'),
      email:   z.string().email().optional().describe('Lead email (used with product for lookup)'),
      product: z.string().optional().describe('Product name (used with email for lookup)'),
      status:  z.string().optional().describe('New status'),
      notes:   z.string().optional().describe('Notes'),
      tags:    z.string().optional().describe('Comma-separated tags'),
      consent: z.boolean().optional().describe('GDPR consent flag'),
    },
    async (params) => {
      // Resolve lead ID
      let leadId: number | undefined = params.id

      if (!leadId) {
        if (!params.email || !params.product) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'MISSING_IDENTIFIER', message: 'Provide id, or both email and product' }),
            }],
          }
        }
        const product = db.prepare('SELECT id FROM products WHERE name = ?').get(params.product) as { id: number } | undefined
        if (!product) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'PRODUCT_NOT_FOUND', message: `Product "${params.product}" does not exist` }),
            }],
          }
        }
        const row = db.prepare('SELECT id FROM leads WHERE email = ? AND product_id = ?').get(params.email, product.id) as { id: number } | undefined
        if (!row) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'LEAD_NOT_FOUND' }),
            }],
          }
        }
        leadId = row.id
      }

      const sets: string[] = ['updated_at = CURRENT_TIMESTAMP']
      const args: unknown[] = []

      if (params.status !== undefined) { sets.push('status = ?');        args.push(params.status) }
      if (params.notes  !== undefined) { sets.push('notes = ?');         args.push(params.notes)  }
      if (params.tags   !== undefined) { sets.push('tags = ?');          args.push(params.tags)   }
      if (params.consent === true)     {
        sets.push('consent_given = 1')
        sets.push('consent_date = COALESCE(consent_date, ?)')
        args.push(new Date().toISOString())
      }

      args.push(leadId)

      db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...args)

      const updated = db.prepare(`
        SELECT l.*, p.name AS product FROM leads l
        LEFT JOIN products p ON p.id = l.product_id
        WHERE l.id = ?
      `).get(leadId)

      return { content: [{ type: 'text' as const, text: JSON.stringify(updated) }] }
    }
  )

  // ── Tool 4: delete_lead ───────────────────────────────────────────────────

  server.tool(
    'delete_lead',
    'Delete a lead and all related records. Logs a GDPR deletion entry.',
    {
      id:      z.number().optional().describe('Lead ID'),
      email:   z.string().email().optional().describe('Lead email (used with product for lookup)'),
      product: z.string().optional().describe('Product name (used with email for lookup)'),
    },
    async (params) => {
      let leadId: number | undefined = params.id
      let leadEmail: string | undefined

      if (!leadId) {
        if (!params.email || !params.product) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'MISSING_IDENTIFIER', message: 'Provide id, or both email and product' }),
            }],
          }
        }
        const product = db.prepare('SELECT id FROM products WHERE name = ?').get(params.product) as { id: number } | undefined
        if (!product) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'PRODUCT_NOT_FOUND', message: `Product "${params.product}" does not exist` }),
            }],
          }
        }
        const row = db.prepare('SELECT id, email FROM leads WHERE email = ? AND product_id = ?').get(params.email, product.id) as { id: number; email: string } | undefined
        if (!row) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'LEAD_NOT_FOUND' }),
            }],
          }
        }
        leadId    = row.id
        leadEmail = row.email
      } else {
        const row = db.prepare('SELECT email FROM leads WHERE id = ?').get(leadId) as { email: string } | undefined
        leadEmail = row?.email
      }

      if (!leadEmail) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'LEAD_NOT_FOUND' }),
          }],
        }
      }

      const activityDeleted  = (db.prepare('DELETE FROM activity_log    WHERE lead_id = ?').run(leadId)).changes
      const trackingDeleted  = (db.prepare('DELETE FROM email_tracking  WHERE lead_id = ?').run(leadId)).changes
      const leadDeleted      = (db.prepare('DELETE FROM leads           WHERE id = ?'     ).run(leadId)).changes

      // GDPR log
      db.prepare(`
        INSERT INTO gdpr_log (email, action, details)
        VALUES (?, 'data_deleted', ?)
      `).run(leadEmail, JSON.stringify({ lead_id: leadId, records_deleted: leadDeleted + activityDeleted + trackingDeleted }))

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            deleted: leadDeleted + activityDeleted + trackingDeleted,
            lead_records:     leadDeleted,
            activity_records: activityDeleted,
            tracking_records: trackingDeleted,
          }),
        }],
      }
    }
  )

  // ── Tool 5: import_leads ──────────────────────────────────────────────────

  server.tool(
    'import_leads',
    'Bulk import leads for a product. Skips duplicates (email + product already exists).',
    {
      data: z.array(z.object({
        email:   z.string().email().describe('Lead email'),
        name:    z.string().optional().describe('Full name'),
        company: z.string().optional().describe('Company name'),
        phone:   z.string().optional().describe('Phone number'),
      })).describe('Array of lead records to import'),
      product: z.string().describe('Product name (required)'),
      source:  z.string().optional().default('import').describe('Lead source (default: import)'),
    },
    async (params) => {
      const product = db.prepare('SELECT id FROM products WHERE name = ?').get(params.product) as { id: number } | undefined
      if (!product) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'PRODUCT_NOT_FOUND', message: `Product "${params.product}" does not exist` }),
          }],
        }
      }
      const productId = product.id
      const source    = params.source ?? 'import'

      const insert = db.prepare(`
        INSERT OR IGNORE INTO leads (email, name, company, phone, product_id, source)
        VALUES (?, ?, ?, ?, ?, ?)
      `)

      let imported = 0
      let skipped  = 0

      const bulkInsert = db.transaction(() => {
        for (const row of params.data) {
          const result = insert.run(
            row.email,
            row.name    ?? null,
            row.company ?? null,
            row.phone   ?? null,
            productId,
            source,
          )
          if (result.changes > 0) {
            imported++
          } else {
            skipped++
          }
        }
      })

      bulkInsert()

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ imported, skipped }),
        }],
      }
    }
  )
}
