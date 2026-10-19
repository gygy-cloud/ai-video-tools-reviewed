#!/usr/bin/env node
/**
 * serve.mjs —— 本地预览 site/ 目录
 * 用法：node scripts/serve.mjs [端口]
 * 会做一次构建，然后在 http://localhost:4000 提供预览
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(ROOT, 'site');
const PORT = Number(process.argv[2]) || 4000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function build() {
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'build-site.mjs')], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  } catch {
    console.error('构建失败，继续用现有的 site/ 目录提供服务');
  }
}

build();

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  let filePath = path.join(SITE_DIR, urlPath);

  // 目录 -> index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // 无扩展名 -> 当作目录尝试
  if (!fs.existsSync(filePath) && !path.extname(filePath)) {
    const alt = path.join(filePath, 'index.html');
    if (fs.existsSync(alt)) filePath = alt;
  }

  // 404 页面
  if (!fs.existsSync(filePath)) {
    const notFound = path.join(SITE_DIR, '404.html');
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      fs.existsSync(notFound)
        ? fs.readFileSync(notFound)
        : '<h1>404</h1><p>Not found. <a href="/">Go home</a></p>'
    );
    return;
  }

  // 防止路径穿越
  if (!path.resolve(filePath).startsWith(path.resolve(SITE_DIR))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(fs.readFileSync(filePath));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🌐 预览地址：http://localhost:${PORT}\n   Ctrl+C 停止\n`);
});
