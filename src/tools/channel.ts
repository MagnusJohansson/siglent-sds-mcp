import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";

const channelEnum = z.enum(["C1", "C2", "C3", "C4"]);

export function registerChannelTools(server: McpServer): void {
  server.tool(
    "get_channel",
    "Query the configuration of an analog channel. Returns volts/div, offset, coupling, bandwidth limit, trace on/off, probe attenuation, and unit.",
    {
      channel: channelEnum.describe("Channel to query (C1, C2, C3, or C4)"),
    },
    { readOnlyHint: true },
    async ({ channel }) => {
      try {
        const [vdiv, ofst, cpl, bwl, tra, attn, unit] = await Promise.all([
          connection.query(`${channel}:VDIV?`),
          connection.query(`${channel}:OFST?`),
          connection.query(`${channel}:CPL?`),
          connection.query("BWL?"),
          connection.query(`${channel}:TRA?`),
          connection.query(`${channel}:ATTN?`),
          connection.query(`${channel}:UNIT?`),
        ]);

        // Parse BWL response to extract this channel's setting
        // BWL response format: C1,OFF,C2,OFF,C3,OFF,C4,OFF
        let bwlState = "Unknown";
        const bwlParts = bwl.split(",");
        for (let i = 0; i < bwlParts.length - 1; i += 2) {
          if (bwlParts[i].trim() === channel) {
            bwlState = bwlParts[i + 1].trim();
            break;
          }
        }

        const result = {
          channel,
          volts_per_div: vdiv,
          offset: ofst,
          coupling: cpl,
          bandwidth_limit: bwlState,
          trace: tra,
          probe_attenuation: attn,
          unit: unit,
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
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

  server.tool(
    "configure_channel",
    "Configure an analog channel's parameters. Only specified parameters will be changed.",
    {
      channel: channelEnum.describe("Channel to configure (C1, C2, C3, or C4)"),
      vdiv: z
        .string()
        .optional()
        .describe(
          "Volts per division with unit (e.g. '500mV', '1V', '2V'). Range: 500uV to 10V"
        ),
      offset: z
        .string()
        .optional()
        .describe(
          "Vertical offset with unit (e.g. '0V', '-500mV', '1.5V')"
        ),
      coupling: z
        .enum(["A1M", "A50", "D1M", "D50", "GND"])
        .optional()
        .describe(
          "Coupling mode: A1M=AC 1MOhm, A50=AC 50Ohm, D1M=DC 1MOhm, D50=DC 50Ohm, GND=Ground"
        ),
      bandwidth_limit: z
        .boolean()
        .optional()
        .describe("Enable (true) or disable (false) 20MHz bandwidth limit"),
      trace: z
        .boolean()
        .optional()
        .describe("Turn channel display on (true) or off (false)"),
      probe: z
        .number()
        .optional()
        .describe(
          "Probe attenuation factor (e.g. 1, 10, 100, 1000)"
        ),
    },
    { readOnlyHint: false, idempotentHint: true },
    async ({ channel, vdiv, offset, coupling, bandwidth_limit, trace, probe }) => {
      try {
        const commands: string[] = [];

        if (vdiv !== undefined) {
          commands.push(`${channel}:VDIV ${vdiv}`);
        }
        if (offset !== undefined) {
          commands.push(`${channel}:OFST ${offset}`);
        }
        if (coupling !== undefined) {
          commands.push(`${channel}:CPL ${coupling}`);
        }
        if (bandwidth_limit !== undefined) {
          commands.push(`BWL ${channel},${bandwidth_limit ? "ON" : "OFF"}`);
        }
        if (trace !== undefined) {
          commands.push(`${channel}:TRA ${trace ? "ON" : "OFF"}`);
        }
        if (probe !== undefined) {
          commands.push(`${channel}:ATTN ${probe}`);
        }

        if (commands.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No parameters specified. Provide at least one parameter to configure.",
              },
            ],
          };
        }

        for (const cmd of commands) {
          await connection.sendCommand(cmd);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Channel ${channel} configured. Commands sent:\n${commands.join("\n")}`,
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
