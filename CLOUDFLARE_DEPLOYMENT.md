# Cloudflare Pages 設定

此 repo 的 Cloudflare 部署首頁會直接顯示管理科學平台；平台也保留在：

```text
/platform/
```

Cloudflare Pages 建議設定：

- Framework preset: None
- Build command: `npm run build`
- Build output directory: `dist`

平台 API 使用 Pages Functions，需在 Cloudflare Pages 專案的 Settings > Functions > Bindings 建立：

- KV namespace binding: `MS_DATA`
- R2 bucket binding: `MS_MEDIA`（選用；未設定時會改用 KV 儲存上傳檔案）

未設定 `MS_DATA` 時，平台仍可讀取 repo 內 `storage/` 的初始資料，但新增、編輯、刪除會失敗。
