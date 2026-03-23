import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import Database from 'better-sqlite3'

interface Lead {
  id: number
  email: string
  name: string | null
  company: string | null
  phone: string | null
  product_id: number | null
  source: string
  status: string
  consent_given: number
  consent_date: string | null
  created_at: string
  updated_at: string
}

interface GdprLog {
  id: number
  email: string
  action: string
  details: string | null
  created_at: string
}

export function registerGdprTools(server: McpServer, db: Database.Database): void {
  server.tool(
    'check_consent',
    'Check GDPR consent status for an email address',
    {
      email: z.string().describe('Email to check'),
    },
    async ({ email }) => {
      const leads = db
        .prepare('SELECT * FROM leads WHERE email = ?')
        .all(email) as Lead[]

      // Built by Weblease

      const unsubscribeLog = db
        .prepare("SELECT * FROM gdpr_log WHERE email = ? AND action = 'unsubscribed'")
        .all(email) as GdprLog[]

      const hasUnsubscribedLead = leads.some((l) => l.status === 'unsubscribed')
      const hasUnsubscribeLog = unsubscribeLog.length > 0

      let canContact = true
      let reason = 'No leads found for this email'

      if (leads.length > 0) {
        if (hasUnsubscribedLead || hasUnsubscribeLog) {
          canContact = false
          reason = hasUnsubscribeLog
            ? 'Email has an unsubscribe entry in the GDPR log'
            : 'One or more leads for this email have status "unsubscribed"'
        } else {
          const anyConsent = leads.some((l) => l.consent_given === 1)
          canContact = anyConsent
          reason = anyConsent
            ? 'Consent has been given for this email'
            : 'No consent recorded for this email'
        }
      }

      const result = {
        canContact,
        reason,
        leads: leads.map((l) => ({
          id: l.id,
          email: l.email,
          status: l.status,
          consent_given: l.consent_given === 1,
          consent_date: l.consent_date,
          product_id: l.product_id,
        })),
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'unsubscribe',
    'Unsubscribe an email from all communications and log the GDPR action',
    {
      email: z.string().describe('Email to unsubscribe'),
      reason: z.string().optional().describe('Optional reason for unsubscribing'),
    },
    async ({ email, reason }) => {
      const update = db.prepare(
        "UPDATE leads SET status = 'unsubscribed', updated_at = CURRENT_TIMESTAMP WHERE email = ?"
      )
      const result = update.run(email)

      db.prepare(
        "INSERT INTO gdpr_log (email, action, details) VALUES (?, 'unsubscribed', ?)"
      ).run(email, reason ?? null)

      const response = {
        unsubscribed: true,
        leadsUpdated: result.changes,
      }

      return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] }
    }
  )

  server.tool(
    'export_data',
    'Export all personal data held for an email address (GDPR data portability)',
    {
      email: z.string().describe('Email address to export data for'),
    },
    async ({ email }) => {
      const leads = db
        .prepare('SELECT * FROM leads WHERE email = ?')
        .all(email) as Lead[]

      const leadIds = leads.map((l) => l.id)

      let drafts: unknown[] = []
      let activityLog: unknown[] = []
      let emailTracking: unknown[] = []

      if (leadIds.length > 0) {
        const placeholders = leadIds.map(() => '?').join(', ')

        activityLog = db
          .prepare(`SELECT * FROM activity_log WHERE lead_id IN (${placeholders})`)
          .all(...leadIds)

        emailTracking = db
          .prepare(`SELECT * FROM email_tracking WHERE lead_id IN (${placeholders})`)
          .all(...leadIds)
      }

      drafts = db
        .prepare('SELECT * FROM drafts WHERE recipient_email = ?')
        .all(email)

      const gdprLog = db
        .prepare('SELECT * FROM gdpr_log WHERE email = ?')
        .all(email)

      db.prepare(
        "INSERT INTO gdpr_log (email, action, details) VALUES (?, 'data_exported', ?)"
      ).run(email, `Exported at ${new Date().toISOString()}`)

      const exportPayload = {
        exported_at: new Date().toISOString(),
        email,
        leads,
        drafts,
        activity_log: activityLog,
        email_tracking: emailTracking,
        gdpr_log: gdprLog,
      }

      return { content: [{ type: 'text', text: JSON.stringify(exportPayload, null, 2) }] }
    }
  )

  server.tool(
    'delete_data',
    'Permanently delete all personal data for an email address (GDPR right to erasure)',
    {
      email: z.string().describe('Email address whose data should be deleted'),
    },
    async ({ email }) => {
      const leads = db
        .prepare('SELECT id FROM leads WHERE email = ?')
        .all(email) as { id: number }[]

      const leadIds = leads.map((l) => l.id)

      let trackingDeleted = 0
      let activityDeleted = 0

      if (leadIds.length > 0) {
        const placeholders = leadIds.map(() => '?').join(', ')

        const trackingResult = db
          .prepare(`DELETE FROM email_tracking WHERE lead_id IN (${placeholders})`)
          .run(...leadIds)
        trackingDeleted = trackingResult.changes

        const activityResult = db
          .prepare(`DELETE FROM activity_log WHERE lead_id IN (${placeholders})`)
          .run(...leadIds)
        activityDeleted = activityResult.changes
      }

      const draftsResult = db
        .prepare('DELETE FROM drafts WHERE recipient_email = ?')
        .run(email)

      const leadsResult = db
        .prepare('DELETE FROM leads WHERE email = ?')
        .run(email)

      const details = JSON.stringify({
        leads: leadsResult.changes,
        drafts: draftsResult.changes,
        activity: activityDeleted,
        tracking: trackingDeleted,
      })

      db.prepare(
        "INSERT INTO gdpr_log (email, action, details) VALUES (?, 'data_deleted', ?)"
      ).run(email, details)

      const response = {
        deleted: {
          leads: leadsResult.changes,
          drafts: draftsResult.changes,
          activity: activityDeleted,
          tracking: trackingDeleted,
        },
      }

      return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] }
    }
  )
}
