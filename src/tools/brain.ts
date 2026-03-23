import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import Database from 'better-sqlite3'

// ── Types ──────────────────────────────────────────────────────────────────

interface Product {
  id: number
  name: string
  display_name: string
  url: string | null
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

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveProductId(db: Database.Database, product: string): number | null {
  const row = db.prepare('SELECT id FROM products WHERE name = ?').get(product) as Pick<Product, 'id'> | undefined
  return row ? row.id : null
}

function stripScriptTags(html: string): string {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
}

function stripStyleTags(html: string): string {
  return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
}

function extractText(html: string): string {
  return stripScriptTags(stripStyleTags(html))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? match[1].trim() : ''
}

function extractInternalLinks(html: string, baseUrl: string, maxLinks = 10): string[] {
  const origin = new URL(baseUrl).origin
  const linkRegex = /href="([^"]+)"/gi
  const links: string[] = []
  let match: RegExpExecArray | null

  while ((match = linkRegex.exec(html)) !== null && links.length < maxLinks) {
    const href = match[1]
    if (href.startsWith('/')) {
      links.push(`${origin}${href}`)
    } else if (href.startsWith(origin)) {
      links.push(href)
    }
  }

  return [...new Set(links)]
}

async function fetchPage(url: string): Promise<{ html: string; text: string; title: string }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SalesMCP/1.0 (content-learning bot)' },
    signal: AbortSignal.timeout(10000),
  })
  const html = await res.text()
  return { html, text: extractText(html), title: extractTitle(html) }
}

// Built by Weblease

// ── Register ───────────────────────────────────────────────────────────────

