# MPanel 应用商店模板

面板的「一键初始化」从这里读取 JSON 清单与 Docker Compose 编排模板，默认通过 GitHub 链接获取：

```text
https://raw.githubusercontent.com/Sakana-1314/MPanel/main/web/store
```

未显式配置 `storeUrl` 时，面板依次尝试 raw.githubusercontent.com、jsDelivr 镜像与同源 `/store`；每个地址最多等待 10 秒。

也可以在部署目录的 `config.json` 中覆盖 `storeUrl`（支持绝对 URL 或同源相对路径），此时只使用该地址，例如：

```json
{
  "storeUrl": "https://cdn.jsdelivr.net/gh/Sakana-1314/MPanel@main/web/store"
}
```

`发布站点` 工作流会把本目录复制到站点根下的 `/store/`，因此把 `storeUrl` 设为 `/store` 也能离线使用面板同源的模板。

## 目录

```text
web/store/
├─ index.json              # 应用索引：id、名称、分类、清单路径
├─ caddy/
│  ├─ app.json             # 清单：变量、Compose 路径、能力与 bootstrap 约定
│  └─ compose.yaml         # 编排模板（{{变量}} 占位）
├─ postgres/{app.json,compose.yaml}
└─ redis/{app.json,compose.yaml}
```

## 清单字段

| 字段 | 说明 |
|---|---|
| `id` | 应用唯一 id，与目录名一致 |
| `stack` | Compose 项目名，同时作为 `/stacks/:name` 的编排名 |
| `service` | Compose 服务名，agent 用它定位运行中的容器 |
| `compose` | 相对商店根目录（`index.json` 所在目录）的 Compose 模板路径 |
| `bootstrap` | `sites` 表示安装前调用 `POST /sites/bootstrap`，用返回的挂载填充变量 |
| `capability` | 安装后轮询的 `system/info.capabilities` 键 |
| `variables[]` | `key`、`label`、`default`、`secret`、`hidden`、`generate.length` |
| `profile` | 数据库安装后自动创建档案的映射：`kind`、`host`、`portVariable`、`usernameVariable`、`passwordVariable`、`databaseVariable`、`redisDb` |

模板占位符使用 `{{KEY}}`，面板会用变量值做纯文本替换；缺失的变量会直接报错，不会静默留空。Compose 中的 `$` 由 Docker Compose 解释，需要字面量 `$` 时写 `$$`。

## 约定

- 所有编排只绑定 `127.0.0.1`（数据库），或仅暴露必要的 80/443（Caddy）。
- 不在这里放真实密码、Token、IP 或内部域名；密码由安装向导在浏览器本地生成。
- 修改模板后需要同步更新 `web/docs/guide/sites.md` 与 `web/docs/guide/databases.md` 中描述的行为。
