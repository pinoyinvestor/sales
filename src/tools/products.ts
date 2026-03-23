import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import Database from 'better-sqlite3'

interface Product {
  id: number
  name: string
  display_name: string
  description: string | null
  pitch: string | null
  features: string | null
  pricing: string | null
  url: string | null
  language: string | null
  created_at: string
  updated_at: string
}

interface Knowledge {
  id: number
  product_id: number
  type: string
  title: string | null
  content: string
  source_url: string | null
  language: string | null
  created_at: string
  updated_at: string
}

interface Learning {
  id: number
  product_id: number | null
  channel_type: string | null
  category: string
  insight: string
  evidence: string | null
  confidence: number
  created_at: string
  updated_at: string
}

// Built by Weblease

export function registerProductTools(server: McpServer, db: Database.Database): void {
  server.tool(
    'list_products',
    'List all products available in the sales system',
    {},
    async () => {
      const products = db.prepare('SELECT * FROM products ORDER BY name').all() as Product[]
      return {
        content: [{ type: 'text', text: JSON.stringify(products, null, 2) }],
      }
    }
  )

  server.tool(
    'get_product_context',
    'Get full context for a product including knowledge base entries and learnings',
    {
      product: z.string().describe('The product name (slug) to retrieve context for'),
    },
    async ({ product }) => {
      const row = db
        .prepare('SELECT * FROM products WHERE name = ?')
        .get(product) as Product | undefined

      if (!row) {
        return {
          content: [{ type: 'text', text: `Product "${product}" not found.` }],
        }
      }

      const knowledge = db
        .prepare(
          'SELECT * FROM knowledge WHERE product_id = ? ORDER BY type, created_at DESC'
        )
        .all(row.id) as Knowledge[]

      const learnings = db
        .prepare(
          `SELECT * FROM learnings
           WHERE (product_id = ? OR product_id IS NULL)
             AND confidence >= 0.3
           ORDER BY confidence DESC
           LIMIT 10`
        )
        .all(row.id) as Learning[]

      const lines: string[] = []

      lines.push(`## Product: ${row.display_name}`)
      if (row.description) lines.push(row.description)
      lines.push('')
      lines.push(`**Pitch:** ${row.pitch ?? '—'}`)
      lines.push(`**URL:** ${row.url ?? '—'}`)
      lines.push(`**Language:** ${row.language ?? '—'}`)
      lines.push(`**Features:** ${row.features ?? '—'}`)
      lines.push(`**Pricing:** ${row.pricing ?? '—'}`)

      if (knowledge.length > 0) {
        lines.push('')
        lines.push('## Knowledge')
        for (const k of knowledge) {
          lines.push(`### ${k.type}: ${k.title ?? '(untitled)'}`)
          lines.push(k.content)
          if (k.source_url) lines.push(`(source: ${k.source_url})`)
          lines.push('')
        }
      }

      if (learnings.length > 0) {
        lines.push('## Learnings')
        for (const l of learnings) {
          const scope = l.channel_type ?? 'universal'
          lines.push(`- [${l.confidence.toFixed(2)}] ${l.insight} (${scope})`)
        }
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      }
    }
  )
}
