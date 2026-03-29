import { spawn } from 'child_process'
import type Database from 'better-sqlite3'
import { sendTelegram } from '../providers/telegram.js'

// ─── Event Types ─────────────────────────────────────────────────────────────

type EventType =
  | 'lead_created'
  | 'lead_status_changed'
  | 'email_received'
  | 'email_sent'
  | 'email_opened'
  | 'email_clicked'
  | 'lead_replied'
  | 'sequence_completed'

interface SalesEvent {
  type: EventType
  lead_id?: number
  product_id?: number
  data: Record<string, unknown>
  created_at: string
}

// ─── Lead Score Weights ──────────────────────────────────────────────────────

const SCORE_WEIGHTS: Record<string, number> = {
  email_sent: 1,
  email_opened: 5,
  email_clicked: 15,
  lead_replied: 25,
  sequence_advanced: 2,
  meeting_created: 20,
  website_visited: 3,
}

// Built by Christos Ferlachidis & Daniel Hedenberg

// ─── Event Handlers ──────────────────────────────────────────────────────────

type Handler = (event: SalesEvent, db: Database.Database) => Promise<void>

const handlers: Record<EventType, Handler[]> = {
  lead_created: [triggerScoutResearch, updateLeadScore],
  lead_status_changed: [updateLeadScore],
  email_received: [checkIfLeadReply, updateLeadScore],
  email_sent: [updateLeadScore],
  email_opened: [updateLeadScore, triggerOutreachFollowup],
  email_clicked: [updateLeadScore, triggerCloserPrepare],
  lead_replied: [updateLeadScore, pauseSequence, notifyTeam],
  sequence_completed: [triggerCloserPrepare],
}

// ─── Score System ────────────────────────────────────────────────────────────

async function updateLeadScore(event: SalesEvent, db: Database.Database): Promise<void> {
  if (!event.lead_id) return

  const weight = SCORE_WEIGHTS[event.type] || 1

  // Add score column if missing
  try {
    db.prepare('ALTER TABLE leads ADD COLUMN score INTEGER DEFAULT 0').run()
  } catch { /* already exists */ }

  db.prepare('UPDATE leads SET score = COALESCE(score, 0) + ? WHERE id = ?').run(weight, event.lead_id)

  // Auto-advance status based on score
  const lead = db.prepare('SELECT id, status, score FROM leads WHERE id = ?').get(event.lead_id) as {
    id: number; status: string; score: number
  } | undefined
  if (!lead) return

  const score = lead.score || 0
  let newStatus = lead.status

  if (score >= 50 && lead.status === 'contacted') newStatus = 'qualified'
  else if (score >= 20 && lead.status === 'new') newStatus = 'contacted'
  else if (score >= 80 && lead.status === 'qualified') newStatus = 'nurturing'

  if (newStatus !== lead.status) {
    db.prepare('UPDATE leads SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newStatus, lead.id)
    db.prepare(
      `INSERT INTO activity_log (product_id, lead_id, action, details, created_at) VALUES (?, ?, 'auto_status_change', ?, datetime('now'))`
    ).run(event.product_id || null, lead.id, JSON.stringify({ from: lead.status, to: newStatus, score }))

    console.log(`[event-bus] Lead ${lead.id} auto-advanced: ${lead.status} → ${newStatus} (score: ${score})`)
  }
}

// ─── Scout Research Trigger ──────────────────────────────────────────────────

async function triggerScoutResearch(event: SalesEvent, db: Database.Database): Promise<void> {
  if (!event.lead_id) return

  const lead = db.prepare(
    'SELECT id, email, name, company, notes FROM leads WHERE id = ?'
  ).get(event.lead_id) as { id: number; email: string; name: string | null; company: string | null; notes: string | null } | undefined
  if (!lead) return

  // Extract domain from email
  const domain = lead.email.split('@')[1]
  if (!domain || domain === 'gmail.com' || domain === 'hotmail.com' || domain === 'outlook.com' || domain === 'proton.me' || domain === 'yahoo.com') {
    // Personal email — can't research company website
    return
  }

  console.log(`[event-bus] Scout researching ${domain} for lead ${lead.email}`)

  try {
    // Fetch their website
    const res = await fetch(`https://${domain}`, {
      headers: { 'User-Agent': 'SalesMCP-Scout/1.0' },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    })

    if (!res.ok) return

    const html = await res.text()

    // Extract useful info
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || ''
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 1000)

    // Detect tech stack
    const usesWordPress = html.includes('wp-content') || html.includes('wordpress')
    const usesWoo = html.includes('woocommerce') || html.includes('wc-')
    const techStack: string[] = []
    if (usesWordPress) techStack.push('WordPress')
    if (usesWoo) techStack.push('WooCommerce')
    if (html.includes('shopify')) techStack.push('Shopify')
    if (html.includes('next') || html.includes('_next')) techStack.push('Next.js')
    if (html.includes('react')) techStack.push('React')

    // Store research
    db.prepare(
      `INSERT INTO agent_research (agent_role, topic, findings, source_url, created_at)
       VALUES ('scout', ?, ?, ?, datetime('now'))`
    ).run(
      `Lead research: ${lead.email}`,
      JSON.stringify({
        domain,
        title,
        summary: text.substring(0, 500),
        tech_stack: techStack,
        uses_wordpress: usesWordPress,
        uses_woocommerce: usesWoo,
        lead_id: lead.id,
      }),
      `https://${domain}`
    )

    // Update lead notes with research
    const researchNote = `[Scout] ${title}. Tech: ${techStack.join(', ') || 'unknown'}. WordPress: ${usesWordPress ? 'JA' : 'nej'}.`
    const existingNotes = lead.notes || ''
    const newNotes = existingNotes ? `${existingNotes}\n${researchNote}` : researchNote

    db.prepare('UPDATE leads SET notes = ?, company = COALESCE(company, ?), updated_at = datetime(\'now\') WHERE id = ?')
      .run(newNotes, title.substring(0, 80) || null, lead.id)

    // Log
    db.prepare(
      `INSERT INTO activity_log (product_id, lead_id, action, details, created_at) VALUES (?, ?, 'scout_research', ?, datetime('now'))`
    ).run(event.product_id || null, lead.id, JSON.stringify({ domain, title, tech_stack: techStack, uses_wordpress: usesWordPress }))

    // Telegram if they use WordPress (hot lead for WPilot!)
    if (usesWordPress) {
      sendTelegram(
        `🔍 <b>Scout: WordPress-sajt hittad!</b>\n\n` +
        `Lead: ${lead.email}\n` +
        `Sajt: ${domain}\n` +
        `Tech: ${techStack.join(', ')}\n` +
        `Titel: ${title.substring(0, 60)}\n\n` +
        `⭐ Potentiell WPilot-kund!`
      ).catch(() => {})
    }

    console.log(`[event-bus] Scout done: ${domain} — WordPress: ${usesWordPress}, Tech: ${techStack.join(',')}`)

  } catch (err) {
    console.error(`[event-bus] Scout research failed for ${domain}:`, (err as Error).message)
  }
}

