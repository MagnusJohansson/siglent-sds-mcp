import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import { connection } from "../connection.js";

export function registerConnectionTools(server: McpServer, config: ServerConfig): void {
  server.tool(
    "connect",
    "Connect to a Siglent oscilloscope over TCP. Returns device identification on success. " +
      "Only the configured oscilloscope (SIGLENT_IP), hosts in SIGLENT_ALLOWED_HOSTS, or, if neither is set, " +
      "private-LAN IP addresses are accepted, on the instrument port.",
    {
      host: z
        .string()
        .max(253)
        .optional()
        .describe("IP address of the oscilloscope (defaults to SIGLENT_IP)"),
      port: z
        .number()
        .int()
        .optional()
        .describe("TCP port (defaults to SIGLENT_PORT or 5025)"),
    },
    { readOnlyHint: false, openWorldHint: true },
    async ({ host, port }) => {
      const targetHost = host || config.defaultHost;
      const targetPort = port ?? config.defaultPort;
      if (!targetHost) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: No host specified. Provide a 'host' parameter or set the SIGLENT_IP environment variable.",
            },
          ],
          isError: true,
        };
      }

      try {
        const idn = await connection.connect(targetHost, targetPort);
        return {
          content: [
            {
              type: "text" as const,
              text: `Connected to ${targetHost}:${targetPort}\nDevice: ${idn}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "disconnect",
    "Disconnect from the oscilloscope.",
    {},
    { readOnlyHint: false },
    async () => {
      const info = connection.getConnectionInfo();
      connection.disconnect();
      return {
        content: [
          { type: "text" as const, text: `Disconnected from ${info}` },
        ],
      };
    }
  );

  server.tool(
    "identify",
    "Query the oscilloscope identification (*IDN?). Returns manufacturer, model, serial number, and firmware version.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const idn = await connection.query("*IDN?");
        const parts = idn.split(",");
        const result = {
          manufacturer: parts[0]?.trim() || "Unknown",
          model: parts[1]?.trim() || "Unknown",
          serial: parts[2]?.trim() || "Unknown",
          firmware: parts[3]?.trim() || "Unknown",
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
