import type { HostPolicy } from "./security/host-policy.js";

export interface ServerConfig {
  /** Oscilloscope address used for auto-connect, reconnects and as the default for `connect`. */
  defaultHost?: string;
  defaultPort: number;
  hostPolicy: HostPolicy;
  /** Whether the raw `scpi_command` tool is registered. */
  rawScpiEnabled: boolean;
  /** Release the connection after this many ms without traffic (0 = never). */
  idleTimeoutMs: number;
  /** Human-readable notes about the effective configuration, logged at startup. */
  notes: string[];
}

const DEFAULT_PORT = 5025;

function parsePort(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} must be a TCP port (1-65535), got "${value}".`);
  }
  return n;
}

function parseSeconds(name: string, value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a number of seconds (0 = never), got "${value}".`);
  }
  return n * 1000;
}

function isTrue(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const notes: string[] = [];

  const defaultHost = (env.SIGLENT_IP ?? "").trim() || undefined;
  const defaultPort = parsePort("SIGLENT_PORT", env.SIGLENT_PORT) ?? DEFAULT_PORT;

  // Connect-target policy: the configured scope plus any explicitly allowed
  // hosts. If neither is set, only private-LAN IP literals are accepted.
  const allowedHosts = (env.SIGLENT_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  if (defaultHost && !allowedHosts.includes(defaultHost)) {
    allowedHosts.push(defaultHost);
  }
  if (allowedHosts.includes("*")) {
    notes.push("WARNING: SIGLENT_ALLOWED_HOSTS=* allows connecting to any host.");
  }

  // Raw SCPI turns `connect` into a general command channel. Without an
  // explicit host list, `connect` falls back to "any private-LAN IP on the
  // instrument port", which also matches signal generators, power supplies
  // and electronic loads (they commonly use 5025 too). So raw SCPI requires
  // named hosts, and "*" doesn't name one.
  const rawScpiEnabled = isTrue(env.SIGLENT_ALLOW_RAW_SCPI);
  if (rawScpiEnabled && (allowedHosts.length === 0 || allowedHosts.includes("*"))) {
    throw new Error(
      "SIGLENT_ALLOW_RAW_SCPI requires SIGLENT_IP or SIGLENT_ALLOWED_HOSTS naming specific " +
        "hosts ('*' is not accepted), so raw commands can only reach instruments you have named."
    );
  }
  if (rawScpiEnabled) {
    notes.push("WARNING: raw scpi_command tool enabled; the model can send any SCPI command.");
  }

  return {
    defaultHost,
    defaultPort,
    hostPolicy: {
      allowedHosts,
      allowedPorts: [...new Set([DEFAULT_PORT, defaultPort])],
    },
    rawScpiEnabled,
    idleTimeoutMs: parseSeconds("SIGLENT_IDLE_TIMEOUT", env.SIGLENT_IDLE_TIMEOUT),
    notes,
  };
}
