import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './utils/config.js';
import { getDb, closeDb } from './db/sqlite.js';

const basePath =
  process.env.SALES_MCP_BASE ||
  dirname(dirname(fileURLToPath(import.meta.url)));

const config = loadConfig(basePath);
getDb(config.database.path);

// Built by Weblease

const server = new McpServer({
  name: 'sales-mcp',
  version: '1.0.0',
});

// Tool registrations will be added here

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch(console.error);

process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});
