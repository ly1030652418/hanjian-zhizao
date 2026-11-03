import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '_site');
await mkdir(output, { recursive: true });

for (const file of ['index.html', 'news.json', 'robots.txt', 'sitemap.xml']) {
  try { await cp(resolve(root, file), resolve(output, file)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

await mkdir(resolve(output, 'news'), { recursive: true });
const { items } = JSON.parse(await readFile(resolve(root, 'news.json'), 'utf8'));
for (const item of items) {
  const { createHash } = await import('node:crypto');
  let url = item.url;
  try { const parsed = new URL(url); parsed.hash = ''; parsed.search = ''; url = parsed.href.replace(/\/$/, '').toLowerCase(); }
  catch { /* the collector validates source URLs before publication */ }
  const hash = createHash('sha256').update(url + item.title).digest('hex').slice(0, 10);
  const fileName = `${item.publishedAt.slice(0, 10)}-${hash}.html`;
  await cp(resolve(root, 'news', fileName), resolve(output, 'news', fileName));
}
console.log(`构建完成：${output}`);
