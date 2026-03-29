import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import Database from 'better-sqlite3'

// Built by Christos Ferlachidis & Daniel Hedenberg

interface WPDetectResult {
  url: string
  is_wordpress: boolean
  has_woocommerce: boolean
  theme: string | null
  plugins: string[]
  wp_version: string | null
  has_contact_email: string | null
  site_title: string | null
  score: number
  reason: string
}

async function detectWordPress(url: string): Promise<WPDetectResult> {
  const result: WPDetectResult = {
    url,
    is_wordpress: false,
    has_woocommerce: false,
    theme: null,
    plugins: [],
    wp_version: null,
    has_contact_email: null,
    site_title: null,
    score: 0,
    reason: '',
  }

  try {
    // Normalize URL
    if (!url.startsWith('http')) url = 'https://' + url
    const baseUrl = url.replace(/\/$/, '')

    // Fetch homepage
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    const res = await fetch(baseUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WPilot-Scout/1.0)' },
      redirect: 'follow',
    })
    clearTimeout(timeout)

    if (!res.ok) {
      result.reason = `HTTP ${res.status}`
      return result
    }

    const html = await res.text()
    const lower = html.toLowerCase()

    // Check for WordPress indicators
    const wpIndicators = [
      { pattern: /wp-content\//i, weight: 3 },
      { pattern: /wp-includes\//i, weight: 3 },
      { pattern: /wp-json/i, weight: 2 },
      { pattern: /<meta[^>]*generator[^>]*wordpress/i, weight: 3 },
      { pattern: /xmlrpc\.php/i, weight: 1 },
      { pattern: /wp-emoji/i, weight: 2 },
      { pattern: /wp-block/i, weight: 2 },
      { pattern: /woocommerce/i, weight: 2 },
    ]

    let wpScore = 0
    for (const ind of wpIndicators) {
      if (ind.pattern.test(html)) wpScore += ind.weight
    }

    result.is_wordpress = wpScore >= 3

    if (!result.is_wordpress) {
      result.reason = 'Not WordPress'
      return result
    }

    // Extract WP version
    const versionMatch = html.match(/<meta[^>]*generator[^>]*WordPress\s*([\d.]+)/i)
    if (versionMatch) result.wp_version = versionMatch[1]

    // Check WooCommerce
    result.has_woocommerce = /woocommerce/i.test(html) || /wc-block/i.test(html) || /product-category/i.test(html)

    // Extract theme
    const themeMatch = html.match(/wp-content\/themes\/([a-zA-Z0-9_-]+)/i)
    if (themeMatch) result.theme = themeMatch[1]

    // Extract plugins from wp-content/plugins/
    const pluginMatches = html.matchAll(/wp-content\/plugins\/([a-zA-Z0-9_-]+)/gi)
    const pluginSet = new Set<string>()
    for (const m of pluginMatches) {
      pluginSet.add(m[1])
    }
    result.plugins = [...pluginSet]

    // Extract site title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    if (titleMatch) result.site_title = titleMatch[1].trim()

    // Look for contact email on page
    const emailMatch = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)
    if (emailMatch) {
      // Filter out generic/system emails
      const real = emailMatch.filter(e =>
        !e.includes('example.com') &&
        !e.includes('wordpress') &&
        !e.includes('woocommerce') &&
        !e.includes('.png') &&
        !e.includes('.jpg')
      )
      if (real.length > 0) result.has_contact_email = real[0]
    }

    // Calculate lead score
    // Higher = better target for WPilot
    let score = 10 // Base: they use WordPress
    if (result.has_woocommerce) score += 20 // WooCommerce = big need
    if (result.plugins.length > 5) score += 10 // Many plugins = complex site
    if (result.plugins.length > 10) score += 10 // Very complex
    if (result.theme === 'starter-theme' || result.theme === 'theme') score += 5 // Custom/basic theme = might need help
    if (result.has_contact_email) score += 5 // We can reach them
    result.score = score
    result.reason = `WordPress detected (score: ${score})`

  } catch (err: any) {
    result.reason = `Error: ${err?.message || 'Unknown'}`
  }

  return result
}

