import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import Database from 'better-sqlite3'

export function registerStatsTools(server: McpServer, db: Database.Database) {

  // ── Tool 1: get_stats ──────────────────────────────────────────────────────

  server.tool(
    'get_stats',
    'Get activity statistics grouped by action type for a given period, optionally filtered by product',
    {
      product: z.string().optional().describe('Product name to filter stats by'),
      period:  z.enum(['today', 'week', 'month', 'all']).describe('Time period: today, week, month, or all'),
    },
    async (params) => {
      // Resolve date filter
      const dateFilters: Record<string, string> = {
        today: "created_at >= date('now', 'start of day')",
        week:  "created_at >= date('now', '-7 days')",
        month: "created_at >= date('now', '-30 days')",
        all:   '',
      }
      const dateFilter = dateFilters[params.period]

      // Resolve product filter
      let productId: number | null = null
      if (params.product) {
        const row = db.prepare('SELECT id FROM products WHERE name = ?').get(params.product) as { id: number } | undefined
        if (!row) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'PRODUCT_NOT_FOUND', message: `Product "${params.product}" does not exist` }),
            }],
          }
        }
        productId = row.id
      }

      // Build WHERE clause for activity_log
      const buildWhere = (extra?: string): string => {
        const parts: string[] = []
        if (dateFilter) parts.push(dateFilter)
        if (productId !== null) parts.push('product_id = ?')
        if (extra) parts.push(extra)
        return parts.length ? `WHERE ${parts.join(' AND ')}` : ''
      }

      const activityArgs = productId !== null ? [productId] : []

      // Built by Weblease

      // Count actions from activity_log
      const countAction = (action: string): number => {
        const where = buildWhere(`action = '${action}'`)
        const row = db.prepare(`SELECT COUNT(*) AS n FROM activity_log ${where}`).get(...activityArgs) as { n: number }
        return row.n
      }

      const emails_sent     = countAction('email_sent')
      const emails_opened   = countAction('email_opened')
      const emails_clicked  = countAction('link_clicked')
      const leads_created   = countAction('lead_created')
      const posts_published = countAction('post_published')
      const sms_sent        = countAction('sms_sent')

      // leads_converted: COUNT from leads WHERE status='converted'
      const leadsConvertedParts: string[] = ["status = 'converted'"]
      const leadsConvertedArgs: unknown[] = []

      if (dateFilter) {
        leadsConvertedParts.push(dateFilter)
      }
      if (productId !== null) {
        leadsConvertedParts.push('product_id = ?')
        leadsConvertedArgs.push(productId)
      }

      const leadsConvertedWhere = `WHERE ${leadsConvertedParts.join(' AND ')}`
      const leadsConvertedRow = db.prepare(
        `SELECT COUNT(*) AS n FROM leads ${leadsConvertedWhere}`
      ).get(...leadsConvertedArgs) as { n: number }
      const leads_converted = leadsConvertedRow.n

      // by_product breakdown
      const byProductWhere = buildWhere()
      const byProductRows = db.prepare(`
        SELECT
          p.name                                        AS name,
          COUNT(CASE WHEN a.action = 'lead_created'   THEN 1 END) AS leads,
          COUNT(CASE WHEN a.action = 'email_sent'     THEN 1 END) AS emails,
          COUNT(CASE WHEN a.action = 'post_published' THEN 1 END) AS posts
        FROM activity_log a
        LEFT JOIN products p ON p.id = a.product_id
        ${byProductWhere}
        GROUP BY a.product_id
        ORDER BY leads DESC
      `).all(...activityArgs) as Array<{ name: string | null; leads: number; emails: number; posts: number }>

      const by_product = byProductRows.map(r => ({
        name:   r.name ?? '(unknown)',
        leads:  r.leads,
        emails: r.emails,
        posts:  r.posts,
      }))

      const result = {
        emails_sent,
        emails_opened,
        emails_clicked,
        leads_created,
        leads_converted,
        posts_published,
        sms_sent,
        by_product,
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    }
  )

  // ── Tool 2: log_activity ───────────────────────────────────────────────────

  server.tool(
    'log_activity',
    'Manually log an activity entry into the activity_log table',
    {
      product:    z.string().optional().describe('Product name to associate with this activity'),
      action:     z.string().describe('Action type (e.g. email_sent, lead_created, post_published)'),
      details:    z.string().optional().describe('Optional JSON or text details for the activity'),
      lead_id:    z.number().optional().describe('Lead ID to associate with this activity'),
      channel_id: z.number().optional().describe('Channel ID to associate with this activity'),
    },
    async (params) => {
      let productId: number | null = null

      if (params.product) {
        const row = db.prepare('SELECT id FROM products WHERE name = ?').get(params.product) as { id: number } | undefined
        if (!row) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'PRODUCT_NOT_FOUND', message: `Product "${params.product}" does not exist` }),
            }],
          }
        }
        productId = row.id
      }

      const result = db.prepare(`
        INSERT INTO activity_log (product_id, lead_id, channel_id, action, details)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        productId,
        params.lead_id    ?? null,
        params.channel_id ?? null,
        params.action,
        params.details    ?? null,
      )

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ logged: true, id: result.lastInsertRowid }),
        }],
      }
    }
  )
}
