import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import Database from 'better-sqlite3'

interface Template {
  id: number
  product_id: number
  name: string
  type: string
  subject: string | null
  content: string
  language: string
  created_at: string
}

interface TemplateRow extends Template {
  product: string
  product_display_name: string
}

// Built by Weblease

export function registerTemplateTools(server: McpServer, db: Database.Database): void {

  // ── Tool 1: get_templates ─────────────────────────────────────────────────

  server.tool(
    'get_templates',
    'Get saved templates, optionally filtered by product name and/or type',
    {
      product: z.string().optional().describe('Product name filter'),
      type: z
        .enum(['email', 'social', 'forum', 'sms'])
        .optional()
        .describe('Template type filter'),
    },
    async ({ product, type }) => {
      const conditions: string[] = []
      const args: unknown[] = []

      if (product) {
        conditions.push('p.name = ?')
        args.push(product)
      }

      if (type) {
        conditions.push('t.type = ?')
        args.push(type)
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

      const rows = db
        .prepare(
          `SELECT
            t.id, t.product_id, t.name, t.type, t.subject, t.content, t.language, t.created_at,
            p.name AS product, p.display_name AS product_display_name
           FROM templates t
           JOIN products p ON p.id = t.product_id
           ${where}
           ORDER BY p.name, t.type, t.name`
        )
        .all(...args) as TemplateRow[]

      return { content: [{ type: 'text' as const, text: JSON.stringify(rows) }] }
    }
  )

  // ── Tool 2: save_template ─────────────────────────────────────────────────

  server.tool(
    'save_template',
    'Create or update a template for a product. Upserts on product + name combination.',
    {
      product:  z.string().describe('Product name (required)'),
      name:     z.string().describe('Template name (required)'),
      type:     z.enum(['email', 'social', 'forum', 'sms']).describe('Template type (required)'),
      subject:  z.string().optional().describe('Subject line (for email templates)'),
      content:  z.string().describe('Template content (required). Use {{variable}} for placeholders.'),
      language: z.string().optional().default('sv').describe('Language code (default: sv)'),
    },
    async (params) => {
      const productRow = db
        .prepare('SELECT id FROM products WHERE name = ?')
        .get(params.product) as { id: number } | undefined

      if (!productRow) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'PRODUCT_NOT_FOUND',
              message: `Product "${params.product}" does not exist`,
            }),
          }],
        }
      }

      const productId = productRow.id
      const language  = params.language ?? 'sv'

      db.prepare(`
        INSERT INTO templates (product_id, name, type, subject, content, language)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(product_id, name) DO UPDATE SET
          subject  = excluded.subject,
          content  = excluded.content,
          type     = excluded.type,
          language = excluded.language
      `).run(
        productId,
        params.name,
        params.type,
        params.subject ?? null,
        params.content,
        language,
      )

      const template = db
        .prepare(`
          SELECT
            t.id, t.product_id, t.name, t.type, t.subject, t.content, t.language, t.created_at,
            p.name AS product, p.display_name AS product_display_name
          FROM templates t
          JOIN products p ON p.id = t.product_id
          WHERE t.product_id = ? AND t.name = ?
        `)
        .get(productId, params.name) as TemplateRow

      return { content: [{ type: 'text' as const, text: JSON.stringify(template) }] }
    }
  )

  // ── Tool 3: use_template ──────────────────────────────────────────────────

  server.tool(
    'use_template',
    'Render a template by replacing {{variable}} placeholders with provided values. Look up by id or by product + name.',
    {
      template_id: z.number().optional().describe('Template ID (fastest lookup)'),
      product:     z.string().optional().describe('Product name (use with name for lookup)'),
      name:        z.string().optional().describe('Template name (use with product for lookup)'),
      variables:   z.string().describe('JSON object of key-value pairs to substitute for {{key}} placeholders, e.g. {"name":"John","company":"Acme"}'),
    },
    async ({ template_id, product, name, variables }) => {
      let template: Template | undefined

      if (template_id !== undefined) {
        template = db
          .prepare('SELECT * FROM templates WHERE id = ?')
          .get(template_id) as Template | undefined
      } else if (product && name) {
        const productRow = db
          .prepare('SELECT id FROM products WHERE name = ?')
          .get(product) as { id: number } | undefined

        if (!productRow) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'PRODUCT_NOT_FOUND',
                message: `Product "${product}" does not exist`,
              }),
            }],
          }
        }

        template = db
          .prepare('SELECT * FROM templates WHERE product_id = ? AND name = ?')
          .get(productRow.id, name) as Template | undefined
      } else {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'MISSING_IDENTIFIER',
              message: 'Provide template_id, or both product and name',
            }),
          }],
        }
      }

      if (!template) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'TEMPLATE_NOT_FOUND' }),
          }],
        }
      }

      const vars: Record<string, string> = typeof variables === 'string' ? JSON.parse(variables) : variables
      const render = (text: string): string =>
        text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`)

      const subject = template.subject ? render(template.subject) : ''
      const content = render(template.content)

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ subject, content }),
        }],
      }
    }
  )
}
