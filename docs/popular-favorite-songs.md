# 百万红心热门歌曲：Subsonic 扩展接口

`GET /rest/getPopularFavoriteSongs.view?size=30` 返回最多 30 首歌曲，JSON 位于 Subsonic 响应中的 `popularFavoriteSongs`。这不是标准 Subsonic 方法，需要客户端专门接入。

## 鉴权和请求

GET 请求使用 `X-Subsonic-User`、`X-Subsonic-Token`、`X-Subsonic-Salt` 请求头；其中 token 为 Subsonic 的 `MD5(密码 + salt)`。也支持 `POST /rest/getPopularFavoriteSongs.view`，以 `application/x-www-form-urlencoded` 表单发送 `u`、`t`、`s` 和可选的 `size`。请求可以包含 `v`、`c`、`f=json`；该扩展始终返回 JSON。为避免访问日志泄露令牌，URL 不接受 `u`、`t`、`s` 或明文密码参数，表单也不接受明文密码。公网应使用 HTTPS 等加密连接：POST 或请求头本身不能加密 HTTP。

`size` 可选，默认 30，必须是 1 至 30 的整数。成功包装的示例字段如下，数字仅为格式示例：

```json
{
  "subsonic-response": {
    "status": "ok",
    "popularFavoriteSongs": {
      "source": "netease",
      "chartId": "6723173524",
      "chartName": "网络热歌榜",
      "chartUpdatedAtMs": 1700000000000,
      "updatedAtMs": 1700000100000,
      "cacheTtlMs": 21600000,
      "stale": false,
      "partial": false,
      "scannedCount": 40,
      "candidateCount": 40,
      "chartSongCount": 100,
      "song": [{
        "id": "wy_123456",
        "title": "歌曲名",
        "artist": "歌手",
        "album": "专辑",
        "coverArt": "封面地址或 ID",
        "duration": 200,
        "favoriteCount": 1200000,
        "favoriteSource": "netease",
        "favoriteUpdatedAtMs": 1700000099000
      }]
    }
  }
}
```

实际上还返回已有的 Subsonic song 字段及响应包装字段。`favoriteCount` 是网易云的单曲红心用户数；严格筛选大于或等于 1,000,000，不是榜单的播放量或歌单收藏数。`favoriteUpdatedAtMs` 为本服务取得该数值的时间，`updatedAtMs` 为生成这一批结果的时间，`chartUpdatedAtMs` 是网易云返回的榜单更新时间；时间均为 Unix 毫秒。榜单可能在网易云调整或停止更新，本服务不编造更新时间。

## 缓存和失败

- 本服务读取网易云「网络热歌榜」，按榜单顺序最多检查前 40 首，最多返回 30 首合格歌曲；结果不足时不补充不合格歌曲。`chartSongCount`、`candidateCount` 和 `scannedCount` 分别表示榜单歌曲数、计划检查的候选数、实际查询人数的歌曲数。
- 正常结果缓存 6 小时。单曲查询间隔至少 350 毫秒；所有用户共用缓存和同一次刷新，单次刷新有时间和候选数上限。
- 首次请求或缓存过期后的刷新需要逐首核对人数，可能等待约 30 秒；客户端应设置足够长的请求超时，并显示加载状态。后续命中缓存的请求会快得多。
- 部分单曲查询失败或刷新触及时间上限时，返回其他已经核实的歌曲、`partial: true`，此结果缓存 10 分钟；不会把未知数值当作 0 或达到门槛。上游限流、禁止访问或连续失败时提前停止查询。
- 若刷新完全失败，允许返回生成时间不超过 24 小时的旧缓存，并标记 `stale: true`；仍保留原来的获取时间。没有可用缓存时返回 Subsonic `status: failed`，上游失败后短暂退避。客户端应检查 `status`，不能只看 HTTP 200。
- ID 使用现有的 `wy_<网易云歌曲 ID>`。能否播放还取决于当前账号配置的音乐源、歌曲版权和音质权限；榜单返回 ID 不代表已验证音流可用。
