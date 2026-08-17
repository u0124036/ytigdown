# ytigdown

`index.html`（前端，Cloudflare Pages）+ `worker.js`（`video-api` Worker）。部署靠 Cloudflare 的 Git 整合：push 到 GitHub 後自動建置，正式站來自 `main`。

## 部署規則（必做）

**每次部署都要把版本號 +1。** 版本號只存在 `index.html` 頁尾的 `· vNN`，是判斷手機上拿到的是不是新版的唯一依據，所以不能跳過。

```sh
npm run predeploy   # 跑檢查 + 版本號 +1
git commit -am "…"  # 版本號變更要跟這次部署的內容在同一個 commit
git push -u origin <branch>
```

- 只想確認目前版本：`npm run version:check`
- 只改版本號：`npm run bump`
- 沒有程式碼變更、單純要觸發重新建置時，那個 commit 本身就是版本號 +1。

## 注意

- 這個環境沒有 Cloudflare API token，跑不了 `wrangler deploy`；部署一律走 git push。
- `npm test` 會 `node --check worker.js` 並實際編譯 `index.html` 裡的 inline script，語法錯誤會擋下來。
