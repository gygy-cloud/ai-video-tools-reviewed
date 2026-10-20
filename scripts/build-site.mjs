#!/usr/bin/env node
/**
 * build-site.mjs —— 把 Markdown 内容构建成静态站，并注入联盟追踪链接
 *
 * 输入：
 *   outputs/content-YYYY-MM-DD/blog-*.md   （每周自动化产出的长文）
 *   site-src/content/**\/*.md              （手动放置的额外文章，可选）
 *   .affiliate-links.json                  （联盟追踪链接配置）
 *
 * 输出：
 *   site/                                   （GitHub Pages 发布目录）
 *
 * 链接注入的两条路径：
 *   1) 占位符：正文里写 {{aff:zebracat}} 或 {{aff:zebracat|自定义锚文本}}
 *   2) 自动改写：正文里已有的平台链接（如 https://zebracat.ai/affiliate）
 *      只要匹配 matchPatterns，就替换成你的追踪链接
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(ROOT, 'site');
const CONFIG_PATH = path.join(ROOT, '.affiliate-links.json');
const ASSETS_SRC = path.join(ROOT, 'site-src', 'assets');
const MANUAL_CONTENT = path.join(ROOT, 'site-src', 'content');

const argv = new Set(process.argv.slice(2));
const CHECK_ONLY = argv.has('--check');
const STRICT = argv.has('--strict');
const QUIET = argv.has('--quiet');

const log = (...a) => { if (!QUIET) console.log(...a); };
const warn = (...a) => console.warn(...a);

/* ------------------------------------------------------------------ */
/* 0. 部署路径前缀                                                     */
/* ------------------------------------------------------------------ */
/*
 * GitHub Pages 的「项目页」把站点放在 /<仓库名>/ 子路径下，而不是域名根。
 * 所有内部链接（导航、样式表、文章列表）如果写成 "/about/" 这种根绝对路径，
 * 线上会跳到用户名根目录并 404。本地预览时前缀为空，行为不变。
 *
 * 前缀来源优先级：环境变量 SITE_BASE > site.baseUrl 的路径部分 > 无前缀
 */
let BASE = '';

function resolveBase(site) {
  let p = process.env.SITE_BASE || '';
  if (!p && site && site.baseUrl) {
    try {
      p = new URL(site.baseUrl).pathname;
    } catch {
      p = '';
    }
  }
  p = String(p).trim().replace(/\/+$/, '');
  // 只接受干净的 URL 路径，防止 Windows shell 把 "/xxx" 转成 "C:/..."
  if (p && !/^\/[\w\-./]*$/.test(p)) {
    warn(`⚠️  SITE_BASE 不是合法路径（${p}），已忽略。Windows 下请直接配置 site.baseUrl`);
    p = '';
  }
  if (p && !p.startsWith('/')) p = '/' + p;
  return p === '/' ? '' : p;
}

/** 把站内绝对路径补上部署前缀 */
const link = (p) => `${BASE}${p.startsWith('/') ? p : '/' + p}`;

