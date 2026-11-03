import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(root, 'site-config.json'), 'utf8'));
const sources = JSON.parse(await readFile(resolve(root, 'news-sources.json'), 'utf8'));
const seed = JSON.parse(await readFile(resolve(root, 'news.json'), 'utf8'));
const indexPath = resolve(root, 'index.html');
const skipFetch = process.argv.includes('--seed-only');
const now = new Date();
const keywords = /焊接|焊缝|焊机|弧焊|焊装|激光焊|weld(?:ing)?/i;

function decodeEntities(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'");
}

function stripHtml(value = '') {
  return decodeEntities(value.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(img|svg|picture|source)\b[^>]*>[\s\S]*?(?:<\/\1>)?/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '))
    .replace(/&hellip;|&#8230;|/gi, ' ').replace(/\s+/g, ' ').trim();
}

function cleanTitle(value = '') {
  return stripHtml(value)
    .replace(/^\s*[—–-]?\s*20\d{2}[./-]\d{1,2}[./-]\d{1,2}\s*[—–-]?\s*/,'')
    .replace(/\s+20\d{2}[./-]\d{1,2}[./-]\d{1,2}\s*[›>]?\s*$/, '')
    .replace(/^[—–|\s]+|[—–|\s]+$/g, '').trim();
}

function absoluteUrl(value, base) {
  try {
    const url = new URL(decodeEntities(value).trim(), base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function parseDate(value = '') {
  const text = decodeEntities(value).trim();
  const chinese = text.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (chinese) return new Date(Date.UTC(+chinese[1], +chinese[2] - 1, +chinese[3]));
  const dotted = text.match(/(20\d{2})[./年-](\d{1,2})[./月-](\d{1,2})/);
  if (dotted) return new Date(Date.UTC(+dotted[1], +dotted[2] - 1, +dotted[3]));
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractTag(xml, names) {
  for (const name of names) {
    const match = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
    if (match) return stripHtml(match[1]);
  }
  return '';
}

function categoryFor(title, fallback = 'company') {
  if (/政策|行业|协会|市场|投用|产业|发布会|报告/i.test(title)) return 'industry';
  if (/技术|工艺|应用|突破|视觉|免示教|跟踪|AI|智能/i.test(title)) return 'technology';
  return fallback;
}

function makeItem(item) {
  const rawTitle = cleanTitle(item.title || '');
  if (rawTitle.length > 120 || /^(随着|本文|查看详情|了解更多|机器人产品|焊接机器人多少钱)/.test(rawTitle) || /\.\.\.|…|&hellip/i.test(rawTitle)) return null;
  const title = rawTitle.slice(0, 180);
  const url = absoluteUrl(item.url || '', item.baseUrl || item.url || 'https://example.org');
  const published = parseDate(item.publishedAt || '');
  if (!title || !url || !published || !keywords.test(`${title} ${item.summary || ''}`)) return null;
  const age = (now - published) / 86400000;
  if (age < -1 || age > (config.maxAgeDays || 365)) return null;
  return {
    title,
    summary: stripHtml(item.summary || '').slice(0, 240),
    url,
    source: stripHtml(item.source || '公开来源').slice(0, 80),
    publishedAt: published.toISOString(),
    ...(item.displayDate ? { displayDate: item.displayDate } : {}),
    category: ['company', 'industry', 'technology'].includes(item.category)
      ? item.category : categoryFor(title, item.category)
  };
}

function xmlItems(xml, source) {
  const entries = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const items = [];
  for (const entry of entries) {
    const title = extractTag(entry, ['title']);
    const summary = extractTag(entry, ['description', 'summary', 'content:encoded', 'content']);
    const publishedAt = extractTag(entry, ['pubDate', 'published', 'updated', 'dc:date']);
    const sourceName = extractTag(entry, ['source']) || source.name;
    const linkText = extractTag(entry, ['link']);
    const linkAttr = entry.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
    const url = linkAttr?.[1] || linkText;
    const item = makeItem({ title, summary, publishedAt, source: sourceName, url, baseUrl: source.url, category: source.category });
    if (item) items.push(item);
  }
  return items;
}

function htmlItems(html, source) {
  const items = [];
  const anchors = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchors.exec(html))) {
    const title = cleanTitle(match[2]);
    if (title.length < 14 || title.length > 120 || !keywords.test(title)) continue;
    if (/^(随着|本文|机器人产品|查看详情|了解更多|焊接机器人多少钱)/.test(title) || /\.\.\.|…|\[&?hellip/i.test(title)) continue;
    const start = Math.max(0, match.index - 100);
    const end = Math.min(html.length, anchors.lastIndex + 150);
    const context = stripHtml(html.slice(start, end));
    const dateText = (title.match(/20\d{2}[./-]\d{1,2}[./-]\d{1,2}/) || context.match(/20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?|20\d{2}[./-]\d{1,2}[./-]\d{1,2}/))?.[0];
    if (!dateText) continue;
    const url = absoluteUrl(match[1], source.url);
    if (!url || new URL(url).pathname === '/' || url === source.url) continue;
    const path = new URL(url).pathname;
    if (!/\.html?$|\/news\/?|\/News\/?|\/d\//i.test(path)) continue;
    const summary = `${source.name}发布的焊接机器人相关资讯，详情请查看来源原文。`;
    const item = makeItem({ title, summary, publishedAt: dateText, source: source.name, url, category: source.category });
    if (item) items.push(item);
  }
  return items;
}

async function fetchSource(source) {
  const response = await fetch(source.url, {
    headers: { 'user-agent': 'WeldNewsBot/1.0 (+public news aggregation; contact: site owner)', 'accept': 'application/rss+xml, application/atom+xml, text/html, */*' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`${source.name}: HTTP ${response.status}`);
  const body = await response.text();
  return source.type === 'rss' ? xmlItems(body, source) : htmlItems(body, source);
}

function canonicalUrl(value) {
  try { const u = new URL(value); u.hash = ''; u.search = ''; return u.href.replace(/\/$/, '').toLowerCase(); }
  catch { return value.toLowerCase(); }
}

function uniqueNews(items) {
  const quality = item => (keywords.test(item.title) ? 10 : 0) - Math.max(0, item.title.length - 70) / 10 - (/&|\[|\]|\.\.\.|…/.test(item.title) ? 20 : 0);
  const sorted = items.map(makeItem).filter(Boolean).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || quality(b) - quality(a));
  const seen = new Set();
  return sorted.filter(item => {
    const key = canonicalUrl(item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, config.maxArticles || 120);
}

function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function slug(item) {
  const hash = createHash('sha256').update(canonicalUrl(item.url) + item.title).digest('hex').slice(0, 10);
  return `${item.publishedAt.slice(0, 10)}-${hash}`;
}

function displayDate(item) {
  if (item.displayDate) return item.displayDate;
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(item.publishedAt)).replaceAll('/', '.');
}

function cardHtml(item) {
  const date = displayDate(item).split('.');
  const category = item.category || 'company';
  const label = { company: '企业动态', industry: '行业新闻', technology: '技术应用' }[category] || '企业动态';
  const search = escapeHtml(`${item.title} ${item.summary} ${item.source}`);
  return `            <a class="news-item" href="news/${slug(item)}.html" data-type="${category}" data-search="${search}">
              <div class="news-date"><b>${escapeHtml(date.at(-1))}</b><small>${escapeHtml(date.slice(0, 2).join('.'))}</small></div><div class="news-body"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary)}</p></div><div class="news-tail"><span class="tag${category === 'technology' ? ' hot' : ''}">${label}</span><small>${escapeHtml(item.source)} ↗</small></div>
            </a>`;
}

function articleHtml(item, siteUrl) {
  const pageUrl = siteUrl ? `${siteUrl}/news/${slug(item)}.html` : '';
  const published = new Date(item.publishedAt).toISOString();
  const hasExactDate = !/^20\d{2}\.\d{2}$/.test(item.displayDate || '');
  const schema = {
    '@context': 'https://schema.org', '@type': 'NewsArticle', headline: item.title,
    description: item.summary, datePublished: hasExactDate ? published : undefined,
    dateModified: hasExactDate ? published : undefined,
    mainEntityOfPage: pageUrl || undefined, author: { '@type': 'Organization', name: item.source },
    publisher: { '@type': 'Organization', name: config.siteName },
    isBasedOn: item.url
  };
  const canonical = pageUrl ? `<link rel="canonical" href="${escapeHtml(pageUrl)}">` : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(item.title)}｜${escapeHtml(config.siteName)}</title><meta name="description" content="${escapeHtml(item.summary)}"><meta name="robots" content="index,follow">
<meta property="og:type" content="article"><meta property="og:title" content="${escapeHtml(item.title)}"><meta property="og:description" content="${escapeHtml(item.summary)}">${canonical}
<script type="application/ld+json">${JSON.stringify(schema).replaceAll('<', '\\u003c')}</script>
<style>body{margin:0;background:#f5f6f2;color:#142522;font:16px/1.8 system-ui,"Microsoft YaHei",sans-serif}.wrap{max-width:780px;margin:8vh auto;padding:36px;background:#fff;border:1px solid #e2e8e2;border-radius:18px}a{color:#165c47}small{color:#728078}.brand{font-weight:800;color:#164c40;text-decoration:none}.tag{display:inline-block;margin-top:30px;padding:3px 9px;background:#edf4df;border-radius:5px;font-size:12px;color:#48684d}h1{font-size:32px;line-height:1.4;margin:14px 0}p{color:#56645e}.source{margin:28px 0;padding:16px;background:#f3f6f2;border-radius:10px;font-size:14px}@media(max-width:600px){.wrap{margin:0;padding:26px 20px;border-radius:0;min-height:100vh}h1{font-size:25px}}</style></head>
<body><main class="wrap"><a class="brand" href="../index.html">龙琪智造观察站 · 智能焊接产业资讯</a><div class="tag">${escapeHtml(({company:'企业动态',industry:'行业新闻',technology:'技术应用'})[item.category] || '企业动态')}</div>
<h1>${escapeHtml(item.title)}</h1><small>发布时间：${escapeHtml(displayDate(item))}　·　来源：${escapeHtml(item.source)}</small>
<p>${escapeHtml(item.summary || '本文为公开来源资讯摘要，详情请查看原文。')}</p><div class="source">本文依据公开来源整理，仅作资讯索引。<br>原文来源：<a href="${escapeHtml(item.url)}" rel="nofollow noopener" target="_blank">${escapeHtml(item.source)} 原文链接 ↗</a></div>
<p><a href="../index.html">← 返回资讯首页</a></p></main></body></html>`;
}

function resolveSiteUrl() {
  let value = process.env.SITE_URL || config.siteUrl || '';
  if (!value && process.env.GITHUB_REPOSITORY) {
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    value = repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${owner}.github.io` : `https://${owner}.github.io/${repo}`;
  }
  return value.replace(/\/$/, '');
}

const siteUrl = resolveSiteUrl();
let collected = [];
if (!skipFetch) {
  const results = await Promise.allSettled(sources.map(fetchSource));
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      collected.push(...result.value);
      console.log(`${sources[i].name}: ${result.value.length} 篇`);
    } else console.warn(`${sources[i].name}: ${result.reason.message}`);
  });
}

const oldItems = seed.items || [];
if (!skipFetch && !collected.length && !oldItems.length) throw new Error('没有可用新闻数据；保留旧数据并检查新闻来源配置。');
const items = uniqueNews([...collected, ...oldItems]);
const changed = JSON.stringify(items) !== JSON.stringify(uniqueNews(oldItems));
const updatedAt = changed ? now.toISOString() : (seed.updatedAt || now.toISOString());
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`, 'utf8');
await writeFile(resolve(root, 'news.json'), JSON.stringify({ updatedAt, items }, null, 2) + '\n', 'utf8');

let html = await readFile(indexPath, 'utf8');
const startMarker = '<!-- AUTO-NEWS-START -->';
const endMarker = '<!-- AUTO-NEWS-END -->';
const start = html.indexOf(startMarker);
const end = html.indexOf(endMarker);
if (start < 0 || end < start) throw new Error('index.html 缺少自动新闻标记，未更新页面。');
const cards = items.slice(0, 12).map(cardHtml).join('\n');
html = html.slice(0, start + startMarker.length) + '\n' + cards + '\n            ' + html.slice(end);
const updatedLabel = `资讯更新于 ${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(updatedAt))} · ${items.length} 条`;
html = html.replace(/(<div class="feed-updated" id="feedUpdated">)[\s\S]*?(<\/div>)/, `$1${escapeHtml(updatedLabel)}$2`);

if (siteUrl) {
  const seo = `<link rel="canonical" href="${siteUrl}/"><meta property="og:type" content="website"><meta property="og:site_name" content="${escapeHtml(config.siteName)}"><meta property="og:title" content="龙琪智造观察站 · 智能焊接产业资讯"><meta property="og:description" content="焊接机器人与智能焊接行业新闻、企业动态、应用案例与公开视频。">`;
  html = html.replace('<!-- GENERATED-SEO -->', seo);
}
await writeFile(indexPath, html, 'utf8');

const newsDir = resolve(root, 'news');
await mkdir(newsDir, { recursive: true });
for (const item of items) await writeFile(resolve(newsDir, `${slug(item)}.html`), articleHtml(item, siteUrl), 'utf8');

const sitemapUrls = [siteUrl ? `${siteUrl}/` : '', ...items.map(item => siteUrl ? `${siteUrl}/news/${slug(item)}.html` : '')].filter(Boolean);
if (siteUrl) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapUrls.map(url => `  <url><loc>${escapeHtml(url)}</loc></url>`).join('\n')}\n</urlset>\n`;
  await writeFile(resolve(root, 'sitemap.xml'), xml, 'utf8');
  await writeFile(resolve(root, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${siteUrl}/sitemap.xml\n`, 'utf8');
}
console.log(`已整理 ${items.length} 条资讯并生成可索引文章页${siteUrl ? `；站点地址：${siteUrl}` : '；尚未设置正式域名'}`);
