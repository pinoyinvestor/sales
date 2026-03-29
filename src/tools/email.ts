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
      template_id:   z.number().optional().describe('Template ID used (for A/B tracking)'),
      variant:       z.string().optional().describe('A/B variant name (for tracking)'),
    },
    async (params) => {
      // 1a. GDPR — check for unsubscribe
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

      // 1b. Opt-out check — respect leads who declined
      const lead = db
        .prepare<[string], { id: number; opted_out: number; response_status: string | null; last_emailed_at: string | null } | undefined>(
          "SELECT id, opted_out, response_status, last_emailed_at FROM leads WHERE email = ?",
        )
        .get(params.to)

      if (lead?.opted_out || lead?.response_status === 'declined') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              sent:  false,
              error: `${params.to} has opted out or declined — email blocked. Respecting their decision.`,
            }),
          }],
        }
      }

      // 1c. 6-month cooldown — don't email same person within 6 months
      if (lead?.last_emailed_at) {
        const lastEmailed = new Date(lead.last_emailed_at)
        const sixMonthsAgo = new Date()
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
        if (lastEmailed > sixMonthsAgo && lead.response_status === 'none') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                sent:  false,
                error: `${params.to} was emailed on ${lead.last_emailed_at} — 6-month cooldown active. Next allowed: ${new Date(lastEmailed.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}`,
              }),
            }],
          }
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

      // 5. Send + log result
      let result: { messageId: string }
      try {
        result = await emailProvider.sendEmail({
          to:      params.to,
          subject: params.subject,
          html,
          headers: {
            'List-Unsubscribe': `<${unsubLink}>`,
          },
        })

        // Log success (with A/B tracking)
        db.prepare(
          `INSERT INTO email_log (lead_id, to_email, subject, status, message_id, template_id, variant, created_at)
           VALUES (?, ?, ?, 'sent', ?, ?, ?, datetime('now'))`,
        ).run(lead?.id ?? params.lead_id ?? null, params.to, params.subject, result.messageId, params.template_id ?? null, params.variant ?? null)

      } catch (sendError: any) {
        // Log failure
        db.prepare(
          `INSERT INTO email_log (lead_id, to_email, subject, status, error_message, created_at)
           VALUES (?, ?, ?, 'failed', ?, datetime('now'))`,
        ).run(lead?.id ?? params.lead_id ?? null, params.to, params.subject, sendError?.message ?? 'Unknown error')

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              sent:  false,
              error: `Failed to send to ${params.to}: ${sendError?.message ?? 'Unknown error'}`,
            }),
          }],
        }
      }

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

      // 8. Update last_emailed_at on lead
      if (lead) {
        db.prepare('UPDATE leads SET last_emailed_at = datetime("now"), last_contacted_at = datetime("now"), updated_at = datetime("now") WHERE id = ?').run(lead.id)
      } else if (params.lead_id) {
        db.prepare('UPDATE leads SET last_emailed_at = datetime("now"), last_contacted_at = datetime("now"), updated_at = datetime("now") WHERE id = ?').run(params.lead_id)
      }

      // 9. Log activity
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

  // ── Tool 4: get_email_log ───────────────────────────────────────────────

  server.tool(
    'get_email_log',
    'View email send history — see sent, failed, bounced, and blocked emails. Use this to check delivery status and find problems.',
    {
      status:  z.enum(['all', 'sent', 'failed', 'bounced', 'blocked']).optional().default('all').describe('Filter by status'),
      limit:   z.number().optional().default(50).describe('Max results'),
      email:   z.string().optional().describe('Filter by recipient email'),
    },
    async (params) => {
      let query = 'SELECT el.*, l.name as lead_name, l.company FROM email_log el LEFT JOIN leads l ON el.lead_id = l.id'
      const conditions: string[] = []
      const values: any[] = []

      if (params.status !== 'all') {
        conditions.push('el.status = ?')
        values.push(params.status)
      }
      if (params.email) {
        conditions.push('el.to_email = ?')
        values.push(params.email)
      }

      if (conditions.length) query += ' WHERE ' + conditions.join(' AND ')
      query += ' ORDER BY el.created_at DESC LIMIT ?'
      values.push(params.limit)

      const rows = db.prepare(query).all(...values)

      const summary = {
        total: rows.length,
        sent: rows.filter((r: any) => r.status === 'sent').length,
        failed: rows.filter((r: any) => r.status === 'failed').length,
        bounced: rows.filter((r: any) => r.status === 'bounced').length,
        blocked: rows.filter((r: any) => r.status === 'blocked').length,
        entries: rows,
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      }
    },
  )
}
