# 桌面端自动发版

桌面端通过 GitHub Actions 构建安装包，使用 Cloudflare R2 的 S3 兼容接口上传，再由 `updates.quantaflow.one` 的 HTTPS 公共域名提供版本清单和下载文件。当前默认是“检测新版本、打开下载链接、用户手动安装”；签名凭据准备好后，手动运行工作流并打开 `signed` 选项即可切换到 `electron-updater` 自动更新。客户端只读公共域名，R2 Access Key 只存在于 GitHub Actions Secrets。

## 发布入口

- 修改根目录 `package.json` 的 `version`，提交并推送到 `main` 后会自动发版；只有版本号相对上一次 `main` 提交发生变化时才会构建，普通代码提交不会重复发版。
- 也可以手动运行 `Release desktop app`，填写与 `package.json` 一致的 `version`（不带或带 `v` 都可以）；没有签名凭据时保持 `signed=false`，有完整签名凭据后才选择 `signed=true`。
- workflow 使用并发组 `desktop-release-stable` 串行发布，不会因为新运行取消已经上传安装包的旧运行。

## R2 配置

创建一个专用 Bucket，并把它绑定到 `updates.quantaflow.one` 这个 R2 Custom Domain。公开访问只开放这个域名；不要把 R2 S3 API 暴露给客户端。GitHub Actions 使用只绑定该 Bucket 的 Object Read & Write Token，配置以下 Secrets：

| Secret | 用途 |
| --- | --- |
| `R2_BUCKET` | Bucket 名称 |
| `CLOUDFLARE_ACCOUNT_ID` | R2 S3 endpoint 的账号 ID |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | 仅用于 Actions 上传 |
| `RELEASE_CHECKOUT_TOKEN` | 读取固定 commit 的 `gongzhaoman0426/judesk-licence` |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | `signed=true` 时使用的 Windows Authenticode 证书 |
| `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` | `signed=true` 时使用的 Apple Developer ID Application 证书 |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | `signed=true` 时使用的 macOS 公证凭据 |

`JUDESK_SERVER_URL`、`RELEASE_PUBLIC_BASE_URL` 和 license client commit 已固定在 workflow 的公开配置中。服务地址只会写入安装包内的 `resources/license.json`，不写入 R2 凭据。

R2 不收取互联网出站流量费；仍会产生存储和 Class A/B 操作费用，Cloudflare Cache 命中、请求数和存储容量按 R2 当期价格计算。不要再按“下载流量计费”估算本方案。[R2 定价](https://developers.cloudflare.com/r2/pricing/)

## 文件布局和发布顺序

每个架构使用独立目录：

```text
https://updates.quantaflow.one/stable/win32/x64/latest.yml
https://updates.quantaflow.one/stable/darwin/arm64/latest-mac.yml
https://updates.quantaflow.one/stable/darwin/x64/latest-mac.yml
```

带版本号的 `.exe`、`.dmg`、`.zip` 和 blockmap 是不可变对象。`scripts/publish-release.mjs` 会在上传前计算 sha512 和大小，发现同名对象存在但内容不同就失败，绝不会覆盖安装包。清单中的 URL 必须是相对文件名，并且每一项的 `sha512`、`size` 都必须和本地文件一致。

workflow 先为 Windows、macOS arm64、macOS x64 上传所有不可变文件，再按同样顺序发布三个 `latest*.yml`。发布清单时会读取 R2 中已有清单：旧版本不能覆盖新版本，同版本内容不同也会失败。最后从公共 HTTPS 域名读取清单并检查每个安装包的 HEAD 大小。

类型检查和完整 Vitest 测试在 Ubuntu quality job 中执行一次；Windows、macOS arm64、macOS x64 runner 负责各自的平台打包。这样测试环境不会因为某个平台的进程或文件系统差异取消其他平台的构建。

离线检查可在不配置任何 R2 凭据时执行：

```bash
RELEASE_PHASE=validate RELEASE_PLATFORM=darwin RELEASE_ARCH=arm64 \
RELEASE_VERSION=0.1.0 RELEASE_DIST=dist node scripts/publish-release.mjs --validate-only
```

这个检查会拒绝混入其他版本、绝对 URL、目录穿越 URL、缺少 sha512/size 或摘要不匹配的产物。脚本本身不访问真实 R2；CI 的上传阶段才需要 AWS CLI 和 R2 Secrets。

## 签名、手动安装和后续切换

默认发布不要求签名凭据。Windows 使用 x64 NSIS 安装包，macOS 使用 `macos-15`（arm64）和 `macos-15-intel`（x64）；用户在软件里看到新版本后，打开对应的 `.exe` 或 `.dmg` 下载链接，退出软件并手动安装。未签名包可能触发 Windows SmartScreen 或 macOS Gatekeeper 警告，只适合内部测试或早期分发。

签名凭据准备好后，在手动运行 workflow 时将 `signed` 设为 `true`。此时工作流强制代码签名、公证和签名检查，安装包内的更新模式切换为自动更新。两个 macOS runner 标签对应当前 GitHub Actions 的 macOS 15 arm64 和 Intel runner。[runner images](https://github.com/actions/runner-images)

第一次使用更新功能的用户直接安装官网或 R2 上的安装包；当前版本检测只负责提供下载链接。切换到自动更新后，第一次仍需手动安装一个签名版本，之后版本更新由客户端完成。
