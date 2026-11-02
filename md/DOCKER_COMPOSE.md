# 使用 Docker Compose 部署当前仓库

仓库根目录的 `docker-compose.yml` 使用 `build: .` 构建当前源码。README 中的
`xcq0607/lxserver` 镜像来自上游，不能保证包含当前仓库的修改。此项目不需要额外部署
MySQL、Redis 或其他数据库，也不需要在宿主机安装 Node.js。

## 部署前的配置

复制 `.env.example` 为 `.env`，填写以下三项，使用不同的长密码：

| 变量 | 用途 |
| --- | --- |
| `ADMIN_PASSWORD` | 管理后台 `/admin` 的管理员密码，替换项目默认值 `123456` |
| `WEBPLAYER_PASSWORD` | Web 播放器的访问密码；模板默认开启 `ENABLE_WEBPLAYER_AUTH=true` |
| `LX_USER_user1` | 首次启动时创建同步用户 `user1` 的密码，替换项目自带的 `admin/password` |

密码保持单引号包裹，例如 `ADMIN_PASSWORD='自行替换的长密码'`。
若希望使用其他用户名，把 Compose 中的 `LX_USER_user1` 键及其插值变量、`.env` 中的
同名变量一起改为 `LX_USER_你的用户名`。也可以先使用 `user1`，再通过后台管理用户。

可选配置：

| 变量 | 默认值 | 调整方式 |
| --- | --- | --- |
| `HOST_IP` | `0.0.0.0` | 允许通过宿主机网络接口访问；若 Nginx 装在宿主机，可设为 `127.0.0.1` |
| `HOST_PORT` | `9527` | 若端口冲突，仅修改此值，例如 `19527`；容器内部仍使用 `9527` |
| `SERVER_NAME` | 模板中的服务名称 | 按需修改 |
| `ENABLE_WEBPLAYER_AUTH` | `true` | 需要免密进入播放器时才改为 `false` |
| `TZ` | `Asia/Shanghai` | 日志时间所用时区 |
| `LOCAL_LIBRARY_HOST_PATH` | `./music` | 已存在的宿主机音乐目录，可改为绝对路径 |
| `LOCAL_LIBRARY_CONTAINER_PATH` | `/library/music` | 曲库在容器内的路径，建议位于 `/library` 下 |

本服务当前启动代码固定监听容器内的 `0.0.0.0`。需要限制访问范围时，使用
`HOST_IP` 控制宿主机的端口发布范围。

`.env` 用于 Compose 插值。仅写入 `.env`、却未在 Compose 的 `environment`
中引用的新变量，不会自动传给应用。WebDAV、缓存策略及其他业务设置可在 `/admin`
中配置；需要通过环境变量管理时，在 Compose 的 `environment` 中显式添加相应项。

## 首次启动

在当前项目目录执行：

```bash
docker version
docker compose version

# 不覆盖已有 .env。
cp -n .env.example .env
chmod 600 .env
nano .env

mkdir -p data cache music cover_cache
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 lx-sync-server
```

如果没有 `nano`，使用其他文本编辑器编辑 `.env`。
`config --quiet` 只验证配置，不打印展开后的密码；必填项为空时会报错。
首次构建需要访问镜像仓库、Alpine 软件仓库和 npm，耗时取决于网络及设备性能。
现有 Dockerfile 会在镜像内安装依赖并编译 TypeScript。

