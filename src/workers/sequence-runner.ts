import type Database from 'better-sqlite3'
import type { SalesConfig } from '../utils/config.js'
import { createEmailProvider } from '../providers/email-provider.js'
import { sendTelegram } from '../providers/telegram.js'
import { generateTrackingId, injectTracking } from './email-tracker.js'

// ─── Types ───────────────────────────────────────────────────────────────────

interface SequenceStep {
  order: number
  type: string           // 'email'
  delay_hours: number    // hours to wait after previous step
  template: string       // template name
  // Legacy fields (some sequences use these)
  day?: number
  template_name?: string
  channel_type?: string
}

interface DueLead {
  id: number
  email: string
  name: string | null
  company: string | null
  product_id: number | null
  product_name: string | null
  sequence_id: number
  sequence_step: number
  last_contacted_at: string | null
  sequence_steps: string
}

interface Template {
  id: number
  subject: string | null
  content: string
  language: string
}

// ─── State ───────────────────────────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null

// Built by Christos Ferlachidis & Daniel Hedenberg

// ─── Template Personalization ────────────────────────────────────────────────

function personalize(text: string, lead: DueLead): string {
  return text
    .replace(/\{\{name\}\}/gi, lead.name || 'there')
    .replace(/\{\{company\}\}/gi, lead.company || 'your company')
    .replace(/\{\{email\}\}/gi, lead.email)
    .replace(/\{\{product\}\}/gi, lead.product_name || 'our product')
}

// ─── Process Due Leads ───────────────────────────────────────────────────────

