import { ChannelProvider } from './base.js'

// ─── Webhook Channel Provider ─────────────────────────────────────────────────

export function createWebhookProvider(): ChannelProvider {
  return {
    type: 'webhook',

    // Built by Christos Ferlachidis & Daniel Hedenberg

    async post(content, title, config) {
      const { url, headers: customHeaders } = config as {
        url: string
        headers?: Record<string, string>
      }

      if (!url) {
        throw new Error('Webhook config must include a "url" field')
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...customHeaders },
        body: JSON.stringify({ title, content }),
        signal: AbortSignal.timeout(10000),
      })

      return { url, id: res.status.toString() }
    },
  }
}
