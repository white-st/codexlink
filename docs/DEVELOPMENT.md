# 开发与验证

## 开发环境

Node.js 22+、Windows PowerShell、Git。修改安卓端时另需 JDK 17 和 Android SDK。项目目前无 npm 依赖；测试使用 Node.js 内置 test runner。正式 App 不需要启动这些测试工具。

```powershell
npm test
```

Node.js 测试采用独立目录和模拟 Codex，不发送模型任务，覆盖权限、存储、网络、附件、任务状态、交接和技能合同。桌面 IPC 测试覆盖状态修订、占用、断线、未知提交结果和文本输入兼容。合成 Office / 图片样例位于 `test/fixtures/attachments`，没有使用私人文档。

安卓构建与 JVM 检查按 [ANDROID.md](ANDROID.md) 配置环境后运行：

```powershell
npm run android:build
```

完整 Android HTTP 合同检查需要先把测试构建产物放到当前仓库的 `public/downloads/`，可在独立开发目录使用 `android/build.ps1 -Publish`：

```powershell
npm run verify:android
```

该脚本使用真实 Java 网络客户端和独立 HTTP 测试服务，模拟 Codex 执行。它检查 100 MiB Office 传输、32 MiB Java 堆、权限、附件引用、下载、APK 元数据等，不等于真实手机或模型制作成果验收。fresh clone 不需要复制已有 `.runtime/access.json`。

## 启动与配置脚本

| 工具 | 用途 |
| --- | --- |
| `start-service.ps1` / `stop.mjs` | 通过独立 Windows 宿主隐藏启动和仅停止本工作台 |
| `desktop-pipe.ps1` | 仅转接同一 Windows 身份的官方签名桌面进程固定本机管道；不是任意远程执行入口 |
| `configure-network.mjs` | local / lan / lan-remote / ddnsto 配置 |
| `configure-storage.mjs` | 新项目根目录配置，不搬迁旧项目 |
| `import-desktop.mjs` | 停服后，按账号登记已有桌面任务，网页只读 |
| `probe.mjs` | 只读检查本机 Codex 登录、接口、少量任务元数据 |

## 联调与实验脚本

| 工具组 | 前提和影响 |
| --- | --- |
| `verify-android.mjs` | Java + 独立 HTTP；需要本地 APK，Codex 使用替身 |
| `verify-access-live.mjs` / `verify-remote.mjs` | 对应独立接口与权限验证，运行前阅读脚本 |
| `verify-live.mjs`、`verify-execution-live.mjs`、`verify-storage-live.mjs`、`verify-attachments-live.mjs`、`verify-images-live.mjs`、`verify-handoff-live.mjs`、`verify-skills-live.mjs` | 接触实际 Codex、文件或会话，会生成测试记录，可能使用账号额度；不能当作普通静态检查批量执行 |
| `*-ui-fixture.mjs` / `build-upload-ui-fixture.ps1` | 独立本机界面测试，测试账号、替身 worker、测试 APK；不用来部署正式服务 |
| `verify-android-provider.ps1` | 在指定安卓设备安装、运行并卸载独立测试包，验证文件提供器兼容 |
| `download-tunnel.ps1` / `quick-tunnel.mjs` | Cloudflare 临时隧道试验，非默认外网方案 |
| `check-environment.mjs`、`probe-worker.mjs`、`prepare-worker.mjs`、`verify-isolation.mjs`、`install-wsl.ps1`、`scripts/linux/` | 早期隔离环境试验；不属于当前产品运行前提，不要为首次启动执行安装 WSL 脚本 |

不同 live 脚本有各自基线前提，部分要求已经初始化的本地运行目录；脚本执行结果不能直接当作其他电脑、网络或设备的验收结论。

## 发布前验证范围

- 后台变化：检查授权、并发、失败状态和旧请求兼容。
- App 变化：检查原生界面、返回、草稿、账号切换、文件选择和系统安装流程。
- 网络变化：本机和手机流量分别验证；页面能打开不代表 Codex 能执行。
- 技能变化：检查安装目录、停用或缺失提示，再执行独立的真实模型验证。
- 文档变化：核对命令、链接、参数默认值和当前能力边界。

整理基线已在原 Windows 环境验证过 Node.js 24.19.0、Codex CLI 0.155.0-alpha.9.2、JDK 17、API 36-ext19、Android 15 模拟器。它们是已验证组合，不是对所有版本兼容的承诺。上传准备目录的重新检查结果记录在 [验证记录](VALIDATION.md)。

## GitHub 提交范围

提交源码、合成测试样例和通用文档。不要提交 `.runtime`、密钥、个人域名配置、用户文件、SDK / 模拟器镜像、构建缓存或历史私人验收记录。APK 如需公开分发，应单独核对它连接的服务地址和签名，再决定是否发布 Release；本次准备仅包含源码。

项目许可尚未由所有者决定，不要为发布方便自行添加第三方许可证。首次远程创建仓库和推送应在维护者确认目标、可见性及文件清单后执行。
