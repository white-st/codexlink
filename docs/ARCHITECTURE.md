# 源码结构与调用关系

## 整体结构

```text
codexlink/
├─ README.md                 项目首页与文档导航
├─ SECURITY.md               权限和数据边界
├─ CHANGELOG.md              功能版本记录
├─ package.json              Node.js 入口、检查命令与环境要求
├─ src/                      电脑后台
├─ public/                   网页工作台和 APK 安装页
├─ android/                  安卓源码、资源、构建与 JVM 检查
├─ scripts/                  配置、启动、探测和联调工具
├─ test/                     Node.js 测试与合成 Office 样例
└─ docs/                     使用、部署和开发说明
```

运行后产生的 `.runtime/`、`android/build/`、`android/output/` 和 `public/downloads/` 不属于源码交付。

## 后台模块

| 文件 | 职责 |
| --- | --- |
| `src/server.mjs` | HTTP 路由、Cookie、静态文件、连接入口、服务生命周期 |
| `src/access-store.mjs` | 账号、密码摘要、登录会话、项目归属、等级与共享 |
| `src/password-vault.mjs` | 独立密码显示密钥加载、AES-256-GCM 加解密和损坏检测 |
| `src/portal.mjs` | 面向客户端的业务层，统一项目和任务权限校验 |
| `src/workbench.mjs` | Codex 任务状态、提交、停止、追问、交接、文件操作 |
| `src/codex-client.mjs` | 启动本工具拥有的 Codex 子进程，处理请求响应与事件 |
| `src/codex-sessions.mjs` | 按任务管理子进程；只读元数据连接与可写任务连接分开 |
| `src/skills.mjs` | 五类固定技能标识与安装目录校验，构造原生技能输入 |
| `src/project-storage.mjs` | 项目根目录、按日期创建目录、旧路径兼容 |
| `src/files.mjs` | 文件枚举、读取与项目目录边界 |
| `src/attachments.mjs` / `file-limits.mjs` | Office 附件结构校验、保存、引用和大小限制 |
| `src/network.mjs` | 本机、局域网和独立转发入口的来源判断 |
| `src/quick-tunnel.mjs` | 可选 Cloudflare 临时隧道进程管理 |
| `src/desktop-import.mjs` | 可信本机操作者登记已有电脑任务 |
| `src/runtime-lock.mjs` | 防止多个进程同时写同一份运行数据 |
| `src/releases.mjs` | 公开 APK 文件名和路由边界 |
| `src/isolation.mjs` | 实验性独立执行环境诊断，不是当前账号隔离保证 |

后台只使用 Node.js 内置模块，没有数据库服务依赖。JSON 文件是登记数据，原生 Codex 历史由 Codex 管理。任务的读写占用可能跨工作台和官方桌面应用发生冲突，不能仅靠切换 App 页面解除。

## 安卓与网页

| 位置 | 职责 |
| --- | --- |
| `MainActivity.java` | 登录、项目卡片、任务对话、技能、账号设置 |
| `ApiClient.java` / `AppCookies.java` | HTTP 请求、会话、文件传输与固定服务来源 |
| `AttachmentUploads.java` | 当前账号下按任务保存的文字、附件和技能草稿 |
| `AttachmentSource.java` / `OfficeAttachment.java` | 安卓文件选择、来源兼容和实际 Office 格式识别 |
| `ChatUi.java` / `Screen.java` | 原生界面组件和布局 |
| `MessageBody.java` / `MessageFormat.java` | 对话内容、代码块、复制和技能名称呈现 |
| `VerificationActivity.java` | DDNSTO 所需连接验证页面 |
| `ReleaseInfo.java` / `UpdatePackage.java` | 更新元数据、文件长度及 SHA-256 校验 |
| `UpdateChecker.java` / `UpdateActivity.java` / `UpdateReceiver.java` | 检查、下载、安装流程与返回处理 |
| `AndroidManifest.xml` / `res/` | 包名、版本、权限、样式、图标和备份规则 |
| `public/index.html` / `app.js` / `style.css` | 电脑及手机浏览器工作台 |
| `public/android.html` / `android.js` / `android.css` | 自己部署的 APK 安装页 |

Java 文件位于 `android/src/com/codexlink/mobile/`。App 使用原生界面；WebView 用于连接验证等特定场景，不是整站套壳。

## 一次需求的流程

1. 手机带登录 Cookie，向任务发送需求、可选附件名和固定 `skillId`。
2. HTTP 层检查入口与会话；Portal 检查项目归属、执行权限及附件引用。
3. Workbench 锁定该任务，必要时恢复自己的原生 Codex 任务。
4. 如选了技能，读取当前项目的已安装技能并复核启用状态；手机不能指定任意主机路径。
5. 向 Codex `turn/start` 发送文字和技能输入，随后按事件更新执行状态。
6. 手机刷新对话和状态；文件通过工作台权限检查后下载。

协议背景见 [官方 Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。本项目以本机验证过的 CLI 行为为准，不承诺兼容任意历史或未来版本。

## 本机数据和配置

| 文件 / 目录 | 内容 |
| --- | --- |
| `.runtime/access.json` | 账号摘要、可选加密密码 passwordDisplay、项目归属、共享等级与任务绑定 |
| `.runtime/password-view.key` | 密码显示专用密钥，必须保密并单独备份 |
| `.runtime/registry.json` | 工作台已登记任务及状态 |
| `.runtime/network.json` | 允许的局域网地址、隧道方式、外网来源 |
| `.runtime/storage.json` | 新建手机项目根目录 |
| `.runtime/server.json` | 进程和连接状态、本机控制令牌 |
| `.runtime/setup-code.txt` | 首次初始化设置码 |
| `.runtime/android-signing/` | 本地 APK 签名材料 |
| `.runtime/workspaces/` 或配置的外部目录 | 项目文件 |

配置由相应脚本生成，不提供带个人数据的配置文件。`CODEX_LINK_RUNTIME` 可供高级部署选择运行目录；普通启动按本仓库 `.runtime/` 使用，后台启动脚本使用标准目录和 4317 端口。

## 密码管理接口

`GET /api/admin/users` 只向管理员提供公开账号字段及 `passwordAvailable` 状态，不返回密码或密文。主动查看使用 `POST /api/admin/users/:id/password/view` 和空对象；重新设置使用 `POST /api/admin/users/:id/password/reset`，只接受 `password`。两者复用来源、会话和管理员校验，重设在异步计算后再次检查会话。

账号库仍为 version=1，新增字段可选，旧账号不会自动迁移密码。新建、本人改密或重设时在同一账号事务中保存摘要和密文；提交失败不替换密码，成功后撤销对应账号旧会话。当前管理员修改自己时走原 `/api/auth/password`，需要原密码。密钥只在本机运行目录初始化；已有密文而密钥缺失时，不会自动生成替代密钥。

## 技能依赖

技能目录和插件标识在 `src/skills.mjs` 明确列出。当前匹配 documents、presentations、spreadsheets、pdf 的指定运行时插件，以及个人 development-workflow 插件。它们不随源码分发，尤其个人插件并非所有 Codex 安装都具备。

在新电脑上先查看技能是否已安装、启用且名称匹配；若不可用，可以正常发送不指定技能的需求。要支持其他技能，应明确修改映射并验证，而不是让手机直接提交任意路径。
