# 千牛后台连接组件

`JuDeskQianniuHook.exe` 是 Windows x64 GUI 程序，使用 `asInvoker` manifest。
JuDesk 在检测到已登录的聊天工作台后自动调用它，没有独立窗口、控制台、UAC 提权或手动注入步骤。
辅助程序只接受 PID 和已验证的千牛完整路径，只加载自身目录中的 `QnQtMsg64.dll`。

执行前检查进程确实为匹配路径的 `AliWorkbench.exe`，并且与 JuDesk 属于同一用户、会话和完整性级别。
不同权限级别直接返回错误；用户须正常启动千牛，不支持后台越权连接管理员进程。
已加载同名 DLL 时直接返回，避免重复初始化；最终是否连接由千牛 WebSocket 身份与 Hook TCP 身份握手共同确认。

原项目 `QNQtHelp64.exe` 的 manifest 要求 `requireAdministrator`，还包含常驻进程扫描及重开客户端行为，因此不打包或调用该程序。
新组件只使用标准 `LoadLibraryW`，不修改目标进程的系统加载函数、不要求调试特权、不修改注册表。
独立的 Win64 线程函数由 `remote-loader.S` 编译生成，通过数据表调用目标进程中的 `LoadLibraryW` 和 `GetLastError`，保存完整的 64 位模块句柄后核对模块路径；不把系统 API 强制转换成线程入口，也不把线程的 DWORD 返回值当作模块句柄。代码和数据只写入新分配的内存，代码写完后设为只读可执行；正常完成后释放，等待未完成时保留直到目标退出。
`QnQtMsg64.dll` 沿用参考项目提供的二进制。其源码不可用，支持的千牛版本和重连行为仍须在真实 Windows 客户端验证。

DLL 来源：`qianniu-platform-gateway/lib/QnQtMsg64.dll`，参考仓库提交 `4c214cd0740c78bfe42fcd1a3db46db203d61548`；SHA256 为 `da0516a52c0e7f7c140eb3c4a5b226cd4849a1982037bb463cf158d9b3609995`。

## 构建

安装 [Zig 0.14.1](https://ziglang.org/download/) 后，在仓库根目录执行：

```sh
node scripts/build-qianniu-hook.mjs
# 或指定工具链路径：
JUDESK_ZIG=/path/to/zig node scripts/build-qianniu-hook.mjs
```

输出为 `resources/qianniu-native/JuDeskQianniuHook.exe`。Windows、Linux、macOS 均使用同一 x64 Windows 目标。
脚本在 macOS 上显式构建 Zig 自带的资源编译器，以兼容 macOS 26；不会引入运行时依赖。
构建结束检查 PE 架构、GUI 子系统和 `asInvoker` manifest。打包前还检查 EXE 与 DLL 均存在。
仓库中的单元测试验证自动发现、登录触发、有界重试、暂停恢复和 PE 元数据；它们不能替代 Windows 实机注入与收发测试。

退出码：`0` 表示 DLL 已加载或原已存在；`2` 参数错误；`3` 目标不匹配；`4` 用户/会话/权限不匹配；
`5` 无访问权限；`6` 架构不支持；`7` DLL 缺失；`8` 加载函数不可用；`9` 远程分配、写入或代码准备失败；
`10` 加载线程未启动；`11` DLL 加载结果未确认；`12` 等待加载未完成。`0` 不表示账号收发已就绪。
