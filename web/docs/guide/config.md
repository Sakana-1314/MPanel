# 配置文件与环境变量

MPanel 的配置完全沿用 1Panel 的目录与文件名：安装根默认 `/opt/mpanel`，core 读 `conf/app.yaml`，agent 读 `conf/agent.yaml`。所有字段都可以用 `MPANEL_*` 环境变量覆盖，便于容器、CI 与 systemd 部署。

::: tip 实现状态
配置加载、默认值、目录创建、原子写回与环境变量覆盖由 `internal/config` 实现（已实现）。本文列出的字段与该包的结构体一一对应；`ssl`、`entrance`、`username`、`password` 等字段目前只做加载与持久化，具体生效逻辑随 core 启动流程落地。
:::

## 1. 目录树

Linux 上默认安装根为 `/opt/mpanel`；非 Linux 开发机回退到 `~/.mpanel`，便于非特权进程启动。core 与 agent 共用同一安装根，但使用不同配置文件与子目录。

```text
/opt/mpanel/
├─ conf/
│  ├─ app.yaml            # core 配置（0600）
│  ├─ agent.yaml          # agent 配置（0600）
│  └─ bootstrap-token     # 首次初始化用，完成后删除
├─ data/                  # core 数据根（system.data_dir）
│  ├─ agent/              # agent 数据（agent.data_dir）
│  │  ├─ caddy/           # 受管 Caddy 配置（可通过 caddy_config 改）
│  │  │  ├─ Caddyfile
│  │  │  ├─ sites.d/*.caddy
│  │  │  ├─ staging/
│  │  │  └─ data/         # Caddy 证书与数据（可通过 caddy_data 改）
│  │  ├─ sites/           # 默认站点根
│  │  ├─ backups/         # 数据库与站点回滚备份
│  │  ├─ trash/           # 文件回收站
│  │  └─ tasks/           # 计划任务输出
│  └─ files/              # 默认文件管理根（files_roots 的默认项）
├─ log/                   # 运行日志（system.log_path / agent.log_path）
├─ db/                    # 状态文档（system.db_path）
├─ backup/                # 备份根（system.backup）
└─ tmp/                   # 临时文件（system.tmp_dir）
```

说明：

- `data/`、`log/`、`db/`、`backup/`、`tmp/` 在 `app.yaml` 中有独立字段，可以分别指向不同磁盘。
- `db/` 是 1Panel 同名目录。1Panel 在这里放 SQLite 的 `core.db`；MPanel 的控制面使用原子 JSON 文档（`internal/store`），按 1Panel 习惯放在同一棵树里，备份时直接打包整个 `db/`。
- agent 的 Caddy 目录解析顺序：`caddy_config` 非空则用它，否则 `${agent.data_dir}/caddy`；`caddy_data` 非空则用它，否则 `${caddy_config}/data`。
- 目录创建权限：core 的 `conf/`、`data/`、`log/`、`db/`、`backup/`、`tmp/` 为 `0700`；agent 的目录为 `0755`（站点/文件根需要被 Web 服务器读取），配置文件统一 `0600`。

## 2. `conf/app.yaml`（core）

配置文件缺失时会按默认值创建。以下是一份完整示例：

```yaml
system:
  port: 10086
  bindAddress: 0.0.0.0
  ssl: ""
  base_dir: /opt/mpanel
  data_dir: /opt/mpanel/data
  log_path: /opt/mpanel/log
  db_file: core.db
  db_path: /opt/mpanel/db
  backup: /opt/mpanel/backup
  tmp_dir: /opt/mpanel/tmp
  username: ""
  password: ""
  secret: "<首次启动自动生成>"
  version: 0.3.0
  entrance: ""
  language: zh
log:
  level: info
```

### 2.1 `system` 字段

| 字段 | 类型 | 默认值 | 对应 1Panel | 说明 |
|---|---|---|---|---|
| `port` | int | `10086` | `system.port` | core 监听端口。1Panel 安装时随机取 10000–65535；MPanel 固定 10086，便于反代与防火墙预设 |
| `bindAddress` | string | `0.0.0.0` | `system.bindAddress` | 监听地址。生产建议 `127.0.0.1`，由反向代理对外 |
| `ssl` | string | 空 | `system.ssl` | 预留的 TLS 开关字段，当前只加载/持久化 |
| `base_dir` | string | `/opt/mpanel` | `system.base_dir` | 安装根。非 Linux 默认 `~/.mpanel` |
| `data_dir` | string | `${base_dir}/data` | `system.data_dir` | 数据根 |
| `log_path` | string | `${base_dir}/log` | `system.log_path` | 日志目录 |
| `db_file` | string | `core.db` | — | 数据文件名，1Panel 兼容命名 |
| `db_path` | string | `${base_dir}/db` | `system.db_path` | 状态文档目录 |
| `backup` | string | `${base_dir}/backup` | `system.backup` | 备份根 |
| `tmp_dir` | string | `${base_dir}/tmp` | — | 临时目录 |
| `username` | string | 空 | — | 可选的管理员种子用户名；当前只加载/持久化，初始化请用 bootstrap token |
| `password` | string | 空 | — | 可选的管理员种子密码；同上 |
| `secret` | string | 随机 32 字节 | — | core 内部密钥，URL-safe base64；为空时自动生成 |
| `version` | string | 构建版本 | — | 版本号，可用 `-ldflags` 注入 |
| `entrance` | string | 空 | `system.entrance` | 预留的安全入口字段，当前只加载/持久化 |
| `language` | string | `zh` | — | 默认语言 |