async function processDueLeads(db: Database.Database, config: SalesConfig): Promise<void> {
  // Find leads in active sequences that are due
  const leads = db.prepare(`
    SELECT
      l.id, l.email, l.name, l.company, l.product_id,
      p.display_name AS product_name,
      l.sequence_id, l.sequence_step, l.last_contacted_at,
      s.steps AS sequence_steps
    FROM leads l
    JOIN sequences s ON s.id = l.sequence_id AND s.enabled = 1
    LEFT JOIN products p ON p.id = l.product_id
    WHERE l.sequence_paused = 0
      AND l.status NOT IN ('unsubscribed', 'lost', 'converted')
    ORDER BY l.last_contacted_at ASC
  `).all() as DueLead[]

  if (leads.length === 0) return

  const emailProvider = createEmailProvider(config.email)
  const now = new Date()
  const nowISO = now.toISOString()
  let sent = 0

  for (const lead of leads) {
    let steps: SequenceStep[]
    try {
      steps = JSON.parse(lead.sequence_steps)
    } catch { continue }

    const step = steps[lead.sequence_step]
    if (!step) {
      // Sequence completed — remove from sequence
      db.prepare(
        `UPDATE leads SET sequence_id = NULL, sequence_step = 0, updated_at = ? WHERE id = ?`
      ).run(nowISO, lead.id)
      db.prepare(
        `INSERT INTO activity_log (product_id, lead_id, action, details, created_at) VALUES (?, ?, 'sequence_completed', '{}', ?)`
      ).run(lead.product_id, lead.id, nowISO)
      continue
    }

    // Resolve delay — support both delay_hours and legacy day field
    const delayMs = step.delay_hours !== undefined
      ? step.delay_hours * 60 * 60 * 1000
      : (step.day || 0) * 24 * 60 * 60 * 1000

    // Check timing — is this step due?
    if (lead.last_contacted_at) {
      const lastContact = new Date(lead.last_contacted_at)
      const dueDate = new Date(lastContact.getTime() + delayMs)
      if (now < dueDate) continue
    }
    // If never contacted, first step is always due

    // Resolve template name — support both template and legacy template_name
    const templateName = step.template || step.template_name
    if (!templateName) {
      console.error(`[sequence-runner] No template name in step ${lead.sequence_step} for lead ${lead.email}`)
      continue
    }

    const template = db.prepare(
      `SELECT id, subject, content, language FROM templates WHERE name = ? LIMIT 1`
    ).get(templateName) as Template | undefined

    if (!template) {
      console.error(`[sequence-runner] Template "${templateName}" not found for lead ${lead.email}`)
      continue
    }

    // Send email
    const stepType = step.type || step.channel_type || 'email'
    if (stepType === 'email') {
      try {
        const subject = personalize(template.subject || 'Hello', lead)
        const rawHtml = personalize(template.content, lead)

        // Add email tracking
        const trackingId = generateTrackingId()
        const trackingBase = config.tracking?.base_url?.replace('/track', '') || 'https://weblease.se/api/sales'
        const html = injectTracking(rawHtml, trackingId, trackingBase)

        const result = await emailProvider.sendEmail({
          to: lead.email,
          subject,
          html,
        })

        // Update lead
        const sentAt = new Date().toISOString()
        db.prepare(
          `UPDATE leads SET sequence_step = sequence_step + 1, last_contacted_at = ?, status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END, updated_at = ? WHERE id = ?`
        ).run(sentAt, sentAt, lead.id)

        // Create tracking entry (uses the trackingId generated above)
        db.prepare(
          `INSERT INTO email_tracking (lead_id, tracking_id, type, created_at) VALUES (?, ?, 'sent', ?)`
        ).run(lead.id, trackingId, sentAt)

        // Log activity
        db.prepare(
          `INSERT INTO activity_log (product_id, lead_id, action, details, created_at) VALUES (?, ?, 'sequence_email_sent', ?, ?)`
        ).run(
          lead.product_id, lead.id,
          JSON.stringify({
            step: lead.sequence_step,
            template: templateName,
            subject,
            to: lead.email,
            messageId: result.messageId,
          }),
          sentAt
        )

        sent++
        console.log(`[sequence-runner] Sent step ${lead.sequence_step} to ${lead.email} (${templateName})`)

        // Telegram notification
        sendTelegram(
          `📨 <b>Sequence-mejl skickat</b>\n\n` +
          `Till: ${lead.email}\n` +
          `Steg: ${lead.sequence_step + 1}/${steps.length}\n` +
          `Mall: ${templateName}\n` +
          `Ämne: ${subject}`
        ).catch(() => {})

        // Rate limit — max 1 email per 5 seconds
        await new Promise(r => setTimeout(r, 5000))

      } catch (err) {
        console.error(`[sequence-runner] Failed to send to ${lead.email}:`, (err as Error).message)
        // Pause this lead's sequence on error
        const errAt = new Date().toISOString()
        db.prepare(
          `UPDATE leads SET sequence_paused = 1, updated_at = ? WHERE id = ?`
        ).run(errAt, lead.id)
        db.prepare(
          `INSERT INTO activity_log (product_id, lead_id, action, details, created_at) VALUES (?, ?, 'sequence_error', ?, ?)`
        ).run(lead.product_id, lead.id, JSON.stringify({ error: (err as Error).message }), errAt)
      }
    }
  }

  if (sent > 0) {
    console.log(`[sequence-runner] Sent ${sent} sequence email(s)`)
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function startSequenceRunner(db: Database.Database, config: SalesConfig): void {
  if (intervalHandle) return

  const INTERVAL = 60 * 60 * 1000 // Every hour

  console.log('[sequence-runner] Starting — checking every 1h')

  // First check after 2 minutes
  setTimeout(() => {
    processDueLeads(db, config).catch(err => {
      console.error('[sequence-runner] Initial check failed:', (err as Error).message)
    })
  }, 120000)

  intervalHandle = setInterval(() => {
    processDueLeads(db, config).catch(err => {
      console.error('[sequence-runner] Check failed:', (err as Error).message)
    })
  }, INTERVAL)
}

export function stopSequenceRunner(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
    console.log('[sequence-runner] Stopped')
  }
}
