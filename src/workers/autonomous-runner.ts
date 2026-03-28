import { spawn } from 'child_process'
import type Database from 'better-sqlite3'
import type { SalesConfig } from '../utils/config.js'

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentJob {
  role: string
  name: string
  team: string
  interval: 'every_6h' | 'every_24h' | 'every_week'
  task: string
}

interface ProductRow {
  id: number
  name: string
  display_name: string
  description: string | null
}

// Built by Christos Ferlachidis & Daniel Hedenberg

// ── Agent Schedule ───────────────────────────────────────────────────────────

const AGENT_JOBS: AgentJob[] = [
  // Every 6 hours
  { role: 'support', name: 'Mila', team: 'customer', interval: 'every_6h',
    task: 'Kolla inbox för nya kundmail. Kategorisera dem. Föreslå svar på de viktigaste. Rapportera mönster (samma fråga flera gånger = behöver bättre docs).' },

  // Every 24 hours
  { role: 'coo', name: 'Sofia', team: 'executive', interval: 'every_24h',
    task: 'Skriv en daglig sammanfattning: vad hände igår, vad ligger i action-kö, vilka leads har uppdaterats, vilka agenter har gjort vad. Max 10 rader.' },
  { role: 'keeper', name: 'Wilma', team: 'customer', interval: 'every_24h',
    task: 'Analysera leads: vilka har inte kontaktats på 7+ dagar? Vilka visar churn-signaler? Föreslå uppföljningsåtgärder.' },
  { role: 'secops', name: 'Axel', team: 'security', interval: 'every_24h',
    task: 'GDPR-check: har alla leads consent? Finns det PII i drafts? Rapportera compliance-status.' },
]

// ── Intervals ────────────────────────────────────────────────────────────────

const INTERVAL_MS: Record<string, number> = {
  every_6h:   6 * 60 * 60 * 1000,
  every_24h: 24 * 60 * 60 * 1000,
  every_week: 7 * 24 * 60 * 60 * 1000,
}

// ── State ────────────────────────────────────────────────────────────────────

const lastRun: Record<string, number> = {}
let intervalHandle: ReturnType<typeof setInterval> | null = null
let running = false

// ── Claude Runner ────────────────────────────────────────────────────────────

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('/home/christaras9126/.local/bin/claude', [
      '-p', prompt, '--max-turns', '1', '--model', 'haiku',
    ], {
      env: { ...process.env, HOME: '/home/christaras9126' },
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    proc.stdin.end()
    let out = '', err = ''
    proc.stdout.on('data', (d: Buffer) => { out += d })
    proc.stderr.on('data', (d: Buffer) => { err += d })
    proc.on('close', (code: number | null) => {
      if (code === 0 && out.trim()) resolve(out.trim())
      else reject(new Error(err || `exit ${code}`))
    })
    proc.on('error', reject)
  })
}

// ── Job Executor ─────────────────────────────────────────────────────────────

