import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(project, 'dist');
const cache = path.join(project, '.dependency-cache');
await fs.mkdir(output, { recursive: true });
await fs.mkdir(cache, { recursive: true });
const checksums = [];
async function download(url, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.access(target); } catch {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`);
    const data = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(`${target}.partial`, data);
    await fs.rename(`${target}.partial`, target);
  }
  const data = await fs.readFile(target);
  checksums.push({ url, sha256: createHash('sha256').update(data).digest('hex') });
  return target;
}
async function packageFiles(name, version, selections) {
  const archive = await download(`https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, path.join(cache, `${name}-${version}.tgz`));
  const unpacked = path.join(cache, `${name}-${version}`);
  await fs.mkdir(unpacked, { recursive: true });
  const extracted = spawnSync('tar', ['-xzf', archive, '-C', unpacked], { stdio: 'inherit' });
  if (extracted.status !== 0) throw new Error(`Cannot extract ${name}`);
  for (const [source, destination] of selections) {
    const target = path.join(output, 'vendor', destination);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(path.join(unpacked, 'package', source), target, { recursive: true });
  }
}
await packageFiles('pdfjs-dist', '4.10.38', [
  ['legacy/build/pdf.mjs', 'pdfjs/pdf.mjs'], ['legacy/build/pdf.worker.mjs', 'pdfjs/pdf.worker.mjs'],
  ['cmaps', 'pdfjs/cmaps'], ['standard_fonts', 'pdfjs/standard_fonts'], ['LICENSE', 'pdfjs/LICENSE']
]);
await packageFiles('tesseract.js', '6.0.1', [
  ['dist/tesseract.min.js', 'tesseract.min.js'], ['dist/worker.min.js', 'tesseract/worker.min.js'], ['LICENSE.md', 'tesseract/LICENSE.md']
]);
await packageFiles('tesseract.js-core', '6.0.0', [
  ['tesseract-core.wasm.js', 'tesseract-core/tesseract-core.wasm.js'], ['tesseract-core.wasm', 'tesseract-core/tesseract-core.wasm'],
  ['tesseract-core-simd.wasm.js', 'tesseract-core/tesseract-core-simd.wasm.js'], ['tesseract-core-simd.wasm', 'tesseract-core/tesseract-core-simd.wasm'],
  ['tesseract-core-lstm.wasm.js', 'tesseract-core/tesseract-core-lstm.wasm.js'], ['tesseract-core-lstm.wasm', 'tesseract-core/tesseract-core-lstm.wasm'],
  ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core/tesseract-core-simd-lstm.wasm.js'], ['tesseract-core-simd-lstm.wasm', 'tesseract-core/tesseract-core-simd-lstm.wasm'],
  ['LICENSE', 'tesseract-core/LICENSE']
]);
const sheetFile = await download('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js', path.join(cache, 'xlsx-0.20.3.min.js'));
await fs.cp(sheetFile, path.join(output, 'vendor', 'xlsx.full.min.js'));
for (const language of ['chi_tra', 'eng']) {
  const source = await download(`https://cdn.jsdelivr.net/npm/@tesseract.js-data/${language}@1.0.0/4.0.0_best_int/${language}.traineddata.gz`, path.join(cache, `${language}.traineddata.gz`));
  await fs.mkdir(path.join(output, 'vendor', 'lang'), { recursive: true });
  await fs.cp(source, path.join(output, 'vendor', 'lang', `${language}.traineddata.gz`));
}
if (!process.argv.includes('--vendor-only')) {
  for (const filename of ['index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'THIRD-PARTY.md']) await fs.cp(path.join(project, filename), path.join(output, filename));
  await fs.cp(path.join(project, 'src'), path.join(output, 'src'), { recursive: true });
}
await fs.writeFile(path.join(output, 'vendor', 'SOURCES.json'), JSON.stringify(checksums, null, 2));
console.log(`Static site ready: ${output}`);