// ─── Outreach Follow-up Trigger ──────────────────────────────────────────────

async function triggerOutreachFollowup(event: SalesEvent, db: Database.Database): Promise<void> {
  if (!event.lead_id) return

  // Create a recommendation for follow-up when email is opened
  const lead = db.prepare('SELECT email, name FROM leads WHERE id = ?').get(event.lead_id) as { email: string; name: string | null } | undefined
  if (!lead) return

  // Check if we already recommended this recently
  const recent = db.prepare(
    `SELECT id FROM recommendations WHERE agent_role = 'outreach' AND title LIKE ? AND created_at > datetime('now', '-1 day') LIMIT 1`
  ).get(`%${lead.email}%`) as { id: number } | undefined
  if (recent) return

  db.prepare(
    `INSERT INTO recommendations (product_id, agent_role, priority, title, description, action_type, action_data, status, created_at)
     VALUES (?, 'outreach', 'high', ?, ?, 'send_email', ?, 'pending', datetime('now'))`
  ).run(
    event.product_id || null,
    `Följ upp ${lead.name || lead.email} — öppnade mejl`,
    `${lead.name || lead.email} har öppnat ditt mejl. Skicka en uppföljning inom 24h medan intresset är varmt.`,
    JSON.stringify({ to: lead.email, reason: 'email_opened' })
  )
}

// ─── Closer Prepare Trigger ──────────────────────────────────────────────────

async function triggerCloserPrepare(event: SalesEvent, db: Database.Database): Promise<void> {
  if (!event.lead_id) return

  const lead = db.prepare('SELECT email, name, company, notes FROM leads WHERE id = ?').get(event.lead_id) as {
    email: string; name: string | null; company: string | null; notes: string | null
  } | undefined
  if (!lead) return

  db.prepare(
    `INSERT INTO recommendations (product_id, agent_role, priority, title, description, action_type, status, created_at)
     VALUES (?, 'closer', 'high', ?, ?, NULL, 'pending', datetime('now'))`
  ).run(
    event.product_id || null,
    `Förbered deal: ${lead.name || lead.email}`,
    `Lead har visat starkt intresse (klick/sequence klar). Research: ${(lead.notes || '').substring(0, 200)}. Förbered personligt erbjudande.`
  )
}

