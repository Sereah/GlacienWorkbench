# Glacien Workbench 桌面应用与三端构建

Glacien 桌面版使用 PySide6 `QWebEngineView` 承载现有 HTML/CSS/JavaScript，继续通过 `127.0.0.1` 访问 Python HTTP API 和 Logcat SSE。Qt WebEngine 随应用产物分发，不依赖使用者安装 Chrome 或 Edge。

桌面壳仅为本机受信页面启用 JavaScript 写入系统剪贴板，用于复制日志筛选命令、证书摘要等文本。前端文本复制先使用同步兼容路径，再回退到 Clipboard API，避免部分 Qt WebEngine 版本提示成功但系统剪贴板未更新。

## 运行结构

```text
Glacien 桌面进程
  -> Qt 原生窗口 + Qt WebEngine
  -> 后台 ThreadingHTTPServer
  -> 现有 /api/*、SSE、ADB 子进程
```

桌面入口是 `codes/desktop_launcher.py`，窗口与下载、文件选择、进程生命周期在 `app/desktop.py`。产品不再提供浏览器应用模式入口。

桌面版关闭最后一个窗口时停止其拥有的 HTTP Server。若配置端口已由另一个 Glacien 实例监听，新窗口复用该服务，不关闭原实例。端口属于其他程序时拒绝启动。`ThreadingHTTPServer.daemon_threads` 必须保持开启，避免断开的 SSE 请求线程阻塞桌面进程退出。

## 用户数据与程序资源

源码模式与打包模式都把只读 Web、`defaults.json`、`release.json` 和 `用户须知.md` 作为程序资源，将可写数据放在：

- macOS：`~/Library/Application Support/GlacienWorkbench/`
- Windows：`%LOCALAPPDATA%\GlacienWorkbench\`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/GlacienWorkbench/`

其中按一级菜单和功能页分级保存 `app/config.json`、APK、资源、签名文件、命令、日志规则、截图、下载和持久化 Web Profile。可用 `GLACIEN_DATA_DIR` 指定隔离数据目录进行测试。详细树形结构见 `configuration.md`。

## 构建

PyInstaller 不支持跨平台编译；必须在目标操作系统点击对应的根目录脚本：

| 系统 | 增量构建 | 全量构建 |
| --- | --- | --- |
| macOS | `增量构建 Glacien macOS.command` | `全量构建 Glacien macOS.command` |
| Windows | `增量构建 Glacien Windows.bat` | `全量构建 Glacien Windows.bat` |
| Linux | `增量构建 Glacien Linux.sh` | `全量构建 Glacien Linux.sh` |

这些脚本都使用项目根目录的 `.desktop-build-venv/` 作为隔离构建环境，并最终调用 `codes/build_desktop.py`。首次构建或 `requirements-desktop.txt` 变化时才安装依赖；后续构建复用虚拟环境。增量脚本保留 PyInstaller 工作缓存，适合日常开发；全量脚本清理工作目录和 PyInstaller 缓存，适合正式发布或排查缓存异常。该目录以及 `build/`、`dist/` 不进入源码分发包。`python3 codes/desktop_launcher.py` 仅用于开发调试。

构建日志会分别输出 PyInstaller、macOS 临时签名和总耗时。构建流程只生成桌面应用，不自动压缩 ZIP。

Linux 正式发布可运行根目录的 `构建 Glacien Linux DEB.sh`。脚本先执行全量桌面构建，再通过 `codes/package_linux_deb.py` 生成 `release-output/glacien-workbench_<版本>_<架构>.deb`。Debian 运行依赖由 `codes/packaging/linux/dependencies.txt` 集中维护，每行一个依赖；`control.template` 在打包时注入 `release.json` 版本、当前 dpkg 架构、安装体积和依赖列表。用户使用 `apt install ./<包名>.deb` 安装时，APT 会保留已满足的依赖并自动补装缺失依赖。

产物：

- macOS：`dist/Glacien.app`
- Windows：`dist/Glacien.exe`
- Linux：`dist/Glacien`

macOS 使用标准 `.app` Bundle；Windows 和 Linux 使用 onefile。Qt WebEngine 会产生受主程序管理的渲染辅助进程，这是 Chromium 多进程模型的一部分，不会启动外部浏览器。

交付时 macOS 应将整个 `Glacien.app` 压缩后发送，不能只发送 `Contents/MacOS/Glacien`；Windows 可直接发送 `Glacien.exe`；Linux 推荐发送 `.deb`，也可直接发送 `Glacien`，但裸文件需要用户自行安装系统依赖并保留可执行权限。Linux 产物应在与目标发行版兼容的 glibc 环境中构建。

构建机架构决定产物架构。macOS arm64 和 x86_64、Linux 不同 glibc 基线应分别使用对应构建机；Windows 也应在目标架构环境构建。正式对外发布时还需为 macOS 签名/公证，为 Windows 进行代码签名。

## 最低回归项

- 启动、关闭与同端口实例复用。
- ADB 设备选择、安装、Push/Pull 和自定义命令。
- Logcat SSE 建立、停止和窗口关闭后的子进程回收。
- `webkitdirectory` 文件夹选择、Worker 分块扫描和停止扫描。
- 普通文件上传、Blob 导出、HTTP 文件下载和另存为。
- 截图文本/图片剪贴板、视频预览和 HTTP Range。
- LocalStorage 与窗口重启后的设置保留。