已安装 Docker Engine、但缺少 Compose 插件的 Ubuntu/Debian 系统，在配置好
[Docker 官方软件源](https://docs.docker.com/compose/install/linux/)后可执行：

```bash
sudo apt-get update
sudo apt-get install docker-compose-plugin
docker compose version
```

Docker 命令若提示访问 daemon 的权限不足，可使用 `sudo docker ...`。
如果局域网无法访问，检查宿主机防火墙；云服务器还需要检查安全组是否允许所选端口。

## 访问服务

将下表中的服务器 IP 和端口替换为实际值：

| 入口 | 地址和凭据 |
| --- | --- |
| Web 播放器 | `http://服务器IP:9527/`，访问密码为 `WEBPLAYER_PASSWORD` |
| 管理后台 | `http://服务器IP:9527/admin`，使用 `ADMIN_PASSWORD` 登录 |
| LX 客户端同步 | 在设置中的同步功能填写 `http://服务器IP:9527/user1`，密码为 `LX_USER_user1` |
| Subsonic | 服务共用 `9527` 端口，API 路径为 `/rest`；使用同步用户名和密码，客户端若自动附加 `/rest`，服务器地址只填根地址 |

管理后台、播放器访问密码和同步用户是不同的认证入口，分别使用表中对应的密码。

首次进入后台后，检查用户配置，并按需导入可用的自定义音源。服务启动成功只代表
部署完成，实际在线歌曲播放还取决于音源及网络可用性。

## 持久化与配置生效

| 宿主机目录 | 容器目录 | 内容 |
| --- | --- | --- |
| `./data` | `/server/data` | 配置 `config.js`、用户 `users.json`、歌单、快照、音源、备份及 `logs/` 日志 |
| `./cache` | `/server/cache` | 默认存储位置下的歌曲缓存 |
| `./music` | `/server/music` | 默认存储位置下的下载歌曲 |
| `./cover_cache` | `/server/cover_cache` | 可重新生成的封面缓存 |

原 Compose 仅挂载 `data`，但歌曲缓存默认写入 `/server/cache`，下载写入
`/server/music`；这些目录已补充挂载。切换为 data 内缓存时，相应文件由 `data`
挂载保存。Dockerfile 默认 `LOG_PATH=/server/data/logs`，因此无需另挂
`./logs:/server/logs`。

不要把配置文件只读挂载到 `/server/data/config.js`：后台保存设置和自动备份需要
写入该文件。首次启动会把镜像内的根配置复制到 `data/config.js`；此后修改仓库根
`config.js` 不会直接更新已持久化的配置，应使用后台或实际的 `data/config.js`。

修改 `.env` 或 Compose 后执行：

```bash
docker compose config --quiet
docker compose up -d
```

`docker compose restart` 不会重新注入修改后的环境变量。普通配置项在启动时通常
由环境变量覆盖文件值；后台更改同一项后，下次重建容器仍可能被环境变量覆盖。

**同步用户的环境变量主要用于首次初始化。** 一旦 `data/users.json` 存在，代码会
在加载环境变量之后用该文件覆盖用户列表。因此已有用户的改密、增删请通过后台
完成，单改 `.env` 中的 `LX_USER_user1` 不会更新已有用户。

WebDAV 默认关闭，首次部署可保持关闭。启用后，启动过程会尝试恢复远端配置和
用户文件，可能改变本地设置，需确认远端备份属于本实例。

### 接入宿主机已有音乐库

这里的宿主机是运行 Docker 的服务器。如果音乐在另一台电脑上，需要先通过
SMB/NFS 等方式挂载到这台服务器，再将该挂载目录映射进容器。

仓库提供的 Compose 已把可写的 `./data/library` 挂载为容器内的 `/library`，
并通过 `.env` 配置一个外部音乐子目录。例如宿主机音乐目录为 `/mnt/music`：

```dotenv
LOCAL_LIBRARY_HOST_PATH='/mnt/music'
LOCAL_LIBRARY_CONTAINER_PATH='/library/music'
```

第一个值替换成真实的宿主机路径；第二个值是容器内路径。该映射与现有的
`./music:/server/music` 分别用于外部曲库和应用下载目录。
宿主机目录应已存在，避免路径拼错后 Docker 自动创建一个空目录。

保存后，在项目目录执行：

```bash
docker compose up -d
docker compose exec lx-sync-server ls -la /library
```

然后在网页中设置：

1. 使用管理员密码进入 `/admin` →「系统配置」→「自定义歌曲目录」，打开
   「启用自定义歌曲目录」并保存。
2. 进入「用户管理」，点击 `user1` 名字旁的铅笔按钮（提示为「重命名用户」，
   打开后标题为「用户配置」）。打开「启用此用户自定义歌曲目录」，目录填写
   `/library`，点击「检测」，成功后保存。这里只设置目录，无需更改用户名。
3. 返回播放器，以 `user1` 和该用户密码选择「用户账号登录」，进入「本地音乐」，
   打开旁边的自定义目录开关。服务会扫描该目录及其子目录。

后台填写的是容器路径 `/library`，不能填写未挂载的宿主机路径。
只通过播放器访问密码进入的访客没有 `user1` 的自定义目录配置，需要登录用户账号。

当前版本会在自定义音乐目录里保存 `custom_index.json`，因此要正常持久化索引，
`/library` 根目录需要可写。外部子目录的读写权限应按需求配置。若只想播放现有音乐，可先
关闭用户配置中的「允许操作目录歌曲」「允许写入歌曲文件」及自动下载，按需再开启。

播放这些本地文件不需要在线音源；自定义音源用于解析在线播放链接。

### 多个音乐目录汇总到同一个用户

当前每个用户只能配置一个 `customMusicDir`，但扫描器会递归扫描它下面的所有
子目录。可以把分散在不同磁盘上的音乐分别挂载到 `/library` 下的不同子目录，
无需移动或复制原文件。

现有配置已经包含可写根目录和一个可通过 `.env` 调整的外部音乐子目录。
如需更多目录，在 Compose 的 `volumes` 下增加挂载，左边替换为真实存在的宿主机目录：

```yaml
      # 额外的外部曲库：仅读取音乐时可使用只读挂载。
      - /mnt/disk1/Music:/library/disk1:ro
      - /mnt/disk2/Music:/library/disk2:ro
```

保留原有的 data、cache、music、cover_cache 和 `/library` 根目录挂载，避免重复
挂载到同一个容器路径。

在项目目录执行：

```bash
mkdir -p data/library
docker compose config --quiet
docker compose up -d
docker compose exec lx-sync-server ls -la /library/disk1 /library/disk2
```

后台用户的「自定义歌曲目录地址」仍然只填写 `/library`，保留全局和用户的启用
开关。以该用户登录播放器，在「本地音乐」中开启自定义目录，再点击「同步并刷新」。
两个目录的歌曲都会进入该用户的曲库。

本方案将索引写入可写的 `/library/custom_index.json`，音乐位于只读的子挂载，
因此不会出现整个 `/library` 只读导致索引保存失败的问题。如果需要向某个曲库
下载、修改标签、保存歌词或删除歌曲，需先去掉对应挂载的 `:ro`，再按需开启应用
权限。更多目录可以继续挂载到 `/library/disk3` 等不同子目录。

如果多个音乐文件夹本就在同一个只含音乐的父目录下，也可以仅挂载该父目录，
由应用递归扫描，无需逐个挂载。

### 导入在线音源

在播放器根页面进入「设置」→「源与基础设置」→「自定义源」→「管理 / 添加」。
弹窗支持「上传脚本文件」（LX 格式的 `.js` 文件）和「从 URL 导入」。
导入后在列表启用音源，等待初始化完成，再测试在线播放。

已登录用户导入的源通常保存在个人目录；需要配置公开源或遇到权限提示时，在
播放器设置的自定义源卡片点击「管理员登录」，使用 `ADMIN_PASSWORD`。
如果服务器无法下载远程链接，可以先在浏览器下载 `.js` 文件，再用上传方式导入。

## 使用域名和 HTTPS

公网使用时可在 Nginx、Caddy 等反向代理上配置域名和 TLS。LX 同步使用 WebSocket，
代理必须支持连接升级。以下是宿主机 Nginx 的转发片段；HTTPS 证书和监听配置需
另外设置：

```nginx
location / {
    proxy_pass http://127.0.0.1:9527;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

此时将 `.env` 的 `HOST_IP` 改为 `127.0.0.1`，并在 Compose 的 `environment`
中添加 `PROXY_HEADER: x-real-ip`，然后重新执行 `docker compose up -d`。
如果代理也运行在容器中，应让两者加入同一 Docker 网络，通过
`http://lx-sync-server:9527` 转发；代理容器内的 `127.0.0.1` 指向代理自己。

## 远程访问

远程访问可使用 HTTPS 反向代理，或按自己的网络环境配置 FRP 等穿透工具。
应用容器内部仍使用 `9527` 端口；外部域名、端口及穿透配置取决于自己的部署。
穿透工具的认证信息应保存在私有配置中，不要提交到公开仓库。

播放器使用服务根地址；管理后台附加 `/admin`；LX 同步路径附加用户名；
Subsonic 客户端通常填写服务根地址，由客户端自行处理 `/rest` 路径。

## 自定义音源排查

导入脚本后需要启用；上传到 `user1` 的私有音源，只会供登录了 `user1` 的请求使用。
脚本的「加载成功」表示初始化完成，播放时仍需上游接口正常返回音乐地址。

- `Unknown cipher`：旧版服务端对 LX 脚本的 AES 算法参数处理有误；当前代码已修复，并对齐 RSA 填充、HTTP 响应和事件返回值。
- `unknow error (... HTTP 503)`：音源上游接口不可用；如果返回 `Service Suspended`，需要等待提供方恢复或更换脚本。
- `read ECONNRESET`：请求连接被重置，需要检查对应音源服务及出站网络。
- `未找到支持 ... 平台的自定义源`：检查账号、启用状态和脚本支持的平台。

2026-10-21 排查时，Huibq `v1.2.0` 与作者仓库脚本一致，其接口返回 HTTP `503`、
`Service Suspended`，无法通过修改本机端口或重新导入相同脚本解决。
接口调用失败时，新增的诊断信息只包含上游主机名和 HTTP 状态，不包含完整请求地址。

## 听澜盒等 Subsonic 客户端

先在管理后台开启「自定义歌曲目录」，然后为 `user1` 启用自定义目录并填写
`/library`（使用容器内路径），在 Web 播放器「本地音乐」中同步目录索引。
Subsonic 会复用这份索引，提供歌曲、歌手、专辑以及名为「本地音乐」的只读歌单。
读取本地歌曲无需在线音源。

听澜盒添加服务器时填写：

| 项目 | 填写值 |
| --- | --- |
| 类型 | Subsonic |
| 协议 | HTTP 或 HTTPS，取决于部署 |
| 主机 | 服务器 IP 或域名 |
| 端口 | 自己配置的访问端口 |
| 用户名 | `user1` |
| 密码 | `.env` 中 `LX_USER_user1` 的值 |

如果界面要求完整地址，填写 `http://服务器IP:9527` 或自己的 HTTPS 地址，无需附加
`/rest`、`/user1` 或 `/admin`。
保存后刷新音乐库；如有音乐文件夹选项，选择「本地音乐库」。
本地目录歌曲按原文件提供播放及下载，客户端音质选择原始音质。
新增文件后可在 Web 播放器重新同步目录，或由 Subsonic 客户端发起扫描。

## 更新、备份和排查

更新前先停止服务并备份，备份文件包含密码和账户信息，应妥善保存：

```bash
docker compose stop
tar -czf ../lxserver-backup-$(date +%Y%m%d-%H%M%S).tar.gz .env data cache music cover_cache
docker compose start
```

确认本地修改已保存，再按自己的 Git 工作流更新代码；如工作区干净，可执行
`git pull --ff-only`。更新源码后重新构建：

```bash
docker compose up -d --build
docker compose ps
```

常用排查命令：

```bash
docker compose logs --tail=100 lx-sync-server
docker compose logs -f lx-sync-server
curl -I http://127.0.0.1:9527/
docker compose down
```

根页面启用访问密码时，HTTP `302` 跳转登录页属于正常响应。
当前项目启动日志会打印部分密码，分享日志前需要打码。
`down` 停止并移除容器，但上述宿主机绑定目录仍然保留；删除这些目录才会丢失数据。
不需要执行 `down` 才能更新，`up -d --build` 会负责重建发生变化的服务。
