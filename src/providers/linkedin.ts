// ─── LinkedIn Company Page Channel Provider ────────────────────────────────────

import { ChannelProvider } from './base.js'

interface LinkedInConfig {
  access_token: string
  organization_id: string
}

interface LinkedInPostResponse {
  id?: string
  message?: string
  status?: number
}

// Built by Christos Ferlachidis & Daniel Hedenberg

export function createLinkedInProvider(): ChannelProvider {
  return {
    type: 'linkedin',

    async post(content, _title, config) {
      const { access_token, organization_id } = config as LinkedInConfig

      if (!access_token || !organization_id) {
        throw new Error('LinkedIn provider requires access_token and organization_id in config')
      }

      const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
        },
        body: JSON.stringify({
          author: `urn:li:organization:${organization_id}`,
          lifecycleState: 'PUBLISHED',
          specificContent: {
            'com.linkedin.ugc.ShareContent': {
              shareCommentary: { text: content },
              shareMediaCategory: 'NONE',
            },
          },
          visibility: {
            'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
          },
        }),
        signal: AbortSignal.timeout(15000),
      })

      const data = await res.json() as LinkedInPostResponse

      if (data.status && data.status >= 400) {
        throw new Error(`LinkedIn API: ${data.message || 'Unknown error'}`)
      }

      const postId = data.id || 'unknown'
      return { id: postId, url: `https://www.linkedin.com/feed/update/${postId}` }
    },

    async read(_limit = 10) {
      return [] as Array<{ id: string; content: string; author?: string; date: string }>
    },
  }
}
