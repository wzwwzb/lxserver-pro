# 跨账号一起听：Subsonic 扩展接口

这些接口复用当前 Subsonic 账号鉴权。每台设备使用**自己的**用户名、令牌与盐；房间只传歌曲 ID 和播放状态，不传密码或带鉴权信息的音流地址。播放时，每台设备使用自己的账号请求既有的 Subsonic 音流接口。

## 请求与响应

- 在现有 Subsonic 路径下使用 `POST /rest/<方法名>.view`，表单格式为 `application/x-www-form-urlencoded`。
- 每次请求携带 `u`、`t`、`s`；`t` 为 Subsonic 的 `MD5(密码 + s)`。建议同时发送 `v`、`c`、`f=json`。请把参数放在 POST 表单体中，而不是 URL 或日志里。
- 不接受明文密码参数 `p`、`password` 等，也不接受音流 URL 参数。受限的歌曲或封面元数据不能包含带账号凭据的 URL。
- 所有房间接口返回现有的 JSON `subsonic-response` 包装。成功时 `status` 为 `ok`；失败时为 `failed` 并包含 `error.code` 和 `error.message`。不要仅凭 HTTP 200 判断成功。

| 方法 | 业务参数 | 成功结果 |
| --- | --- | --- |
| `createListenRoom` | 无 | `listenRoom` |
| `joinListenRoom` | `roomId` | `listenRoom` |
| `getListenRoom` | `roomId` | `listenRoom` |
| `updateListenRoom` | `roomId`、`songId`、`title`、`artist`、`album`、`coverArt`、`albumId`、`duration`、`positionMs`、`playing` | `listenRoom` |
| `leaveListenRoom` | `roomId` | 成功包装 |

`songId` 为空字符串表示尚未选歌；`playing` 为 `true` 或 `false`；`duration` 的单位是秒，`positionMs` 的单位是毫秒。`title`、`artist`、`album`、`coverArt`、`albumId` 可为空，`duration` 缺省为 0。

成功快照的结构：

```json
{
  "subsonic-response": {
    "status": "ok",
    "version": "1.16.1",
    "type": "lxserver",
    "listenRoom": {
      "roomId": "示例房间码，以服务器实际返回值为准",
      "revision": 3,
      "serverTimeMs": 1700000001000,
      "changedAtMs": 1700000000000,
      "positionMs": 12000,
      "playing": true,
      "song": {
        "id": "wy_example",
        "title": "歌曲名",
        "artist": "歌手",
        "album": "专辑",
        "coverArt": "封面 ID 或无鉴权信息的封面 URL",
        "albumId": "专辑 ID",
        "duration": 212
      },
      "members": ["用户甲", "用户乙"]
    }
  }
}
```

服务还会按已有 Subsonic 包装返回 `serverVersion` 和 `openSubsonic`。未选歌时，`song` 为 `null`。

`positionMs` 是 `changedAtMs` 时刻的基准位置。播放中客户端可用 `positionMs + max(0, serverTimeMs - changedAtMs)` 估算服务器响应时的进度，再考虑收到响应之后经过的本地时间；暂停时使用原位置。`serverTimeMs` 是响应时的服务器 Unix 毫秒，`changedAtMs` 是上次播放状态更新的服务器 Unix 毫秒，创建房间时初始化为创建时间。

## 成员和访问限制

- 房间码为高熵随机值，加入房间需要该码和本人账号鉴权。创建者自动加入；任意成员可邀请或更新状态。
- `get`、`update` 和 `leave` 都要求账号已加入。相同账号的多个设备计为一个成员；其中一个设备退出等同于该账号退出。
- 新成员加入、状态更新和成员退出会增加 `revision`；读取或重复加入同一账号不增加。服务在单进程中串行修改房间。
- 非成员与不存在或已过期房间使用同一类错误。空房间立即销毁；自最后一次成功成员活动起空闲 2 小时过期。房间只保存在内存中，服务重启后失效。
- 最多 256 个房间、每个房间最多 32 个账号，每个账号最多创建 16 个仍存活的房间。表单请求体不超过 16 KiB；各元数据字段也有长度限制。

本地曲库歌曲 ID 带有用户名。当两个成员的本地曲库**各自已经授权访问同一个文件**时，服务可以根据当前房间把原 ID 安全解析到请求者自己的文件。成员没有启用本地曲库、无权访问该文件或文件不是同一个时，音流、歌词和封面请求会失败，不会借用其他账号的权限。

房间接口不会记录参数，主服务的 Subsonic 访问日志不会记录查询字符串；反向代理或客户端的日志配置也应避免记录凭据和房间码。公网使用应通过 HTTPS 等加密传输保护房间码与登录令牌。
