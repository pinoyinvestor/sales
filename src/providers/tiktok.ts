// ─── TikTok Business Channel Provider ──────────────────────────────────────────

import { ChannelProvider } from './base.js'

interface TikTokConfig {
  access_token: string
}

interface TikTokPostResponse {
  data?: { publish_id: string }
  error?: { code: string; message: string }
}

// Built by Weblease

export function createTikTokProvider(): ChannelProvider {
  return {
    type: 'tiktok',

    async post(content, _title, config) {
      const { access_token } = config as TikTokConfig

      if (!access_token) {
        throw new Error('TikTok provider requires access_token in config')
      }

      // TikTok Content Posting API requires video upload in multiple steps:
      // 1. Initialize upload via /v2/post/publish/content/init/
      // 2. Upload video file chunks
      // 3. Confirm publish
      // This stub sends the init request — full video upload needs file handling.

      const res = await fetch('https://open.tiktokapis.com/v2/post/publish/content/init/', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({
          post_info: {
            title: content.slice(0, 150),
            privacy_level: 'SELF_ONLY',
          },
          source_info: {
            source: 'PULL_FROM_URL',
            video_url: '',
          },
        }),
        signal: AbortSignal.timeout(15000),
      })

      const data = await res.json() as TikTokPostResponse

      if (data.error) throw new Error(`TikTok API: ${data.error.message}`)

      const publishId = data.data?.publish_id || 'pending'
      return { id: publishId, url: `https://www.tiktok.com` }
    },

    async read(_limit = 10) {
      return [] as Array<{ id: string; content: string; author?: string; date: string }>
    },
  }
}
