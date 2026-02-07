import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";

const channelEnum = z.enum(["C1", "C2", "C3", "C4"]);

const measureParam = z.enum([
  "PKPK",
  "MAX",
  "MIN",
  "AMPL",
  "TOP",
  "BASE",
  "CMEAN",
  "MEAN",
  "RMS",
  "CRMS",
  "OVSN",
  "FPRE",
  "OVSP",
  "RPRE",
  "PER",
  "FREQ",
  "PWID",
  "NWID",
  "RISE",
  "FALL",
  "WID",
  "DUTY",
  "NDUTY",
  "ALL",
]);

export function registerMeasureTools(server: McpServer): void {
  server.tool(
    "measure",
    "Take a measurement on a channel. Common parameters: PKPK (peak-to-peak), FREQ (frequency), RMS, MEAN, RISE (rise time), FALL (fall time), DUTY (duty cycle), ALL (all measurements). Installs the measurement on the scope and returns the value.",
    {
      channel: channelEnum.describe("Channel to measure (C1, C2, C3, or C4)"),
      parameter: measureParam.describe(
        "Measurement type: PKPK, MAX, MIN, AMPL, TOP, BASE, CMEAN, MEAN, RMS, CRMS, OVSN, FPRE, OVSP, RPRE, PER, FREQ, PWID, NWID, RISE, FALL, WID, DUTY, NDUTY, ALL"
      ),
    },
    { readOnlyHint: true },
    async ({ channel, parameter }) => {
      try {
        // Install the measurement
        await connection.sendCommand(`PACU ${parameter},${channel}`);

        // Small delay for measurement to complete
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Query the measurement value
        const value = await connection.query(
          `${channel}:PAVA? ${parameter}`
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `${channel} ${parameter}: ${value}`,
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
    "measure_statistics",
    "Control measurement statistics. Turn statistics on/off, reset them, or read the statistical values (current, mean, min, max, std-dev, count) for a measurement.",
    {
      channel: channelEnum.describe("Channel to measure"),
      parameter: measureParam.describe("Measurement type"),
      action: z
        .enum(["on", "off", "reset", "read"])
        .describe(
          "Action: 'on' enables statistics, 'off' disables, 'reset' clears accumulated stats, 'read' returns current statistics"
        ),
    },
    { readOnlyHint: true },
    async ({ channel, parameter, action }) => {
      try {
        switch (action) {
          case "on":
            await connection.sendCommand(`PACU ${parameter},${channel}`);
            await connection.sendCommand("PASTAT ON");
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Statistics enabled for ${channel} ${parameter}`,
                },
              ],
            };

          case "off":
            await connection.sendCommand("PASTAT OFF");
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Statistics disabled",
                },
              ],
            };

          case "reset":
            await connection.sendCommand("PASTAT RESET");
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Statistics reset",
                },
              ],
            };

          case "read": {
            // Ensure measurement is installed and stats are on
            await connection.sendCommand(`PACU ${parameter},${channel}`);
            await connection.sendCommand("PASTAT ON");

            // Small delay
            await new Promise((resolve) => setTimeout(resolve, 300));

            const stats = await connection.query("PAVA? STAT1");
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${channel} ${parameter} statistics:\n${stats}`,
                },
              ],
            };
          }
        }
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
