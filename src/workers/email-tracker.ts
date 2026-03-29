import { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { emit } from './event-bus.js'
import { randomUUID } from 'crypto'

// ─── Tracking ID Generator ──────────────────────────────────────────────────

export function generateTrackingId(): string {
  return randomUUID().replace(/-/g, '')
}

// Built by Christos Ferlachidis & Daniel Hedenberg

// ─── Inject Tracking into HTML ───────────────────────────────────────────────

export function injectTracking(
  html: string,
  trackingId: string,
  baseUrl: string
): string {
  // 1. Add open tracking pixel (1x1 transparent GIF)
  const pixel = `<img src="${baseUrl}/track/${trackingId}/open" width="1" height="1" style="display:none" alt="" />`
  const tracked = html.includes('</body>')
    ? html.replace('</body>', `${pixel}</body>`)
    : html + pixel

  // 2. Wrap links for click tracking
  const linkRegex = /href="(https?:\/\/[^"]+)"/gi
  let match: RegExpExecArray | null
  let result = tracked
  const replacements: [string, string][] = []

  while ((match = linkRegex.exec(tracked)) !== null) {
    const originalUrl = match[1]
    if (originalUrl.includes('unsubscribe')) continue
    const trackedUrl = `${baseUrl}/track/${trackingId}/click?url=${encodeURIComponent(originalUrl)}`
    replacements.push([`href="${originalUrl}"`, `href="${trackedUrl}"`])
  }

  for (const [from, to] of replacements) {
    result = result.replace(from, to)
  }

  return result
}

// ─── Tracking Routes (add to Hono app) ──────────────────────────────────────

export function createTrackingRoutes(db: Database.Database): Hono {
  const app = new Hono()

  // Open tracking pixel
  app.get('/track/:id/open', async (c) => {
    const trackingId = c.req.param('id')

    const existing = db.prepare(
      "SELECT id, lead_id FROM email_tracking WHERE tracking_id = ? AND type = 'sent'"
    ).get(trackingId) as { id: number; lead_id: number | null } | undefined

    if (existing) {
      db.prepare(
        "UPDATE email_tracking SET triggered_at = COALESCE(triggered_at, datetime('now')) WHERE tracking_id = ? AND type = 'sent'"
      ).run(trackingId)

      try {
        db.prepare(
          "INSERT INTO email_tracking (lead_id, tracking_id, type, created_at) VALUES (?, ?, 'open', datetime('now'))"
        ).run(existing.lead_id, trackingId + '-open')
      } catch { /* duplicate */ }

      db.prepare(
        "INSERT INTO activity_log (lead_id, action, details, created_at) VALUES (?, 'email_opened', ?, datetime('now'))"
      ).run(existing.lead_id, JSON.stringify({ tracking_id: trackingId }))

      if (existing.lead_id) {
        emit(db, {
          type: 'email_opened',
          lead_id: existing.lead_id,
          data: { tracking_id: trackingId },
          created_at: new Date().toISOString(),
        }).catch(() => {})
      }
    }

    // Return 1x1 transparent GIF
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    return new Response(gif, {
      headers: {
        'Content-Type': 'image/gif',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    })
  })

  // Click tracking redirect
  app.get('/track/:id/click', async (c) => {
    const trackingId = c.req.param('id')
    const url = c.req.query('url')

    if (!url) return c.text('Missing URL', 400)

    const existing = db.prepare(
      "SELECT lead_id FROM email_tracking WHERE tracking_id = ? AND type = 'sent'"
    ).get(trackingId) as { lead_id: number | null } | undefined

    if (existing) {
      try {
        db.prepare(
          "INSERT INTO email_tracking (lead_id, tracking_id, type, url, triggered_at, created_at) VALUES (?, ?, 'click', ?, datetime('now'), datetime('now'))"
        ).run(existing.lead_id, trackingId + '-click-' + Date.now(), url)
      } catch { /* ok */ }

      db.prepare(
        "INSERT INTO activity_log (lead_id, action, details, created_at) VALUES (?, 'email_clicked', ?, datetime('now'))"
      ).run(existing.lead_id, JSON.stringify({ tracking_id: trackingId, url }))

      if (existing.lead_id) {
        emit(db, {
          type: 'email_clicked',
          lead_id: existing.lead_id,
          data: { tracking_id: trackingId, url },
          created_at: new Date().toISOString(),
        }).catch(() => {})
      }
    }

    return c.redirect(url, 302)
  })

  return app
}
