// MCP-09 part B diagnostic: the official SDK client against a RUNNING Career Companion server, to tell
// server faults from AI-client faults. Lists the tool by default; with --send-fixture it also sends the
// fixture's `applied` entries (synthetic data; repeats are recorded once and return already_recorded).
// `expectedFirstRun` assumes the fixture's seedApplications exist for that user and nothing was sent before.
//
//   CC_MCP_TOKEN=ccmcp_… node scripts/mcp-client-check.cjs http://localhost:3000/mcp
//   CC_MCP_TOKEN=ccmcp_… node scripts/mcp-client-check.cjs http://localhost:3000/mcp \
//     --send-fixture ../career-companion-frontend-main/scripts/fixtures/mcp-daily-applications.json
//
// The token is read from the environment only and is never printed.
const fs = require('node:fs');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

async function main() {
  const [url, flag, fixturePath] = process.argv.slice(2);
  const token = process.env.CC_MCP_TOKEN;
  if (!url || !token) throw new Error('Usage: CC_MCP_TOKEN=… node scripts/mcp-client-check.cjs <server URL> [--send-fixture <json>]');
  if (flag && (flag !== '--send-fixture' || !fixturePath)) throw new Error('Unknown option; use --send-fixture <json>');

  const client = new Client({ name: 'cc-mcp-client-check', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  } catch (err) {
    throw new Error(`Could not connect (check the URL, MCP_ALLOWED_HOSTS and that the token is active): ${err.message}`);
  }
  const { tools } = await client.listTools();
  console.log(JSON.stringify({ connected: true, protocolVersion: client.getNegotiatedProtocolVersion(), tools: tools.map((t) => t.name) }));
  if (flag) {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    for (const entry of fixture.entries.filter((e) => e.status === 'applied')) {
      const result = await client.callTool({ name: 'record_application_submission', arguments: entry.arguments });
      const outcome = result.isError ? JSON.parse(result.content[0].text) : result.structuredContent;
      console.log(JSON.stringify({ entry: entry.heading, expectedFirstRun: entry.expected, outcome }));
    }
  }
  await client.close();
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exitCode = 1;
});
