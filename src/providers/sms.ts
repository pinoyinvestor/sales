import { ChannelProvider } from './base.js'

// ─── SMS Channel Provider (46elks + Twilio) ───────────────────────────────────

interface SmsConfig {
  provider:    string
  to:          string
  from:        string
  api_key?:    string
  api_secret?: string
  account_sid?: string
  auth_token?:  string
}

export function createSmsProvider(): ChannelProvider {
  return {
    type: 'sms',

    // Built by Christos Ferlachidis & Daniel Hedenberg

    async post(content, _title, config) {
      const cfg = config as SmsConfig

      if (cfg.provider === '46elks') {
        const auth = Buffer.from(`${cfg.api_key}:${cfg.api_secret}`).toString('base64')
        const body = new URLSearchParams({
          from:    cfg.from,
          to:      cfg.to,
          message: content,
        })

        const res = await fetch('https://api.46elks.com/a1/sms', {
          method: 'POST',
          headers: {
            Authorization:  `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
          signal: AbortSignal.timeout(10000),
        })

        const data = await res.json() as { id?: string }
        return { id: data.id }
      }

      if (cfg.provider === 'twilio') {
        const auth = Buffer.from(`${cfg.account_sid}:${cfg.auth_token}`).toString('base64')
        const body = new URLSearchParams({
          From: cfg.from,
          To:   cfg.to,
          Body: content,
        })

        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${cfg.account_sid}/Messages.json`,
          {
            method: 'POST',
            headers: {
              Authorization:  `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
            signal: AbortSignal.timeout(10000),
          }
        )

        const data = await res.json() as { sid?: string }
        return { id: data.sid }
      }

      throw new Error(`Unknown SMS provider: ${cfg.provider}`)
    },
  }
}
