import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import type Database from 'better-sqlite3'
import type { SalesConfig } from '../utils/config.js'
import { sendTelegram, formatNewEmail } from '../providers/telegram.js'

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

  // Built by Christos Ferlachidis & Daniel Hedenberg

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
      const fromAddr = envelope?.from?.[0]?.address ?? 'unknown'
      const subject  = envelope?.subject ?? '(inget ämne)'
      const date     = envelope?.date?.toISOString() ?? new Date().toISOString()

      // Parse MIME properly to get clean text
      let snippet = ''
      try {
        const parsed = await simpleParser(msg.source as Buffer)
        snippet = (parsed.text || parsed.html?.replace(/<[^>]+>/g, ' ') || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      } catch {
        // Fallback to raw extraction
        const source = msg.source?.toString('utf-8') ?? ''
        const bodyMatch = source.match(/\r?\n\r?\n([\s\S]*)/)
        snippet = (bodyMatch ? bodyMatch[1] : '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
      }

      messages.push({ uid: msg.uid, from: fromAddr, subject, snippet, date })
    }

    // Process each message
    const now = new Date().toISOString()

    const insertActivity = db.prepare(
      `INSERT INTO activity_log (product_id, lead_id, channel_id, action, details, created_at)
       VALUES (NULL, ?, NULL, 'email_received', ?, ?)`
    )

    const insertRecommendation = db.prepare(
      `INSERT INTO recommendations (product_id, agent_role, priority, title, description, action_type, action_data, status, created_at)
       VALUES (NULL, 'inbox_reader', ?, ?, ?, 'create_lead', ?, 'pending', ?)`
    )

    const findLead = db.prepare<[string], { id: number; name: string | null; status: string; response_status: string | null } | undefined>(
      `SELECT id, name, status, response_status FROM leads WHERE email = ? LIMIT 1`
    )

    // Auto-categorization keywords
    const declineWords = ['no thank', 'not interested', 'unsubscribe', 'remove me', 'stop emailing', 'don\'t contact', 'no longer', 'not running wordpress', 'unfortunately', 'opted out', 'please remove']
    const interestWords = ['interested', 'tell me more', 'sounds good', 'demo', 'try it', 'how does it work', 'pricing', 'let\'s talk', 'schedule', 'show me', 'curious', 'want to test', 'sign me up', 'how much']

    for (const msg of messages) {
      // Skip bounce/system messages
      if (msg.from.includes('MAILER-DAEMON') || msg.from.includes('postmaster@') || msg.from.includes('noreply@')) continue

      const lead = findLead.get(msg.from)
      const details = JSON.stringify({ from: msg.from, subject: msg.subject, snippet: msg.snippet, date: msg.date })

      // Store in activity_log
      insertActivity.run(lead?.id ?? null, details, now)

      if (lead) {
        const text = (msg.subject + ' ' + msg.snippet).toLowerCase()
        const isDecline = declineWords.some(kw => text.includes(kw))
        const isInterest = interestWords.some(kw => text.includes(kw))

        if (isDecline) {
          db.prepare('UPDATE leads SET response_status = ?, last_contacted_at = ?, updated_at = ? WHERE id = ?')
            .run('declined', now, now, lead.id)
          console.log(`[inbox-reader] Auto-declined: ${msg.from}`)
          sendTelegram(`❌ ${lead.name || msg.from} avböjde: "${msg.snippet.substring(0, 80)}"`).catch(() => {})

        } else if (isInterest) {
          db.prepare('UPDATE leads SET response_status = ?, status = ?, last_contacted_at = ?, updated_at = ? WHERE id = ?')
            .run('interested', 'qualified', now, now, lead.id)
          console.log(`[inbox-reader] Auto-interested: ${msg.from}`)
          sendTelegram(`🔥 ${lead.name || msg.from} ÄR INTRESSERAD: "${msg.snippet.substring(0, 80)}"\n\nSvara snabbt!`).catch(() => {})

          // Create high-priority follow-up recommendation
          insertRecommendation.run('high',
            `🔥 ${lead.name || msg.from} visar intresse!`,
            `"${msg.snippet.substring(0, 120)}" — Svara snabbt och personligt!`,
            JSON.stringify({ email: msg.from, lead_id: lead.id, action: 'follow_up' }),
            now
          )

        } else {
          db.prepare('UPDATE leads SET last_contacted_at = ?, updated_at = ? WHERE id = ?')
            .run(now, now, lead.id)
          sendTelegram(`📨 Svar från ${lead.name || msg.from}: "${msg.snippet.substring(0, 100)}"`).catch(() => {})
        }
      } else {
        // Unknown sender
        sendTelegram(formatNewEmail(msg.from, msg.subject)).catch(() => {})
        insertRecommendation.run('medium',
          `Ny email från ${msg.from}`,
          `Ämne: ${msg.subject}. "${msg.snippet.substring(0, 100)}"`,
          JSON.stringify({ email: msg.from, subject: msg.subject }),
          now
        )
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