export function registerBrainTools(server: McpServer, db: Database.Database): void {

  // ── Tool 1: learn_product ────────────────────────────────────────────────

  server.tool(
    'learn_product',
    'Crawl a product website and store all page content in the knowledge base for AI use',
    {
      product: z.string().describe('Product name (slug) to attach knowledge to'),
      url:     z.string().url().describe('Starting URL to crawl (usually the product homepage)'),
    },
    async ({ product, url }) => {
      const productId = resolveProductId(db, product)
      if (productId === null) {
        return { content: [{ type: 'text', text: `Product "${product}" not found.` }] }
      }

      const root = await fetchPage(url)
      const internalLinks = extractInternalLinks(root.html, url, 10)

      db.prepare('DELETE FROM knowledge WHERE product_id = ?').run(productId)

      const insertKnowledge = db.prepare(`
        INSERT INTO knowledge (product_id, type, title, content, source_url)
        VALUES (?, ?, ?, ?, ?)
      `)

      insertKnowledge.run(
        productId,
        'page_content',
        root.title || url,
        root.text.slice(0, 5000),
        url
      )

      let pagesCrawled = 1

      for (const link of internalLinks) {
        try {
          const page = await fetchPage(link)
          insertKnowledge.run(
            productId,
            'page_content',
            page.title || link,
            page.text.slice(0, 5000),
            link
          )
          pagesCrawled++
        } catch {
          // Skip pages that fail to load
        }
      }

      const knowledgeCount = (
        db.prepare('SELECT COUNT(*) as c FROM knowledge WHERE product_id = ?').get(productId) as { c: number }
      ).c

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ pages_crawled: pagesCrawled, knowledge_entries: knowledgeCount }, null, 2),
        }],
      }
    }
  )

  // ── Tool 2: crawl_url ────────────────────────────────────────────────────

  server.tool(
    'crawl_url',
    'Fetch and extract text from any URL without storing it — use for manual inspection',
    {
      url: z.string().url().describe('URL to fetch and extract content from'),
    },
    async ({ url }) => {
      const { html, text, title } = await fetchPage(url)
      const links = extractInternalLinks(html, url, 20)

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ url, title, content: text.slice(0, 10000), links }, null, 2),
        }],
      }
    }
  )

  // ── Tool 3: save_learning ────────────────────────────────────────────────

  server.tool(
    'save_learning',
    'Save or reinforce a marketing/sales insight so the AI learns from past results',
    {
      product:      z.string().optional().describe('Product name — omit for universal learning'),
      channel_type: z.string().optional().describe('Channel type (email, sms, linkedin, etc.)'),
      category:     z.enum(['subject_line', 'content_style', 'timing', 'audience', 'objection', 'cta', 'general'])
                      .describe('Type of insight'),
      insight:      z.string().describe('The learning or pattern observed'),
      evidence:     z.string().optional().describe('Supporting data as JSON string'),
    },
    async ({ product, channel_type, category, insight, evidence }) => {
      const productId = product ? resolveProductId(db, product) : null

      if (product && productId === null) {
        return { content: [{ type: 'text', text: `Product "${product}" not found.` }] }
      }

      const existing = db.prepare(`
        SELECT * FROM learnings
        WHERE (product_id IS ? OR (product_id IS NULL AND ? IS NULL))
          AND (channel_type IS ? OR (channel_type IS NULL AND ? IS NULL))
          AND category = ?
          AND insight = ?
        LIMIT 1
      `).get(
        productId, productId,
        channel_type ?? null, channel_type ?? null,
        category, insight
      ) as Learning | undefined

      let result: Learning

      if (existing) {
        const newConfidence = Math.min(1.0, existing.confidence + 0.1)
        db.prepare(`
          UPDATE learnings
          SET insight = ?, evidence = ?, confidence = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(insight, evidence ?? existing.evidence, newConfidence, existing.id)

        result = db.prepare('SELECT * FROM learnings WHERE id = ?').get(existing.id) as Learning
      } else {
        const info = db.prepare(`
          INSERT INTO learnings (product_id, channel_type, category, insight, evidence, confidence)
          VALUES (?, ?, ?, ?, ?, 0.5)
        `).run(productId, channel_type ?? null, category, insight, evidence ?? null)

        result = db.prepare('SELECT * FROM learnings WHERE id = ?').get(info.lastInsertRowid) as Learning
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    }
  )

  // ── Tool 4: get_learnings ────────────────────────────────────────────────

  server.tool(
    'get_learnings',
    'Retrieve stored learnings filtered by product, channel, category, and minimum confidence',
    {
      product:        z.string().optional().describe('Product name to filter by'),
      channel_type:   z.string().optional().describe('Channel type to filter by'),
      category:       z.string().optional().describe('Category to filter by'),
      min_confidence: z.number().optional().default(0.3).describe('Minimum confidence threshold (default 0.3)'),
    },
    async ({ product, channel_type, category, min_confidence }) => {
      const productId = product ? resolveProductId(db, product) : null

      if (product && productId === null) {
        return { content: [{ type: 'text', text: `Product "${product}" not found.` }] }
      }

      const conditions: string[] = ['confidence >= ?']
      const args: unknown[] = [min_confidence ?? 0.3]

      if (productId !== null) {
        conditions.push('(product_id = ? OR product_id IS NULL)')
        args.push(productId)
      }

      if (channel_type) {
        conditions.push('channel_type = ?')
        args.push(channel_type)
      }

      if (category) {
        conditions.push('category = ?')
        args.push(category)
      }

      const where = `WHERE ${conditions.join(' AND ')}`
      const rows = db.prepare(`
        SELECT * FROM learnings
        ${where}
        ORDER BY confidence DESC
      `).all(...args) as Learning[]

      return {
        content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
      }
    }
  )

  // ── Tool 5: get_knowledge ────────────────────────────────────────────────

  server.tool(
    'get_knowledge',
    'Retrieve stored knowledge base entries for a product',
    {
      product: z.string().describe('Product name to retrieve knowledge for'),
      type:    z.string().optional().describe('Filter by knowledge type (e.g. page_content, faq, feature)'),
    },
    async ({ product, type }) => {
      const productId = resolveProductId(db, product)
      if (productId === null) {
        return { content: [{ type: 'text', text: `Product "${product}" not found.` }] }
      }

      const rows = type
        ? (db.prepare('SELECT * FROM knowledge WHERE product_id = ? AND type = ? ORDER BY created_at DESC').all(productId, type) as Knowledge[])
        : (db.prepare('SELECT * FROM knowledge WHERE product_id = ? ORDER BY type, created_at DESC').all(productId) as Knowledge[])

      return {
        content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
      }
    }
  )
}
