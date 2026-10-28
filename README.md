# dsh-siyuan-sender

把 DeepSeek Harness 对话里生成的 Markdown 文档，一键发送到你自己部署的思源笔记（SiYuan）。

对话中每份生成出来的文档，卡片上会多出一个「思源」按钮；点一下，文档就带着标题和正文落进你指定的笔记本，并提示落位路径。也可以直接对模型说「把 xxx.md 发到思源」，由 Agent 工具完成。

> 已在 SiYuan 3.8.8（Docker 部署、外网访问）上实测通过。

> 想了解实现细节、设计取舍与安全模型，见 [设计说明.md](设计说明.md)。本文只讲怎么用。

---

## 目录

- [功能](#功能)
- [准备工作](#准备工作)
- [安装](#安装)
- [配置](#配置)
- [使用](#使用)
- [命名与去重规则](#命名与去重规则)
- [给模型的工具](#给模型的工具)
- [安全与隐私](#安全与隐私)
- [故障排查](#故障排查)
- [开发](#开发)
- [已知限制](#已知限制)
- [许可证](#许可证)

---

## 功能

| 入口 | 位置 | 说明 |
|---|---|---|
| 交付文件卡片 | 每轮对话末尾的交付文件卡片，右侧按钮行 | 图标 + 「思源」，只对 `.md` 文件出现 |
| 文档预览工具栏 | 右侧边栏预览 `.md` 时，标题栏工具栏 | 图标 + 「发送到思源」 |
| 设置页 | 设置 → **思源发送** | 地址、Token、笔记本、父路径、连接测试 |
| Agent 工具 | `siyuan_send` | 模型可自行调用，参数为工作区内的文件路径 |

发送结果有三层反馈：

- **按钮本体**：发送中显示「发送中…」；成功变绿显示「已发送」；失败变红显示「重试」，可直接再点。
- **浮出提示**：成功时浮出「已发送到思源「笔记本名」」以及完整文档路径，停留 7 秒；失败时浮出具体原因，停留 12 秒。
- **无障碍**：成功走 `role="status"` / `aria-live="polite"`，失败走 `role="alert"` / `aria-live="assertive"`。

---

## 准备工作

1. **SiYuan 侧**
   - 确认 SiYuan 正常运行且能被这台机器访问（Docker 部署时注意端口映射与反向代理）。
   - 记下基础地址，**到端口为止**，不要带 `/api`：
     - 局域网：`http://192.168.1.10:6806`
     - 域名反代：`https://siyuan.example.com`
   - 打开 **设置 → 关于 → API token**，复制 token。
   - 准备一个目标笔记本，例如 `DSH收件箱`。建议专门建一个，别和主笔记混在一起。
2. **DSH 侧**
   - 需要能访问 SiYuan 所在网络（本机或同网段最省事）。

> 如果 SiYuan 使用**自签名 HTTPS 证书**，请在插件设置里勾选「允许自签名证书」，否则连接会因证书校验失败被拒。

---

## 安装

这是一个「bundle」形态的 DSH 插件，包含宿主端与浏览器端两半。用插件管理器安装本地目录即可，**不要**手动编辑 profile 的 `package.json` 或 `cordis.patch.yml`。

让 Agent 执行：

```text
plugin_manager  action: install_bundle
                target: <本仓库的绝对路径>
```

或者用 DSH 命令行把该目录加入当前 profile。安装成功后：

- 设置里出现新的「思源发送」页；
- 对话里 `.md` 交付卡片右侧出现按钮；
- 工具列表出现 `siyuan_send`。

**修改代码后需要重新安装**（先 `remove_bundle` 再 `install_bundle`），然后刷新浏览器页面。只刷新页面不会重新加载已安装的旧代码。

---

## 配置

### 通过设置页（推荐）

设置 → **思源发送**，填写：

| 字段 | 说明 |
|---|---|
| 思源地址 | 基础地址，例如 `http://nas.example.com:6806` |
| API token | 从 SiYuan「设置 → 关于」复制；只存入本机凭据库，不写入设置文件 |
| 目标笔记本 | 笔记本**名称**或 **ID**，例如 `DSH收件箱` |
| 父文档路径 | 笔记本内的存放位置，例如 `/DSH收件箱`；填 `/` 表示直接放根目录 |
| 允许自签名证书 | 仅在私有 CA / 自签名 HTTPS 时开启 |

填完点 **测试连接**，会返回 SiYuan 版本号并确认笔记本是否找到。找不到时提示会列出你实际拥有的笔记本名称，方便直接改。

### 通过配置文件

运行期设置在 bundle 的 `cordis.patch.yml` 里，安装后保存在：

```
$DSH_HOME/.dsh-siyuan-sender.json
```

字段含义如下（除 token 外都可直接改文件）：

```json
{
  "endpoint": "http://nas.example.com:6806",
  "tokenRef": "SIYUAN_API_TOKEN",
  "notebook": "DSH收件箱",
  "parentPath": "/DSH收件箱",
  "allowSelfSigned": false,
  "timeoutMs": 15000
}
```

- `tokenRef` 是**凭据引用名**，不是 token 本身。改这个名字就等于换一个凭据槽位。
- `timeoutMs` 允许 1000–120000，默认 15000。
- `parentPath` 会自动规范化：统一正斜杠、去掉多余斜杠和末尾斜杠。

---

## 使用

### 在对话里点按钮

当模型生成并交付了一份 `.md` 文档，卡片右侧会出现「思源」按钮。点它 → 按钮进入「发送中…」→ 成功后变绿并浮出路径提示。

非 Markdown 文件（如 `.png`、`.docx`）不会显示该按钮；后端也会拒绝，避免把二进制塞进笔记本。

### 在右侧预览里点按钮

打开任意 `.md` 的侧边栏预览，工具栏上会出现「发送到思源」。适合先把文档读一遍再决定发不发。

### 让模型发送

```text
把 report.md 发送到思源
```

模型会调用 `siyuan_send`，并把「笔记本 / 路径 / 文档 ID」回给你。

---

## 命名与去重规则

文档标题按这个顺序决定：

1. 正文第一个 `# 一级标题`（不超过 120 字符时优先用它）；
2. 否则用文件名去掉扩展名。

标题会做路径安全处理：`\ / : * ? " < > |` 替换为 `-`，连续空白合并成一个空格，截断到 120 字符。

**重名绝不覆盖。** 若目标路径已存在，自动追加本地时间戳：

```text
/DSH收件箱/季度报告                      ← 首次
/DSH收件箱/季度报告 2026-10-28 13:07     ← 同名再发
/DSH收件箱/季度报告 2026-10-28 13:07 (2) ← 同一分钟内再发
```

时间戳取的是**运行 DSH 那台机器**的本地时区，不是 NAS 的时间。

支持发送的扩展名：`.md`、`.markdown`、`.mdown`、`.mdx`。

---

## 给模型的工具

```json
{
  "name": "siyuan_send",
  "parameters": {
    "path": "相对会话工作区的 Markdown 路径"
  }
}
```

返回体：

```json
{ "ok": true, "docId": "...", "hpath": "/DSH收件箱/…", "title": "…", "notebook": "DSH收件箱" }
```

失败时返回 `{ "ok": false, "error": "可直接展示给用户的中文原因" }`。

---

## 安全与隐私

- **Token 不落设置文件**。它通过 DSH 的凭据服务（`ctx.credentials`）保存，属于 `$DSH_HOME` 下的凭据存储；每次请求时重新解析，所以换 token 不用重启。
- **Token 不出宿主进程**。浏览器端所有接口的响应体都不含 token 值，只回报「是否已配置」。
- **路由在认证栅栏内**。三个接口注册在 DSH 的连接层上，未认证请求一律 401，跨站请求也进不来。
- **只发 Markdown**。扩展名不在白名单内直接拒绝，避免把二进制文件送进笔记库。
- **不覆盖已有内容**。同名必定新建，绝不静默改写你已有的笔记。
- **不记录敏感日志**。发送失败只回报错误文本，不写 token。

---

## 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 点按钮无任何反应 | 浏览器还跑着旧代码 | 重新安装插件后**刷新页面** |
| 「还没有设置思源地址」 | 配置未保存 | 设置 → 思源发送 → 填地址 → 保存 |
| 「API token 无效或未授权」 | token 复制错、或已重置 | 重新从思源「设置 → 关于」复制 |
| 「该地址没有返回思源的响应」 | 填成了别的 Web 服务，或路径带了 `/api` | 只填基础地址到端口 |
| 「没有找到名为 X 的笔记本」 | 名称不符，或笔记本未打开 | 提示里会列出实际笔记本名；照抄一个，或用笔记本 ID |
| 「思源的 HTTPS 证书校验失败」 | 自签名证书 | 勾选「允许自签名证书」 |
| 「思源拒绝连接」 | 端口错 / 容器未起 / 防火墙 | 先在浏览器打开 SiYuan 确认可达 |
| 「超时」 | 外网链路慢 | 调大 `timeoutMs`（最高 120000） |
| 笔记本里出现多份同名文档 | 重复点击 | 这是「不覆盖」设计；删掉多余的即可 |

---

## 开发

### 文件结构

```
dsh-siyuan-sender/
├── index.js            # 宿主端：三个路由 + siyuan_send 工具 + SiYuan HTTP 客户端
├── client.js           # 浏览器端：三个 UI 席位，零构建（window.__ModuleLoader__ 契约）
├── cordis.patch.yml    # bundle patch：插入一行插件配置
├── package.json        # 清单：dsh.bundle / dsh.client 声明
├── locale/
│   ├── zh.json         # 插件管理页显示的中文标题与描述
│   └── en.json         # 英文标题与描述
├── icon.svg            # 插件图标
├── README.md           # 面向使用者（你正在看的这份）
├── 设计说明.md          # 面向维护者：架构、决策、安全模型、踩过的坑
├── LICENSE             # MIT
└── test/
    └── host.test.mjs   # 宿主端回归测试（内置模拟思源内核）
```

### 两半的职责

- **宿主端**（`index.js`）：唯一持有 token 的地方，负责把「交付文件坐标」或「工作区路径」解析成绝对路径、读文件、调 SiYuan API。同时把它注册为 `siyuan_send` 工具，让 UI 和 Agent 共用同一份逻辑。
- **浏览器端**（`client.js`）：只负责界面。文件按钮不传路径，只把它从卡片上拿到的会话坐标（`sessionId` / `seq` / `index`）交给宿主，由宿主重新走会话授权路径解析 —— 浏览器不直接接触文件系统。

### 用到的 SiYuan API

| 接口 | 用途 |
|---|---|
| `POST /api/system/version` | 连接测试，确认是思源 |
| `POST /api/notebook/lsNotebooks` | 按名称或 ID 解析目标笔记本 |
| `POST /api/filetree/getIDsByHPath` | 判断 hpath 是否已被占用（去重） |
| `POST /api/filetree/createDocWithMd` | 以 Markdown 创建文档 |

认证头：`Authorization: Token <token>`。所有接口都是 `POST` + JSON body。

### 跑测试

测试不依赖真实思源：它起一个本地 HTTP 服务器模拟 SiYuan 内核，把插件挂到假 context 上，覆盖配置往返、连接测试、按坐标发送、去重、拒绝非 Markdown、缺 token、工具调用与渲染。

```bash
node test/host.test.mjs
```

期望输出 `22/22 checks passed`，退出码 0。

### 改完代码怎么生效

1. `plugin_manager` → `remove_bundle`（目标 `@local/dsh-siyuan-sender`）
2. `plugin_manager` → `install_bundle`（目标本目录绝对路径）
3. 刷新浏览器页面

只做第 3 步不会加载新代码 —— profile 里存的是安装时的副本。

---

## 已知限制

- **只处理 Markdown**。其它格式请在思源里用导入功能。
- **不处理图片资源**。文档里引用的相对路径图片不会一并上传，需要在思源内单独处理。
- **不做双向同步**。本插件是单向「发送」，不会回读思源内容，也不会更新已发送的文档。
- **多份同名文档是刻意的**。重复发送会产生副本，这是「绝不覆盖」的代价。
- **依赖 DSH 的服务名**：`connection`、`credentials`、`sessionQuery`、`workspaceFiles`、`tools`。若 DSH 大版本改了这些名字，需要相应更新。
- **包名是 `@local/` 作用域**，仅用于本地目录安装。若要发布到 npm，需改成你自己的作用域并补 `LICENSE`。

---

## 许可证

[MIT](LICENSE) © 2026 baby7

可自由使用、修改、分发，包括商业用途；保留版权声明即可。详见 [LICENSE](LICENSE)。

---

## English summary

A DeepSeek Harness plugin that pushes Markdown documents produced in a conversation to a self-hosted SiYuan instance.

- Adds a **SiYuan** button to every delivered `.md` file card, and a **Send to SiYuan** button to the markdown preview toolbar.
- A **SiYuan** settings section stores the endpoint, token, target notebook and parent path, and offers a live connection test.
- Registers a `siyuan_send` tool so the model can push a file by path.
- The token lives in the DSH credential store, never in the settings file, and never reaches the browser.
- Never overwrites: a repeated send gets a timestamped copy.

Requires SiYuan 3.x with an API token; tested against 3.8.8.
