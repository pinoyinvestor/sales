import type Database from 'better-sqlite3'
import type { SalesConfig } from '../utils/config.js'
import { createEmailProvider } from '../providers/email-provider.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApprovedAction {
  id: number
  agent_role: string
  agent_name: string
  product_id: number | null
  action_type: string
  action_data: string
  priority: string
}

// ─── Executor Logic ──────────────────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null

function markExecuted(db: Database.Database, id: number, result: string): void {
  db.prepare(
    `UPDATE action_queue SET status = 'executed', executed_at = datetime('now'), result = ? WHERE id = ?`
  ).run(result, id)
}

function markFailed(db: Database.Database, id: number, error: string): void {
  db.prepare(
    `UPDATE action_queue SET status = 'failed', executed_at = datetime('now'), result = ? WHERE id = ?`
  ).run(error, id)
}

// Built by Christos Ferlachidis & Daniel Hedenberg

function logActivity(db: Database.Database, productId: number | null, action: string, details: string): void {
  db.prepare(
    `INSERT INTO activity_log (product_id, action, details, created_at) VALUES (?, ?, ?, datetime('now'))`
  ).run(productId, action, details)
}

// ─── Action Handlers ─────────────────────────────────────────────────────────

function executeCreateLead(db: Database.Database, data: Record<string, unknown>): string {
  if (!data.email) throw new Error('email is required for create_lead')

  const result = db.prepare(
    `INSERT INTO leads (email, name, company, phone, product_id, source, status, notes, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(
    data.email, data.name ?? null, data.company ?? null, data.phone ?? null,
    data.product_id ?? null, data.source ?? 'agent', data.status ?? 'new',
    data.notes ?? null, data.tags ?? null
  )

  const leadId = result.lastInsertRowid
  logActivity(db, (data.product_id as number) ?? null, 'lead_created', JSON.stringify({ lead_id: leadId, source: data.source ?? 'agent' }))
  return JSON.stringify({ lead_id: leadId })
}

function executeUpdateLead(db: Database.Database, data: Record<string, unknown>): string {
  if (!data.id) throw new Error('id is required for update_lead')

  const existing = db.prepare('SELECT id FROM leads WHERE id = ?').get(data.id)
  if (!existing) throw new Error(`Lead ${data.id} not found`)

  const sets: string[] = []
  const args: (string | number | null)[] = []

  if (data.name !== undefined) { sets.push('name = ?'); args.push(data.name as string) }
  if (data.company !== undefined) { sets.push('company = ?'); args.push(data.company as string) }
  if (data.status !== undefined) { sets.push('status = ?'); args.push(data.status as string) }
  if (data.notes !== undefined) { sets.push('notes = ?'); args.push(data.notes as string) }
  if (data.tags !== undefined) { sets.push('tags = ?'); args.push(data.tags as string) }
  if (data.phone !== undefined) { sets.push('phone = ?'); args.push(data.phone as string) }

  if (!sets.length) throw new Error('No fields to update')

  sets.push("updated_at = datetime('now')")
  args.push(data.id as number)
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...args)

  return JSON.stringify({ lead_id: data.id, updated_fields: sets.length - 1 })
}

function executeCreateDraft(db: Database.Database, data: Record<string, unknown>): string {
  if (!data.content) throw new Error('content is required for create_draft')

  const result = db.prepare(
    `INSERT INTO drafts (product_id, channel_id, type, title, content, recipient_email, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`
  ).run(
    data.product_id ?? null, data.channel_id ?? null,
    data.type ?? 'email', data.title ?? null,
    data.content, data.recipient_email ?? null
  )

  const draftId = result.lastInsertRowid
  logActivity(db, (data.product_id as number) ?? null, 'draft_created', JSON.stringify({ draft_id: draftId }))
  return JSON.stringify({ draft_id: draftId })
}

async function executeSendEmail(db: Database.Database, config: SalesConfig, data: Record<string, unknown>): Promise<string> {
  if (!data.to || !data.subject || !data.body) {
    throw new Error('to, subject, and body are required for send_email')
  }

  const emailProvider = createEmailProvider(config.email)
  const result = await emailProvider.sendEmail({
    to: data.to as string,
    subject: data.subject as string,
    html: data.body as string,
  })

  logActivity(
    db, (data.product_id as number) ?? null, 'email_sent',
    JSON.stringify({ to: data.to, subject: data.subject, messageId: result.messageId })
  )

  return JSON.stringify({ messageId: result.messageId })
}

function executeCreateRecommendation(db: Database.Database, data: Record<string, unknown>): string {
  if (!data.agent_role || !data.title || !data.description) {
    throw new Error('agent_role, title, and description are required for create_recommendation')
  }

  const result = db.prepare(
    `INSERT INTO recommendations (product_id, agent_role, priority, title, description, action_type, action_data, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`
  ).run(
    data.product_id ?? null, data.agent_role, data.priority ?? 'medium',
    data.title, data.description, data.action_type ?? null, data.action_data ?? null
  )

  return JSON.stringify({ recommendation_id: result.lastInsertRowid })
}

function executeAssignTask(db: Database.Database, data: Record<string, unknown>): string {
  if (!data.from_agent || !data.to_agent || !data.title) {
    throw new Error('from_agent, to_agent, and title are required for assign_task')
  }

  const result = db.prepare(
    `INSERT INTO agent_tasks (from_agent, to_agent, product_id, title, description, priority, due_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.from_agent, data.to_agent, data.product_id ?? null,
    data.title, data.description ?? null, data.priority ?? 'medium', data.due_at ?? null
  )

  return JSON.stringify({ task_id: result.lastInsertRowid })
}

function executeSaveLearning(db: Database.Database, data: Record<string, unknown>): string {
  if (!data.category || !data.insight) {
    throw new Error('category and insight are required for save_learning')
  }

  let productId: number | null = null
  if (data.product) {
    const p = db.prepare('SELECT id FROM products WHERE name = ?').get(data.product) as { id: number } | undefined
    if (p) productId = p.id
  } else if (data.product_id) {
    productId = data.product_id as number
  }

  // Check for existing learning to reinforce
  const existing = db.prepare(
    'SELECT id, confidence FROM learnings WHERE agent_role IS ? AND product_id IS ? AND category = ? AND insight = ?'
  ).get(data.agent_role ?? null, productId, data.category, data.insight) as { id: number; confidence: number } | undefined

  if (existing) {
    const newConf = Math.min(1.0, existing.confidence + 0.1)
    db.prepare('UPDATE learnings SET confidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newConf, existing.id)
    return JSON.stringify({ learning_id: existing.id, reinforced: true, confidence: newConf })
  }

  const result = db.prepare(
    'INSERT INTO learnings (agent_role, product_id, category, insight, confidence, source) VALUES (?, ?, ?, ?, 0.5, ?)'
  ).run(data.agent_role ?? null, productId, data.category, data.insight, data.source ?? 'agent')

  return JSON.stringify({ learning_id: result.lastInsertRowid, reinforced: false, confidence: 0.5 })
}

function executeBookMeeting(db: Database.Database, data: Record<string, unknown>): string {
  if (!data.title || !data.date || !data.time) {
    throw new Error('title, date, and time are required for book_meeting')
  }

  const result = db.prepare(
    `INSERT INTO meetings (title, description, product_id, lead_id, contact_name, contact_email, contact_phone, meeting_type, location, meeting_url, date, time, duration_minutes, notes, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', datetime('now'), datetime('now'))`
  ).run(
    data.title, data.description ?? null, data.product_id ?? null, data.lead_id ?? null,
    data.contact_name ?? null, data.contact_email ?? null, data.contact_phone ?? null,
    data.meeting_type ?? 'video', data.location ?? null, data.meeting_url ?? null,
    data.date, data.time, data.duration_minutes ?? 30, data.notes ?? null
  )

  const meetingId = result.lastInsertRowid
  logActivity(
    db, (data.product_id as number) ?? null, 'meeting_created',
    JSON.stringify({ meeting_id: meetingId, title: data.title, date: data.date, time: data.time })
  )

  return JSON.stringify({ meeting_id: meetingId })
}

function executeEscalate(data: Record<string, unknown>): string {
  console.log(`[action-executor] Escalation: ${JSON.stringify(data)}`)
  return JSON.stringify({ escalated: true, message: data.message ?? 'Escalation logged' })
}

// ─── Main Processing Loop ────────────────────────────────────────────────────

async function processApprovedActions(db: Database.Database, config: SalesConfig): Promise<void> {
  const actions = db.prepare(
    `SELECT id, agent_role, agent_name, product_id, action_type, action_data, priority
     FROM action_queue
     WHERE status = 'approved'
     ORDER BY
       CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       approved_at ASC`
  ).all() as ApprovedAction[]

  if (actions.length === 0) return

  console.log(`[action-executor] Found ${actions.length} approved action(s) to execute`)

  for (const action of actions) {
    try {
      let data: Record<string, unknown>
      try {
        data = JSON.parse(action.action_data)
      } catch {
        throw new Error(`Invalid JSON in action_data: ${action.action_data}`)
      }

      // Carry product_id from the action if not in the data
      if (action.product_id && !data.product_id) {
        data.product_id = action.product_id
      }

      let result: string

      switch (action.action_type) {
        case 'create_lead':
          result = executeCreateLead(db, data)
          break
        case 'update_lead':
          result = executeUpdateLead(db, data)
          break
        case 'create_draft':
          result = executeCreateDraft(db, data)
          break
        case 'send_email':
          result = await executeSendEmail(db, config, data)
          break
        case 'create_recommendation':
          result = executeCreateRecommendation(db, data)
          break
        case 'assign_task':
          result = executeAssignTask(db, data)
          break
        case 'save_learning':
          result = executeSaveLearning(db, data)
          break
        case 'book_meeting':
          result = executeBookMeeting(db, data)
          break
        case 'escalate':
          result = executeEscalate(data)
          break
        default:
          throw new Error(`Unknown action_type: ${action.action_type}`)
      }

      markExecuted(db, action.id, result)
      console.log(`[action-executor] Executed #${action.id} (${action.action_type}) by ${action.agent_name}: ${result}`)

    } catch (err) {
      const errorMsg = (err as Error).message
      markFailed(db, action.id, errorMsg)
      console.error(`[action-executor] Failed #${action.id} (${action.action_type}): ${errorMsg}`)
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function startActionExecutor(db: Database.Database, config: SalesConfig): void {
  if (intervalHandle) {
    console.warn('[action-executor] Already running')
    return
  }

  const INTERVAL_MS = 30_000 // 30 seconds

  console.log('[action-executor] Starting — checking every 30s')

  // Run immediately on start
  processApprovedActions(db, config).catch((err) => {
    console.error('[action-executor] Initial run failed:', (err as Error).message)
  })

  // Then repeat every 30 seconds
  intervalHandle = setInterval(() => {
    processApprovedActions(db, config).catch((err) => {
      console.error('[action-executor] Cycle failed:', (err as Error).message)
    })
  }, INTERVAL_MS)
}

export function stopActionExecutor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
    console.log('[action-executor] Stopped')
  }
}
