// Agent Scheduler — Autonomous cron-like tasks for the Sales MCP system
// Runs periodic agent tasks automatically without human intervention

import type Database from 'better-sqlite3'
import type { SalesConfig } from '../utils/config.js'
import { sendTelegram } from '../providers/telegram.js'

// ─── Interval Handles ────────────────────────────────────────────────────────

let scoutHandle: ReturnType<typeof setInterval> | null = null
let outreachHandle: ReturnType<typeof setInterval> | null = null
let keeperHandle: ReturnType<typeof setInterval> | null = null
let statsHandle: ReturnType<typeof setInterval> | null = null

// ─── Constants ───────────────────────────────────────────────────────────────

const SIX_HOURS    = 6 * 60 * 60 * 1000
const TWO_HOURS    = 2 * 60 * 60 * 1000
const TWELVE_HOURS = 12 * 60 * 60 * 1000
const TWENTY_FOUR  = 24 * 60 * 60 * 1000

// Built by Christos Ferlachidis & Daniel Hedenberg

// ─── Scout Auto-Research (every 6h) ──────────────────────────────────────────

function runScout(db: Database.Database): void {
  try {
    const now = new Date().toISOString()

    const row = db.prepare<[], { cnt: number }>(
      `SELECT COUNT(*) as cnt FROM leads WHERE status = 'new' AND tags LIKE '%wordpress%'`
    ).get()

    const count = row?.cnt ?? 0

    if (count < 50) {
      const message = `Scout: Need more WordPress leads — run research (currently ${count}/50)`

      db.prepare(
        `INSERT INTO activity_log (product_id, lead_id, channel_id, action, details, created_at)
         VALUES (NULL, NULL, NULL, 'agent_auto_task', ?, ?)`
      ).run(JSON.stringify({ agent: 'scout', recommendation: message, wp_lead_count: count }), now)

      db.prepare(
        `INSERT INTO recommendations (product_id, agent_role, priority, title, description, action_type, action_data, status, created_at)
         VALUES (NULL, 'scout', 'medium', ?, ?, 'research', ?, 'pending', ?)`
      ).run(
        'WordPress lead pool running low',
        message,
        JSON.stringify({ current_count: count, target: 50, tag: 'wordpress' }),
        now
      )

      console.log(`[agent-scheduler] Scout: ${count} WordPress leads — recommendation created`)
    } else {
      console.log(`[agent-scheduler] Scout: ${count} WordPress leads — sufficient`)
    }
  } catch (err) {
    console.error('[agent-scheduler] Scout error:', (err as Error).message)
  }
}

// ─── Outreach Check (every 2h) ──────────────────────────────────────────────

function runOutreachCheck(db: Database.Database): void {
  try {
    const now = new Date().toISOString()
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

    const staleLeads = db.prepare<[], { id: number; name: string | null; email: string; last_contacted_at: string | null; status: string }>(
      `SELECT id, name, email, last_contacted_at, status FROM leads
       WHERE (status = 'qualified' OR response_status = 'interested')
         AND last_contacted_at IS NOT NULL
         AND last_contacted_at < ?
       ORDER BY last_contacted_at ASC
       LIMIT 20`
    ).all(cutoff)

    if (staleLeads.length === 0) {
      console.log('[agent-scheduler] Outreach: No stale follow-ups found')
      return
    }

    for (const lead of staleLeads) {
      const lastContact = lead.last_contacted_at ? new Date(lead.last_contacted_at) : null
      const daysSince = lastContact
        ? Math.floor((Date.now() - lastContact.getTime()) / (24 * 60 * 60 * 1000))
        : 0
      const displayName = lead.name || lead.email

      const message = `Outreach: Follow up with ${displayName} — interested but no reply in ${daysSince} days`

      db.prepare(
        `INSERT INTO recommendations (product_id, agent_role, priority, title, description, action_type, action_data, status, created_at)
         VALUES (NULL, 'outreach', 'high', ?, ?, 'follow_up', ?, 'pending', ?)`
      ).run(
        `Follow up: ${displayName}`,
        message,
        JSON.stringify({ lead_id: lead.id, email: lead.email, days_since: daysSince }),
        now
      )

      db.prepare(
        `INSERT INTO activity_log (product_id, lead_id, channel_id, action, details, created_at)
         VALUES (NULL, ?, NULL, 'agent_auto_task', ?, ?)`
      ).run(lead.id, JSON.stringify({ agent: 'outreach', recommendation: message }), now)
    }

    console.log(`[agent-scheduler] Outreach: Created ${staleLeads.length} follow-up recommendation(s)`)
  } catch (err) {
    console.error('[agent-scheduler] Outreach error:', (err as Error).message)
  }
}

// ─── Keeper Cleanup (every 24h) ─────────────────────────────────────────────

