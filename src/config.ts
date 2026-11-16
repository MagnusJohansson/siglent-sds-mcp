import * as path from "node:path";
import type { HostPolicy } from "./security/host-policy.js";

/** Where audit events go (SIGLENT_AUDIT_LOG), and at which level. */
export type AuditConfig =
  | { sink: "stderr"; level: "security" | "full" }
  | { sink: "file"; level: "full"; path: string }
  | { sink: "off" };

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
  audit: AuditConfig;
  /** OTLP export of the full audit trail, when an endpoint is configured. */
  otlp?: OtlpConfig;
}

export interface OtlpConfig {
  /**
   * The URL the exporter posts to, as it may be logged: no userinfo, query
   * string or fragment. OTEL_EXPORTER_OTLP_ENDPOINT gets /v1/logs appended,
   * as the exporter does; OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is used as-is.
   */
  endpoint: string;
}

/**
 * The exporter reads the standard variables itself (endpoint, headers,
 * timeout). Here the server decides whether to export at all, checks the
 * endpoint (an invalid URL is a configuration error) and the protocol: it
 * sends OTLP/HTTP with JSON payloads.
 *
 * Opt-in: the generic OTEL_EXPORTER_OTLP_ENDPOINT is often inherited from an
 * environment set up for another application's telemetry, and the audit
 * trail carries tool arguments and the instrument's serial number. So the
 * export needs SIGLENT_AUDIT_OTLP=1, or the logs-specific
 * OTEL_EXPORTER_OTLP_LOGS_ENDPOINT; the generic endpoint alone gets a note.
 */
function parseOtlp(env: NodeJS.ProcessEnv, notes: string[]): OtlpConfig | undefined {
  if ((env.OTEL_SDK_DISABLED ?? "").trim().toLowerCase() === "true") return undefined;
  // OTEL_LOGS_EXPORTER chooses the logs exporter: "none" turns the export
  // off, and only "otlp" is supported.
  const exporters = (env.OTEL_LOGS_EXPORTER ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (exporters.length > 0 && !exporters.includes("otlp")) {
    if (!exporters.every((e) => e === "none")) {
      notes.push(`OTEL_LOGS_EXPORTER=${env.OTEL_LOGS_EXPORTER} is not supported (only otlp); the audit log isn't exported.`);
    }
    return undefined;
  }
  const name = (env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? "").trim()
    ? "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"
    : (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim()
      ? "OTEL_EXPORTER_OTLP_ENDPOINT"
      : undefined;
  if (!name) {
    // Asked for an off-machine trail without saying where: fail closed
    // rather than start without it.
    if (isTrue(env.SIGLENT_AUDIT_OTLP)) {
      throw new Error("SIGLENT_AUDIT_OTLP=1 needs OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.");
    }
    return undefined;
  }
  if (name === "OTEL_EXPORTER_OTLP_ENDPOINT" && !isTrue(env.SIGLENT_AUDIT_OTLP)) {
    notes.push(
      "OTEL_EXPORTER_OTLP_ENDPOINT is set, but the audit log isn't exported: set SIGLENT_AUDIT_OTLP=1 " +
        "(or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) to export it."
    );
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(env[name]!.trim());
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an http:// or https:// URL.`);
  }
  const protocol = (env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "").trim();
  if (protocol && protocol !== "http/json") {
    notes.push(`OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is not supported; audit events are exported as OTLP/HTTP with JSON.`);
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  if (name === "OTEL_EXPORTER_OTLP_ENDPOINT") {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/logs`;
  }
  return { endpoint: url.toString() };
}

/**
 * SIGLENT_AUDIT_LOG: unset = security events on stderr; "stderr" = the full
 * trail on stderr; an absolute path = the full trail in that file; "off" =
 * nothing. A relative path is a configuration error (fail closed).
 */
function parseAudit(value: string | undefined): AuditConfig {
  const v = (value ?? "").trim();
  if (v === "") return { sink: "stderr", level: "security" };
  if (v.toLowerCase() === "off") return { sink: "off" };
  if (v.toLowerCase() === "stderr") return { sink: "stderr", level: "full" };
  if (!path.isAbsolute(v)) {
    throw new Error(`SIGLENT_AUDIT_LOG must be "off", "stderr" or an absolute file path, got "${v}".`);
  }
  return { sink: "file", level: "full", path: v };
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

/** Longest delay setTimeout supports; Node treats anything larger as 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function parseSeconds(name: string, value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a number of seconds (0 = never), got "${value}".`);
  }
  const ms = Math.round(n * 1000);
  if (ms > MAX_TIMER_MS) {
    throw new Error(
      `${name} must be at most ${Math.floor(MAX_TIMER_MS / 1000)} seconds (about 24 days), got "${value}".`
    );
  }
  return ms;
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
    audit: parseAudit(env.SIGLENT_AUDIT_LOG),
    otlp: parseOtlp(env, notes),
  };
}
