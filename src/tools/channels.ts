import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import Database from 'better-sqlite3'
import { ProviderRegistry } from '../providers/base.js'
import { checkRateLimit } from '../utils/rate-limiter.js'
import { decrypt } from '../utils/crypto.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChannelRow {
  id:           number
  type:         string
  name:         string
  credentials:  string | null
  config:       string | null
  enabled:      number
  last_used_at: string | null
  last_error:   string | null
  created_at:   string
}

// Built by Weblease

// ─── Credential Masking ───────────────────────────────────────────────────────

function maskCredentials(channel: ChannelRow): Record<string, unknown> {
  const { credentials, ...rest } = channel
  return {
    ...rest,
    credentials: credentials ? '***' : null,
  }
}

// ─── Tool Registration ────────────────────────────────────────────────────────

export function registerChannelTools(
  server:           McpServer,
  db:               Database.Database,
  providerRegistry: ProviderRegistry
): void {

  // ── Tool 1: list_channels ──────────────────────────────────────────────────

  server.tool(
    'list_channels',
    'List all configured channels. Credentials are masked in the response.',
    {},
    async () => {
      const rows = db
        .prepare('SELECT * FROM channels ORDER BY created_at DESC')
        .all() as ChannelRow[]

      const masked = rows.map(maskCredentials)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(masked, null, 2) }],
      }
    }
  )

  // ── Tool 2: post_to_channel ────────────────────────────────────────────────

  server.tool(
    'post_to_channel',
    'Post content to a channel using its configured provider',
    {
      channel_id:   z.number().int().positive().optional().describe('Channel ID (use this or channel_name)'),
      channel_name: z.string().optional().describe('Channel name (use this or channel_id)'),
      content:      z.string().describe('Content to post (required)'),
      title:        z.string().optional().describe('Optional title for the post'),
      product:      z.string().optional().describe('Product slug to associate with the activity log entry'),
    },
    async ({ channel_id, channel_name, content, title, product }) => {
      // ── Resolve channel ──────────────────────────────────────────────────
      let channel: ChannelRow | undefined

      if (channel_id != null) {
        channel = db
          .prepare('SELECT * FROM channels WHERE id = ?')
          .get(channel_id) as ChannelRow | undefined
      } else if (channel_name) {
        channel = db
          .prepare('SELECT * FROM channels WHERE name = ?')
          .get(channel_name) as ChannelRow | undefined
      } else {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'MISSING_CHANNEL', message: 'Provide channel_id or channel_name' }),
          }],
        }
      }

      if (!channel) {
        const key = channel_id != null ? `id ${channel_id}` : `name "${channel_name}"`
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'CHANNEL_NOT_FOUND', message: `Channel with ${key} not found` }),
          }],
        }
      }

      // ── Check enabled ────────────────────────────────────────────────────
      if (!channel.enabled) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'CHANNEL_DISABLED', message: `Channel "${channel.name}" is disabled` }),
          }],
        }
      }

      // ── Check rate limit ─────────────────────────────────────────────────
      const rateResult = checkRateLimit(db, channel.id)
      if (!rateResult.allowed) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error:      'RATE_LIMITED',
              message:    rateResult.reason,
              retryAfter: rateResult.retryAfter,
            }),
          }],
        }
      }

      // ── Get provider ─────────────────────────────────────────────────────
      const provider = providerRegistry.get(channel.type)
      if (!provider) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'PROVIDER_NOT_FOUND', message: `No provider registered for channel type "${channel.type}"` }),
          }],
        }
      }

      // ── Decrypt credentials ───────────────────────────────────────────────
      let parsedCredentials: Record<string, unknown> = {}
      if (channel.credentials) {
        try {
          const decrypted = decrypt(channel.credentials)
          parsedCredentials = JSON.parse(decrypted)
        } catch (err) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'CREDENTIAL_ERROR', message: `Failed to decrypt credentials: ${(err as Error).message}` }),
            }],
          }
        }
      }

      // ── Call provider ─────────────────────────────────────────────────────
      let postResult: { url?: string; id?: string }
      try {
        postResult = await provider.post(content, title, parsedCredentials)
      } catch (err) {
        const message = (err as Error).message
        db.prepare('UPDATE channels SET last_error = ? WHERE id = ?').run(message, channel.id)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'POST_FAILED', message }),
          }],
        }
      }

      // ── Update last_used_at ───────────────────────────────────────────────
      const nowIso = new Date().toISOString()
      db.prepare('UPDATE channels SET last_used_at = ?, last_error = NULL WHERE id = ?').run(nowIso, channel.id)

      // ── Resolve product_id for activity log ───────────────────────────────
      let productId: number | null = null
      if (product) {
        const productRow = db
          .prepare('SELECT id FROM products WHERE name = ?')
          .get(product) as { id: number } | undefined
        productId = productRow?.id ?? null
      }

      // ── Log to activity_log ───────────────────────────────────────────────
      db.prepare(
        `INSERT INTO activity_log (product_id, channel_id, action, details)
         VALUES (?, ?, 'post_published', ?)`
      ).run(
        productId,
        channel.id,
        JSON.stringify({ title: title ?? null, external_id: postResult.id ?? null, url: postResult.url ?? null })
      )

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success:  true,
            channel:  channel.name,
            type:     channel.type,
            result:   postResult,
            postedAt: nowIso,
          }),
        }],
      }
    }
  )

  // ── Tool 3: read_channel ───────────────────────────────────────────────────

  server.tool(
    'read_channel',
    'Read recent posts from a channel (only supported by providers that implement read())',
    {
      channel_id: z.number().int().positive().describe('Channel ID (required)'),
      limit:      z.number().int().positive().optional().default(10).describe('Number of posts to retrieve (default: 10)'),
    },
    async ({ channel_id, limit }) => {
      const channel = db
        .prepare('SELECT * FROM channels WHERE id = ?')
        .get(channel_id) as ChannelRow | undefined

      if (!channel) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'CHANNEL_NOT_FOUND', message: `Channel with id ${channel_id} not found` }),
          }],
        }
      }

      const provider = providerRegistry.get(channel.type)
      if (!provider) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'PROVIDER_NOT_FOUND', message: `No provider registered for channel type "${channel.type}"` }),
          }],
        }
      }

      if (typeof provider.read !== 'function') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'READ_NOT_SUPPORTED', message: 'This channel type does not support reading' }),
          }],
        }
      }

      try {
        const posts = await provider.read(limit)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ channel: channel.name, type: channel.type, posts }),
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'READ_FAILED', message: (err as Error).message }),
          }],
        }
      }
    }
  )
}
