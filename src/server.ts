import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { audit, type ToolAnnotations } from "./audit/audit.js";
import { auditTransport } from "./audit/transport.js";
import type { ServerConfig } from "./config.js";
import { connection } from "./connection.js";
import { registerConnectionTools } from "./tools/connection.js";
import { registerChannelTools } from "./tools/channel.js";
import { registerAcquisitionTools } from "./tools/acquisition.js";
import { registerMeasureTools } from "./tools/measure.js";
import { registerWaveformTools } from "./tools/waveform.js";
import { registerScpiTools } from "./tools/scpi.js";

export const SERVER_VERSION = "2.1.0";

/** Build the MCP server with all tools registered under the given configuration. */
export function createServer(config: ServerConfig): McpServer {
  // The connection enforces the host policy on every connect path
  // (connect tool, auto-connect, reconnect after idle or a timeout). It's one
  // process-wide connection, so this configures it for every server in the
  // process: one server per process, or the last one created sets the policy
  // for all of them.
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
  recordToolAnnotations(server);

  registerConnectionTools(server, config);
  registerChannelTools(server);
  registerAcquisitionTools(server);
  registerMeasureTools(server);
  registerWaveformTools(server);
  registerScpiTools(server, config);

  return server;
}

/**
 * Connect a server to a transport with the audit hooks installed. The hooks
 * must go in before server.connect() (see src/audit/transport.ts), so every
 * caller uses this instead of server.connect().
 */
export async function connectServer(server: McpServer, transport: Transport, config: ServerConfig): Promise<void> {
  auditTransport(transport, { rawScpiEnabled: config.rawScpiEnabled });
  await server.connect(transport);
}

/**
 * Record each tool's annotations as it's registered: state-changing tools
 * (readOnlyHint: false) are audited at the security level. Every tool here is
 * registered as server.tool(name, description, schema, annotations, callback).
 */
function recordToolAnnotations(server: McpServer): void {
  const register = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    const annotations = args
      .slice(1, -1)
      .find(
        (a): a is ToolAnnotations =>
          typeof a === "object" && a !== null && ("readOnlyHint" in a || "destructiveHint" in a)
      );
    audit.registerTool(String(args[0]), annotations);
    return register(...args);
  };
}