### 2.2 `log` 字段

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `level` | string | `info` | 日志级别，常用 `debug`、`info`、`warn`、`error` |

## 3. `conf/agent.yaml`（agent）

```yaml
agent:
  transport: http
  listen: 0.0.0.0:10087
  token: ""
  core_url: ""
  machine_id: ""
  machine_secret: ""
  edge_key: ""
  base_dir: /opt/mpanel
  data_dir: /opt/mpanel/data/agent
  log_path: /opt/mpanel/log
  version: 0.3.0
  caddy_bin: caddy
  caddy_config: ""
  caddy_data: ""
  caddy_admin: ""
  docker_bin: docker
  pg_dump_bin: pg_dump
  psql_bin: psql
  redis_cli_bin: redis-cli
  files_roots:
    - name: files
      path: /opt/mpanel/data/files
log:
  level: info
```

### 3.1 `agent` 字段

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `transport` | string | `http` | `http`、`stdio` 或 `reverse-ws`。stdio 由 core 拉起子进程；reverse-ws 由 agent 主动拨号 core |
| `listen` | string | `0.0.0.0:10087` | http 传输的监听地址（`host:port`）。reverse-ws/stdio 仍会开一个仅 loopback 的随机端口供隧道回环使用 |
| `token` | string | 空 | agent 静态访问令牌。http 传输必填，建议至少 32 字节随机；core 用同一个值访问 agent |
| `core_url` | string | 空 | reverse-ws/边缘节点的 core 基地址，如 `https://panel.example.com`；也接受完整 `wss://.../ws/worker` |
| `machine_id` | string | 空 | 预建 reverse-ws 机器的 id；与 `machine_secret` 配对使用 |
| `machine_secret` | string | 空 | 预建 reverse-ws 机器的注册 secret，只在创建/轮换时显示一次 |
| `edge_key` | string | 空 | 边缘入网密钥（`mpedge_...`）。配置后 agent 先入网换取身份，再拨 `/ws/worker` |
| `base_dir` | string | `/opt/mpanel` | 安装根 |
| `data_dir` | string | `${base_dir}/data/agent` | agent 数据根 |
| `log_path` | string | `${base_dir}/log` | 日志目录 |
| `version` | string | 构建版本 | 版本号 |
| `caddy_bin` | string | `caddy` | Caddy 可执行文件；可写绝对路径 |
| `caddy_config` | string | `${data_dir}/caddy` | 受管 Caddy 配置目录（`Caddyfile`、`sites.d/`、`staging/`） |
| `caddy_data` | string | `${caddy_config}/data` | Caddy 数据目录（证书扫描来源） |
| `caddy_admin` | string | 空 | Caddy admin API 地址；留空时按 Caddy 默认 `127.0.0.1:2019` |
| `docker_bin` | string | `docker` | Docker CLI 路径 |
| `pg_dump_bin` | string | `pg_dump` | PostgreSQL 备份工具 |
| `psql_bin` | string | `psql` | PostgreSQL 恢复/查询工具 |
| `redis_cli_bin` | string | `redis-cli` | Redis CLI，用于 `rdb` 备份 |
| `files_roots` | list | `files=/opt/mpanel/data/files` | 文件管理沙箱根列表，每项 `{name, path}`；名称唯一，路径必须是绝对路径 |
| `log.level` | string | `info` | 日志级别 |

### 3.2 `files_roots` 的两种写法

YAML：

```yaml
agent:
  files_roots:
    - name: files
      path: /opt/mpanel/data/files
    - name: www
      path: /var/www
```

环境变量（会整体替换列表）：

```bash
export MPANEL_FILES_ROOTS='files=/opt/mpanel/data/files,www=/var/www'
```

解析规则：逗号分隔，每项 `name=path`；没有 `=` 时名称默认为 `files`；名称或路径为空则跳过。

## 4. `MPANEL_*` 覆盖规则

### 4.1 优先级与写回

加载顺序固定为：

```text
内置默认值  →  conf/app.yaml 或 conf/agent.yaml  →  MPANEL_* 环境变量
```

