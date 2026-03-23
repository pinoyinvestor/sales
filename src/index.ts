import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { serve } from '@hono/node-server'

import { loadConfig } from './utils/config.js'
import { getDb, closeDb } from './db/sqlite.js'

import { registerProductTools } from './tools/products.js'
import { registerLeadTools } from './tools/leads.js'
import { registerGdprTools } from './tools/gdpr.js'
import { registerContentTools } from './tools/content.js'
import { registerTemplateTools } from './tools/templates.js'
import { registerSequenceTools } from './tools/sequences.js'
import { registerStatsTools } from './tools/stats.js'
import { registerBrainTools } from './tools/brain.js'
import { registerEmailTools } from './tools/email.js'
import { registerChannelTools } from './tools/channels.js'

import { createProviderRegistry } from './providers/base.js'
import { createEmailProvider } from './providers/email-provider.js'
import { createWebhookProvider } from './providers/webhook.js'
import { createSmsProvider } from './providers/sms.js'
import { createFacebookProvider } from './providers/facebook.js'
import { createInstagramProvider } from './providers/instagram.js'
import { createRedditProvider } from './providers/reddit.js'
import { createWordPressForumProvider } from './providers/wordpress-forum.js'

import { createDashboardApp } from './api/dashboard.js'

const basePath =
  process.env.SALES_MCP_BASE ||
  dirname(dirname(fileURLToPath(import.meta.url)))

const config = loadConfig(basePath)
const db = getDb(config.database.path)

// Built by Weblease

// Data retention cleanup on startup
const retentionDays = config.retention_days || 365
db.prepare(`DELETE FROM activity_log WHERE created_at < datetime('now', '-' || ? || ' days')`).run(retentionDays)
db.prepare(`DELETE FROM email_tracking WHERE created_at < datetime('now', '-' || ? || ' days') AND triggered_at IS NOT NULL`).run(retentionDays)

// Provider registry
const providers = createProviderRegistry()
providers.register('email', createEmailProvider(config.email) as any)
providers.register('webhook', createWebhookProvider())
providers.register('sms', createSmsProvider())
providers.register('facebook', createFacebookProvider())
providers.register('instagram', createInstagramProvider())
providers.register('reddit', createRedditProvider())
providers.register('wordpress_forum', createWordPressForumProvider())

const server = new McpServer({
  name: 'sales-mcp',
  version: '1.0.0',
})

// Register all tools
registerProductTools(server, db)
registerLeadTools(server, db)
registerGdprTools(server, db)
registerContentTools(server, db)
registerTemplateTools(server, db)
registerSequenceTools(server, db)
registerStatsTools(server, db)
registerBrainTools(server, db)
registerEmailTools(server, db, config)
registerChannelTools(server, db, providers)

// Start dashboard HTTP API
const dashboardApp = createDashboardApp(db, config)
serve({ fetch: dashboardApp.fetch, port: config.dashboard_api.port })

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
main().catch(console.error)

process.on('SIGINT', () => {
  closeDb()
  process.exit(0)
})
