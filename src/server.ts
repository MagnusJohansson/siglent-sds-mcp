import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "./config.js";
import { connection } from "./connection.js";
import { registerConnectionTools } from "./tools/connection.js";
import { registerChannelTools } from "./tools/channel.js";
import { registerAcquisitionTools } from "./tools/acquisition.js";
import { registerMeasureTools } from "./tools/measure.js";
import { registerWaveformTools } from "./tools/waveform.js";
import { registerScpiTools } from "./tools/scpi.js";

export const SERVER_VERSION = "2.0.1";

/** Build the MCP server with all tools registered under the given configuration. */
export function createServer(config: ServerConfig): McpServer {
  // The connection enforces the host policy on every connect path
  // (connect tool, auto-connect, reconnect after idle or a timeout).
  connection.configure({
    hostPolicy: config.hostPolicy,
    defaultHost: config.defaultHost,
    defaultPort: config.defaultPort,
    idleTimeoutMs: config.idleTimeoutMs,
  });

  const server = new McpServer({
    name: "siglent-sds-mcp",
    version: SERVER_VERSION,
  });

  registerConnectionTools(server, config);
  registerChannelTools(server);
  registerAcquisitionTools(server);
  registerMeasureTools(server);
  registerWaveformTools(server);
  registerScpiTools(server, config);

  return server;
}