async function executeJob(job: AgentJob, db: Database.Database): Promise<void> {
  const key = `${job.role}_${job.interval}`
  const now = Date.now()
  const interval = INTERVAL_MS[job.interval]

  if (lastRun[key] && (now - lastRun[key]) < interval) return

  console.log(`[autonomous] Running ${job.name} (${job.role}) — ${job.task.substring(0, 50)}...`)
  lastRun[key] = now

  // Get agent profile
  const profile = db.prepare('SELECT * FROM agent_profiles WHERE role = ?').get(job.role) as {
    system_prompt: string; personality: string
  } | undefined
  if (!profile) return

  // Get all products
  const products = db.prepare('SELECT * FROM products').all() as ProductRow[]

  // Get recent activity
  const recentActivity = db.prepare(
    'SELECT action, details, created_at FROM activity_log ORDER BY created_at DESC LIMIT 10'
  ).all() as { action: string; details: string | null; created_at: string }[]

  // Get leads summary
  const leadStats = db.prepare(`
    SELECT status, COUNT(*) as count FROM leads GROUP BY status
  `).all() as { status: string; count: number }[]

  // Get pending actions
  const pendingCount = (db.prepare(
    "SELECT COUNT(*) as c FROM action_queue WHERE status = 'pending'"
  ).get() as { c: number }).c

  // Get learnings for this agent
  const learnings = db.prepare(
    'SELECT category, insight, confidence FROM learnings WHERE (agent_role = ? OR agent_role IS NULL) AND confidence >= 0.3 ORDER BY confidence DESC LIMIT 10'
  ).all(job.role) as { category: string; insight: string; confidence: number }[]

  const prompt = `${profile.system_prompt.substring(0, 1500)}

AUTONOM UPPGIFT (kör automatiskt, ingen admin närvarande):
${job.task}

PRODUKTER:
${products.map(p => `- ${p.display_name} (${p.name}): ${p.description || ''}`).join('\n')}

LEAD-STATUS:
${leadStats.map(s => `- ${s.status}: ${s.count}`).join('\n')}

VÄNTANDE ACTIONS: ${pendingCount} st

SENASTE AKTIVITET:
${recentActivity.map(a => `- ${a.action} ${a.created_at}`).join('\n')}

DINA LEARNINGS:
${learnings.map(l => `- [${l.category}] ${l.insight}`).join('\n') || '(inga)'}

SVARA MED EN KORT RAPPORT (max 200 ord). Om du har rekommendationer, lista dem.
Om du hittar problem, flagga dem tydligt.
Svara på svenska.`

  try {
    const response = await runClaude(prompt)

    // Save report
    db.prepare(`
      INSERT INTO daily_reports (product_id, report_type, agent_role, content, period_start, period_end)
      VALUES (NULL, 'auto_report', ?, ?, datetime('now', '-1 day'), datetime('now'))
    `).run(job.role, response)

    // Log activity
    db.prepare(`
      INSERT INTO activity_log (product_id, action, details, created_at)
      VALUES (NULL, 'agent_auto_report', ?, datetime('now'))
    `).run(JSON.stringify({ agent: job.role, name: job.name, summary: response.substring(0, 200) }))

    // Update agent last action
    db.prepare(`
      UPDATE agent_profiles SET last_action = ?, last_action_at = datetime('now') WHERE role = ?
    `).run('Auto report: ' + job.task.substring(0, 80), job.role)

    console.log(`[autonomous] ${job.name} done: ${response.substring(0, 100)}...`)
  } catch (err) {
    console.error(`[autonomous] ${job.name} failed:`, (err as Error).message)
  }
}

// ── Check Loop ───────────────────────────────────────────────────────────────

async function checkJobs(db: Database.Database): Promise<void> {
  if (running) return
  running = true

  try {
    for (const job of AGENT_JOBS) {
      await executeJob(job, db)
    }
  } catch (err) {
    console.error('[autonomous] Error:', (err as Error).message)
  } finally {
    running = false
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function startAutonomousRunner(db: Database.Database, _config: SalesConfig): void {
  if (intervalHandle) return

  console.log(`[autonomous] Starting — ${AGENT_JOBS.length} jobs scheduled`)
  for (const job of AGENT_JOBS) {
    console.log(`  ${job.name} (${job.role}): ${job.interval}`)
  }

  // Check every 5 minutes
  intervalHandle = setInterval(() => {
    checkJobs(db).catch(err => {
      console.error('[autonomous] Cycle failed:', (err as Error).message)
    })
  }, 5 * 60 * 1000)

  // First run after 30 seconds (let everything else start first)
  setTimeout(() => {
    checkJobs(db).catch(err => {
      console.error('[autonomous] Initial run failed:', (err as Error).message)
    })
  }, 30000)
}

export function stopAutonomousRunner(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
    console.log('[autonomous] Stopped')
  }
}
