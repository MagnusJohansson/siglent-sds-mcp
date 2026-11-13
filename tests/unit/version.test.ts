import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SERVER_VERSION } from "../../src/server.js";

describe("version", () => {
  it("reports the package.json version to MCP clients", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
