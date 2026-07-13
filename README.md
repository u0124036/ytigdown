# YouTube / Instagram 下載流程

這個專案由 `index.html` 呼叫 Cloudflare Worker，再由 Worker 呼叫 Cobalt API 取得下載連結並串流影片。

## 現況判斷

公開 Cobalt instance 會限流、加上 bot protection，或因來源站更新而失效。它們只能當最後備援，不適合當主要下載管道。

目前 Worker 支援三層流程：

1. 自架或授權 Cobalt：最穩定，建議設為主通道。
2. 公開 Cobalt fallback：不用設定，但不保證可用。
3. 本機 yt-dlp：網頁端失敗時的人工備援，適合需要 cookies 或登入的影片。

## Worker 設定

### 主通道

在 Cloudflare Worker 設定環境變數：

```sh
wrangler secret put COBALT_PRIMARY
```

值可以是一個或多個 Cobalt API base URL，用逗號分隔：

```txt
https://your-cobalt.example.com/
```

如果 Cobalt instance 需要驗證，設定其中一種：

```sh
wrangler secret put COBALT_API_KEY
wrangler secret put COBALT_BEARER_TOKEN
wrangler secret put COBALT_AUTH_HEADER
```

`COBALT_AUTH_HEADER` 可直接放完整 header 值，例如：

```txt
Api-Key xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

目前公開 Cobalt 對 YouTube 常回 `error.api.auth.jwt.missing`、HTTP 400/5xx，不能當主要通道。YouTube 要穩定下載，必須設定可用的 `COBALT_PRIMARY` 與對應授權。

### 關閉公開備援

如果只想使用自架或授權 instance：

```sh
wrangler secret put DISABLE_PUBLIC_COBALT_FALLBACKS
```

值設為：

```txt
1
```

## 健康檢查

部署後打開：

```txt
https://video-api.s0937854008.workers.dev/health
```

重點看：

- `primaryConfigured: true`：代表已設定主下載通道。
- `providers[].ok: true`：代表該 Cobalt instance 的 `GET /` 可連線。
- `providers[].services`：確認 instance 支援 `youtube`、`instagram`。

## 安全限制

`/proxy` 不再是公開任意網址代理。前端下載改走 `/download`，Worker 會在串流前檢查內容型態，避免把 Instagram 封面 JPEG 或錯誤文字誤判為 MP4。

如果 `/download` 回 `not_video:image`，代表 Cobalt 回來的是圖片/封面，不是影片。

## 建議的穩定流程

1. 先用網頁下載器。
2. 如果頁面顯示「使用公開備援通道」，先補 `COBALT_PRIMARY`。
3. 如果 YouTube 回 `bot`、`login`、`age`、`members` 相關錯誤，改用本機 yt-dlp 並帶 cookies。
4. 如果 Instagram 私人貼文、限動、好友可見內容失敗，改用本機 yt-dlp 並帶 Instagram cookies。
5. 如果 Cobalt 回 `local_processing_unsupported`，代表該素材需要本機合併或轉檔，改用 yt-dlp。

## 本機 yt-dlp 備援

安裝或更新：

```sh
brew install yt-dlp ffmpeg
brew upgrade yt-dlp ffmpeg
```

YouTube：

```sh
yt-dlp -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b" --merge-output-format mp4 "URL"
```

YouTube 需要登入或 cookies：

```sh
yt-dlp --cookies-from-browser firefox -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b" --merge-output-format mp4 "URL"
```

Instagram：

```sh
yt-dlp --cookies-from-browser firefox "URL"
```

如果 Firefox cookies 讀不到，改用瀏覽器外掛匯出 `cookies.txt` 後：

```sh
yt-dlp --cookies cookies.txt "URL"
```

## 失敗排查

先看 Worker：

```txt
/health
```

再看下載錯誤：

- `cobalt_error`：該 instance 無法處理請求或被擋。
- `api.auth.*.missing`：Cobalt instance 需要 API key 或 Bearer token。
- `local_processing_unsupported`：Worker 不能本機合併，改 yt-dlp。
- `fetch_403` 或 `tcp_403`：下載來源 CDN 擋 Cloudflare egress，改自架 Cobalt 或本機 yt-dlp。
- `all_failed`：所有設定的通道都不可用。

## 本機檢查

```sh
npm test
```

這會檢查 `worker.js` 語法與 `index.html` 內嵌 script 語法。