function runKeeperCleanup(db: Database.Database): void {
  try {
    const now = new Date().toISOString()
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

    // Mark leads contacted 14+ days ago with no response
    const noResponseResult = db.prepare(
      `UPDATE leads SET status = 'no_response', updated_at = ?
       WHERE last_contacted_at IS NOT NULL
         AND last_contacted_at < ?
         AND (response_status IS NULL OR response_status = 'none')
         AND status NOT IN ('converted', 'no_response', 'bounced', 'unsubscribed')`
    ).run(now, fourteenDaysAgo)

    const noResponseCount = noResponseResult.changes

    // Ensure bounced leads are not in active sequences
    const bouncedResult = db.prepare(
      `UPDATE leads SET sequence_id = NULL, sequence_step = 0, sequence_paused = 1, updated_at = ?
       WHERE status = 'bounced'
         AND (sequence_id IS NOT NULL OR sequence_paused = 0)`
    ).run(now)

    const bouncedCleaned = bouncedResult.changes

    // Log summary
    const summary = {
      agent: 'keeper',
      no_response_updated: noResponseCount,
      bounced_cleaned: bouncedCleaned,
      run_at: now,
    }

    db.prepare(
      `INSERT INTO activity_log (product_id, lead_id, channel_id, action, details, created_at)
       VALUES (NULL, NULL, NULL, 'agent_auto_task', ?, ?)`
    ).run(JSON.stringify(summary), now)

    console.log(`[agent-scheduler] Keeper: ${noResponseCount} marked no_response, ${bouncedCleaned} bounced cleaned from sequences`)
  } catch (err) {
    console.error('[agent-scheduler] Keeper error:', (err as Error).message)
  }
}

// ─── Stats Reporter (every 12h) ─────────────────────────────────────────────

async function runStatsReporter(db: Database.Database): Promise<void> {
  try {
    const now = new Date().toISOString()

    const total = db.prepare<[], { cnt: number }>(`SELECT COUNT(*) as cnt FROM leads`).get()?.cnt ?? 0
    const wordpress = db.prepare<[], { cnt: number }>(`SELECT COUNT(*) as cnt FROM leads WHERE tags LIKE '%wordpress%'`).get()?.cnt ?? 0
    const contacted = db.prepare<[], { cnt: number }>(`SELECT COUNT(*) as cnt FROM leads WHERE last_contacted_at IS NOT NULL`).get()?.cnt ?? 0
    const interested = db.prepare<[], { cnt: number }>(`SELECT COUNT(*) as cnt FROM leads WHERE response_status = 'interested'`).get()?.cnt ?? 0
    const converted = db.prepare<[], { cnt: number }>(`SELECT COUNT(*) as cnt FROM leads WHERE status = 'converted'`).get()?.cnt ?? 0
    const bounced = db.prepare<[], { cnt: number }>(`SELECT COUNT(*) as cnt FROM leads WHERE status = 'bounced'`).get()?.cnt ?? 0
    const responseRate = contacted > 0
      ? Math.round(((interested + converted) / contacted) * 100)
      : 0

    const stats = {
      total,
      wordpress,
      contacted,
      interested,
      converted,
      bounced,
      response_rate: responseRate,
      generated_at: now,
    }

    db.prepare(
      `INSERT INTO activity_log (product_id, lead_id, channel_id, action, details, created_at)
       VALUES (NULL, NULL, NULL, 'daily_stats', ?, ?)`
    ).run(JSON.stringify(stats), now)

    // Send Telegram summary
    const telegramMsg = [
      '<b>Sales MCP Stats</b>',
      '',
      `Total leads: <b>${total}</b>`,
      `WordPress: <b>${wordpress}</b>`,
      `Contacted: <b>${contacted}</b>`,
      `Interested: <b>${interested}</b>`,
      `Converted: <b>${converted}</b>`,
      `Bounced: <b>${bounced}</b>`,
      `Response rate: <b>${responseRate}%</b>`,
    ].join('\n')

    await sendTelegram(telegramMsg)

    console.log(`[agent-scheduler] Stats: ${total} total, ${wordpress} WP, ${responseRate}% response rate`)
  } catch (err) {
    console.error('[agent-scheduler] Stats error:', (err as Error).message)
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function startAgentScheduler(db: Database.Database, _config: SalesConfig): void {
  if (scoutHandle || outreachHandle || keeperHandle || statsHandle) {
    console.warn('[agent-scheduler] Already running')
    return
  }

  console.log('[agent-scheduler] Starting autonomous agent tasks')

  // Run all immediately on start
  runScout(db)
  runOutreachCheck(db)
  runKeeperCleanup(db)
  runStatsReporter(db).catch((err) => {
    console.error('[agent-scheduler] Initial stats run failed:', (err as Error).message)
  })

  // Schedule recurring intervals
  scoutHandle = setInterval(() => runScout(db), SIX_HOURS)
  outreachHandle = setInterval(() => runOutreachCheck(db), TWO_HOURS)
  keeperHandle = setInterval(() => runKeeperCleanup(db), TWENTY_FOUR)
  statsHandle = setInterval(() => {
    runStatsReporter(db).catch((err) => {
      console.error('[agent-scheduler] Stats cycle failed:', (err as Error).message)
    })
  }, TWELVE_HOURS)

  console.log('[agent-scheduler] Scheduled: Scout (6h), Outreach (2h), Keeper (24h), Stats (12h)')
}

export function stopAgentScheduler(): void {
  if (scoutHandle) { clearInterval(scoutHandle); scoutHandle = null }
  if (outreachHandle) { clearInterval(outreachHandle); outreachHandle = null }
  if (keeperHandle) { clearInterval(keeperHandle); keeperHandle = null }
  if (statsHandle) { clearInterval(statsHandle); statsHandle = null }
  console.log('[agent-scheduler] Stopped')
}
