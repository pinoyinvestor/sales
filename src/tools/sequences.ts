import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import Database from 'better-sqlite3'

interface SequenceStep {
  order?: number
  type?: string
  delay_hours?: number
  template?: string
  day?: number
  template_name?: string
  channel_type?: string
  [key: string]: unknown
}

interface Sequence {
  id: number
  product_id: number | null
  name: string
  description: string | null
  steps: string
  enabled: number
  created_at: string
}

interface Lead {
  id: number
  email: string
  name: string | null
  company: string | null
  phone: string | null
  product_id: number | null
  source: string
  status: string
  sequence_id: number | null
  sequence_step: number
  sequence_paused: number
  last_contacted_at: string | null
  notes: string | null
  tags: string | null
  consent_given: number
  consent_date: string | null
  created_at: string
  updated_at: string
  product?: string
}

// Built by Christos Ferlachidis & Daniel Hedenberg

export function registerSequenceTools(server: McpServer, db: Database.Database): void {

  // ── Tool 1: get_sequences ─────────────────────────────────────────────────

  server.tool(
    'get_sequences',
    'Get all sequences, optionally filtered by product',
    {
      product: z.string().optional().describe('Product name to filter sequences by'),
    },
    async (params) => {
      const conditions: string[] = []
      const args: unknown[] = []

      if (params.product) {
        conditions.push('p.name = ?')
        args.push(params.product)
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

      const rows = db.prepare(`
        SELECT
          s.id, s.name, s.description, s.steps, s.enabled, s.created_at,
          p.name AS product, p.display_name AS product_display_name
        FROM sequences s
        LEFT JOIN products p ON p.id = s.product_id
        ${where}
        ORDER BY s.created_at DESC
      `).all(...args)

      return { content: [{ type: 'text' as const, text: JSON.stringify(rows) }] }
    }
  )

  // ── Tool 2: create_sequence ───────────────────────────────────────────────

  server.tool(
    'create_sequence',
    'Create a new outreach sequence for a product with defined steps',
    {
      product:     z.string().describe('Product name (required)'),
      name:        z.string().describe('Sequence name (required)'),
      description: z.string().optional().describe('Optional description of the sequence'),
      steps:       z.string().describe('JSON array of steps: [{day: number, template_name: string, channel_type: string}]'),
    },
    async (params) => {
      // Validate steps JSON
      let parsedSteps: SequenceStep[]
      try {
        parsedSteps = JSON.parse(params.steps)
        if (!Array.isArray(parsedSteps)) throw new Error('steps must be an array')
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'INVALID_STEPS', message: `steps must be a valid JSON array: ${(err as Error).message}` }),
          }],
        }
      }

      // Resolve product
      const product = db.prepare('SELECT id FROM products WHERE name = ?').get(params.product) as { id: number } | undefined
      if (!product) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'PRODUCT_NOT_FOUND', message: `Product "${params.product}" does not exist` }),
          }],
        }
      }

      const result = db.prepare(`
        INSERT INTO sequences (product_id, name, description, steps)
        VALUES (?, ?, ?, ?)
      `).run(product.id, params.name, params.description ?? null, JSON.stringify(parsedSteps))

      const sequence = db.prepare(`
        SELECT s.*, p.name AS product, p.display_name AS product_display_name
        FROM sequences s
        LEFT JOIN products p ON p.id = s.product_id
        WHERE s.id = ?
      `).get(result.lastInsertRowid)

      return { content: [{ type: 'text' as const, text: JSON.stringify(sequence) }] }
    }
  )

  // ── Tool 3: advance_lead ──────────────────────────────────────────────────

  server.tool(
    'advance_lead',
    'Advance a lead to the next step in its sequence if the step timing is due',
    {
      lead_id: z.number().describe('Lead ID (required)'),
    },
    async (params) => {
      const lead = db.prepare(`
        SELECT l.*, p.name AS product
        FROM leads l
        LEFT JOIN products p ON p.id = l.product_id
        WHERE l.id = ?
      `).get(params.lead_id) as Lead | undefined

      if (!lead) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'LEAD_NOT_FOUND', message: `Lead ${params.lead_id} does not exist` }),
          }],
        }
      }

      if (!lead.sequence_id) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'NO_SEQUENCE', message: 'Lead is not enrolled in a sequence' }),
          }],
        }
      }

      const sequence = db.prepare('SELECT * FROM sequences WHERE id = ?').get(lead.sequence_id) as Sequence | undefined
      if (!sequence) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'SEQUENCE_NOT_FOUND', message: `Sequence ${lead.sequence_id} does not exist` }),
          }],
        }
      }

      let steps: SequenceStep[]
      try {
        steps = JSON.parse(sequence.steps)
      } catch {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'INVALID_SEQUENCE_STEPS', message: 'Sequence steps could not be parsed' }),
          }],
        }
      }

      const currentStep = steps[lead.sequence_step]
      if (!currentStep) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ advanced: false, reason: 'Sequence completed — no more steps', lead }),
          }],
        }
      }

      // Check timing
      const now = new Date()
      if (lead.last_contacted_at !== null) {
        const lastContacted = new Date(lead.last_contacted_at)
        const delayMs = currentStep.delay_hours !== undefined ? currentStep.delay_hours * 60 * 60 * 1000 : (currentStep.day || 0) * 24 * 60 * 60 * 1000
        const dueDate = new Date(lastContacted.getTime() + delayMs)
        if (now < dueDate) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ advanced: false, reason: 'Not due yet', nextDue: dueDate.toISOString() }),
            }],
          }
        }
      }

      // Advance the step
      const nowIso = now.toISOString()
      db.prepare(`
        UPDATE leads
        SET sequence_step = sequence_step + 1,
            last_contacted_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(nowIso, nowIso, params.lead_id)

      // Log activity
      db.prepare(`
        INSERT INTO activity_log (product_id, lead_id, action, details)
        VALUES (?, ?, 'sequence_advanced', ?)
      `).run(
        lead.product_id,
        params.lead_id,
        JSON.stringify({ step: lead.sequence_step, template_name: currentStep.template_name, channel_type: currentStep.channel_type }),
      )

      const updatedLead = db.prepare(`
        SELECT l.*, p.name AS product
        FROM leads l
        LEFT JOIN products p ON p.id = l.product_id
        WHERE l.id = ?
      `).get(params.lead_id)

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ advanced: true, step: currentStep, lead: updatedLead }),
        }],
      }
    }
  )

  // ── Tool 4: pause_sequence ────────────────────────────────────────────────

  server.tool(
    'pause_sequence',
    'Pause a lead\'s sequence progression',
    {
      lead_id: z.number().describe('Lead ID (required)'),
      reason:  z.string().optional().describe('Optional reason for pausing'),
    },
    async (params) => {
      const lead = db.prepare('SELECT id, product_id FROM leads WHERE id = ?').get(params.lead_id) as { id: number; product_id: number | null } | undefined
      if (!lead) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'LEAD_NOT_FOUND', message: `Lead ${params.lead_id} does not exist` }),
          }],
        }
      }

      const nowIso = new Date().toISOString()
      db.prepare(`
        UPDATE leads
        SET sequence_paused = 1, updated_at = ?
        WHERE id = ?
      `).run(nowIso, params.lead_id)

      db.prepare(`
        INSERT INTO activity_log (product_id, lead_id, action, details)
        VALUES (?, ?, 'sequence_paused', ?)
      `).run(
        lead.product_id,
        params.lead_id,
        JSON.stringify({ reason: params.reason ?? null }),
      )

      return { content: [{ type: 'text' as const, text: JSON.stringify({ paused: true }) }] }
    }
  )

  // ── Tool 5: remove_from_sequence ──────────────────────────────────────────

  server.tool(
    'remove_from_sequence',
    'Remove a lead from its current sequence and reset sequence state',
    {
      lead_id: z.number().describe('Lead ID (required)'),
    },
    async (params) => {
      const lead = db.prepare('SELECT id, product_id FROM leads WHERE id = ?').get(params.lead_id) as { id: number; product_id: number | null } | undefined
      if (!lead) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'LEAD_NOT_FOUND', message: `Lead ${params.lead_id} does not exist` }),
          }],
        }
      }

      const nowIso = new Date().toISOString()
      db.prepare(`
        UPDATE leads
        SET sequence_id = NULL, sequence_step = 0, sequence_paused = 0, updated_at = ?
        WHERE id = ?
      `).run(nowIso, params.lead_id)

      db.prepare(`
        INSERT INTO activity_log (product_id, lead_id, action, details)
        VALUES (?, ?, 'sequence_removed', ?)
      `).run(lead.product_id, params.lead_id, JSON.stringify({}))

      return { content: [{ type: 'text' as const, text: JSON.stringify({ removed: true }) }] }
    }
  )

  // ── Tool 6: get_due_leads ─────────────────────────────────────────────────

  server.tool(
    'get_due_leads',
    'Get leads whose next sequence step is due for outreach',
    {
      product: z.string().optional().describe('Product name to filter by'),
    },
    async (params) => {
      const conditions: string[] = [
        "l.sequence_id IS NOT NULL",
        "l.sequence_paused = 0",
        "l.status NOT IN ('unsubscribed', 'lost', 'converted')",
      ]
      const args: unknown[] = []

      if (params.product) {
        conditions.push('p.name = ?')
        args.push(params.product)
      }

      const where = `WHERE ${conditions.join(' AND ')}`

      const leads = db.prepare(`
        SELECT
          l.*,
          p.name AS product,
          s.steps AS sequence_steps
        FROM leads l
        LEFT JOIN products p ON p.id = l.product_id
        LEFT JOIN sequences s ON s.id = l.sequence_id
        ${where}
        ORDER BY l.last_contacted_at ASC
      `).all(...args) as (Lead & { sequence_steps: string })[]

      const now = new Date()
      const dueLeads: { lead: Lead; nextStep: SequenceStep; dueDate: string }[] = []

      for (const row of leads) {
        let steps: SequenceStep[]
        try {
          steps = JSON.parse(row.sequence_steps)
        } catch {
          continue
        }

        const nextStep = steps[row.sequence_step]
        if (!nextStep) continue // sequence completed

        let dueDate: Date
        if (row.last_contacted_at === null) {
          // Never contacted — always due immediately
          dueDate = new Date(0)
        } else {
          const lastContacted = new Date(row.last_contacted_at)
          const stepDelayMs = nextStep.delay_hours !== undefined ? nextStep.delay_hours * 60 * 60 * 1000 : (nextStep.day || 0) * 24 * 60 * 60 * 1000
          dueDate = new Date(lastContacted.getTime() + stepDelayMs)
        }

        if (now >= dueDate) {
          const { sequence_steps: _steps, ...leadData } = row
          dueLeads.push({ lead: leadData as Lead, nextStep, dueDate: dueDate.toISOString() })
        }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(dueLeads) }] }
    }
  )
}
