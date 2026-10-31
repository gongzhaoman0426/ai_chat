import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
for (const source of ['toolkits/local/shop-helpers/index.ts']) {
  const name = source.split('/')[2];
  const dir = resolve('extensions-dist', name);
  await mkdir(dir, { recursive: true });
  await build({
    entryPoints: [source],
    outfile: join(dir, 'index.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    external: ['@mastra/core/*', 'zod'],
    minify: false,
  });
  const module = await import(pathToFileURL(join(dir, 'index.mjs')).href);
  const manifest = module.default.manifest;
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('index.mjs', await readFile(join(dir, 'index.mjs')));
  zip.writeZip(resolve('extensions-dist', `${name}-${manifest.version}.zip`));
  console.log(`Built ${manifest.assetId}@${manifest.version}`);
}
