import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import { connection } from "../connection.js";

function errorResult(err: unknown) {
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

export function registerScpiTools(server: McpServer, config: ServerConfig): void {
  server.tool(
    "scpi_query",
    "Send a SCPI query to the oscilloscope and return the response. Use this as an escape hatch for " +
      "queries not covered by other tools. Only queries are accepted: a single header ending in '?' " +
      "(e.g. '*IDN?', 'C1:VDIV?', 'SARA?'); parameters after '?' only for PAVA? (e.g. 'C1:PAVA? FREQ'). " +
      "Note: CHDR is set to OFF, so responses contain only values (no headers).",
    {
      command: z
        .string()
        .max(512)
        .describe("SCPI query to send (e.g. '*IDN?', 'C1:VDIV?', 'SARA?')"),
      timeout_ms: z
        .number()
        .int()
        .min(500)
        .max(60_000)
        .optional()
        .describe("Timeout in milliseconds (default 5000)"),
    },
    // Read-only is now enforced: the connection rejects anything that isn't
    // structurally a query (see src/security/scpi-guard.ts).
    { readOnlyHint: true },
    async ({ command, timeout_ms }) => {
      try {
        const response = await connection.query(command, timeout_ms);
        return { content: [{ type: "text" as const, text: response }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // Raw command access is opt-in. With it, the model can change any setting,
  // including ones no other tool exposes (e.g. *RST or recalling a setup),
  // so it is only registered when explicitly enabled.
  if (!config.rawScpiEnabled) return;

  server.tool(
    "scpi_command",
    "Send a raw SCPI command to the oscilloscope (no response expected). Escape hatch for commands not " +
      "covered by other tools. One command per call; newlines and ';' are rejected. Queries must use scpi_query.",
    {
      command: z
        .string()
        .max(512)
        .describe("SCPI command to send (e.g. 'ARM', 'C1:VDIV 500mV')"),
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({ command }) => {
      try {
        await connection.sendCommand(command);
        return { content: [{ type: "text" as const, text: `Command sent: ${command}` }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
