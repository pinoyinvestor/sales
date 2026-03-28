import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import Database from 'better-sqlite3'

interface Product {
  id: number
  name: string
  display_name: string
}

interface Channel {
  id: number
  name: string
  type: string
}

interface Draft {
  id: number
  product_id: number | null
  channel_id: number | null
  type: string
  title: string | null
  content: string
  recipient_email: string | null
  status: string
  posted_at: string | null
  external_url: string | null
  created_at: string
}

interface DraftRow extends Draft {
  product_name: string | null
  product_display_name: string | null
  channel_name: string | null
  channel_type: string | null
}

// Built by Christos Ferlachidis & Daniel Hedenberg

export function registerContentTools(server: McpServer, db: Database.Database): void {
  server.tool(
    'save_draft',
    'Save a content draft for a product, optionally tied to a channel',
    {
      product: z.string().describe('Product name (slug) to associate the draft with'),
      channel: z.string().optional().describe('Channel name to associate the draft with'),
      type: z
        .enum(['email', 'blog_post', 'forum_post', 'social_post', 'sms'])
        .describe('Type of content draft'),
      title: z.string().optional().describe('Title of the draft'),
      content: z.string().describe('Body/content of the draft'),
      recipient_email: z.string().optional().describe('Recipient email address (for email drafts)'),
    },
    async ({ product, channel, type, title, content, recipient_email }) => {
      const productRow = db
        .prepare('SELECT id, name, display_name FROM products WHERE name = ?')
        .get(product) as Product | undefined

      if (!productRow) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Product "${product}" not found.` }) }],
        }
      }

      let channelId: number | null = null
      if (channel) {
        const channelRow = db
          .prepare('SELECT id, name, type FROM channels WHERE name = ?')
          .get(channel) as Channel | undefined

        if (!channelRow) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Channel "${channel}" not found.` }) }],
          }
        }
        channelId = channelRow.id
      }

      const result = db
        .prepare(
          `INSERT INTO drafts (product_id, channel_id, type, title, content, recipient_email, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`
        )
        .run(productRow.id, channelId, type, title ?? null, content, recipient_email ?? null)

      const draft = db
        .prepare('SELECT * FROM drafts WHERE id = ?')
        .get(result.lastInsertRowid) as Draft

      return {
        content: [{ type: 'text', text: JSON.stringify(draft, null, 2) }],
      }
    }
  )

  server.tool(
    'get_drafts',
    'Retrieve content drafts, optionally filtered by product, status, or type',
    {
      product: z.string().optional().describe('Filter by product name (slug)'),
      status: z
        .enum(['pending', 'approved', 'rejected', 'posted'])
        .optional()
        .default('pending')
        .describe('Filter by draft status (default: pending)'),
      type: z
        .enum(['email', 'blog_post', 'forum_post', 'social_post', 'sms'])
        .optional()
        .describe('Filter by draft type'),
      limit: z.number().int().positive().optional().default(20).describe('Maximum number of results (default: 20)'),
    },
    async ({ product, status, type, limit }) => {
      const conditions: string[] = []
      const params: (string | number)[] = []

      if (product) {
        const productRow = db
          .prepare('SELECT id FROM products WHERE name = ?')
          .get(product) as Pick<Product, 'id'> | undefined

        if (!productRow) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Product "${product}" not found.` }) }],
          }
        }
        conditions.push('d.product_id = ?')
        params.push(productRow.id)
      }

      if (status) {
        conditions.push('d.status = ?')
        params.push(status)
      }

      if (type) {
        conditions.push('d.type = ?')
        params.push(type)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      params.push(limit ?? 20)

      const drafts = db
        .prepare(
          `SELECT
             d.*,
             p.name        AS product_name,
             p.display_name AS product_display_name,
             c.name        AS channel_name,
             c.type        AS channel_type
           FROM drafts d
           JOIN products p ON p.id = d.product_id
           LEFT JOIN channels c ON c.id = d.channel_id
           ${whereClause}
           ORDER BY d.created_at DESC
           LIMIT ?`
        )
        .all(...params) as DraftRow[]

      return {
        content: [{ type: 'text', text: JSON.stringify(drafts, null, 2) }],
      }
    }
  )

  server.tool(
    'approve_draft',
    'Approve or reject a content draft',
    {
      id: z.number().int().positive().describe('ID of the draft to update'),
      action: z.enum(['approve', 'reject']).describe('Action to take on the draft'),
    },
    async ({ id, action }) => {
      const existing = db
        .prepare('SELECT * FROM drafts WHERE id = ?')
        .get(id) as Draft | undefined

      if (!existing) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Draft with id ${id} not found.` }) }],
        }
      }

      const newStatus = action === 'approve' ? 'approved' : 'rejected'

      db.prepare('UPDATE drafts SET status = ? WHERE id = ?').run(newStatus, id)

      const updated = db
        .prepare('SELECT * FROM drafts WHERE id = ?')
        .get(id) as Draft

      return {
        content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }],
      }
    }
  )

  server.tool(
    'post_draft',
    'Mark an approved draft as posted (channel provider integration pending)',
    {
      id: z.number().int().positive().describe('ID of the approved draft to post'),
    },
    async ({ id }) => {
      const draft = db
        .prepare('SELECT * FROM drafts WHERE id = ?')
        .get(id) as Draft | undefined

      if (!draft) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Draft with id ${id} not found.` }) }],
        }
      }

      if (draft.status !== 'approved') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `Draft must be approved before posting. Current status: "${draft.status}".`,
              }),
            },
          ],
        }
      }

      const postedAt = new Date().toISOString()

      db.prepare(
        `UPDATE drafts SET status = 'posted', posted_at = ? WHERE id = ?`
      ).run(postedAt, id)

      db.prepare(
        `INSERT INTO activity_log (product_id, channel_id, draft_id, action, details)
         VALUES (?, ?, ?, 'post_published', ?)`
      ).run(
        draft.product_id,
        draft.channel_id,
        id,
        JSON.stringify({ type: draft.type, title: draft.title, posted_at: postedAt })
      )

      const updated = db
        .prepare('SELECT * FROM drafts WHERE id = ?')
        .get(id) as Draft

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ...updated,
                _note: 'Draft marked as posted. Direct channel provider posting will be implemented in a future update.',
              },
              null,
              2
            ),
          },
        ],
      }
    }
  )
}
