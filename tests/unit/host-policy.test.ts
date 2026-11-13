import { describe, it, expect } from "vitest";
import {
  assertConnectAllowed,
  isPrivateLanAddress,
  type HostPolicy,
} from "../../src/security/host-policy.js";
import { ScpiPolicyError } from "../../src/security/scpi-guard.js";

describe("isPrivateLanAddress", () => {
  it.each(["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.1.126", "fd12:3456:789a::1", "fc00::1"])(
    "%s is private LAN",
    (ip) => {
      expect(isPrivateLanAddress(ip)).toBe(true);
    }
  );

  it.each([
    ["loopback", "127.0.0.1"],
    ["IPv6 loopback", "::1"],
    ["cloud metadata (link-local)", "169.254.169.254"],
    ["IPv6 link-local", "fe80::1"],
    ["just below 172.16/12", "172.15.255.255"],
    ["just above 172.16/12", "172.32.0.1"],
    ["public", "8.8.8.8"],
    ["unspecified", "0.0.0.0"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["fd as compressed first group (0x00fd)", "fd::1"],
    ["host name", "sds.local"],
    ["not an address", "192.168.1"],
  ])("%s (%s) is not private LAN", (_label, ip) => {
    expect(isPrivateLanAddress(ip)).toBe(false);
  });
});

describe("assertConnectAllowed", () => {
  const lanOnly: HostPolicy = { allowedHosts: [], allowedPorts: [5025] };
  const listed: HostPolicy = { allowedHosts: ["192.168.1.126", "SDS.lab"], allowedPorts: [5025] };

  it("accepts a private LAN IP on the instrument port when no list is configured", () => {
    expect(() => assertConnectAllowed("192.168.1.50", 5025, lanOnly)).not.toThrow();
  });

  it.each([
    ["metadata endpoint", "169.254.169.254", 5025],
    ["loopback service", "127.0.0.1", 5025],
    ["host name in LAN-only mode", "example.com", 5025],
    ["SSH on a LAN host", "192.168.1.50", 22],
    ["fractional port", "192.168.1.50", 5025.5],
  ])("rejects %s", (_label, host, port) => {
    expect(() => assertConnectAllowed(host, port, lanOnly)).toThrow(ScpiPolicyError);
  });

  it("uses exact, case-insensitive matching when a list is configured", () => {
    expect(() => assertConnectAllowed("192.168.1.126", 5025, listed)).not.toThrow();
    expect(() => assertConnectAllowed("sds.LAB", 5025, listed)).not.toThrow();
    expect(() => assertConnectAllowed("192.168.1.127", 5025, listed)).toThrow(ScpiPolicyError);
  });

  it("allows any host with '*' but still enforces the port", () => {
    const any: HostPolicy = { allowedHosts: ["*"], allowedPorts: [5025] };
    expect(() => assertConnectAllowed("8.8.8.8", 5025, any)).not.toThrow();
    expect(() => assertConnectAllowed("8.8.8.8", 80, any)).toThrow(ScpiPolicyError);
  });
});
