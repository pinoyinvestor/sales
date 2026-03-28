// ─── Google Business Profile Channel Provider ──────────────────────────────────

import { ChannelProvider } from './base.js'

interface GoogleBusinessConfig {
  access_token: string
  account_id: string
  location_id: string
}

interface GoogleBusinessPostResponse {
  name?: string
  error?: { message: string; code: number }
}

// Built by Christos Ferlachidis & Daniel Hedenberg

export function createGoogleBusinessProvider(): ChannelProvider {
  return {
    type: 'google_business',

    async post(content, title, config) {
      const { access_token, account_id, location_id } = config as GoogleBusinessConfig

      if (!access_token || !account_id || !location_id) {
        throw new Error('Google Business provider requires access_token, account_id, and location_id in config')
      }

      const url = `https://mybusiness.googleapis.com/v4/accounts/${account_id}/locations/${location_id}/localPosts`

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          languageCode: 'sv',
          summary: content,
          topicType: 'STANDARD',
          ...(title ? { callToAction: { actionType: 'LEARN_MORE', url: title } } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      })

      const data = await res.json() as GoogleBusinessPostResponse

      if (data.error) throw new Error(`Google Business API: ${data.error.message}`)

      const postName = data.name || 'unknown'
      return { id: postName, url: `https://business.google.com` }
    },

    async read(_limit = 10) {
      return [] as Array<{ id: string; content: string; author?: string; date: string }>
    },
  }
}