export function registerWordPressDetectTools(server: McpServer, db: Database.Database) {

  // ── Tool: detect_wordpress ────────────────────────────────────────────────

  server.tool(
    'detect_wordpress',
    'Scan a website to check if it runs WordPress, what plugins/theme it uses, and if it has WooCommerce. Use this BEFORE adding a lead to verify they actually use WordPress.',
    {
      url: z.string().describe('Website URL to scan (e.g. "example.com")'),
    },
    async (params) => {
      const result = await detectWordPress(params.url)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    },
  )

  // ── Tool: scan_leads_wordpress ────────────────────────────────────────────

  server.tool(
    'scan_leads_wordpress',
    'Scan existing leads to verify they run WordPress. Updates lead score and tags based on scan results. Use to clean up lead list.',
    {
      status: z.string().optional().default('new').describe('Only scan leads with this status'),
      limit: z.number().optional().default(10).describe('Max leads to scan (be careful with rate limiting)'),
    },
    async (params) => {
      const leads = db.prepare(`
        SELECT id, email, name, company, notes
        FROM leads
        WHERE status = ? AND email IS NOT NULL
        ORDER BY created_at DESC
        LIMIT ?
      `).all(params.status, params.limit) as any[]

      const results: any[] = []

      for (const lead of leads) {
        // Try to extract domain from email
        const domain = lead.email.split('@')[1]
        if (!domain || domain === 'gmail.com' || domain === 'yahoo.com' || domain === 'hotmail.com' || domain === 'outlook.com' || domain === 'proton.me') {
          results.push({ lead_id: lead.id, email: lead.email, skipped: true, reason: 'Generic email provider' })
          continue
        }

        const scan = await detectWordPress(domain)
        results.push({ lead_id: lead.id, email: lead.email, domain, ...scan })

        // Update lead with scan results
        if (scan.is_wordpress) {
          const tags = ['wordpress']
          if (scan.has_woocommerce) tags.push('woocommerce')
          if (scan.plugins.length > 5) tags.push('complex-site')

          db.prepare('UPDATE leads SET score = ?, tags = ?, notes = COALESCE(notes, "") || ?, updated_at = datetime("now") WHERE id = ?').run(
            scan.score,
            tags.join(','),
            `\n[WP Scan] Theme: ${scan.theme}, Plugins: ${scan.plugins.length}, WooCommerce: ${scan.has_woocommerce}`,
            lead.id,
          )
        } else {
          // Not WordPress — mark as lost
          db.prepare('UPDATE leads SET status = ?, tags = ?, notes = COALESCE(notes, "") || ?, updated_at = datetime("now") WHERE id = ?').run(
            'lost',
            'not-wordpress',
            '\n[WP Scan] Not a WordPress site — removed from outreach',
            lead.id,
          )
        }

        // Small delay to avoid hammering
        await new Promise(r => setTimeout(r, 500))
      }

      const wpCount = results.filter(r => r.is_wordpress).length
      const notWp = results.filter(r => r.is_wordpress === false && !r.skipped).length
      const skipped = results.filter(r => r.skipped).length

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            summary: { scanned: results.length, wordpress: wpCount, not_wordpress: notWp, skipped },
            results,
          }, null, 2),
        }],
      }
    },
  )

  // ── Tool: find_wordpress_sites ────────────────────────────────────────────

  server.tool(
    'find_wordpress_sites',
    'Given a list of domains/URLs, check which ones run WordPress and return only the WordPress ones with their details. Perfect for qualifying leads before import.',
    {
      urls: z.array(z.string()).describe('List of URLs/domains to check'),
    },
    async (params) => {
      const results: WPDetectResult[] = []

      for (const url of params.urls) {
        const scan = await detectWordPress(url)
        results.push(scan)
        await new Promise(r => setTimeout(r, 300))
      }

      const wpSites = results.filter(r => r.is_wordpress)

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            total_checked: results.length,
            wordpress_found: wpSites.length,
            wordpress_sites: wpSites,
            non_wordpress: results.filter(r => !r.is_wordpress).map(r => ({ url: r.url, reason: r.reason })),
          }, null, 2),
        }],
      }
    },
  )
}
