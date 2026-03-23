// ─── Instagram Channel Provider ───────────────────────────────────────────────

import { ChannelProvider } from './base.js'

interface InstagramConfig {
  ig_user_id: string
  access_token: string
  image_url?: string
}

interface IgMediaResponse {
  id?: string
  error?: { message: string }
}

interface IgPublishResponse {
  id?: string
  error?: { message: string }
}

// Built by Weblease

export function createInstagramProvider(): ChannelProvider {
  return {
    type: 'instagram',

    async post(content, _title, config) {
      const { ig_user_id, access_token, image_url } = config as InstagramConfig

      if (!ig_user_id || !access_token) {
        throw new Error('Instagram provider requires ig_user_id and access_token in config')
      }

      if (!image_url) {
        throw new Error(
          'Instagram API requires an image_url — Instagram does not support text-only posts. ' +
          'Provide image_url in config.',
        )
      }

      // Step 1: create media container
      const mediaRes = await fetch(
        `https://graph.facebook.com/v19.0/${ig_user_id}/media`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_url, caption: content, access_token }),
          signal: AbortSignal.timeout(15000),
        },
      )

      const mediaData = await mediaRes.json() as IgMediaResponse

      if (mediaData.error) throw new Error(`Instagram API (media): ${mediaData.error.message}`)
      if (!mediaData.id) throw new Error('Instagram API: no creation_id returned from media endpoint')

      const creation_id = mediaData.id

      // Step 2: publish the container
      const publishRes = await fetch(
        `https://graph.facebook.com/v19.0/${ig_user_id}/media_publish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creation_id, access_token }),
          signal: AbortSignal.timeout(15000),
        },
      )

      const publishData = await publishRes.json() as IgPublishResponse

      if (publishData.error) throw new Error(`Instagram API (publish): ${publishData.error.message}`)
      if (!publishData.id) throw new Error('Instagram API: no post ID returned from publish endpoint')

      return {
        id: publishData.id,
        url: `https://www.instagram.com/p/${publishData.id}/`,
      }
    },

    async read(_limit = 10) {
      // Instagram media reads require ig_user_id + access_token via config context.
      // Return empty stub — wire config through a closure if needed.
      return [] as Array<{ id: string; content: string; author?: string; date: string }>
    },
  }
}
