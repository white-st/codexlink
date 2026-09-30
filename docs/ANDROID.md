# 安卓构建、安装与更新

这是原生 Java Android 项目，当前使用 PowerShell + Android 命令行工具构建，没有 Gradle 工程。最低 Android 8.0（API 26），当前 targetSdk 为 36。

## 准备 JDK 和 SDK

安装 JDK 17、Android SDK Platform 36、包含 aapt2 / D8 / apksigner / zipalign 的 Build Tools。真机或模拟器调试另需 Platform Tools；模拟器与系统镜像只在电脑预览时需要。

本项目开发基线使用 JDK 17、API 36-ext19 和包含 `lib/d8.jar` / `lib/apksigner.jar` 的工具包。不同 SDK 安装的目录名称可能不同，请填写实际路径。构建脚本会检查工具文件是否存在，不能只把示例目录原样复制。

```powershell
$env:JAVA_HOME = 'C:\Tools\jdk-17'
$env:ANDROID_HOME = 'C:\Tools\android-sdk'
$env:ANDROID_BUILD_TOOLS = "$env:ANDROID_HOME\build-tools\36.0.0"
$env:ANDROID_JAR = "$env:ANDROID_HOME\platforms\android-36\android.jar"
$env:CODEXLINK_ORIGIN = 'https://your-device.ddnsto.com'
npm run android:build
```

以上均为示例。`CODEXLINK_ORIGIN` 必须是自己的 HTTPS 根地址，无账号密码、子路径、查询参数或片段。`ANDROID_HOME` 供调试工具使用，主构建使用明确的 Build Tools 和 android.jar 路径。

也可直接传参：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File android/build.ps1 -JdkPath $env:JAVA_HOME -BuildToolsPath $env:ANDROID_BUILD_TOOLS -AndroidJar $env:ANDROID_JAR -ServerOrigin $env:CODEXLINK_ORIGIN
```

脚本先运行 JVM 检查（含会话同步与缓存），再编译、打包、对齐、签名和校验。服务地址仅写入临时构建副本与产物，不回写源码。仓库里的 `https://codexlink.example.invalid` 是不可访问的占位地址，不是公共服务。

产物：

```text
android/output/CodexLink-0.12.0.apk
android/output/release.json
```

构建不会自动安装到手机，也不会自动把源码上传 GitHub。正常构建默认不更新下载目录。

## 签名与覆盖安装

首次构建会在本机 `.runtime/android-signing/` 生成测试签名和随机密码文件。后续使用相同目录复用签名。请单独安全备份，不提交 GitHub。

同一 App 的覆盖更新需要保持包名和签名一致，并递增 Manifest 的 versionCode。换电脑后如重新生成了签名，该 APK 不能覆盖原签名的安装。项目所有者的现有手机 App 需要继续使用所有者原有本地密钥；本仓库不会携带这份密钥。

安装 APK 由安卓系统确认。不要为了更新先卸载旧 App。自行构建的测试包不要与他人的现有安装混用。

## 向自己的工作台发布 APK

确认服务地址、版本、签名和测试通过后，才执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File android/build.ps1 -Publish
```

上述命令依赖前文设置的环境变量。`-Publish` 会把 APK 和版本元数据复制到**当前这份仓库**的 `public/downloads/`，影响使用该目录的工作台更新入口。它不是 GitHub 发布命令。

更新时修改 `android/AndroidManifest.xml` 的 versionName / versionCode，并填写 `android/release-notes.txt`。同一版本发布后不要替换为不同内容；保留旧包，检查 `/downloads/release.json` 中的名称、字节数、SHA-256 和域名。源码库默认忽略 APK 与下载目录，是否另发 GitHub Release 由维护者决定。

## 模拟器配合

在 Android Studio Device Manager 创建 Android 8.0 以上的设备；开发中使用 Android 15 模拟器验证过界面。启动后可用 ADB 安装自己构建的 APK，或从该模拟器浏览器下载。普通用户只使用真实手机时不需要安装模拟器。

仓库还包含独立附件提供器、上传和技能界面测试工具。它们使用不同测试包名，并可能安装、卸载测试包或绑定本机端口；运行前阅读脚本。它们需要前文的环境变量和本机签名，**不是启动正式 App 的必要步骤**。
