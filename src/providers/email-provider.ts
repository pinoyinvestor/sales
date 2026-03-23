import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import type { EmailConfig } from '../utils/config.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReadEmailsOptions {
  folder?:     string
  limit?:      number
  unreadOnly?: boolean
  search?:     string
}

export interface EmailMessage {
  id:      string
  from:    string
  to:      string
  subject: string
  body:    string
  date:    string
  read:    boolean
}

export interface SendEmailOptions {
  to:          string
  subject:     string
  html:        string
  inReplyTo?:  string
  headers?:    Record<string, string>
}

export interface ReplyEmailOptions {
  messageId: string
  to:        string
  subject:   string
  html:      string
}

export interface SendResult {
  messageId: string
}

// Built by Weblease

// ─── Email Provider Factory ───────────────────────────────────────────────────

export function createEmailProvider(config: EmailConfig) {

  // ── Read emails via IMAP ──────────────────────────────────────────────────

  async function readEmails(opts: ReadEmailsOptions = {}): Promise<EmailMessage[]> {
    const folder     = opts.folder     ?? 'INBOX'
    const limit      = opts.limit      ?? 20
    const unreadOnly = opts.unreadOnly ?? false

    const client = new ImapFlow({
      host:   config.imap.host,
      port:   config.imap.port,
      secure: config.imap.tls,
      auth: {
        user: config.user,
        pass: config.pass,
      },
      logger: false,
    })

    await client.connect()

    const messages: EmailMessage[] = []

    try {
      await client.mailboxOpen(folder)

      // Build search criteria
      let searchCriteria: string | string[] | Record<string, unknown> = 'ALL'
      if (unreadOnly && opts.search) {
        searchCriteria = { and: [{ unseen: true }, { text: opts.search }] } as unknown as Record<string, unknown>
      } else if (unreadOnly) {
        searchCriteria = { unseen: true } as unknown as Record<string, unknown>
      } else if (opts.search) {
        searchCriteria = { text: opts.search } as unknown as Record<string, unknown>
      }

      const uids = await client.search(searchCriteria as Parameters<typeof client.search>[0], { uid: true })

      // Take the most recent `limit` UIDs
      const targetUids = uids.slice(-limit)

      if (targetUids.length === 0) {
        return []
      }

      const uidRange = targetUids.join(',')

      for await (const msg of client.fetch(uidRange, { envelope: true, source: true, flags: true }, { uid: true })) {
        const envelope = msg.envelope
        const source   = msg.source?.toString('utf-8') ?? ''
        const flags    = msg.flags ?? new Set<string>()

        // Extract plain body from raw source (after double newline)
        const bodyMatch = source.match(/\r?\n\r?\n([\s\S]*)/)
        const body      = bodyMatch ? bodyMatch[1].trim() : source

        messages.push({
          id:      String(msg.uid),
          from:    envelope?.from?.[0]?.address ?? '',
          to:      envelope?.to?.[0]?.address   ?? '',
          subject: envelope?.subject             ?? '(no subject)',
          body,
          date:    envelope?.date?.toISOString() ?? new Date().toISOString(),
          read:    flags.has('\\Seen'),
        })
      }
    } finally {
      await client.logout()
    }

    return messages
  }

  // ── Send email via SMTP ───────────────────────────────────────────────────

  async function sendEmail(opts: SendEmailOptions): Promise<SendResult> {
    const transport = nodemailer.createTransport({
      host:   config.smtp.host,
      port:   config.smtp.port,
      secure: config.smtp.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
    })

    try {
      const extraHeaders: Record<string, string> = opts.headers ?? {}
      if (opts.inReplyTo) {
        extraHeaders['In-Reply-To'] = opts.inReplyTo
        extraHeaders['References']  = opts.inReplyTo
      }

      const info = await transport.sendMail({
        from:    config.user,
        to:      opts.to,
        subject: opts.subject,
        html:    opts.html,
        headers: extraHeaders,
      })

      return { messageId: info.messageId }
    } finally {
      transport.close()
    }
  }

  // ── Reply to email ────────────────────────────────────────────────────────

  async function replyEmail(opts: ReplyEmailOptions): Promise<SendResult> {
    return sendEmail({
      to:         opts.to,
      subject:    opts.subject.startsWith('Re:') ? opts.subject : `Re: ${opts.subject}`,
      html:       opts.html,
      inReplyTo:  opts.messageId,
    })
  }

  return { readEmails, sendEmail, replyEmail }
}
