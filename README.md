# 焊见智造网站

## 自动新闻

`scripts/update-news.mjs` 从 `news-sources.json` 中的公开 RSS 和公司新闻页采集内容，按标题和焊接关键词筛选、去重，然后更新 `news.json`、首页新闻列表和可索引的新闻详情页。新闻页面只展示简短摘要，并链接回原始来源。

本地预览：

```powershell
node scripts/update-news.mjs --seed-only
node scripts/serve.mjs
```

随后打开 `http://localhost:8000`。新闻源列表可在 `news-sources.json` 中调整。采集器只会导入带有可识别发布时间的焊接相关条目；采集失败时会保留已有数据。正式部署时由 `scripts/build-site.mjs` 生成仅含网站资源的 `_site` 目录。

## 部署与定时发布

仓库包含 GitHub Pages 部署流程，以及每 6 小时运行一次的新闻更新流程。更新任务会把新闻摘要写入仓库；随后部署流程将网站重新发布。

发布前需要：

1. 将项目上传至 GitHub 仓库，并使用 `main` 分支。
2. 在仓库设置中将 Pages 的发布来源设为 **GitHub Actions**。
3. 在仓库 `Settings → Secrets and variables → Actions → Variables` 新建 `SITE_URL`，值为公开站点的完整 HTTPS 地址。自定义域名需先配置 DNS，并在 Pages 设置中添加域名。
4. 在仓库 Actions 页面手动运行一次 **Update welding news**，然后运行 **Deploy site to GitHub Pages**。
5. 网站上线后，将 `/sitemap.xml` 提交至 Google Search Console 和 Bing Webmaster Tools。搜索引擎收录需要等待爬取，不会在部署后立即出现。

GitHub Pages 的默认地址由仓库名称决定；若改用其他托管服务，需要把定时任务和部署流程对应迁移到该平台。
