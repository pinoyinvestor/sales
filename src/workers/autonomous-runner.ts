import { spawn } from 'child_process'
import type Database from 'better-sqlite3'
import type { SalesConfig } from '../utils/config.js'
import { sendTelegram, formatAutoReport } from '../providers/telegram.js'

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentJob {
  role: string
  name: string
  team: string
  interval: 'every_4h' | 'every_6h' | 'every_12h' | 'every_24h' | 'every_week'
  task: string
  canAct: boolean
  collaborates: string[] // Roles this agent should see output from
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

const AUTO_APPROVE_ACTIONS = new Set([
  'create_lead',
  'update_lead',
  'create_draft',
  'save_learning',
  'create_recommendation',
  'assign_task',
])

// ── ALL 16 AGENTS — Full Team Collaboration ─────────────────────────────────

const AGENT_JOBS: AgentJob[] = [
  // ═══ EXECUTIVE TEAM ═══

  { role: 'coo', name: 'Sofia', team: 'executive', interval: 'every_12h', canAct: true,
    collaborates: ['scout', 'outreach', 'closer', 'content', 'seo', 'strategist', 'support', 'keeper', 'secops', 'analyst'],
    task: `Daglig sammanfattning + koordinering:
1. Sammanfatta vad ALLA agenter gjort sedan senast
2. Identifiera blockeringar, konflikter, och missade möjligheter
3. Tilldela tasks med ACTION:assign_task om något behöver göras
4. Om scout hittat leads men outreach inte följt upp — eskalera
5. Om content skapat drafts men ingen granskat — tilldela reviewer
6. Rapportera KPIs: leads, emails sent, response rate, deals i pipeline` },

  { role: 'cfo', name: 'Viktor', team: 'executive', interval: 'every_24h', canAct: true,
    collaborates: ['coo', 'strategist', 'closer', 'analyst'],
    task: `Ekonomisk analys:
1. Beräkna email-kostnad per lead (API/SMTP-kostnader vs converted leads)
2. Analysera vilka produkter som ger bäst ROI per outreach-insats
3. Kontrollera att vi inte bränner pengar på bounced/declined leads
4. Föreslå budget-omfördelning om en produkt underpresterar
5. Spara insikter med ACTION:save_learning` },

  { role: 'cto', name: 'Erik', team: 'executive', interval: 'every_24h', canAct: true,
    collaborates: ['secops', 'seo', 'analyst', 'coo'],
    task: `Teknisk övervakning:
1. Kolla bounce-rate — om den är hög, flagga deliverability-problem
2. Granska om inbox-reader missar mail (activity_log vs email_tracking)
3. Kontrollera att sekvenser kör korrekt (sequence_step progression)
4. Om det finns tekniska problem, ACTION:assign_task till rätt agent
5. Spara tekniska insikter som ACTION:save_learning` },

  // ═══ SALES TEAM ═══

  { role: 'scout', name: 'Max', team: 'sales', interval: 'every_6h', canAct: true,
    collaborates: ['outreach', 'closer', 'strategist', 'analyst'],
    task: `Lead research & kvalificering:
1. Analysera befintliga leads — vilka har högt score men inget outreach?
2. Kolla vilka produkter som saknar leads — hitta nya
3. Skapa nya leads med ACTION:create_lead (kolla dedup först!)
4. Uppdatera lead-score och tags med ACTION:update_lead
5. Tilldela heta leads till Elina (outreach) med ACTION:assign_task
6. Per produkt: matcha lead mot rätt produkts målgrupp` },

  { role: 'outreach', name: 'Elina', team: 'sales', interval: 'every_6h', canAct: true,
    collaborates: ['scout', 'closer', 'copywriter', 'strategist'],
    task: `Email outreach & follow-up:
1. Kolla qualified/interested leads utan uppföljning
2. Skriv personliga email-drafts med ACTION:create_draft
3. Kolla A/B-testresultat — vilken subject line funkar bäst?
4. Om lead svarade positivt → ACTION:assign_task till Oscar (closer)
5. Uppdatera lead-status med ACTION:update_lead
6. Lär av Novas copywriting-tips (kolla hennes learnings)
7. Sälj BEHOVET, inte features. Max 3 mail utan svar.` },

  { role: 'closer', name: 'Oscar', team: 'sales', interval: 'every_12h', canAct: true,
    collaborates: ['outreach', 'scout', 'coo', 'cfo'],
    task: `Deal preparation & avslut:
1. Kolla interested/qualified leads — förbered deal-underlag
2. Skapa mötesförfrågningar som ACTION:create_draft
3. Sammanställ lead-info + invändningar per qualified lead
4. Om en lead har visat intresse men inte fått offert → ACTION:create_draft med förslag
5. Uppdatera pipeline-status med ACTION:update_lead
6. Tilldela tid-kritiska deals till COO med ACTION:assign_task
7. Du stänger ALDRIG deals — du FÖRBEREDER allt åt Christos/Daniel` },

  // ═══ MARKETING TEAM ═══

  { role: 'content', name: 'Alma', team: 'marketing', interval: 'every_24h', canAct: true,
    collaborates: ['seo', 'copywriter', 'strategist', 'scout'],
    task: `Content skapande:
1. Kolla Leos (SEO) senaste keyword-rekommendationer
2. Kolla Novas (copywriter) senaste tips om messaging
3. Skapa 2-3 content-idéer baserat på learnings och trender
4. ACTION:create_draft med blogginlägg/nyhetsbrev/social posts
5. ACTION:save_learning med insikter om vad som engagerar
6. Fråga Astrid (strategist) om content-kalendern behöver uppdateras` },

  { role: 'copywriter', name: 'Nova', team: 'marketing', interval: 'every_24h', canAct: true,
    collaborates: ['outreach', 'content', 'strategist', 'closer'],
    task: `Copy-optimering & A/B-test:
1. Granska Elinas (outreach) senaste email-drafts — ge feedback
2. Föreslå bättre subject lines, CTAs och value propositions
3. Analysera vilka templates som har bäst open/click rate
4. Skapa nya copy-varianter med ACTION:create_draft
5. ACTION:save_learning med copywriting-insikter
6. Hjälp Oscar (closer) med övertygande offertttexter` },

  { role: 'seo', name: 'Leo', team: 'marketing', interval: 'every_24h', canAct: true,
    collaborates: ['content', 'strategist', 'cto', 'analyst'],
    task: `SEO-analys & rekommendationer:
1. Analysera vilka produkters webbsidor som behöver SEO-kärlek
2. Föreslå keywords per produkt baserat på lead-data
3. Granska Almas (content) drafts för SEO-optimering
4. ACTION:save_learning med keyword-insikter
5. ACTION:create_recommendation för teknisk SEO till Erik (CTO)
6. Kolla konkurrenters ranking för våra nyckelord` },

  { role: 'strategist', name: 'Astrid', team: 'marketing', interval: 'every_24h', canAct: true,
    collaborates: ['content', 'copywriter', 'seo', 'outreach', 'analyst', 'coo'],
    task: `Marketing-strategi & kampanjplanering:
1. Analysera övergripande funnel: leads → contacted → interested → converted
2. Identifiera vilka steg som läcker mest (flaskhals)
3. Kolla A/B-testresultat och ge rekommendationer
4. ACTION:assign_task till content/copywriter/seo med kampanjprioriteter
5. Beräkna conversion rate per kanal, produkt och template
6. ACTION:save_learning med strategiska insikter
7. Koordinera med Sofia (COO) om resursallokering` },

  // ═══ CUSTOMER TEAM ═══

  { role: 'support', name: 'Mila', team: 'customer', interval: 'every_4h', canAct: true,
    collaborates: ['closer', 'keeper', 'outreach', 'coo'],
    task: `Kundservice & inbox:
1. Kolla inbox för nya mail — kategorisera och prioritera
2. Om inbound lead → ACTION:create_lead med source='inbound'
3. Om kundmail → ACTION:create_draft med svar
4. Om support-fråga upprepas → ACTION:save_learning (FAQ-pattern)
5. Eskalera brådskande ärenden till Sofia (COO) med ACTION:assign_task
6. Om kund visar intresse för uppgradering → tilldela Oscar (closer)` },

  { role: 'keeper', name: 'Wilma', team: 'customer', interval: 'every_12h', canAct: true,
    collaborates: ['support', 'outreach', 'closer', 'analyst'],
    task: `Retention & churn-prevention:
1. Hitta leads som inte kontaktats på 7+ dagar → ACTION:update_lead
2. Hitta qualified leads som stagnerat → ACTION:assign_task till Oscar
3. Markera leads som no_response efter 14 dagar
4. Rensa bounced leads från aktiva sekvenser
5. ACTION:save_learning med retention-insikter
6. Föreslå win-back-kampanjer för tapade leads via Astrid (strategist)` },

  // ═══ SECURITY TEAM ═══

  { role: 'secops', name: 'Axel', team: 'security', interval: 'every_24h', canAct: true,
    collaborates: ['cto', 'coo', 'outreach'],
    task: `GDPR & säkerhetsaudit:
1. Kontrollera att alla leads har consent innan de kontaktas
2. Flagga leads med PII i notes-fältet som inte borde vara där
3. Kontrollera att opted_out/declined leads ALDRIG kontaktas
4. Kontrollera cooldown-perioden (6 månader) — flagga överträdelser
5. ACTION:save_learning med compliance-insikter
6. Om GDPR-problem hittas → ACTION:assign_task till Sofia (COO)
7. Rapportera compliance-status per produkt` },

  // ═══ INTELLIGENCE TEAM ═══

  { role: 'analyst', name: 'Nils', team: 'intelligence', interval: 'every_12h', canAct: true,
    collaborates: ['coo', 'cfo', 'strategist', 'scout', 'outreach'],
    task: `Data-analys & insikter:
1. Beräkna conversion funnel per produkt: new → contacted → interested → qualified → converted
2. Analysera email performance: open rate, reply rate, bounce rate per template
3. Identifiera top-performing templates och kanaler
4. Analysera lead-score distribution och kvalitet per källa
5. Jämför response rate per bransch, land och storlek
6. ACTION:save_learning med datainsikter
7. ACTION:create_recommendation med optimeringsförslag till Astrid och Sofia` },

  // ═══ CREATIVE TEAM ═══

  { role: 'creative_director', name: 'Saga', team: 'creative', interval: 'every_24h', canAct: true,
    collaborates: ['content', 'copywriter', 'strategist', 'outreach'],
    task: `Kreativ ledning & varumärke:
1. Granska senaste email-drafts — passar de varumärkets ton?
2. Ge feedback på content: är det konsekvent, engagerande, on-brand?
3. Föreslå kreativa kampanjidéer baserat på trender
4. ACTION:save_learning med varumärkesriktlinjer och insikter
5. ACTION:create_recommendation om något inte håller kreativ standard
6. Se till att alla produkter har konsekvent look & feel i kommunikation` },

  // ═══ OPERATIONS TEAM ═══

  { role: 'pm', name: 'Hugo', team: 'operations', interval: 'every_12h', canAct: true,
    collaborates: ['coo', 'scout', 'outreach', 'content', 'closer'],
    task: `Projektledning & prioritering:
1. Granska agent_tasks-kön — vilka tasks är overdue?
2. Identifiera agenter som har för många tasks → omfördela
3. Kolla att alla teams har balanserad workload
4. ACTION:assign_task för att lösa blockeringar
5. ACTION:save_learning med processförbättringsförslag
6. Flagga om en agent producerar dålig kvalitet (tomma rapporter, irrelevanta actions)
7. Koordinera med Sofia (COO) om prioriteringsändringar behövs` },
]

// ── Intervals ────────────────────────────────────────────────────────────────

const INTERVAL_MS: Record<string, number> = {
  every_4h:   4 * 60 * 60 * 1000,
  every_6h:   6 * 60 * 60 * 1000,
  every_12h: 12 * 60 * 60 * 1000,
  every_24h: 24 * 60 * 60 * 1000,
  every_week: 7 * 24 * 60 * 60 * 1000,
}

// ── State ────────────────────────────────────────────────────────────────────

const lastRun: Record<string, number> = {}
let intervalHandle: ReturnType<typeof setInterval> | null = null
let running = false

// ── Claude Runner (uses spawn — safe from injection) ─────────────────────────

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

function parseActions(response: string): ParsedAction[] {
  const actions: ParsedAction[] = []
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

    const autoApprove = AUTO_APPROVE_ACTIONS.has(action.type)
    const status = autoApprove ? 'approved' : 'pending'
    const requiresApproval = autoApprove ? 0 : 1

    try {
      // Dedup check for leads
      if (action.type === 'create_lead' && action.data.email) {
        const existing = db.prepare('SELECT id FROM leads WHERE email = ?').get(action.data.email as string)
        if (existing) {
          console.log(`[autonomous] Skipped duplicate lead: ${action.data.email}`)
          continue
        }
      }

      insertAction.run(
        job.role, job.name, productId, action.type,
        JSON.stringify(action.data), priority, status, requiresApproval,
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

// ── Get Collaboration Context ────────────────────────────────────────────────

function getCollaborationContext(db: Database.Database, job: AgentJob): string {
  const lines: string[] = ['KOLLEGORS SENASTE RAPPORTER (samarbeta!):']

  // Get latest report from each collaborator
  for (const collab of job.collaborates) {
    const report = db.prepare(`
      SELECT agent_role, content, created_at FROM daily_reports
      WHERE agent_role = ? ORDER BY created_at DESC LIMIT 1
    `).get(collab) as { agent_role: string; content: string; created_at: string } | undefined

    if (report) {
      const agentName = AGENT_JOBS.find(j => j.role === collab)?.name ?? collab
      lines.push(`\n--- ${agentName} (${collab}) senast ${report.created_at} ---`)
      lines.push(report.content.substring(0, 300))
    }
  }

  // Get pending tasks assigned TO this agent
  const myTasks = db.prepare(`
    SELECT from_agent, title, description, priority FROM agent_tasks
    WHERE to_agent = ? AND status = 'pending'
    ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END
    LIMIT 5
  `).all(job.role) as { from_agent: string; title: string; description: string | null; priority: string }[]

  if (myTasks.length > 0) {
    lines.push('\nDINA VÄNTANDE TASKS (från andra agenter):')
    for (const t of myTasks) {
      const fromName = AGENT_JOBS.find(j => j.role === t.from_agent)?.name ?? t.from_agent
      lines.push(`- [${t.priority}] Från ${fromName}: ${t.title}${t.description ? ' — ' + t.description.substring(0, 80) : ''}`)
    }
  }

  // Get recent learnings from collaborators
  const collabLearnings = db.prepare(`
    SELECT agent_role, category, insight FROM learnings
    WHERE agent_role IN (${job.collaborates.map(() => '?').join(',')})
      AND confidence >= 0.5
    ORDER BY updated_at DESC LIMIT 5
  `).all(...job.collaborates) as { agent_role: string; category: string; insight: string }[]

  if (collabLearnings.length > 0) {
    lines.push('\nKOLLEGORS SENASTE INSIKTER:')
    for (const l of collabLearnings) {
      const name = AGENT_JOBS.find(j => j.role === l.agent_role)?.name ?? l.agent_role
      lines.push(`- ${name}: [${l.category}] ${l.insight}`)
    }
  }

  return lines.join('\n')
}

// ── Job Executor ─────────────────────────────────────────────────────────────

async function executeJob(job: AgentJob, db: Database.Database): Promise<void> {
  const key = `${job.role}_${job.interval}`
  const now = Date.now()
  const interval = INTERVAL_MS[job.interval]

  if (lastRun[key] && (now - lastRun[key]) < interval) return

  console.log(`[autonomous] Running ${job.name} (${job.role}) — ${job.task.substring(0, 50)}...`)
  lastRun[key] = now

  const profile = db.prepare('SELECT * FROM agent_profiles WHERE role = ?').get(job.role) as {
    system_prompt: string; personality: string
  } | undefined
  if (!profile) return

  const products = db.prepare('SELECT * FROM products').all() as ProductRow[]

  const recentActivity = db.prepare(
    'SELECT action, details, created_at FROM activity_log ORDER BY created_at DESC LIMIT 10'
  ).all() as { action: string; details: string | null; created_at: string }[]

  const leadStats = db.prepare(
    'SELECT status, COUNT(*) as count FROM leads GROUP BY status'
  ).all() as { status: string; count: number }[]

  const pendingCount = (db.prepare(
    "SELECT COUNT(*) as c FROM action_queue WHERE status = 'pending'"
  ).get() as { c: number }).c

  const learnings = db.prepare(
    'SELECT category, insight, confidence FROM learnings WHERE (agent_role = ? OR agent_role IS NULL) AND confidence >= 0.3 ORDER BY confidence DESC LIMIT 10'
  ).all(job.role) as { category: string; insight: string; confidence: number }[]

  const knowledge = db.prepare(
    "SELECT title, content FROM knowledge WHERE product_id IN (SELECT id FROM products) ORDER BY CASE type WHEN 'product_brief' THEN 0 WHEN 'sales_playbook' THEN 1 ELSE 2 END, updated_at DESC LIMIT 8"
  ).all() as { title: string; content: string }[]

  const leads = db.prepare(
    `SELECT email, name, company, status, product_id, last_contacted_at, response_status, notes, score
     FROM leads ORDER BY
       CASE WHEN response_status = 'interested' THEN 0
            WHEN status = 'qualified' THEN 1
            WHEN status = 'new' THEN 2
            ELSE 3 END,
       score DESC, created_at DESC
     LIMIT 30`
  ).all() as { email: string; name: string | null; company: string | null; status: string; product_id: number | null; last_contacted_at: string | null; response_status: string | null; notes: string | null; score: number }[]

  // Build collaboration context
  const collabContext = getCollaborationContext(db, job)

  const productContext = products.map(p => `${p.display_name} (${p.name}): ${p.description || ''}`).join('\n')
  const learningContext = learnings.map(l => `[${l.category}] ${l.insight}`).join('\n') || '(inga)'

  const systemPrompt = profile.system_prompt
    .replace('{{PRODUCT_CONTEXT}}', `\nPRODUKTER:\n${productContext}`)
    .replace('{{LEARNINGS}}', `\nLEARNINGS:\n${learningContext}`)
    .replace('{{TEAM_KNOWLEDGE}}', '')
    .replace('{{CURRENT_CONTEXT}}', '')

  const actionInstructions = job.canAct ? `

ACTION-FORMAT (använd EXAKT detta format):
- ACTION:create_lead{"email":"x@y.com","name":"Namn","company":"Företag","product_id":${products[0]?.id || 1},"source":"agent_${job.role}","tags":"...","notes":"..."}
- ACTION:update_lead{"id":123,"status":"qualified","notes":"..."}
- ACTION:create_draft{"type":"email","title":"Ämne","content":"<p>HTML body</p>","recipient_email":"x@y.com","product_id":${products[0]?.id || 1}}
- ACTION:save_learning{"category":"...","insight":"...","product":"wpilot"}
- ACTION:create_recommendation{"agent_role":"outreach","title":"...","description":"...","priority":"high"}
- ACTION:assign_task{"from_agent":"${job.role}","to_agent":"outreach","title":"...","description":"...","priority":"medium"}

Auto-approved: create_lead, update_lead, create_draft, save_learning, assign_task
Kräver godkännande: send_email, book_meeting` : ''

  const prompt = `${systemPrompt}

AUTONOM UPPGIFT — ${job.name} (${job.role}, team: ${job.team}):
${job.task}
${actionInstructions}

${collabContext}

PRODUKTER (${products.length} st):
${products.map(p => `- ${p.display_name} (${p.name}): ${p.description || ''}`).join('\n')}

PRODUKTKUNSKAP:
${knowledge.map(k => `- ${k.title}: ${k.content.substring(0, 200)}`).join('\n') || '(ingen)'}

LEADS (topp 30 — prioriterade):
${leads.map(l => `- ${l.email} (${l.name || '?'}, ${l.company || '?'}) — status: ${l.status}, response: ${l.response_status || 'none'}, score: ${l.score || 0}, senast: ${l.last_contacted_at || 'aldrig'}`).join('\n') || '(inga)'}

LEAD-STATUS:
${leadStats.map(s => `- ${s.status}: ${s.count}`).join('\n')}

VÄNTANDE ACTIONS: ${pendingCount} st

SENASTE AKTIVITET:
${recentActivity.map(a => `- ${a.action} ${a.created_at}`).join('\n')}

DINA LEARNINGS:
${learnings.map(l => `- [${l.category}] ${l.insight}`).join('\n') || '(inga)'}

REGLER:
- Svara DIREKT med rapport + ACTIONs.
- SAMARBETA: läs kollegors rapporter ovan, agera på deras input, tilldela tasks
- Var konkret: siffror, namn, datum.
- Max 400 ord.
- Svara på svenska.`

  try {
    const response = await runClaude(prompt)
    const defaultProduct = products[0]?.id || null

    let actionsQueued = 0
    if (job.canAct) {
      const actions = parseActions(response)
      if (actions.length > 0) {
        actionsQueued = queueActions(db, job, actions, defaultProduct)
        console.log(`[autonomous] ${job.name} queued ${actionsQueued} action(s)`)
      }
    }

    // Mark any pending tasks assigned to this agent as completed
    db.prepare(`
      UPDATE agent_tasks SET status = 'completed', completed_at = datetime('now'),
        result = 'Handled in autonomous run'
      WHERE to_agent = ? AND status = 'pending'
    `).run(job.role)

    db.prepare(`
      INSERT INTO daily_reports (product_id, report_type, agent_role, content, period_start, period_end)
      VALUES (?, 'auto_report', ?, ?, datetime('now', '-1 day'), datetime('now'))
    `).run(defaultProduct, job.role, response)

    db.prepare(`
      INSERT INTO activity_log (product_id, action, details, created_at)
      VALUES (?, 'agent_auto_report', ?, datetime('now'))
    `).run(defaultProduct, JSON.stringify({
      agent: job.role, name: job.name,
      summary: response.substring(0, 200),
      actions_queued: actionsQueued,
      collaborators: job.collaborates.length,
    }))

    db.prepare(`
      UPDATE agent_profiles SET last_action = ?, last_action_at = datetime('now') WHERE role = ?
    `).run(`Auto: ${job.task.substring(0, 50)} (${actionsQueued} actions)`, job.role)

    console.log(`[autonomous] ${job.name} done (${actionsQueued} actions): ${response.substring(0, 80)}...`)

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

  console.log(`[autonomous] Starting — ${AGENT_JOBS.length} agents, ALL active`)

  const teams: Record<string, string[]> = {}
  for (const job of AGENT_JOBS) {
    if (!teams[job.team]) teams[job.team] = []
    teams[job.team].push(`${job.name}(${job.interval}${job.canAct ? ',acts' : ''})`)
  }
  for (const [team, members] of Object.entries(teams)) {
    console.log(`  ${team}: ${members.join(', ')}`)
  }

  // Check every 5 minutes
  intervalHandle = setInterval(() => {
    checkJobs(db).catch(err => {
      console.error('[autonomous] Cycle failed:', (err as Error).message)
    })
  }, 5 * 60 * 1000)

  // Restore last run times
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
    console.log(`[autonomous] Restored ${recentReports.length} timestamps`)
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
