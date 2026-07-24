/**
 * Boot the whole Northwind demo locally so you can drive it by hand:
 *
 *   npx tsx examples/northwind/run.ts
 *
 * It starts the mock backend + the MCP server with a stub Hub that just prints
 * the handle-JWT it receives at bind time, then prints ready-to-run curl calls.
 */
import type { AddressInfo } from 'node:net';
import { createNorthwindBackend } from './backend.js';
import { createNorthwindMcp } from './northwind-mcp.js';

const ADMIN_KEY = 'admin-secret';
let lastToken = '';

const backend = createNorthwindBackend();
const backendServer = backend.app.listen(0, () => {
  const apiUrl = `http://localhost:${(backendServer.address() as AddressInfo).port}`;
  const cookie = backend.login('ALFKI', 'ALFKI');

  const mcp = createNorthwindMcp({
    apiUrl,
    adminKey: ADMIN_KEY,
    jwtSecret: 'jwt-secret',
    // Stub Hub: capture + print the handle the real Hub would store and replay.
    hubClient: {
      async bind(connectionId, token) {
        lastToken = token;
        process.stderr.write(`\n[hub] bound connection ${connectionId}\n[hub] handle-JWT:\n${token}\n`);
      },
    },
  });

  const mcpServer = mcp.listen(0, () => {
    const mcpUrl = `http://localhost:${(mcpServer.address() as AddressInfo).port}`;
    process.stderr.write(
      [
        '',
        `Northwind backend : ${apiUrl}`,
        `Northwind MCP     : ${mcpUrl}`,
        '',
        '1) Bind the user session (app → MCP, admin-keyed):',
        `   curl -s ${mcpUrl}/bind -H 'content-type: application/json' -H 'x-admin-key: ${ADMIN_KEY}' \\`,
        `     -d '{"connectionId":"conn-1","artifacts":{"sessionCookie":"${cookie}"}}'`,
        '',
        '   (the handle-JWT prints above — copy it as <TOKEN>)',
        '',
        '2) Call a tool as the Hub would (Bearer = the handle-JWT):',
        `   curl -s ${mcpUrl}/mcp -H 'content-type: application/json' \\`,
        `     -H 'accept: application/json, text/event-stream' -H 'authorization: Bearer <TOKEN>' \\`,
        `     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"my_orders","arguments":{}}}'`,
        '',
        'Ctrl-C to stop.',
        '',
      ].join('\n'),
    );
    void lastToken; // populated after step 1
  });
});
