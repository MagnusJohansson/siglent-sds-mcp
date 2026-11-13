/**
 * Strict formats for free-text tool parameters that are built into SCPI
 * commands. The connection-layer guard already stops a second command being
 * smuggled onto the wire; these formats are the second layer, and the only
 * one that stops unexpected text inside a single command
 * (e.g. "1V,OFF" where a voltage is expected).
 */
import { z } from "zod";

const NUMBER = String.raw`(\d+(\.\d*)?|\.\d+)([eE][+-]?\d{1,3})?`;

/** e.g. "500mV", "1V", "2E-1", "0.5" */
export const VOLTAGE = new RegExp(`^${NUMBER}(UV|MV|V|KV)?$`, "i");
/** e.g. "-200mV", "+1.5V", "0V" */
export const SIGNED_VOLTAGE = new RegExp(`^[+-]?${NUMBER}(UV|MV|V|KV)?$`, "i");
/** e.g. "1US", "500NS", "10MS", "1S", "1.00E-06" */
export const TIME = new RegExp(`^${NUMBER}(PS|NS|US|MS|S|KS)?$`, "i");
/** e.g. "-4.8US", "0S", "100NS" */
export const SIGNED_TIME = new RegExp(`^[+-]?${NUMBER}(PS|NS|US|MS|S|KS)?$`, "i");

export const voltageString = (description: string) =>
  z.string().regex(VOLTAGE, "Expected a voltage such as '500mV' or '1V'").describe(description);

export const signedVoltageString = (description: string) =>
  z
    .string()
    .regex(SIGNED_VOLTAGE, "Expected a voltage such as '-200mV' or '1.5V'")
    .describe(description);

export const timeString = (description: string) =>
  z.string().regex(TIME, "Expected a time such as '1US' or '10MS'").describe(description);

export const signedTimeString = (description: string) =>
  z.string().regex(SIGNED_TIME, "Expected a time such as '-4.8US' or '0S'").describe(description);
