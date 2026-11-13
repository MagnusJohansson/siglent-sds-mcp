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

        if (trigger_source !== undefined) {
          if (/^C\d$/.test(trigger_source)) {
            await connection.checkChannel(trigger_source);
          }
          await connection.sendCommand(`TRSE EDGE,SR,${trigger_source}`);
          commandsSent.push(`TRSE EDGE,SR,${trigger_source}`);
        }

        if (trigger_level !== undefined || trigger_slope !== undefined) {
          // Level/slope are per-channel; apply them to the active trigger
          // source rather than assuming C1 (setting <ch>:TRLV also switches
          // the trigger source to <ch> on SDS1000X-E).
          const src =
            trigger_source ?? (await getTriggerSource()) ?? "C1";
          if (trigger_level !== undefined) {
            await connection.sendCommand(`${src}:TRLV ${trigger_level}`);
            commandsSent.push(`${src}:TRLV ${trigger_level}`);
          }
          if (trigger_slope !== undefined) {
            await connection.sendCommand(`${src}:TRSL ${trigger_slope}`);
            commandsSent.push(`${src}:TRSL ${trigger_slope}`);
          }
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

        // Query level/slope of the active trigger source
        const trigSource = parseTriggerSource(trse);
        let trigLevel = "";
        let trigSlope = "";
        if (trigSource) {
          try {
            trigLevel = await connection.query(`${trigSource}:TRLV?`);
            trigSlope = await connection.query(`${trigSource}:TRSL?`);
          } catch {
            // Source may not support level/slope (e.g. serial trigger types)
          }
        }

        const result = {
          acquisition_status: sast,
          sample_rate: sara,
          timebase: tdiv,
          trigger_delay: trdl,
          trigger_mode: trmd,
          trigger_select: trse,
          trigger_source: trigSource ?? "",
          trigger_level: trigLevel,
          trigger_slope: trigSlope,
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

// TRSE? returns e.g. "EDGE,SR,C2,HT,OFF" — the source follows the SR field.
function parseTriggerSource(trse: string): string | undefined {
  const parts = trse.split(",").map((p) => p.trim());
  const i = parts.indexOf("SR");
  return i >= 0 ? parts[i + 1] : undefined;
}

async function getTriggerSource(): Promise<string | undefined> {
  try {
    return parseTriggerSource(await connection.query("TRSE?"));
  } catch {
    return undefined;
  }
}
