import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";

export function registerConnectionTools(server: McpServer): void {
  server.tool(
    "connect",
    "Connect to a Siglent oscilloscope over TCP. Returns device identification on success.",
    {
      host: z
        .string()
        .optional()
        .describe(
          "IP address of the oscilloscope (defaults to SIGLENT_IP env var)"
        ),
      port: z
        .number()
        .optional()
        .describe("TCP port (defaults to 5025)"),
    },
    { readOnlyHint: false, openWorldHint: true },
    async ({ host, port }) => {
      const targetHost = host || process.env.SIGLENT_IP;
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
        const idn = await connection.connect(targetHost, port);
        return {
          content: [
            {
              type: "text" as const,
              text: `Connected to ${targetHost}:${port || 5025}\nDevice: ${idn}`,
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
