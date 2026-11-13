/**
 * Connect-target policy.
 *
 * The `connect` tool lets the model choose a host and port. Without host and
 * port restrictions, that plus a raw-command tool is a general-purpose TCP client: the model
 * (or anyone who can steer it via prompt injection) could reach any service
 * the server can reach and write arbitrary lines to it.
 */
import * as net from "node:net";
import { ScpiPolicyError } from "./scpi-guard.js";

export interface HostPolicy {
  /**
   * Exact host names / IPs that may be connected to. "*" allows any host.
   * When empty, only private-LAN IP literals are allowed.
   */
  allowedHosts: string[];
  /** Ports that may be connected to. */
  allowedPorts: number[];
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/**
 * Private-LAN ranges where bench instruments live (RFC 1918 and IPv6 ULA).
 * Deliberately excluded: loopback (local services) and link-local
 * 169.254.0.0/16 (includes cloud metadata endpoints such as 169.254.169.254).
 */
export function isPrivateLanAddress(host: string): boolean {
  if (net.isIPv4(host)) {
    return (
      inCidr(host, "10.0.0.0", 8) ||
      inCidr(host, "172.16.0.0", 12) ||
      inCidr(host, "192.168.0.0", 16)
    );
  }
  if (net.isIPv6(host)) {
    const first = host.toLowerCase().split(":")[0];
    // fc00::/7 (unique local addresses)
    return /^f[cd][0-9a-f]{2}$/.test(first);
  }
  return false;
}

export function assertConnectAllowed(host: string, port: number, policy: HostPolicy): void {
  if (!Number.isInteger(port) || !policy.allowedPorts.includes(port)) {
    throw new ScpiPolicyError(
      `Port ${port} is not allowed. Allowed ports: ${policy.allowedPorts.join(", ")}. ` +
        "Configure SIGLENT_PORT to use a different instrument port."
    );
  }

  if (policy.allowedHosts.includes("*")) return;

  if (policy.allowedHosts.length > 0) {
    const normalized = host.trim().toLowerCase();
    if (!policy.allowedHosts.some((h) => h.toLowerCase() === normalized)) {
      throw new ScpiPolicyError(
        `Host "${host}" is not in the allowed list. ` +
          "Set SIGLENT_ALLOWED_HOSTS (comma-separated) to allow additional instruments."
      );
    }
    return;
  }

  if (!isPrivateLanAddress(host)) {
    throw new ScpiPolicyError(
      `Host "${host}" is not allowed. Without SIGLENT_ALLOWED_HOSTS, only private-LAN IP ` +
        "addresses (10/8, 172.16/12, 192.168/16, fc00::/7) are accepted; host names, loopback " +
        "and link-local addresses are rejected."
    );
  }
}
