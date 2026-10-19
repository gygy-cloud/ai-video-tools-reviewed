# 网站自动发布说明

这套东西解决一件事：**每周自动产出的文章 → 自动带上你的联盟追踪链接 → 自动发布到 GitHub Pages**，全程不用手动操作。

---

## 一、目录结构

```
2026-10-13-00-03-01/
├── .affiliate-links.json        ★ 联盟追踪链接配置（你唯一需要手动维护的文件）
├── site-src/
│   ├── content/                 ★ 要发布的文章（Markdown）
│   │   └── simplified-review.md
│   └── assets/style.css         站点样式
├── scripts/
│   ├── build-site.mjs           构建脚本（Markdown → HTML + 链接注入）
│   └── serve.mjs                本地预览服务器
├── site/                        构建产物（自动生成，已 gitignore）
├── .github/workflows/deploy.yml GitHub Actions 自动部署
├── package.json
└── outputs/                     内部文档（调研报告等，已 gitignore，不会发布）
```

**关键分工**：`site-src/content/` 里的东西会公开；`outputs/` 里的东西不会。

---

## 二、链接注入机制

有两条路径，同时生效。

### 路径 A：占位符（推荐，自动化用这个）

在文章任意位置写：

```markdown
{{aff:zebracat}}
```
→ 渲染成 `<a href="你的追踪链接">Visit Zebracat</a>`

```markdown
{{aff:zebracat|Try Zebracat free}}
```
→ 渲染成 `<a href="你的追踪链接">Try Zebracat free</a>`（自定义锚文本）

### 路径 B：自动改写已有链接

文章里如果直接写了平台链接，构建时会自动替换：

| 正文里写的 | 构建后变成 |
|---|---|
| `https://affiliate.simplified.com/` | 你的 Simplified 追踪链接 |
| `https://zebracat.ai/affiliate` | 你的 Zebracat 追踪链接 |
| `https://aipicturesque.com/` | 你的 Picturesque 追踪链接 |

匹配规则写在 `.affiliate-links.json` 的 `matchPatterns` 里，**按字符串长度降序匹配**，所以更具体的规则优先。

**所有被注入的链接自动加上** `rel="sponsored nofollow noopener"` 和 `target="_blank"` —— 这既是 FTC/Google 的规范，也避免被判定为操纵排名。

---

## 三、怎么填追踪链接（唯一需要你做的事）

打开 `.affiliate-links.json`，把对应项目的 `url` 从空字符串换成你的专属链接：

```json
"zebracat": {
  "name": "Zebracat",
  "url": "https://zebracat.ai/?fpr=你的ID",     ← 填这里
  "fallback": "https://www.zebracat.ai/",
  "matchPatterns": ["zebracat.ai"]
}
```

**没填会怎样**：构建不会失败，但链接会降级指向 `fallback`（官方主页），你赚不到佣金。构建报告会用 ⚠️ 列出所有未配置的项目：

```
⚠️  以下项目还没有填追踪链接，已降级指向官方主页（赚不到佣金）：
   · Zebracat（zebracat）
```

**填完就生效**，不需要动任何文章内容 —— 重新构建一次即可。

---

## 四、本地预览

```bash
npm install          # 第一次需要
npm run build        # 构建，看报告
npm run serve        # 构建 + 启动 http://localhost:4000
npm run check        # 只检查不写盘，看哪些链接没配
```

---

## 五、部署到 GitHub Pages

### 第 1 步：创建仓库并推送

在 GitHub 上新建一个仓库（**public** 才能免费用 Pages），然后在本地执行：

```bash
git remote add origin https://github.com/你的用户名/你的仓库名.git
git branch -M main
git push -u origin main
```

### 第 2 步：打开 Pages

仓库页面 → **Settings** → 左侧 **Pages** → **Build and deployment** → **Source** 选 **GitHub Actions**

不需要选分支，不需要填目录 —— 工作流会自己上传 `site/` 目录。

### 第 3 步：等第一次部署

回到 **Actions** 标签页，会看到 `Build & Deploy Site` 正在跑。约 1 分钟后完成，访问：

```
https://你的用户名.github.io/你的仓库名/
```

### 之后每次更新

`git push` 到 main 就自动重新构建部署。**每周自动化提交文章后会自动触发**，你什么都不用做。

---

## 六、每周自动化怎么接进来

每周一 09:00 的自动化现在应该：

1. 抓 openaffiliate.dev 实时数据
2. 选一个还没写过的项目
3. 写英文 SEO 长文，**CTA 用 `{{aff:项目slug}}` 占位符**
4. 写入 `site-src/content/<slug>.md`（带 `Date:` 元数据）
5. 社交内容仍写到 `outputs/content-YYYY-MM-DD/social-*.md`（不进仓库，供你手动发）
6. 执行 `npm run build` 验证，确认报告里没有 ❌

---

## 七、常见问题

**Q：构建报「未识别的占位符」？**
占位符里的 slug 在 `.affiliate-links.json` 的 `programs` 里不存在。检查拼写，或先在配置里加一条。

**Q：想加新项目？**
在 `.affiliate-links.json` 的 `programs` 里加一个键，填 `name` / `url` / `fallback` / `matchPatterns` 四项即可。

**Q：文章日期不对？**
构建按这个顺序取日期：目录名 → 元数据 `Date:` → 正文里的 `Last updated: October 13, 2026` → 文件修改时间。建议在元数据里显式写 `Date: 2026-10-13`。

**Q：目录链接点了没反应？**
构建会自动给标题生成 id，并对简写的锚点做前缀匹配修复（例如 `#simplified-pricing` → `#simplified-pricing-in-2026`）。修复数量会在报告里列出。

**Q：能不能不用 GitHub Pages，用别的？**
`site/` 是纯静态目录，Vercel / Netlify / Cloudflare Pages 都能直接部署，指向 `site` 作为输出目录即可。

---

## 八、两个必须注意的合规点

1. **FTC 披露**：文章模板和站点页脚都已有披露声明。**如果 AI 生成的文章漏了**，构建不会自动补 —— 生成内容时必须在正文顶部、第一个链接之前放披露声明。
2. **别投品牌词广告**：Zebracat、Fliki、Vid.AI、AdCreative、StoryLab 都明确禁止。这套流程走的是有机内容和 SEO，不涉及付费广告，所以安全 —— 但如果以后要投广告，记得先查条款。
