#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerConnectionTools } from "./tools/connection.js";
import { registerChannelTools } from "./tools/channel.js";
import { registerAcquisitionTools } from "./tools/acquisition.js";
import { registerMeasureTools } from "./tools/measure.js";
import { registerWaveformTools } from "./tools/waveform.js";
import { registerScpiTools } from "./tools/scpi.js";
import { connection } from "./connection.js";

// Prevent uncaught errors from killing the MCP server process
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

const server = new McpServer({
  name: "siglent-sdx-mcp",
  version: "1.0.0",
});

// Register all tool groups
registerConnectionTools(server);
registerChannelTools(server);
registerAcquisitionTools(server);
registerMeasureTools(server);
registerWaveformTools(server);
registerScpiTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("siglent-sdx-mcp server running on stdio");

  // Auto-connect if SIGLENT_IP is set (fire-and-forget, don't block MCP startup)
  const autoIp = process.env.SIGLENT_IP;
  if (autoIp) {
    const port = parseInt(process.env.SIGLENT_PORT || "5025", 10);
    connection.connect(autoIp, port).then(
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
