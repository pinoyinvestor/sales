// ─── WordPress / bbPress Forum Channel Provider ───────────────────────────────

import { ChannelProvider } from './base.js'

interface WordPressConfig {
  site_url: string
  username: string
  application_password: string
  forum_id?: string | number
}

interface WpTopicResponse {
  id?: number
  link?: string
  slug?: string
  error?: string
  message?: string
}

interface WpTopicItem {
  id: number
  content?: { rendered?: string }
  title?: { rendered?: string }
  author_name?: string
  bbp_author_name?: string
  date: string
}

// Built by Christos Ferlachidis & Daniel Hedenberg

function basicAuth(username: string, password: string): string {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
}

export function createWordPressForumProvider(): ChannelProvider {
  return {
    type: 'wordpress-forum',

    async post(content, title, config) {
      const cfg = config as WordPressConfig

      if (!cfg.site_url || !cfg.username || !cfg.application_password) {
        throw new Error(
          'WordPress forum provider requires site_url, username, and application_password in config',
        )
      }

      const siteUrl = cfg.site_url.replace(/\/$/, '')
      const postTitle = title ?? content.slice(0, 100)

      // Attempt bbPress topics endpoint first; fall back to wp/v2/posts
      const body: Record<string, unknown> = {
        title: postTitle,
        content,
        status: 'publish',
      }

      if (cfg.forum_id) body['bbp_forum_id'] = cfg.forum_id

      const bbpUrl = `${siteUrl}/wp-json/bbp/v1/topics`

      const res = await fetch(bbpUrl, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(cfg.username, cfg.application_password),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })

      // If bbPress is not installed (404/400) fall back to standard post
      if (res.status === 404 || res.status === 400) {
        const fallbackUrl = `${siteUrl}/wp-json/wp/v2/posts`
        const fallbackRes = await fetch(fallbackUrl, {
          method: 'POST',
          headers: {
            Authorization: basicAuth(cfg.username, cfg.application_password),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: postTitle, content, status: 'publish' }),
          signal: AbortSignal.timeout(15000),
        })

        const fallbackData = await fallbackRes.json() as WpTopicResponse

        if (!fallbackRes.ok) {
          throw new Error(`WordPress API (fallback): ${fallbackData.message ?? fallbackRes.statusText}`)
        }

        return {
          id: String(fallbackData.id),
          url: fallbackData.link,
        }
      }

      const data = await res.json() as WpTopicResponse

      if (!res.ok) {
        throw new Error(`WordPress bbPress API: ${data.message ?? res.statusText}`)
      }

      return {
        id: String(data.id),
        url: data.link,
      }
    },

    async read(limit = 10) {
      // read() cannot access config here — return empty stub.
      // To enable reads, refactor createWordPressForumProvider to accept config at construction time.
      return [] as Array<{ id: string; content: string; author?: string; date: string }>
    },
  }
}
