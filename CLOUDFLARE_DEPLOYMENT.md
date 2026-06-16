# Cloudflare Pages 設定

此 repo 保留原本個人網站首頁，管理科學平台放在：

```text
/platform/
```

Cloudflare Pages 建議設定：

- Framework preset: None
- Build command: 留空
- Build output directory: `.`

平台 API 使用 Pages Functions，需在 Cloudflare Pages 專案的 Settings > Functions > Bindings 建立：

- KV namespace binding: `MS_DATA`
- R2 bucket binding: `MS_MEDIA`

未設定 binding 時，平台仍可讀取 repo 內 `storage/` 的初始資料，但新增、編輯、刪除、上傳圖片或法規文件會失敗。
