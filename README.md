# Pinterest Connector Cloud

一个部署到 Render 的 Node.js Express 服务，用 Pinterest 官方 API 读取你授权账号下的 Boards / Pins，并把某个 Board 同步成 Codex 每日审美训练可解压的批次包。

本服务只读取 Pinterest API 授权范围内的数据，不抓取搜索页，不绕过风控，不做搜索页截图。

## Render 免费实例提醒

Render 免费 Web Service 通常不适合长期保存 token / exports；如果没有 persistent disk，实例重启或重建后数据可能丢失。

正式使用建议选择 Render paid web service + disk，或把 token、exports 改接到外部数据库 / 对象存储。

## 创建 Pinterest Developer App

1. 打开 [Pinterest Developers](https://developers.pinterest.com/)。
2. 进入 My apps，创建一个 App。
3. 记录 `App ID / Client ID` 和 `App secret / Client Secret`。
4. 部署 Render 后，把回调地址加入 Pinterest App 的 Redirect URI：

```text
https://你的服务名.onrender.com/auth/pinterest/callback
```

需要的 OAuth scope：

```text
boards:read,pins:read,user_accounts:read
```

## Render 部署

1. 把本目录推到 GitHub 仓库 `pinterest-connector-cloud`。
2. 打开 Render Dashboard。
3. 选择 New Blueprint。
4. 选择 GitHub repo。
5. Render 会读取 `render.yaml` 创建 Web Service 和 `/var/data` disk。
6. 在环境变量中填入：

```text
PINTEREST_CLIENT_ID
PINTEREST_CLIENT_SECRET
```

`ADMIN_TOKEN` 会由 Render 自动生成。`NODE_ENV=production`、`DATA_DIR=/var/data` 已在 `render.yaml` 中配置。

## 完成 Pinterest 授权

部署完成后复制 Render service URL，例如：

```text
https://pinterest-connector-cloud.onrender.com
```

先把 callback URL 填入 Pinterest App：

```text
https://pinterest-connector-cloud.onrender.com/auth/pinterest/callback
```

然后访问授权入口：

```text
https://pinterest-connector-cloud.onrender.com/auth/pinterest/start
```

授权成功后，token 会保存到：

```text
/var/data/tokens/pinterest_token.json
```

服务不会把 `access_token` 或 `refresh_token` 返回给前端。

## API

除 `/health`、`/auth/pinterest/start`、`/auth/pinterest/callback` 外，其余接口都需要：

```text
Authorization: Bearer <ADMIN_TOKEN>
```

### Health

```bash
curl https://pinterest-connector-cloud.onrender.com/health
```

返回：

```json
{ "ok": true }
```

### 读取 Boards

```bash
curl \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://pinterest-connector-cloud.onrender.com/pinterest/boards
```

返回字段包括：

```text
id,name,description,privacy,created_at,pin_count
```

### 读取指定 Board 的 Pins

```bash
curl \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://pinterest-connector-cloud.onrender.com/pinterest/boards/<board_id>/pins
```

返回字段包括：

```text
pin_id,title,description,link,board_id,pin_url,image_url,width,height
```

### 同步 Board 为训练批次

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "board_id": "xxx",
    "batch_name": "2026-06-22_pinterest_board_training",
    "main_category": "其他 / 待判断"
  }' \
  https://pinterest-connector-cloud.onrender.com/sync/board
```

服务会生成：

```text
/var/data/batches/<batch_name>/reference_links.csv
/var/data/batches/<batch_name>/original_manifest.csv
/var/data/batches/<batch_name>/search_log.md
/var/data/batches/<batch_name>/images/
/var/data/exports/<batch_name>.zip
```

`formal_status` 规则：

```text
downloaded_valid：有本地图片、size_bytes > 0、有 sha256，可计入正式候选。
metadata_only：只有元数据，没有本地图片，不计入正式候选。
skipped_broken_image：图片下载失败，不计入正式候选。
skipped_low_quality：低清或尺寸异常，不计入正式候选。
```

### 列出 exports

```bash
curl \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://pinterest-connector-cloud.onrender.com/exports
```

### 下载 export zip

```bash
curl -L \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -o 2026-06-22_pinterest_board_training.zip \
  https://pinterest-connector-cloud.onrender.com/exports/2026-06-22_pinterest_board_training.zip
```

把 zip 解压到当前工作区：

```text
每日审美训练_30张图/联网候选_待审阅/
```

解压后应得到：

```text
每日审美训练_30张图/联网候选_待审阅/<batch_name>/
├─ images/
├─ reference_links.csv
├─ original_manifest.csv
└─ search_log.md
```

## 本地运行

```bash
npm install
copy .env.example .env
npm start
```

本地服务端口：

```text
http://localhost:3000
```

本地测试：

```bash
curl http://localhost:3000/health
```

## 数据安全

- 不要把 `.env` 提交到 GitHub。
- 不要把 `/var/data` 中的 token、batch、export 文件提交到 GitHub。
- `.gitignore` 已忽略 `.env`、`data`、`exports`、`tokens`、`node_modules`。
- token 只保存到 `DATA_DIR/tokens/pinterest_token.json`。