- 环境变量**只覆盖非空值**；无法用空字符串清空 YAML 中的字段。
- `MPANEL_PORT` 只有在解析为 `1..65535` 的整数时才生效，非法值被忽略。
- 每次加载都会做归一化，并**把结果原子写回 YAML（0600）**。因此环境变量覆盖过的值会落盘：之后即使不再设置该环境变量，文件里仍然是上次覆盖后的值。需要恢复默认值时请手动编辑 YAML。
- 安装根优先取 `MPANEL_BASE_DIR`（core）或 `MPANEL_AGENT_BASE_DIR`（agent）；配置文件路径由安装根推导，不能用环境变量单独指定文件名。

### 4.2 core 环境变量

| 环境变量 | 覆盖字段 | 备注 |
|---|---|---|
| `MPANEL_BASE_DIR` | `system.base_dir` | 安装根 |
| `MPANEL_PORT` | `system.port` | 1–65535 |
| `MPANEL_BIND_ADDRESS` | `system.bindAddress` | 如 `127.0.0.1` |
| `MPANEL_DATA_DIR` | `system.data_dir` | |
| `MPANEL_LOG_PATH` | `system.log_path` | |
| `MPANEL_DB_PATH` | `system.db_path` | |
| `MPANEL_BACKUP` | `system.backup` | |
| `MPANEL_TMP_DIR` | `system.tmp_dir` | |
| `MPANEL_SECRET` | `system.secret` | 为空时自动生成 |
| `MPANEL_USERNAME` | `system.username` | 种子管理员，规划中 |
| `MPANEL_PASSWORD` | `system.password` | 种子管理员，规划中 |
| `MPANEL_LOG_LEVEL` | `log.level` | |

### 4.3 agent 环境变量

| 环境变量 | 覆盖字段 | 备注 |
|---|---|---|
| `MPANEL_AGENT_BASE_DIR` | `agent.base_dir` | 安装根 |
| `MPANEL_AGENT_LISTEN` | `agent.listen` | `host:port` |
| `MPANEL_AGENT_TOKEN` | `agent.token` | http 传输必填 |
| `MPANEL_AGENT_TRANSPORT` | `agent.transport` | 配置层的传输覆盖名；命令行约定也接受 `MPANEL_TRANSPORT`，由 agent 入口映射 |
| `MPANEL_CORE_URL` | `agent.core_url` | reverse-ws / 边缘节点 |
| `MPANEL_MACHINE_ID` | `agent.machine_id` | 预建 reverse-ws |
| `MPANEL_MACHINE_SECRET` | `agent.machine_secret` | 预建 reverse-ws |
| `MPANEL_EDGE_KEY` | `agent.edge_key` | 边缘入网 |
| `MPANEL_AGENT_DATA_DIR` | `agent.data_dir` | |
| `MPANEL_CADDY_BIN` | `agent.caddy_bin` | |
| `MPANEL_CADDY_CONFIG` | `agent.caddy_config` | |
| `MPANEL_CADDY_DATA` | `agent.caddy_data` | |
| `MPANEL_CADDY_ADMIN` | `agent.caddy_admin` | |
| `MPANEL_DOCKER_BIN` | `agent.docker_bin` | |
| `MPANEL_PG_DUMP_BIN` | `agent.pg_dump_bin` | |
| `MPANEL_PSQL_BIN` | `agent.psql_bin` | |
| `MPANEL_REDIS_CLI_BIN` | `agent.redis_cli_bin` | |
| `MPANEL_FILES_ROOTS` | `agent.files_roots` | `name=path,...`，整体替换 |
| `MPANEL_LOG_LEVEL` | `log.level` | 与 core 同名 |

### 4.4 与 1Panel 的字段对照

| 1Panel `system.*` | MPanel 对应 | 说明 |
|---|---|---|
| `port` | `system.port` | 默认 10086，而不是安装时随机 |
| `bindAddress` | `system.bindAddress` | 语义相同 |
| `data_dir` | `system.data_dir` | 语义相同 |
| `log_path` | `system.log_path` | 语义相同 |
| `db_path` | `system.db_path` | 目录语义相同；MPanel 用原子 JSON 文档而不是 SQLite |
| `backup` | `system.backup` | 语义相同 |
| `base_dir` | `system.base_dir` | 默认 `/opt/mpanel` |
| — | `system.db_file`、`system.tmp_dir` | MPanel 额外拆分出的字段 |
| — | `agent.yaml` | agent 独立配置，1Panel 的 agent 配置同样独立 |

## 5. 端口与监听建议

| 场景 | core | agent |
|---|---|---|
| 单机直连 | 不启动 | `127.0.0.1:10087` + 同机反代 |
| 多机（http 传输） | `127.0.0.1:10086` + 反代 | `0.0.0.0:10087` 仅内网可达 |
| 多机（reverse-ws / 边缘） | `127.0.0.1:10086` + 反代 | `listen` 不对外；agent 只发起出站连接 |

修改端口后要同步更新反向代理、防火墙与前端连接地址。配置生效需要重启对应进程；环境变量在进程启动时读取。
