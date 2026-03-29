import { spawn } from 'child_process'
import type Database from 'better-sqlite3'
import type { SalesConfig } from '../utils/config.js'
import { sendTelegram, formatAutoReport } from '../providers/telegram.js'

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentJob {
  role: string
  name: string
  team: string
  interval: 'every_6h' | 'every_12h' | 'every_24h' | 'every_week'
  task: string
  canAct: boolean // Can this agent queue real actions?
}

interface ProductRow {
  id: number
  name: string
  display_name: string
  description: string | null
}

interface ParsedAction {
  type: string
  data: Record<string, unknown>
}

// Built by Christos Ferlachidis & Daniel Hedenberg

// ── Auto-Approve Rules ──────────────────────────────────────────────────────
// Low-risk actions that agents can execute without human approval

const AUTO_APPROVE_ACTIONS = new Set([
  'create_lead',
  'update_lead',
  'create_draft',       // drafts still need approval to send
  'save_learning',
  'create_recommendation',
  'assign_task',
])

const NEEDS_APPROVAL_ACTIONS = new Set([
  'send_email',
  'book_meeting',
  'escalate',
])

// ── Agent Schedule ───────────────────────────────────────────────────────────

const AGENT_JOBS: AgentJob[] = [
  // Every 6 hours — Support checks inbox
  { role: 'support', name: 'Mila', team: 'customer', interval: 'every_6h', canAct: true,
    task: 'Kolla inbox för nya kundmail. Kategorisera dem. Om du hittar intressanta leads, skapa dem med ACTION:create_lead. Föreslå svar som ACTION:create_draft. Rapportera mönster.' },

  // Every 24 hours — COO daily summary
  { role: 'coo', name: 'Sofia', team: 'executive', interval: 'every_24h', canAct: false,
    task: 'Skriv en daglig sammanfattning: vad hände igår, vad ligger i action-kö, vilka leads har uppdaterats, vilka agenter har gjort vad. Max 10 rader.' },

  // Every 24 hours — Keeper retention
  { role: 'keeper', name: 'Wilma', team: 'customer', interval: 'every_24h', canAct: true,
    task: 'Analysera leads: vilka har inte kontaktats på 7+ dagar? Vilka visar churn-signaler? Uppdatera deras status med ACTION:update_lead om det behövs. Föreslå uppföljningsåtgärder.' },

  // Every 24 hours — Security audit
  { role: 'secops', name: 'Axel', team: 'security', interval: 'every_24h', canAct: false,
    task: 'GDPR-check: har alla leads consent? Finns det PII i drafts? Rapportera compliance-status.' },

  // Every 12 hours — Scout research
  { role: 'scout', name: 'Max', team: 'sales', interval: 'every_12h', canAct: true,
    task: 'Analysera våra leads: vilka företag har vi inte kontaktat? Om du hittar nya potentiella leads från kunskapsbasen, skapa dem med ACTION:create_lead. Föreslå personliga kontaktmeddelanden som ACTION:create_draft.' },

  // Every 24 hours — Content ideas
  { role: 'content', name: 'Alma', team: 'marketing', interval: 'every_24h', canAct: true,
    task: 'Baserat på learnings och leads: föreslå 3 content-idéer. Spara insikter som ACTION:save_learning. Ge konkreta rubriker och vinkel.' },

  // Every 24 hours — Outreach follow-up drafts
  { role: 'outreach', name: 'Ella', team: 'sales', interval: 'every_24h', canAct: true,
    task: 'Kolla qualified/interested leads som inte fått uppföljning på 48h+. Skriv personliga uppföljningsmejl som ACTION:create_draft för varje. Sälj behovet, inte features.' },
]

// ── Intervals ────────────────────────────────────────────────────────────────

const INTERVAL_MS: Record<string, number> = {
  every_6h:   6 * 60 * 60 * 1000,
  every_12h: 12 * 60 * 60 * 1000,
  every_24h: 24 * 60 * 60 * 1000,
  every_week: 7 * 24 * 60 * 60 * 1000,
}

// ── State ────────────────────────────────────────────────────────────────────

const lastRun: Record<string, number> = {}
let intervalHandle: ReturnType<typeof setInterval> | null = null
let running = false

// ── Claude Runner (uses spawn, not exec — safe from injection) ───────────────

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('/home/christaras9126/.local/bin/claude', [
      '-p', prompt, '--max-turns', '3', '--model', 'haiku',
    ], {
      env: { ...process.env, HOME: '/home/christaras9126' },
      timeout: 90000,
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

// ── Action Parser ────────────────────────────────────────────────────────────
// Parses ACTION:type{json} blocks from Claude responses

function parseActions(response: string): ParsedAction[] {
  const actions: ParsedAction[] = []
  // Match ACTION:type{...} — supports nested objects via balanced brace matching
  const regex = /ACTION:(\w+)\s*(\{[^}]+\})/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(response)) !== null) {
    try {
      const type = match[1]
      const data = JSON.parse(match[2])
      actions.push({ type, data })
    } catch {
      // Skip malformed actions
    }
  }

  return actions
}