/* ------------------------------------------------------------------ */
/* 1. 配置                                                             */
/* ------------------------------------------------------------------ */

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`找不到配置文件：${CONFIG_PATH}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`配置文件 JSON 解析失败：${e.message}`);
  }
  cfg.programs = cfg.programs || {};
  cfg.site = cfg.site || {};

  // 校验 matchPatterns 是否有重复（会互相覆盖）
  const seen = new Map();
  for (const [slug, p] of Object.entries(cfg.programs)) {
    for (const pat of p.matchPatterns || []) {
      const key = pat.toLowerCase();
      if (seen.has(key) && seen.get(key) !== slug) {
        warn(`⚠️  matchPatterns 冲突：「${pat}」同时属于 ${seen.get(key)} 和 ${slug}，后者优先`);
      }
      seen.set(key, slug);
    }
    if (p.url && !/^https?:\/\//i.test(p.url)) {
      warn(`⚠️  ${slug} 的 url 不是 http(s) 链接：${p.url}`);
    }
  }
  return cfg;
}

/** 把所有匹配规则按「长度降序」展开，保证更具体的规则先命中 */
function buildPatternIndex(cfg) {
  const idx = [];
  for (const [slug, p] of Object.entries(cfg.programs)) {
    for (const pat of p.matchPatterns || []) {
      idx.push({ pat: pat.toLowerCase(), slug, program: p });
    }
  }
  idx.sort((a, b) => b.pat.length - a.pat.length);
  return idx;
}

function matchProgram(url, patternIndex) {
  const u = String(url).toLowerCase();
  for (const entry of patternIndex) {
    if (u.includes(entry.pat)) return entry;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 2. 内容发现与解析                                                    */
/* ------------------------------------------------------------------ */

function findContentFiles() {
  const files = [];

  // 手动文章：site-src/content/**/*.md  —— 这是「要发布」的唯一权威目录
  if (fs.existsSync(MANUAL_CONTENT)) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.md$/i.test(e.name)) {
          files.push({ file: full, date: null, source: 'content' });
        }
      }
    };
    walk(MANUAL_CONTENT);
  }

  // 兼容模式：--include-outputs 时把 outputs/content-YYYY-MM-DD/blog-*.md 也纳入
  // （默认关闭，因为 outputs/ 是内部文档目录，不进仓库）
  if (argv.has('--include-outputs')) {
    const outputsDir = path.join(ROOT, 'outputs');
    if (fs.existsSync(outputsDir)) {
      for (const dir of fs.readdirSync(outputsDir)) {
        const m = dir.match(/^content-(\d{4}-\d{2}-\d{2})$/);
        if (!m) continue;
        const full = path.join(outputsDir, dir);
        if (!fs.statSync(full).isDirectory()) continue;
        for (const f of fs.readdirSync(full)) {
          if (/^blog-.*\.md$/i.test(f)) {
            files.push({ file: path.join(full, f), date: m[1], source: 'outputs' });
          }
        }
      }
    }
  }

  return files;
}

/** 解析「---\nSEO METADATA\n---\nKey: Value\n...\n---」这种伪 front matter */
function parseContent(raw) {
  let text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const meta = {};

  // 第一层：可选的标签块  ---\nSEO METADATA\n---
  const labelMatch = text.match(/^---[ \t]*\n([^\n]{1,60})\n---[ \t]*\n/);
  if (labelMatch && /^[A-Z][A-Z0-9 _-]*$/.test(labelMatch[1].trim())) {
    meta._label = labelMatch[1].trim();
    text = text.slice(labelMatch[0].length);
  }

  // 第二层：Key: Value 块，以 --- 结束
  const kvMatch = text.match(/^([\s\S]*?)\n---[ \t]*\n/);
  if (kvMatch && /^[A-Za-z][\w ()-]*:[ \t]/m.test(kvMatch[1])) {
    for (const line of kvMatch[1].split('\n')) {
      const m = line.match(/^([A-Za-z][\w ()-]*):[ \t]*(.*)$/);
      if (m) meta[m[1].trim()] = m[2].trim();
    }
    text = text.slice(kvMatch[0].length);
  }

  return { meta, body: text.trim() };
}

function slugify(text) {
  return String(text)
    .replace(/<[^>]+>/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ */
/* 3. 链接注入                                                          */
/* ------------------------------------------------------------------ */

/**
 * 路径 A：占位符替换（在 Markdown 阶段做，产出标准 markdown 链接）
 *   {{aff:zebracat}}              -> [Visit Zebracat](url)
 *   {{aff:zebracat|Try it free}}  -> [Try it free](url)
 */
function replaceTokens(markdown, cfg, report) {
  return markdown.replace(
    /\{\{\s*aff:([a-z0-9_-]+)\s*(?:\|\s*([^}]+?)\s*)?\}\}/gi,
    (whole, slug, anchor) => {
      const p = cfg.programs[slug.toLowerCase()];
      if (!p) {
        report.unknownTokens.push(slug);
        return whole;
      }
      const target = p.url || p.fallback;
      if (!p.url) report.unconfigured.add(slug.toLowerCase());
      report.tokenHits[slug] = (report.tokenHits[slug] || 0) + 1;
      return `[${(anchor || `Visit ${p.name}`).trim()}](${target})`;
    }
  );
}

/**
 * 路径 B：HTML 阶段改写已有平台链接
 * 任何外链只要命中 matchPatterns，href 就换成你的追踪链接
 */
function rewriteLinks(html, patternIndex, report) {
  return html.replace(/<a\b([^>]*?)\bhref="([^"]*)"([^>]*)>/gi, (whole, pre, href, post) => {
    if (!/^https?:\/\//i.test(href)) return whole;
    const hit = matchProgram(href, patternIndex);
    if (!hit) return whole;

    const { slug, program: prog } = hit;
    const target = prog.url || prog.fallback;
    report.linkRewrite[slug] = (report.linkRewrite[slug] || 0) + 1;
    if (!prog.url) report.unconfigured.add(slug);

    // 清掉原有的 target / rel，统一重写
    const attrs = (pre + post).replace(/\s*\b(target|rel)="[^"]*"/gi, '').replace(/\s+/g, ' ').trim();
    const head = attrs ? `<a ${attrs} ` : '<a ';
    return `${head}href="${target}" target="_blank" rel="sponsored nofollow noopener">`;
  });
}

/** 给标题加 id，并修复正文里对不上的锚点 */
function addHeadingIds(html, report) {
  const ids = new Set();
  html = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (whole, lvl, inner) => {
    const base = slugify(inner) || `section-${ids.size + 1}`;
    let id = base;
    let i = 2;
    while (ids.has(id)) id = `${base}-${i++}`;
    ids.add(id);
    return `<h${lvl} id="${id}">${inner}</h${lvl}>`;
  });

  // 目录里手写的锚点常常是简写，用前缀匹配救回来
  html = html.replace(/href="#([^"]+)"/g, (whole, frag) => {
    if (ids.has(frag)) return whole;
    const cand = [...ids].find((id) => id.startsWith(frag));
    if (cand) {
      report.anchorsFixed.push(`${frag} -> ${cand}`);
      return `href="#${cand}"`;
    }
    report.anchorsBroken.push(frag);
    return whole;
  });

  return html;
}

/* ------------------------------------------------------------------ */
/* 4. 模板                                                             */
/* ------------------------------------------------------------------ */

function pageTemplate({ site, title, description, body, canonical, isHome, posts }) {
  const siteName = site.name || 'Affiliate Reviews';
  const nav = `<header class="site-header">
  <div class="wrap">
    <a class="brand" href="${link('/')}">${escapeHtml(siteName)}</a>
    <nav class="nav">
      <a href="${link('/')}">Reviews</a>
      <a href="${link('/about/')}">About</a>
    </nav>
  </div>