// ─── Reply Detection ─────────────────────────────────────────────────────────

async function checkIfLeadReply(event: SalesEvent, db: Database.Database): Promise<void> {
  const from = event.data.from as string | undefined
  if (!from) return

  const lead = db.prepare('SELECT id, product_id FROM leads WHERE email = ?').get(from) as { id: number; product_id: number | null } | undefined
  if (!lead) return

  // This is a reply from an existing lead!
  await emit(db, {
    type: 'lead_replied',
    lead_id: lead.id,
    product_id: lead.product_id || undefined,
    data: event.data,
    created_at: new Date().toISOString(),
  })
}

// ─── Pause Sequence on Reply ─────────────────────────────────────────────────

async function pauseSequence(event: SalesEvent, db: Database.Database): Promise<void> {
  if (!event.lead_id) return

  const lead = db.prepare('SELECT sequence_id FROM leads WHERE id = ?').get(event.lead_id) as { sequence_id: number | null } | undefined
  if (!lead?.sequence_id) return

  db.prepare('UPDATE leads SET sequence_paused = 1, updated_at = datetime(\'now\') WHERE id = ?').run(event.lead_id)
  console.log(`[event-bus] Paused sequence for lead ${event.lead_id} — they replied`)
}

// ─── Notify Team ─────────────────────────────────────────────────────────────

async function notifyTeam(event: SalesEvent, db: Database.Database): Promise<void> {
  if (!event.lead_id) return

  const lead = db.prepare('SELECT email, name FROM leads WHERE id = ?').get(event.lead_id) as { email: string; name: string | null } | undefined
  if (!lead) return

  sendTelegram(
    `🔥 <b>Lead svarade!</b>\n\n` +
    `${lead.name || lead.email} har svarat på ett mejl.\n` +
    `Sequence pausad automatiskt.\n` +
    `Följ upp personligt!`
  ).catch(() => {})
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function emit(db: Database.Database, event: SalesEvent): Promise<void> {
  const eventHandlers = handlers[event.type]
  if (!eventHandlers) return

  for (const handler of eventHandlers) {
    try {
      await handler(event, db)
    } catch (err) {
      console.error(`[event-bus] Handler failed for ${event.type}:`, (err as Error).message)
    }
  }
}

// ─── Activity Log Watcher ────────────────────────────────────────────────────
// Watches activity_log for new entries and emits corresponding events

let watchHandle: ReturnType<typeof setInterval> | null = null
let lastActivityId = 0

export function startEventBus(db: Database.Database): void {
  if (watchHandle) return

  // Get current max activity ID as baseline
  const max = db.prepare('SELECT MAX(id) as m FROM activity_log').get() as { m: number | null }
  lastActivityId = max?.m || 0

  console.log(`[event-bus] Starting — watching activity_log from ID ${lastActivityId}`)

  // Check every 30 seconds for new activities
  watchHandle = setInterval(async () => {
    try {
      const newActivities = db.prepare(
        `SELECT id, product_id, lead_id, action, details FROM activity_log WHERE id > ? ORDER BY id ASC LIMIT 20`
      ).all(lastActivityId) as { id: number; product_id: number | null; lead_id: number | null; action: string; details: string | null }[]

      for (const a of newActivities) {
        lastActivityId = a.id

        let data: Record<string, unknown> = {}
        try { data = JSON.parse(a.details || '{}') } catch { /* skip */ }

        const eventMap: Record<string, EventType> = {
          lead_created: 'lead_created',
          email_received: 'email_received',
          email_sent: 'email_sent',
          sequence_email_sent: 'email_sent',
          sequence_completed: 'sequence_completed',
        }

        const eventType = eventMap[a.action]
        if (eventType) {
          await emit(db, {
            type: eventType,
            lead_id: a.lead_id || undefined,
            product_id: a.product_id || undefined,
            data,
            created_at: new Date().toISOString(),
          })
        }
      }
    } catch (err) {
      console.error('[event-bus] Watch failed:', (err as Error).message)
    }
  }, 30000)
}

export function stopEventBus(): void {
  if (watchHandle) {
    clearInterval(watchHandle)
    watchHandle = null
    console.log('[event-bus] Stopped')
  }
}