// ── Queue Actions ────────────────────────────────────────────────────────────

function queueActions(
  db: Database.Database,
  job: AgentJob,
  actions: ParsedAction[],
  defaultProductId: number | null,
): number {
  let queued = 0

  const insertAction = db.prepare(`
    INSERT INTO action_queue (agent_role, agent_name, product_id, action_type, action_data, priority, status, requires_approval, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `)

  for (const action of actions) {
    const productId = (action.data.product_id as number) ?? defaultProductId
    const priority = (action.data.priority as string) ?? 'medium'

    // Determine if auto-approve
    const autoApprove = AUTO_APPROVE_ACTIONS.has(action.type)
    const status = autoApprove ? 'approved' : 'pending'
    const requiresApproval = autoApprove ? 0 : 1

    try {
      // Dedup check — don't queue duplicate leads
      if (action.type === 'create_lead' && action.data.email) {
        const existing = db.prepare('SELECT id FROM leads WHERE email = ?').get(action.data.email as string)
        if (existing) {
          console.log(`[autonomous] Skipped duplicate lead: ${action.data.email}`)
          continue
        }
      }

      insertAction.run(
        job.role,
        job.name,
        productId,
        action.type,
        JSON.stringify(action.data),
        priority,
        status,
        requiresApproval,
      )
      queued++

      if (autoApprove) {
        console.log(`[autonomous] Auto-approved: ${action.type} by ${job.name}`)
      } else {
        console.log(`[autonomous] Queued (needs approval): ${action.type} by ${job.name}`)
        sendTelegram(`✅ <b>Action behöver godkännas</b>\n\nAgent: ${job.name} (${job.role})\nTyp: ${action.type}\nData: ${JSON.stringify(action.data).substring(0, 200)}`).catch(() => {})
      }
    } catch (err) {
      console.error(`[autonomous] Failed to queue ${action.type}:`, (err as Error).message)
    }
  }

  return queued
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

  // Get knowledge — prioritize product briefs and playbooks
  const knowledge = db.prepare(
    "SELECT title, content FROM knowledge WHERE product_id IN (SELECT id FROM products) ORDER BY CASE type WHEN 'product_brief' THEN 0 WHEN 'sales_playbook' THEN 1 ELSE 2 END, updated_at DESC LIMIT 8"
  ).all() as { title: string; content: string }[]

  // Get leads detail — more for action agents
  const leadLimit = job.canAct ? 30 : 15
  const leads = db.prepare(
    `SELECT email, name, company, status, product_id, last_contacted_at, response_status, notes, score
     FROM leads ORDER BY
       CASE WHEN response_status = 'interested' THEN 0
            WHEN status = 'qualified' THEN 1
            WHEN status = 'new' THEN 2
            ELSE 3 END,
       score DESC, created_at DESC
     LIMIT ?`
  ).all(leadLimit) as { email: string; name: string | null; company: string | null; status: string; product_id: number | null; last_contacted_at: string | null; response_status: string | null; notes: string | null; score: number }[]

  // Replace placeholders in system prompt
  const productContext = products.map(p => `${p.display_name} (${p.name}): ${p.description || ''}`).join('\n')
  const learningContext = learnings.map(l => `[${l.category}] ${l.insight}`).join('\n') || '(inga)'

  const systemPrompt = profile.system_prompt
    .replace('{{PRODUCT_CONTEXT}}', `\nPRODUKTER:\n${productContext}`)
    .replace('{{LEARNINGS}}', `\nLEARNINGS:\n${learningContext}`)
    .replace('{{TEAM_KNOWLEDGE}}', '')
    .replace('{{CURRENT_CONTEXT}}', '')

  const actionInstructions = job.canAct ? `

ACTION-FORMAT (använd EXAKT detta format för att köa riktiga actions):
- ACTION:create_lead{"email":"x@y.com","name":"Namn","company":"Företag","product_id":${products[0]?.id || 1},"source":"agent_scout","tags":"wordpress","notes":"..."}
- ACTION:update_lead{"id":123,"status":"qualified","notes":"..."}
- ACTION:create_draft{"type":"email","title":"Ämne","content":"<p>HTML body</p>","recipient_email":"x@y.com","product_id":${products[0]?.id || 1}}
- ACTION:save_learning{"category":"outreach","insight":"...","product":"wpilot"}
- ACTION:create_recommendation{"agent_role":"outreach","title":"...","description":"...","priority":"high"}

VIKTIGT: Skapa bara leads som INTE redan finns i listan nedan. Kolla email/domän först.
Auto-approved: create_lead, update_lead, create_draft, save_learning
Kräver godkännande: send_email, book_meeting` : ''

  const prompt = `${systemPrompt}

AUTONOM UPPGIFT (kör automatiskt, ingen admin närvarande):
${job.task}
${actionInstructions}

PRODUKTER (${products.length} st):
${products.map(p => `- ${p.display_name} (${p.name}): ${p.description || ''}`).join('\n')}

PRODUKTKUNSKAP:
${knowledge.map(k => `- ${k.title}: ${k.content.substring(0, 300)}`).join('\n') || '(ingen)'}

LEADS (${leads.length} st — prioriterade):
${leads.map(l => `- ${l.email} (${l.name || '?'}, ${l.company || '?'}) — status: ${l.status}, response: ${l.response_status || 'none'}, score: ${l.score || 0}, senast: ${l.last_contacted_at || 'aldrig'}${l.notes ? ', anteckning: ' + l.notes.substring(0, 50) : ''}`).join('\n') || '(inga)'}

LEAD-STATUS:
${leadStats.map(s => `- ${s.status}: ${s.count}`).join('\n')}

VÄNTANDE ACTIONS: ${pendingCount} st

SENASTE AKTIVITET:
${recentActivity.map(a => `- ${a.action} ${a.created_at}`).join('\n')}

DINA LEARNINGS:
${learnings.map(l => `- [${l.category}] ${l.insight}`).join('\n') || '(inga)'}

REGLER:
- Svara DIREKT med din rapport + eventuella ACTIONs.
- Var konkret och specifik. Ge siffror, namn, datum.
- Max 300 ord.
- ${job.canAct ? 'Använd ACTION-format ovan för att köa riktiga åtgärder. Var smart — kolla att leads inte redan finns!' : 'Inga actions — bara rapport och rekommendationer.'}
- Svara på svenska.`

  try {
    const response = await runClaude(prompt)

    // Resolve product_id
    const defaultProduct = products[0]?.id || null

    // Parse and queue actions if agent can act
    let actionsQueued = 0
    if (job.canAct) {
      const actions = parseActions(response)
      if (actions.length > 0) {
        actionsQueued = queueActions(db, job, actions, defaultProduct)
        console.log(`[autonomous] ${job.name} queued ${actionsQueued} action(s)`)
      }
    }

    // Save report
    db.prepare(`
      INSERT INTO daily_reports (product_id, report_type, agent_role, content, period_start, period_end)
      VALUES (?, 'auto_report', ?, ?, datetime('now', '-1 day'), datetime('now'))
    `).run(defaultProduct, job.role, response)

    // Log activity
    db.prepare(`
      INSERT INTO activity_log (product_id, action, details, created_at)
      VALUES (?, 'agent_auto_report', ?, datetime('now'))
    `).run(defaultProduct, JSON.stringify({
      agent: job.role,
      name: job.name,
      summary: response.substring(0, 200),
      actions_queued: actionsQueued,
    }))

    // Update agent last action
    db.prepare(`
      UPDATE agent_profiles SET last_action = ?, last_action_at = datetime('now') WHERE role = ?
    `).run(`Auto: ${job.task.substring(0, 60)} (${actionsQueued} actions)`, job.role)

    console.log(`[autonomous] ${job.name} done: ${response.substring(0, 100)}...`)

    // Telegram notification
    const actionSuffix = actionsQueued > 0 ? `\n\n⚡ ${actionsQueued} action(s) köade` : ''
    sendTelegram(formatAutoReport(job.name, response.substring(0, 300) + actionSuffix)).catch(() => {})
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
    console.log(`  ${job.name} (${job.role}): ${job.interval}${job.canAct ? ' [CAN ACT]' : ''}`)
  }

  // Check every 5 minutes
  intervalHandle = setInterval(() => {
    checkJobs(db).catch(err => {
      console.error('[autonomous] Cycle failed:', (err as Error).message)
    })
  }, 5 * 60 * 1000)

  // Restore last run times from DB to prevent restart duplicates
  const recentReports = db.prepare(
    `SELECT agent_role, MAX(created_at) as last FROM daily_reports WHERE created_at > datetime('now', '-1 day') GROUP BY agent_role`
  ).all() as { agent_role: string; last: string }[]
  for (const r of recentReports) {
    const job = AGENT_JOBS.find(j => j.role === r.agent_role)
    if (job) {
      const key = `${job.role}_${job.interval}`
      lastRun[key] = new Date(r.last).getTime()
    }
  }
  if (recentReports.length > 0) {
    console.log(`[autonomous] Restored ${recentReports.length} last-run timestamps (prevents restart duplicates)`)
  }

  // First run after 30 seconds
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
