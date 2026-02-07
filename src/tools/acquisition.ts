import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";

export function registerAcquisitionTools(server: McpServer): void {
  server.tool(
    "configure_acquisition",
    "Control acquisition state and configure timebase/trigger settings. Use 'command' to run/stop the scope, and optionally set timebase and trigger parameters in the same call.",
    {
      command: z
        .enum(["run", "stop", "single", "auto"])
        .optional()
        .describe(
          "Acquisition command: 'run' starts acquisition (ARM), 'stop' stops it, 'single' sets single trigger mode, 'auto' sets auto trigger mode"
        ),
      timebase: z
        .string()
        .optional()
        .describe(
          "Time per division with unit (e.g. '1US', '500NS', '10MS', '1S'). Range: 1NS to 100S"
        ),
      trigger_mode: z
        .enum(["AUTO", "NORM", "SINGLE", "STOP"])
        .optional()
        .describe("Trigger sweep mode"),
      trigger_source: z
        .enum(["C1", "C2", "C3", "C4", "EX", "EX5"])
        .optional()
        .describe("Trigger source channel"),
      trigger_level: z
        .string()
        .optional()
        .describe(
          "Trigger level voltage with unit (e.g. '1.5V', '500mV', '-200mV')"
        ),
      trigger_slope: z
        .enum(["POS", "NEG", "WINDOW"])
        .optional()
        .describe(
          "Trigger slope: POS=rising edge, NEG=falling edge, WINDOW=alternating"
        ),
      trigger_delay: z
        .string()
        .optional()
        .describe(
          "Trigger delay / horizontal position with unit (e.g. '0S', '-4.8US', '100NS')"
        ),
    },
    { readOnlyHint: false },
    async ({
      command,
      timebase,
      trigger_mode,
      trigger_source,
      trigger_level,
      trigger_slope,
      trigger_delay,
    }) => {
      try {
        const commandsSent: string[] = [];

        if (timebase !== undefined) {
          await connection.sendCommand(`TDIV ${timebase}`);
          commandsSent.push(`TDIV ${timebase}`);
        }

        if (trigger_delay !== undefined) {
          await connection.sendCommand(`TRDL ${trigger_delay}`);
          commandsSent.push(`TRDL ${trigger_delay}`);
        }

        if (trigger_mode !== undefined) {
          await connection.sendCommand(`TRMD ${trigger_mode}`);
          commandsSent.push(`TRMD ${trigger_mode}`);
        }

        if (trigger_source !== undefined && trigger_level !== undefined) {
          await connection.sendCommand(
            `${trigger_source}:TRLV ${trigger_level}`
          );
          commandsSent.push(`${trigger_source}:TRLV ${trigger_level}`);
        } else if (trigger_level !== undefined) {
          // Apply to C1 by default if no source specified
          await connection.sendCommand(`C1:TRLV ${trigger_level}`);
          commandsSent.push(`C1:TRLV ${trigger_level}`);
        }

        if (trigger_slope !== undefined) {
          const src = trigger_source || "C1";
          await connection.sendCommand(`${src}:TRSL ${trigger_slope}`);
          commandsSent.push(`${src}:TRSL ${trigger_slope}`);
        }

        if (command !== undefined) {
          switch (command) {
            case "run":
              await connection.sendCommand("ARM");
              commandsSent.push("ARM");
              break;
            case "stop":
              await connection.sendCommand("STOP");
              commandsSent.push("STOP");
              break;
            case "single":
              await connection.sendCommand("TRMD SINGLE");
              commandsSent.push("TRMD SINGLE");
              break;
            case "auto":
              await connection.sendCommand("TRMD AUTO");
              commandsSent.push("TRMD AUTO");
              break;
          }
        }

        if (commandsSent.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No parameters specified. Provide at least one parameter to configure.",
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Acquisition configured. Commands sent:\n${commandsSent.join("\n")}`,
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

  server.tool(
    "get_acquisition_status",
    "Get the current acquisition state including sample rate, memory depth, timebase, trigger configuration, and acquisition status.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const [sast, sara, tdiv, trdl, trmd, trse] = await Promise.all([
          connection.query("SAST?"),
          connection.query("SARA?"),
          connection.query("TDIV?"),
          connection.query("TRDL?"),
          connection.query("TRMD?"),
          connection.query("TRSE?"),
        ]);

        // Query trigger level for C1 (common default source)
        let trigLevel = "";
        let trigSlope = "";
        try {
          trigLevel = await connection.query("C1:TRLV?");
          trigSlope = await connection.query("C1:TRSL?");
        } catch {
          // Trigger source may not be C1
        }

        const result = {
          acquisition_status: sast,
          sample_rate: sara,
          timebase: tdiv,
          trigger_delay: trdl,
          trigger_mode: trmd,
          trigger_select: trse,
          trigger_level_c1: trigLevel,
          trigger_slope_c1: trigSlope,
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
}