</header>`;

  const footer = `<footer class="site-footer">
  <div class="wrap">
    <p class="disclosure">
      <strong>Affiliate disclosure:</strong> This site contains affiliate links. If you buy through them,
      we may earn a commission at no extra cost to you. We only recommend tools we have evaluated.
    </p>
    <p class="copy">&copy; ${new Date().getFullYear()} ${escapeHtml(siteName)}. Independent reviews. Not affiliated with any vendor beyond the programs listed.</p>
  </div>
</footer>`;

  return `<!DOCTYPE html>
<html lang="${escapeHtml(site.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description || '')}">
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ''}
<link rel="stylesheet" href="${link('/assets/style.css')}">
</head>
<body>
${nav}
<main class="wrap">
${body}
</main>
${footer}
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* 5. 构建                                                             */
/* ------------------------------------------------------------------ */

function build() {
  const cfg = loadConfig();
  const patternIndex = buildPatternIndex(cfg);
  const site = cfg.site;
  BASE = resolveBase(site);
  if (BASE) log(`🔗 部署路径前缀：${BASE}`);

  const report = {
    posts: [],
    tokenHits: {},
    linkRewrite: {},
    unconfigured: new Set(),
    unknownTokens: [],
    anchorsFixed: [],
    anchorsBroken: [],
    skipped: [],
  };

  const sources = findContentFiles();
  if (!sources.length) {
    warn('⚠️  没有找到任何 Markdown 内容。自动化产出应位于 outputs/content-YYYY-MM-DD/blog-*.md');
  }

  const built = [];

  for (const src of sources) {
    const raw = fs.readFileSync(src.file, 'utf8');
    const { meta, body: rawBody } = parseContent(raw);

    if (!rawBody.trim()) {
      report.skipped.push({ file: path.basename(src.file), reason: '正文为空' });
      continue;
    }

    // 标题：优先 metadata，其次正文第一个 H1，最后用文件名
    let title = meta.Title || meta.title || '';
    if (!title) {
      const h1 = rawBody.match(/^#\s+(.+)$/m);
      title = h1 ? h1[1].trim() : path.basename(src.file, '.md');
    }
    const description = meta['Meta Description'] || meta.description || '';

    // slug：优先 metadata，其次正文 H1
    let slug = meta.Slug || meta.slug || '';
    if (!slug) {
      const h1 = rawBody.match(/^#\s+(.+)$/m);
      slug = slugify(h1 ? h1[1] : path.basename(src.file, '.md'));
    }
    slug = slugify(slug) || 'post';

    // 日期：目录名优先，其次 metadata 的 Date，再次正文里的 "Last updated"，最后文件 mtime
    let date = src.date;
    if (!date) {
      const d = meta.Date || meta.date;
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
        date = d;
      } else {
        const human = rawBody.match(/Last updated\**\s*:?\s*([A-Z][a-z]+ \d{1,2}, \d{4})/);
        const parsed = human ? new Date(human[1]) : null;
        date =
          parsed && !isNaN(parsed)
            ? parsed.toISOString().slice(0, 10)
            : fs.statSync(src.file).mtime.toISOString().slice(0, 10);
      }
    }

    // 模板已经在 <header> 里渲染了 H1，正文开头若还有一个 H1 就去掉，避免重复
    let bodyForRender = rawBody;
    if (/^#\s+/.test(bodyForRender)) {
      bodyForRender = bodyForRender.replace(/^#\s+[^\n]*\n+/, '');
    }

    // ① 占位符注入（Markdown 阶段）
    let md = replaceTokens(bodyForRender, cfg, report);

    // ② Markdown -> HTML
    let html = marked.parse(md);

    // ③ 已有平台链接改写（HTML 阶段）
    html = rewriteLinks(html, patternIndex, report);

    // ④ 标题 id + 锚点修复
    html = addHeadingIds(html, report);

    // ⑤ 包一层文章容器
    const articleBody = `<article class="post">
<header class="post-header">
  <p class="post-meta"><time datetime="${date}">${date}</time></p>
  <h1>${escapeHtml(title)}</h1>
</header>
${html}
</article>`;

    const canonical = site.baseUrl ? `${site.baseUrl.replace(/\/$/, '')}/posts/${slug}/` : '';
    const outFile = path.join(SITE_DIR, 'posts', slug, 'index.html');
    const page = pageTemplate({
      site,
      title: `${title}${site.name ? ' · ' + site.name : ''}`,
      description,
      body: articleBody,
      canonical,
    });

    built.push({ slug, title, description, date, outFile, page, html });
  }

  // 去重：同一 slug 只保留最新日期
  const bySlug = new Map();
  for (const p of built) {
    const prev = bySlug.get(p.slug);
    if (!prev || p.date > prev.date) {
      if (prev) report.skipped.push({ file: `posts/${p.slug}`, reason: '重复 slug，保留较新的一份' });
      bySlug.set(p.slug, p);
    } else {
      report.skipped.push({ file: `posts/${p.slug}`, reason: '重复 slug，保留较新的一份' });
    }
  }
  const posts = [...bySlug.values()].sort((a, b) => (a.date < b.date ? 1 : -1));

  /* ---- --check 模式：只报告，不写盘 ---- */
  if (CHECK_ONLY) {
    printReport(report, posts, cfg);
    const missing = [...report.unconfigured];
    if (STRICT && missing.length) {
      warn(`\n❌ --strict：以下项目缺少追踪链接：${missing.join(', ')}`);
      process.exit(1);
    }
    return;
  }

  /* ---- 写盘 ---- */
  fs.rmSync(SITE_DIR, { recursive: true, force: true });

  for (const p of posts) {
    fs.mkdirSync(path.dirname(p.outFile), { recursive: true });
    fs.writeFileSync(p.outFile, p.page, 'utf8');
  }

  // 首页
  const list = posts
    .map(
      (p) => `  <li class="card">
    <a href="${link(`/posts/${p.slug}/`)}">
      <time datetime="${p.date}">${p.date}</time>
      <h2>${escapeHtml(p.title)}</h2>
      ${p.description ? `<p>${escapeHtml(p.description)}</p>` : ''}
    </a>
  </li>`
    )
    .join('\n');

  const homeBody = `<section class="hero">
  <h1>${escapeHtml(site.name || 'Affiliate Reviews')}</h1>
  <p>${escapeHtml(site.tagline || '')}</p>
</section>
<ul class="post-list">
${list || '  <li class="card"><p>还没有文章。</p></li>'}
</ul>`;

  fs.writeFileSync(
    path.join(SITE_DIR, 'index.html'),
    pageTemplate({
      site,
      title: site.name || 'Affiliate Reviews',
      description: site.tagline || '',
      body: homeBody,
      canonical: site.baseUrl ? site.baseUrl.replace(/\/$/, '') + '/' : '',
    }),
    'utf8'
  );

  // 关于页（FTC 要求有实体说明）
  const aboutBody = `<article class="post">
<h1>About &amp; Disclosure</h1>
<p>${escapeHtml(site.name || 'This site')} publishes independent reviews of AI video and content tools.
We test tools, compare published pricing, and document affiliate program terms at source.</p>
<h2>How we make money</h2>
<p>Some links on this site are affiliate links. If you subscribe through one, the vendor pays us a
commission at no additional cost to you. This never changes our ratings — we list downsides
explicitly, including short cookie windows and capped commission periods.</p>
<h2>Editorial independence</h2>
<p>We do not accept payment for positive coverage. Where a vendor's published terms conflict with
third-party data, we say so in the article.</p>
</article>`;

  fs.mkdirSync(path.join(SITE_DIR, 'about'), { recursive: true });
  fs.writeFileSync(
    path.join(SITE_DIR, 'about', 'index.html'),
    pageTemplate({
      site,
      title: `About & Disclosure${site.name ? ' · ' + site.name : ''}`,
      description: 'Affiliate disclosure and editorial policy.',
      body: aboutBody,
      canonical: site.baseUrl ? site.baseUrl.replace(/\/$/, '') + '/about/' : '',
    }),
    'utf8'
  );

  // 样式
  fs.mkdirSync(path.join(SITE_DIR, 'assets'), { recursive: true });
  if (fs.existsSync(ASSETS_SRC)) {
    for (const f of fs.readdirSync(ASSETS_SRC)) {
      fs.copyFileSync(path.join(ASSETS_SRC, f), path.join(SITE_DIR, 'assets', f));
    }
  }

  // robots + sitemap
  const robots = ['User-agent: *', 'Allow: /'];
  if (site.baseUrl) robots.push(`Sitemap: ${site.baseUrl.replace(/\/$/, '')}/sitemap.xml`);
  fs.writeFileSync(path.join(SITE_DIR, 'robots.txt'), robots.join('\n') + '\n', 'utf8');
  if (site.baseUrl) {
    const base = site.baseUrl.replace(/\/$/, '');
    const urls = [`${base}/`, `${base}/about/`, ...posts.map((p) => `${base}/posts/${p.slug}/`)];
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>`;
    fs.writeFileSync(path.join(SITE_DIR, 'sitemap.xml'), sitemap, 'utf8');
  }

  printReport(report, posts, cfg);
}

function printReport(report, posts, cfg) {
  log('\n══════════════════════════════════════════');
  log('  构建报告');
  log('══════════════════════════════════════════');
  log(`\n📄 生成文章：${posts.length} 篇`);
  for (const p of posts) log(`   · ${p.date}  ${p.slug}  「${p.title}」`);

  const tokens = Object.entries(report.tokenHits);
  log(`\n🔗 占位符注入：${tokens.length ? tokens.reduce((a, [, n]) => a + n, 0) : 0} 处`);
  for (const [k, n] of tokens) log(`   · {{aff:${k}}} × ${n}`);

  const nameOf = (slug) => (cfg.programs[slug] && cfg.programs[slug].name) || slug;

  const rewrites = Object.entries(report.linkRewrite);
  log(`\n🔁 已有链接改写：${rewrites.length ? rewrites.reduce((a, [, n]) => a + n, 0) : 0} 处`);
  for (const [k, n] of rewrites) log(`   · ${nameOf(k)} × ${n}`);

  if (report.unknownTokens.length) {
    warn(`\n⚠️  未识别的占位符（配置里没有这个 slug）：${[...new Set(report.unknownTokens)].join(', ')}`);
  }

  if (report.unconfigured.size) {
    warn(`\n⚠️  以下项目还没有填追踪链接，已降级指向官方主页（赚不到佣金）：`);
    for (const s of report.unconfigured) warn(`   · ${nameOf(s)}（${s}）`);
    warn(`   → 编辑 .affiliate-links.json 填上 url，重新构建即生效`);
  } else {
    log('\n✅ 所有用到的项目都已配置追踪链接');
  }

  if (report.anchorsFixed.length) {
    log(`\n🔧 自动修复目录锚点：${report.anchorsFixed.length} 处`);
    for (const a of report.anchorsFixed.slice(0, 6)) log(`   · ${a}`);
  }
  if (report.anchorsBroken.length) {
    warn(`\n⚠️  无法匹配的目录锚点：${[...new Set(report.anchorsBroken)].join(', ')}`);
  }
  if (report.skipped.length) {
    log(`\n⏭  跳过：${report.skipped.length} 项`);
    for (const s of report.skipped) log(`   · ${s.file} —— ${s.reason}`);
  }

  const configured = Object.values(cfg.programs).filter((p) => p.url).length;
  log(`\n📊 配置进度：${configured}/${Object.keys(cfg.programs).length} 个项目已填追踪链接`);
  if (!CHECK_ONLY) log(`\n📁 输出目录：${SITE_DIR}\n`);
}

/* ------------------------------------------------------------------ */
/* 6. watch                                                            */
/* ------------------------------------------------------------------ */

if (argv.has('--watch')) {
  build();
  const targets = [path.join(ROOT, 'outputs'), MANUAL_CONTENT, CONFIG_PATH].filter((p) => fs.existsSync(p));
  log(`👀 监听中：${targets.map((t) => path.relative(ROOT, t)).join(', ')}`);
  let timer = null;
  for (const t of targets) {
    fs.watch(t, { recursive: fs.statSync(t).isDirectory() }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          build();
        } catch (e) {
          warn('构建失败：', e.message);
        }
      }, 300);
    });
  }
} else {
  try {
    build();
  } catch (e) {
    warn('\n❌ 构建失败：', e.message);
    process.exit(1);
  }
}
