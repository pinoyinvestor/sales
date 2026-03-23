// ─── Reddit Channel Provider ──────────────────────────────────────────────────

import { ChannelProvider } from './base.js'

interface RedditConfig {
  client_id: string
  client_secret: string
  refresh_token: string
  subreddit: string
  username: string
}

interface RedditTokenResponse {
  access_token?: string
  error?: string
}

interface RedditSubmitResponse {
  json?: {
    errors?: [string, string, string][]
    data?: { url?: string; id?: string; name?: string }
  }
}

interface RedditPost {
  id: string
  selftext: string
  author: string
  created_utc: number
}

interface RedditListingResponse {
  data?: {
    children?: Array<{ data: RedditPost }>
  }
}

// Built by Weblease

async function getAccessToken(config: RedditConfig): Promise<string> {
  const credentials = Buffer.from(`${config.client_id}:${config.client_secret}`).toString('base64')

  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': `sales-mcp/1.0 by ${config.username}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.refresh_token,
    }).toString(),
    signal: AbortSignal.timeout(10000),
  })

  const data = await res.json() as RedditTokenResponse

  if (data.error) throw new Error(`Reddit OAuth: ${data.error}`)
  if (!data.access_token) throw new Error('Reddit OAuth: no access_token returned')

  return data.access_token
}

export function createRedditProvider(): ChannelProvider {
  return {
    type: 'reddit',

    async post(content, title, config) {
      const cfg = config as RedditConfig

      if (!cfg.client_id || !cfg.client_secret || !cfg.refresh_token || !cfg.subreddit) {
        throw new Error(
          'Reddit provider requires client_id, client_secret, refresh_token, subreddit, and username in config',
        )
      }

      const accessToken = await getAccessToken(cfg)

      const res = await fetch('https://oauth.reddit.com/api/submit', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': `sales-mcp/1.0 by ${cfg.username}`,
        },
        body: new URLSearchParams({
          sr: cfg.subreddit,
          kind: 'self',
          title: title ?? content.slice(0, 100),
          text: content,
          resubmit: 'true',
        }).toString(),
        signal: AbortSignal.timeout(15000),
      })

      const data = await res.json() as RedditSubmitResponse

      const errors = data.json?.errors
      if (errors && errors.length > 0) {
        throw new Error(`Reddit API: ${errors.map(e => e[1]).join(', ')}`)
      }

      const postData = data.json?.data
      return {
        id: postData?.name ?? postData?.id,
        url: postData?.url,
      }
    },

    async read(limit = 10) {
      // read() cannot access config directly — return empty stub.
      // To enable reads, refactor createRedditProvider to accept config at construction time.
      return [] as Array<{ id: string; content: string; author?: string; date: string }>
    },
  }
}
