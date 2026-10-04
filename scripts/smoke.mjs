// Starts the BUNDLED language server over stdio and checks it answers like the real thing.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const server = process.env.OSC_SERVER ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'server.js');
const child = spawn(process.execPath, [server, '--stdio']);
let buffer = Buffer.alloc(0);
const messages = [];
child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    messages.push(JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()));
    buffer = buffer.subarray(end + 4 + length);
  }
});
const send = (o) => { const s = JSON.stringify(o); child.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); };

const uri = 'file:///smoke/test.osc';
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
send({ jsonrpc: '2.0', method: 'initialized', params: {} });
send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'osc', version: 1, text: '{macro:a}\n1 2 Min (S.L.x)\n{end}\n' } } });
send({ jsonrpc: '2.0', id: 2, method: 'textDocument/hover', params: { textDocument: { uri }, position: { line: 0, character: 2 } } });
send({ jsonrpc: '2.0', id: 3, method: 'textDocument/completion', params: { textDocument: { uri }, position: { line: 1, character: 0 } } });

await new Promise((resolve) => setTimeout(resolve, 2000));
child.kill();

const diag = messages.find((m) => m.method === 'textDocument/publishDiagnostics')?.params.diagnostics ?? [];
const hover = messages.find((m) => m.id === 2)?.result;
const items = messages.find((m) => m.id === 3)?.result ?? [];
const failures = [];
if (!diag.some((d) => d.code === 'unknown-word')) failures.push('no unknown-word diagnostic');
if (!hover?.contents?.value?.includes('macro')) failures.push('no hover on {macro:a}');
if (items.length < 20) failures.push(`only ${items.length} completion items`);
if (failures.length) { console.error('smoke test FAILED:', failures.join('; ')); process.exit(1); }
console.log(`smoke test OK (${diag.length} diagnostic(s), ${items.length} completion items)`);
