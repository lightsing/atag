import { rolldown } from 'rolldown';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = process.argv[2];
if (!output) throw new Error('Pass the destination for QueryEngine.js.');
await mkdir(dirname(output), { recursive: true });
const licenses = await Promise.all(['@noble/curves', '@noble/hashes', 'zod'].map(async name =>
  name + '\n' + await readFile(new URL(`../node_modules/${name}/LICENSE`, import.meta.url), 'utf8')));
const bundle = await rolldown({ input: fileURLToPath(new URL('../lib/ios/query-engine.ts', import.meta.url)) });
try {
  await bundle.write({ file: output, format: 'iife', minify: true, comments: { legal: true },
    banner: `/*!\n${licenses.join('\n')}\n*/` });
} finally {
  await bundle.close();
}
