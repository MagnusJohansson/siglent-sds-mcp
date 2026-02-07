# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

MCP server that lets AI assistants control Siglent SDS oscilloscopes via SCPI commands over TCP (port 5025). Uses `@modelcontextprotocol/sdk`, communicates over stdio with JSON-RPC. No VISA drivers needed.

## Commands

```bash
npm run build          # Compile TypeScript → build/
npm test               # Run all tests once (vitest run)
npm run test:watch     # Watch mode (vitest)
npx vitest run tests/unit                          # Run only unit tests
npx vitest run tests/integration/channel-tools     # Run a single test file
npm run dev            # Build and run server
npm run inspector      # Launch with MCP Inspector for debugging
```

## Architecture

```
Claude <-- stdio/JSON-RPC --> McpServer (index.ts) <-- TCP/SCPI --> Oscilloscope:5025
```

**Singleton connection pattern:** `src/connection.ts` exports a `connection` singleton (`SiglentConnection` class) that manages the TCP socket. All tool files import this singleton. It has an internal query queue that serializes all SCPI commands — tools can safely issue parallel `Promise.all` queries.

**Tool registration:** Each file in `src/tools/` exports a `register*Tools(server: McpServer)` function. `index.ts` calls all six registration functions on a single McpServer instance. Tools use Zod schemas for parameter validation (provided by the MCP SDK's `server.tool()` API).

**Binary data handling:** The connection layer auto-detects two binary framing formats:
- Raw BMP (starts with `BM` magic bytes, size from BMP header)
- IEEE 488.2 definite-length blocks (`#<digitCount><length><data>`)

**Voltage reconstruction** (in `waveform.ts`): Raw ADC bytes → signed code values (two's complement for >127) → `code * (vdiv/25) - offset`. Helper functions `parseSampleRate` and `countTrailingZeros` are exported for unit testing.

**Screenshot pipeline** (in `waveform.ts`): The scope returns 16-bit RGB565 BI_BITFIELDS BMP. The code manually extracts color masks, converts pixels to 24-bit RGB, then uses `sharp` to produce PNG. Falls back to letting sharp decode standard BMPs directly.

## Testing

Tests use **Vitest** with two layers:

- **Unit tests** (`tests/unit/`): Pure function tests (parseSampleRate, countTrailingZeros)
- **Integration tests** (`tests/integration/`): Full MCP round-trip using `InMemoryTransport` from the MCP SDK. A test client sends tool calls through the real McpServer with all tools registered, but with `src/connection.ts` mocked via `vi.mock`.

**Connection mocking pattern:** Every integration test file uses `vi.hoisted()` to define a mock connection object, then `vi.mock("../../src/connection.js", ...)` to replace the singleton. The mock's `query()` returns canned SCPI responses based on command strings. This is required because `vi.mock` factories are hoisted above normal variable declarations.

**Shared helper** (`tests/helpers.ts`): `createTestServer()` wires up McpServer + InMemoryTransport + Client. Returns `{ client, server, cleanup }`.

## Module System

ESM throughout (`"type": "module"` in package.json). All imports use `.js` extensions (Node16 module resolution). TypeScript compiles to `build/` — tests are excluded from `tsconfig.json` and run via vitest's own transform.
