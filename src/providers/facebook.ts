// ─── Facebook Channel Provider ────────────────────────────────────────────────

import { ChannelProvider } from './base.js'

interface FacebookConfig {
  page_id: string
  access_token: string
}

interface FacebookPostResponse {
  id?: string
  error?: { message: string }
}

interface FacebookFeedItem {
  id: string
  message?: string
  from?: { name: string }
  created_time: string
}

interface FacebookFeedResponse {
  data?: FacebookFeedItem[]
  error?: { message: string }
}

// Built by Weblease

export function createFacebookProvider(): ChannelProvider {
  return {
    type: 'facebook',

    async post(content, _title, config) {
      const { page_id, access_token } = config as FacebookConfig

      if (!page_id || !access_token) {
        throw new Error('Facebook provider requires page_id and access_token in config')
      }

      const res = await fetch(`https://graph.facebook.com/v19.0/${page_id}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content, access_token }),
        signal: AbortSignal.timeout(15000),
      })

      const data = await res.json() as FacebookPostResponse

      if (data.error) throw new Error(`Facebook API: ${data.error.message}`)
      if (!data.id) throw new Error('Facebook API: no post ID returned')

      return { id: data.id, url: `https://facebook.com/${data.id}` }
    },

    async read(limit = 10) {
      // Full read requires page_id + access_token via config context.
      // This stub returns empty — wire config through a closure if needed.
      return [] as Array<{ id: string; content: string; author?: string; date: string }>
    },
  }
}
