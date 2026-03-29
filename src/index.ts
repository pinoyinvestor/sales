import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { serve } from '@hono/node-server'

import { loadConfig } from './utils/config.js'
import { getDb, closeDb } from './db/sqlite.js'

import { registerProductTools } from './tools/products.js'
import { registerLeadTools } from './tools/leads.js'
import { registerWordPressDetectTools } from './tools/wordpress-detect.js'
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
import { createTikTokProvider } from './providers/tiktok.js'
import { createLinkedInProvider } from './providers/linkedin.js'
import { createGoogleBusinessProvider } from './providers/google-business.js'

import { createDashboardApp } from './api/dashboard.js'
import { startInboxReader, stopInboxReader } from './workers/inbox-reader.js'
import { startAutonomousRunner, stopAutonomousRunner } from './workers/autonomous-runner.js'
import { startActionExecutor, stopActionExecutor } from './workers/action-executor.js'
import { startWPilotMonitor, stopWPilotMonitor } from './workers/wpilot-monitor.js'
import { startSequenceRunner, stopSequenceRunner } from './workers/sequence-runner.js'
import { startEventBus, stopEventBus } from './workers/event-bus.js'
import { startLeadImporter, stopLeadImporter } from './workers/lead-importer.js'
import { startAgentScheduler, stopAgentScheduler } from './workers/agent-scheduler.js'
import { createTrackingRoutes } from './workers/email-tracker.js'

const basePath =
  process.env.SALES_MCP_BASE ||
  dirname(dirname(fileURLToPath(import.meta.url)))

const config = loadConfig(basePath)
const dbPath = resolve(basePath, config.database.path)
const db = getDb(dbPath)

// Built by Christos Ferlachidis & Daniel Hedenberg
import { seedAgentProfiles } from './agents/profiles.js'

// Data retention cleanup on startup
const retentionDays = config.retention_days || 365
db.prepare(`DELETE FROM activity_log WHERE created_at < datetime('now', '-' || ? || ' days')`).run(retentionDays)
db.prepare(`DELETE FROM email_tracking WHERE created_at < datetime('now', '-' || ? || ' days') AND triggered_at IS NOT NULL`).run(retentionDays)

// Seed 16 agent profiles
seedAgentProfiles(db)

// Provider registry
const providers = createProviderRegistry()
providers.register('email', createEmailProvider(config.email) as any)
providers.register('webhook', createWebhookProvider())
providers.register('sms', createSmsProvider())
providers.register('facebook', createFacebookProvider())
providers.register('instagram', createInstagramProvider())
providers.register('reddit', createRedditProvider())
providers.register('wordpress_forum', createWordPressForumProvider())
providers.register('tiktok', createTikTokProvider())
providers.register('linkedin', createLinkedInProvider())
providers.register('google_business', createGoogleBusinessProvider())

const server = new McpServer({
  name: 'sales-mcp',
  version: '1.0.0',
})

// Register all tools
registerProductTools(server, db)
registerLeadTools(server, db)
registerWordPressDetectTools(server, db)
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

// Mount tracking routes on the dashboard app
const trackingRoutes = createTrackingRoutes(db)
dashboardApp.route('/', trackingRoutes)

try {
  const dashServer = serve({ fetch: dashboardApp.fetch, port: config.dashboard_api.port })
  dashServer.on('error', (err: Error) => {
    console.error(`Dashboard failed to start: ${err.message}`)
  })
} catch {
  console.error('Dashboard port unavailable, MCP tools still active')
}

// Start workers — only what produces real value
// Autonomous runner DISABLED: burns tokens with minimal output (6 actions / 58 runs)
// Agents are available via MCP tools + meeting room when needed
startInboxReader(db, config)       // Reads inbox every 60s — free, catches replies
startActionExecutor(db, config)    // Executes approved actions every 30s — free
startSequenceRunner(db, config)    // Sends follow-up emails on schedule — free
startAgentScheduler(db, config)    // Scout/Outreach/Keeper cron tasks — free (no Claude)
startWPilotMonitor(db)             // Tracks WPilot license stats — free
startEventBus(db)                  // Watches activity_log — free
startLeadImporter(db)              // Google Places import — free
// startAutonomousRunner(db, config) // DISABLED: 16 agents * Haiku = token burn

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
main().catch(console.error)

process.on('SIGINT', () => {
  stopAgentScheduler()
  stopLeadImporter()
  stopEventBus()
  stopSequenceRunner()
  stopWPilotMonitor()
  stopActionExecutor()
  // stopAutonomousRunner() // DISABLED
  stopInboxReader()
  closeDb()
  process.exit(0)
})
