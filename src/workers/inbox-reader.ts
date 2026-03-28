import { ImapFlow } from 'imapflow'
import type Database from 'better-sqlite3'
import type { SalesConfig } from '../utils/config.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface InboxMessage {
  uid:     number
  from:    string
  subject: string
  snippet: string
  date:    string
}

// ─── Inbox Reader Worker ──────────────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null

async function processNewEmails(db: Database.Database, config: SalesConfig): Promise<void> {
  const imapCfg = config.email.imap

  const client = new ImapFlow({
    host:   imapCfg.host,
    port:   imapCfg.port,
    secure: imapCfg.tls,
    auth: {
      user: config.email.user,
      pass: config.email.pass,
    },
    logger: false,
  })

  // Built by Weblease

  try {
    await client.connect()
    await client.mailboxOpen('INBOX')

    // Search for unseen emails
    const uids = await client.search({ unseen: true } as Parameters<typeof client.search>[0], { uid: true })

    if (uids.length === 0) {
      await client.logout()
      return
    }

    const uidRange = uids.join(',')
    const messages: InboxMessage[] = []

    for await (const msg of client.fetch(uidRange, { envelope: true, source: true, flags: true }, { uid: true })) {
      const envelope = msg.envelope
      const source   = msg.source?.toString('utf-8') ?? ''
      const fromAddr = envelope?.from?.[0]?.address ?? 'unknown'
      const subject  = envelope?.subject ?? '(inget ämne)'
      const date     = envelope?.date?.toISOString() ?? new Date().toISOString()

      // Extract a plain text snippet (first 200 chars of body)
      const bodyMatch = source.match(/\r?\n\r?\n([\s\S]*)/)
      const rawBody   = bodyMatch ? bodyMatch[1] : ''
      const snippet   = rawBody
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200)

      messages.push({ uid: msg.uid, from: fromAddr, subject, snippet, date })
    }

    // Process each message
    const insertActivity = db.prepare(
      `INSERT INTO activity_log (product_id, lead_id, channel_id, action, details, created_at)
       VALUES (NULL, ?, NULL, 'email_received', ?, datetime('now'))`
    )

    const insertRecommendation = db.prepare(
      `INSERT INTO recommendations (product_id, agent_role, priority, title, description, action_type, action_data, status, created_at)
       VALUES (NULL, 'inbox_reader', 'medium', ?, ?, 'create_lead', ?, 'pending', datetime('now'))`
    )

    const updateLastContacted = db.prepare(
      `UPDATE leads SET last_contacted_at = datetime('now'), updated_at = datetime('now') WHERE email = ?`
    )

    const findLead = db.prepare<[string], { id: number } | undefined>(
      `SELECT id FROM leads WHERE email = ? LIMIT 1`
    )

    for (const msg of messages) {
      const lead = findLead.get(msg.from)

      const details = JSON.stringify({
        from:    msg.from,
        subject: msg.subject,
        snippet: msg.snippet,
        date:    msg.date,
      })

      // Store in activity_log
      insertActivity.run(lead?.id ?? null, details)

      if (lead) {
        // Existing lead — update last_contacted_at
        updateLastContacted.run(msg.from)
      } else {
        // Unknown sender — create recommendation
        const title = `Ny email från ${msg.from}`
        const description = `Ny email från ${msg.from} — ämne: ${msg.subject}. Skapa lead?`
        const actionData = JSON.stringify({ email: msg.from, subject: msg.subject })
        insertRecommendation.run(title, description, actionData)
      }

      // Mark as seen
      try {
        await client.messageFlagsAdd({ uid: msg.uid } as unknown as string, ['\\Seen'], { uid: true })
      } catch (flagErr) {
        console.error(`[inbox-reader] Failed to mark UID ${msg.uid} as seen:`, flagErr)
      }
    }

    console.log(`[inbox-reader] Processed ${messages.length} new email(s)`)
    await client.logout()
  } catch (err) {
    console.error('[inbox-reader] Error processing inbox:', (err as Error).message)
    try { await client.logout() } catch { /* already disconnected */ }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startInboxReader(db: Database.Database, config: SalesConfig): void {
  if (intervalHandle) {
    console.warn('[inbox-reader] Already running')
    return
  }

  const INTERVAL_MS = 60_000 // 60 seconds

  console.log('[inbox-reader] Starting — checking every 60s')

  // Run immediately on start
  processNewEmails(db, config).catch((err) => {
    console.error('[inbox-reader] Initial run failed:', (err as Error).message)
  })

  // Then repeat every 60 seconds
  intervalHandle = setInterval(() => {
    processNewEmails(db, config).catch((err) => {
      console.error('[inbox-reader] Cycle failed:', (err as Error).message)
    })
  }, INTERVAL_MS)
}

export function stopInboxReader(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
    console.log('[inbox-reader] Stopped')
  }
}
