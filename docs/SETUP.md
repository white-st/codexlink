# 安装与配套软件

本文针对 Windows 电脑。路径和域名均为示例，请换成自己的值。所有命令在项目根目录执行。

## 1. 准备电脑环境

| 软件 | 要求 / 作用 | 官方入口 |
| --- | --- | --- |
| Node.js | 项目要求 22+；运行后台 | [下载 Node.js](https://nodejs.org/en/download) |
| Codex | 本机已登录、支持本项目使用的 App Server 接口 | [Codex CLI 文档](https://learn.chatgpt.com/docs/codex/cli) |
| DDNSTO Windows 客户端 | 把独立本机转发入口提供给外网手机 | [DDNSTO 官方指南](https://doc.linkease.com/zh/guide/ddnsto/) |
| JDK 17 | 仅构建 Android 时需要 | [Adoptium JDK 17](https://adoptium.net/temurin/releases/?version=17) |
| Android SDK / Android Studio | 构建工具、平台 android.jar；模拟器按需安装 | [Android 下载入口](https://developer.android.com/studio)、[命令行工具说明](https://developer.android.com/tools) |

本项目默认启动自己的 Codex 子进程，不依靠模拟点击官方桌面界面。手机任务已被兼容的 Windows Codex 桌面占用时，会通过本机 IPC 把需求交给原会话。此能力需要后台和桌面使用同一 Windows 用户、同一登录会话及受支持协议，不保证所有桌面版本可用。项目通过现有 Codex 登录执行任务，没有另外实现 API Key 登录页；可用额度与账号状态由本机 Codex 决定。

检查安装：

```powershell
node --version
codex --version
```

如果 `codex` 不在 PATH 中：

```powershell
$env:CODEX_BIN = 'C:\Tools\Codex\codex.exe'
```

上面是占位路径，必须填写实际存在的可执行文件。环境变量只对当前 PowerShell 和它启动的进程有效。不要把本机 Codex 的登录文件复制进仓库。

## 2. 启动后台并创建管理员

```powershell
npm start
```

电脑浏览器打开 `http://127.0.0.1:4317`。首次运行会在 `.runtime/setup-code.txt` 生成设置码；在**电脑本机页面**填写设置码并创建自己的管理员账号。手机和外网不能完成这一步。

- 用户名：3–40 位字母、数字、下划线或短横线。
- 密码：6–128 位，没有默认密码。登录使用校验值，可查看密码另以密文保存。
- 管理员可在网页“管理员 · 账号与密码”中创建普通账号、分配 0–9 级、查看或重新设置密码。旧账号原密码无法还原，先重新设置一次才能查看。
- 私有项目接口仍按当前身份判断，但管理员可以取得密码并使用相应账号登录；详见 [权限与数据边界](../SECURITY.md)。

关闭当前前台进程后，可使用隐藏后台启动：

```powershell
npm run start:background
```

隐藏后台通过 Windows WMI 创建独立宿主，保持原 Windows 用户身份，等待端口和服务就绪后返回。关闭启动它的终端或桌面应用不会因此结束后台；它不是 Windows 服务，也没有安装开机自启。电脑重启后需重新启动。

脚本沿用 `CODEX_BIN`，未设置时从 PATH 查找 `codex.exe`。默认运行目录为 `.runtime`、端口为 4317，高级部署可传 `-RuntimeDirectory` 和 `-Port`。若使用自定义运行目录，停止和配置脚本也应设置相同的 `CODEX_LINK_RUNTIME`，避免操作另一份数据。

日志位于 `.runtime/service-日期时间-编号.stdout.log` / `.stderr.log`；`launch-编号.json` 记录此次启动结果。停止工作台：

```powershell
npm stop
```

不要启动两个实例抢占同一端口或运行目录。停止本工具不会关闭独立运行的 DDNSTO 或官方桌面 Codex。工作台服务重启后需要重新登录。

## 3. 先验证一次电脑执行

在网页“手机任务”列表中新建私有项目，创建任务并发送：

> 请在当前项目中创建 UTF-8 文件“连接测试.txt”，内容为“连接成功”，完成后告诉我文件名。

任务完成后，从项目文件下载并核对内容。若只看到页面但不能执行，先检查 Codex 登录和后台日志，再进行外网配置。结果待核实时应刷新核对，不要连续重复发送。

## 4. 可选：设置新项目目录

默认位置为 `.runtime/workspaces/projects`。可在服务停止后更改新建项目根目录：

```powershell
npm stop
npm run storage:configure -- 'D:\CodexLinkWorkspace'
npm run start:background
```

格式为 `YYYY-MM-DD/HHmmss_项目名_短编号`，时区为 Asia/Shanghai。同一项目后续任务继续使用原目录。已有项目不会被搬迁；若新位置与已有项目冲突，配置会被拒绝。不要手动改登记文件来移动项目。

## 5. 同 Wi-Fi 网页访问

```powershell
npm stop
npm run network:lan
npm run start:background
```

电脑页面会显示本次配置的局域网地址，手机浏览器在同一 Wi-Fi 下访问它。`127.0.0.1` 在手机上指手机自身，不是电脑地址。此 HTTP 入口适合受信任局域网联调；正式安卓 App 固定使用构建时配置的 HTTPS 地址。

更换电脑网络或 IP 后重新配置。配置脚本不修改防火墙、路由器端口或 Windows 网络类别。只保留本机访问可改用 `npm run network:local` 并重启。

## 6. DDNSTO 外网访问

1. 从官方渠道安装 DDNSTO Windows 客户端，在它自己的设置界面保存个人 Token，并在控制台确认设备在线。Token 不填写到本项目源码中。
2. 控制台创建访问域名，目标地址填写 **`http://127.0.0.1:4318`**。
3. 将获得的 HTTPS 根地址配置到工作台，例如：

```powershell
npm stop
npm run network:ddnsto -- 'https://your-device.ddnsto.com'
npm run start:background
```

示例域名不可直接使用。域名必须与 DDNSTO 实际分配的地址一致，不能附加路径或验证参数。若调整转发端口，命令可追加端口数值，控制台目标同步调整。

| 地址 / 端口 | 用途 |
| --- | --- |
| `http://127.0.0.1:4317` | 电脑本机工作台，含首次初始化能力 |
| `http://127.0.0.1:4318` | DDNSTO 独立转发入口，禁用首次初始化和停止服务 |
| 自己的 HTTPS 域名 | 手机外网入口；也作为 APK 构建地址 |

DDNSTO 应映射 **4318**，不要映射 4317 或 DDNSTO 客户端自己的配置页面。只配置公网地址不代表隧道已经在线。

4. 手机关闭 Wi-Fi，使用流量访问自己的 HTTPS 地址。先完成 DDNSTO 所需验证，再登录工作台，重复创建测试文件的流程。
5. 外网测试成功后按 [Android 指南](ANDROID.md) 构建 APK。App、工作台配置和更新元数据应使用同一 HTTPS 根地址。

电脑、工作台、Codex 登录状态和 DDNSTO 均需保持可用。电脑睡眠、断网或 DDNSTO 离线会导致手机无法访问。

## 7. 其他方案与组件

仓库保留 Cloudflare Quick Tunnel 试验工具，但不作为本项目已验收的稳定外网方案；临时域名不适合直接绑定长期使用的 App。没有要求安装 WSL 或 Docker；`scripts/install-wsl.ps1`、`prepare-worker.mjs` 等属于独立实验工具，日常运行不用执行。

Office 阅读器用于打开下载成果。技能内部可能需要 Python、文档渲染器等额外工具，取决于所安装技能的说明；安装 Office 或 Android SDK 不会自动补齐这些技能依赖。
