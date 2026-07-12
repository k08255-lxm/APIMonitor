# Android APK 签名与更新

## 一键构建

在项目根目录双击 `构建安卓小组件.cmd`。它会自动完成以下工作：

1. 安装/确认所需 Android SDK 组件和许可证。
2. 首次构建时优先复制当前 Windows 用户的 Android 默认 debug keystore，以便覆盖此前由本机 debug APK 安装的版本。
3. 将用于后续更新的 keystore 和密码元数据保存到 `%LOCALAPPDATA%\APIMonitor\android-signing\`。
4. 在 `android-widget/local-signing.properties` 写入本机 Gradle 签名配置（此文件已被 Git 忽略）。
5. 生成并验证 `android-widget/app/build/outputs/apk/release/app-release.apk`。

以后始终使用同一台 Windows 用户账户下的一键构建器，或先还原该私有签名目录，再构建新 APK。这样同一包名 `com.apimonitor.widget` 的版本可以正常覆盖安装，桌面组件和应用内配置也会保留。

## 私钥备份

请把整个 `%LOCALAPPDATA%\APIMonitor\android-signing\` 目录备份到受保护的位置。不要提交、上传或发送其中的 `.jks` 和 `.properties` 文件，也不要把密码贴到 GitHub、聊天记录或截图中。项目只提交 `signing.properties.example`，不包含任何真实签名信息。

若在另一台电脑构建更新，先把备份目录恢复到相同路径，再运行一键构建。缺少原 keystore 时不要生成新的同包名发布版本，因为 Android 会拒绝覆盖安装。

## 已安装版本提示“签名不一致”

Android 只接受由同一签名证书签发的 APK 覆盖同一包名。构建器会优先保留本机默认 debug key，以覆盖此前由该 key 签名的旧 APK；构建结束时会显示并验证新 APK 的证书摘要。

如果手机中的旧 APK 来自另一台电脑、旧 keystore 已删除，或它本来就由不同证书签名，则没有办法在不持有旧私钥的情况下原地更新。这是 Android 的安全限制，不能通过修改版本号、重新签名或 GitHub 发布绕过。一次性的处理方式是：

1. 在手机上移除旧的“API 监测台”应用和桌面组件。
2. 安装本次生成的 `app-release.apk`。
3. 重新填写连接信息并添加桌面组件。

之后保留上述私有签名目录并一直使用它构建，即可正常覆盖更新。

## App 内检查和一键更新

App 首页的“检查更新”只读取 GitHub 的最新正式 Release。发现版本更高的 APK 后，“一键更新”会下载到应用私有 Download 目录，校验 APK 包名、版本、签名证书和可用的 SHA-256 摘要，然后交给 Android 系统安装器。首次安装外部 APK 时，系统会要求在“允许安装未知应用”页面单独授权本 App；授权后返回 App 会继续打开安装器。系统仍会强制校验 APK 签名，签名不同的包不能覆盖安装。

每次 GitHub 发布都必须使用与 `app/build.gradle` 相同的 `versionName` 和递增的 `versionCode`，并在 Release 正文单独写且只写一行机器可读字段：

```text
Android-Version-Code: 4
```

发布 APK 前先运行一键构建器并确认 `apksigner verify --print-certs` 显示的证书仍是稳定私钥对应的证书；不要上传 debug、unsigned 或由另一台未恢复私钥的电脑生成的 APK。

## 手动构建

已经运行过一键构建时，可在 `android-widget/` 中使用 Android Studio 的 **Build > Generate Signed Bundle / APK**，或执行 `:app:assembleRelease`。Gradle 会读取忽略文件 `local-signing.properties`。首次手动配置可从 `signing.properties.example` 复制该文件；路径使用正斜杠，例如 `C:/Users/...`。

没有 `local-signing.properties` 时，release 构建会明确失败，避免意外产出另一把签名的 APK。
