#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { connection } from "./connection.js";
import { createServer } from "./server.js";

// Prevent uncaught errors from killing the MCP server process
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

// Fail closed on invalid configuration: exit non-zero instead of starting
// with a security setting silently ignored.
let config: ServerConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
for (const note of config.notes) {
  console.error(note);
}
const server = createServer(config);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("siglent-sds-mcp server running on stdio");

  // Auto-connect if SIGLENT_IP is set (fire-and-forget, don't block MCP startup).
  // connect() applies the host policy.
  const autoIp = config.defaultHost;
  if (autoIp) {
    connection.connect(autoIp, config.defaultPort).then(
      (idn) => console.error(`Auto-connected to ${autoIp}: ${idn}`),
      (err) => {
        console.error(
          `Auto-connect to ${autoIp} failed: ${err instanceof Error ? err.message : String(err)}`
        );
        console.error("Use the 'connect' tool to connect manually.");
      }
    );
  }
}

main().catch((error) => {
  console.error("Startup error:", error);
});
