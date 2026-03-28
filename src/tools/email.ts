import { McpServer }            from '@modelcontextprotocol/sdk/server/mcp.js'
import { z }                    from 'zod'
import { createHash }           from 'crypto'
import { v4 as uuidv4 }         from 'uuid'
import Database                 from 'better-sqlite3'
import { createEmailProvider }  from '../providers/email-provider.js'
import { checkRateLimit }       from '../utils/rate-limiter.js'
import type { SalesConfig }     from '../utils/config.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function md5(value: string): string {
  return createHash('md5').update(value.toLowerCase().trim()).digest('hex')
}

function rewriteLinks(html: string, trackingBase: string, trackingId: string): string {
  return html.replace(/href="([^"]+)"/g, (_match, url: string) => {
    // Skip mailto and unsubscribe links
    if (url.startsWith('mailto:') || url.includes('/unsubscribe')) return `href="${url}"`
    const encoded = encodeURIComponent(url)
    return `href="${trackingBase}/${trackingId}/click?url=${encoded}"`
  })
}

// Built by Christos Ferlachidis & Daniel Hedenberg

// ─── Register email MCP tools ─────────────────────────────────────────────────

export function registerEmailTools(
  server:      McpServer,
  db:          Database.Database,
  emailConfig: SalesConfig,
) {
  const emailProvider  = createEmailProvider(emailConfig.email)
  const trackingBase   = emailConfig.tracking.base_url
  const unsubscribeUrl = emailConfig.tracking.unsubscribe_url

  // ── Tool 1: read_emails ───────────────────────────────────────────────────

  server.tool(
    'read_emails',
    'Read emails from the configured IMAP mailbox',
    {
      folder:       z.string().optional().default('INBOX').describe('Mailbox folder to read (default: INBOX)'),
      limit:        z.number().optional().default(20).describe('Maximum number of emails to return (default: 20)'),
      unread_only:  z.boolean().optional().default(false).describe('Only return unread emails'),
      search_query: z.string().optional().describe('IMAP search query string'),
    },
    async (params) => {
      const messages = await emailProvider.readEmails({
        folder:     params.folder,
        limit:      params.limit,
        unreadOnly: params.unread_only,
        search:     params.search_query,
      })

      return {
        content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
      }
    },
  )

  // ── Tool 2: send_email ────────────────────────────────────────────────────

  server.tool(
    'send_email',
    'Send an HTML email with optional open/click tracking and automatic unsubscribe footer',
    {
      to:            z.string().describe('Recipient email address'),
      subject:       z.string().describe('Email subject line'),
      body:          z.string().describe('HTML body of the email'),
      product:       z.string().optional().describe('Product name (used for activity log)'),
      track_opens:   z.boolean().optional().default(false).describe('Inject a 1x1 tracking pixel'),
      track_clicks:  z.boolean().optional().default(false).describe('Rewrite links with click-tracking URLs'),
      lead_id:       z.number().optional().describe('Lead ID to associate with this email'),
    },
    async (params) => {
      // 1. GDPR — check for unsubscribe
      const unsub = db
        .prepare<[string, string], { id: number } | undefined>(
          "SELECT id FROM gdpr_log WHERE email = ? AND action = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(params.to, 'unsubscribe')

      if (unsub) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              sent:  false,
              error: `${params.to} has unsubscribed — email blocked`,
            }),
          }],
        }
      }

      // 2. Rate limit — find the email channel
      const emailChannel = db
        .prepare<[], { id: number; config: string | null } | undefined>(
          "SELECT id, config FROM channels WHERE type = 'email' AND enabled = 1 ORDER BY id ASC LIMIT 1",
        )
        .get()

      if (emailChannel) {
        const rateCheck = checkRateLimit(db, emailChannel.id, emailChannel.config ?? undefined)
        if (!rateCheck.allowed) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                sent:       false,
                error:      rateCheck.reason,
                retryAfter: rateCheck.retryAfter,
              }),
            }],
          }
        }
      }

      // 3. Tracking setup
      const trackingId  = uuidv4()
      const emailHash   = md5(params.to)
      let   html        = params.body

      if (params.track_clicks) {
        html = rewriteLinks(html, trackingBase, trackingId)
      }

      if (params.track_opens) {
        html += `\n<img src="${trackingBase}/${trackingId}/open" width="1" height="1" style="display:none" alt="" />`
      }

      // 4. Unsubscribe footer + header
      const unsubLink = `${unsubscribeUrl}/${emailHash}`
      html += `\n<p style="font-size:11px;color:#999;margin-top:20px;">Vill du inte få fler mail? <a href="${unsubLink}">Avregistrera dig här</a></p>`

      // 5. Send
      const result = await emailProvider.sendEmail({
        to:      params.to,
        subject: params.subject,
        html,
        headers: {
          'List-Unsubscribe': `<${unsubLink}>`,
        },
      })

      // 6. Insert email_tracking rows
      const insertTracking = db.prepare(
        `INSERT INTO email_tracking (lead_id, tracking_id, type, created_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )

      if (params.track_opens) {
        insertTracking.run(params.lead_id ?? null, `${trackingId}:open`, 'open')
      }
      if (params.track_clicks) {
        insertTracking.run(params.lead_id ?? null, `${trackingId}:click`, 'click')
      }

      // 7. Resolve product_id if provided
      let productId: number | null = null
      if (params.product) {
        const prod = db
          .prepare<[string], { id: number } | undefined>('SELECT id FROM products WHERE name = ?')
          .get(params.product)
        productId = prod?.id ?? null
      }

      // 8. Log activity
      db.prepare(
        `INSERT INTO activity_log (product_id, lead_id, channel_id, action, details, created_at)
         VALUES (?, ?, ?, 'email_sent', ?, datetime('now'))`,
      ).run(
        productId,
        params.lead_id ?? null,
        emailChannel?.id ?? null,
        JSON.stringify({ to: params.to, subject: params.subject, messageId: result.messageId, trackingId }),
      )

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ sent: true, messageId: result.messageId, trackingId }),
        }],
      }
    },
  )

  // ── Tool 3: reply_email ───────────────────────────────────────────────────

  server.tool(
    'reply_email',
    'Reply to an existing email by message ID',
    {
      message_id: z.string().describe('Original message ID to reply to (In-Reply-To header)'),
      to:         z.string().describe('Recipient email address of the reply'),
      subject:    z.string().optional().default('').describe('Subject line (will be prefixed with Re: if not already)'),
      body:       z.string().describe('HTML body of the reply'),
      lead_id:    z.number().optional().describe('Lead ID to associate with this reply'),
    },
    async (params) => {
      const result = await emailProvider.replyEmail({
        messageId: params.message_id,
        to:        params.to,
        subject:   params.subject ?? '',
        html:      params.body,
      })

      // Log activity
      const emailChannel = db
        .prepare<[], { id: number } | undefined>(
          "SELECT id FROM channels WHERE type = 'email' AND enabled = 1 ORDER BY id ASC LIMIT 1",
        )
        .get()

      db.prepare(
        `INSERT INTO activity_log (lead_id, channel_id, action, details, created_at)
         VALUES (?, ?, 'email_sent', ?, datetime('now'))`,
      ).run(
        params.lead_id ?? null,
        emailChannel?.id ?? null,
        JSON.stringify({ inReplyTo: params.message_id, messageId: result.messageId }),
      )

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ sent: true, messageId: result.messageId }),
        }],
      }
    },
  )
}
