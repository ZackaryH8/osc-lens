// Bundles the extension host client and the language server into single files so the
// packaged extension needs no node_modules.
import { build } from 'esbuild';

await build({
  entryPoints: { client: 'src/client.ts', server: 'src/server.ts' },
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outdir: 'out',
  external: ['vscode'],
  logLevel: 'info',
});
