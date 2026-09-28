# Glacien Workbench：Agent 导览

本文档描述当前代码结构、稳定约束和验证方式。具体领域的实现细节按需查阅 `docs/`：

- `docs/configuration.md`：功能配置和用户数据目录。
- `docs/storage-contract.md`：稳定存储 key、schema 迁移和跨用户导入契约。
- `docs/artifacts.md`：APK、签名与资源部署。
- `docs/device.md`：ADB、设备、进程、拉起、广播和无线连接。
- `docs/logs-and-frontend.md`：实时与离线日志、SSE 和前端状态。
- `docs/device-logs.md`：设备日志源、时间识别与安全 Pull。
- `docs/captures.md`：截图、录屏、scrcpy 和媒体文件。
- `docs/device-files.md`：设备文件浏览、Pull、上传与删除。
- `docs/audio-processing.md`：外置 FFmpeg、PCM 参数和多通道播放预览。
- `docs/desktop.md`：Qt WebEngine 桌面宿主和三端构建。

## 产品与架构

Glacien Workbench 是本地开发工作站，后端仅监听 `127.0.0.1`。桌面应用使用 PySide6 `QWebEngineView` 承载静态 HTML/CSS/JavaScript，前端通过本地 HTTP API 和 SSE 调用 Python 标准库后端。

主要能力包括：

- 多 ADB 设备选择、USB/无线连接和设备状态。
- APK 安装、签名、校验、收集与推送，以及资源部署。
- 进程管理、自定义命令和广播发送。
- 实时 Logcat、离线日志分析和设备日志 Pull。
- 截图、连续截图、录屏、截图对比和 scrcpy 投屏。
- 设备文件浏览、新建、文本预览、上传、下载和删除。
- 内置主题与用户主题导入、导出和删除。
- 外置 FFmpeg 驱动的多通道 PCM 读取与播放预览。

工具不内置 Android SDK 或 FFmpeg。ADB 功能需要 `adb`，APK 签名和证书读取需要 `apksigner`，签名流程可选使用 `zipalign`；scrcpy 投屏需要系统安装 `scrcpy`，PCM 播放需要系统安装或配置 `ffmpeg`。

## 启动链路

桌面应用的主要启动链路：

```text
desktop_launcher.py
  -> app.desktop.run()
  -> 本地 HTTP Server(127.0.0.1:<port>)
  -> PySide6 QWebEngineView
```

端口绑定失败时，启动器先请求该端口的 `/api/config`，并校验端口、`_meta.app_config` 和 `_meta.data_root` 等 Glacien 响应特征。只有确认监听者是 Glacien 时才能复用服务；未知进程不得被终止。

程序资源路径统一通过 `runtime.resource_path()` 获取。`server.STATIC` 使用解析后的真实路径，以兼容桌面 Bundle 中的资源链接并保证静态文件 containment 校验正确。

## 前后端边界

- `app/server.py` 只负责 HTTP/SSE 解码、路由和响应。
- 业务逻辑进入对应的领域模块，不能堆放在路由层。
- 浏览器提交的本机路径不可信；后端必须从受管目录或命名白名单重新解析。
- 设备操作先通过 `android.selected_device_settings()` 验证 serial，再通过 `android.device_adb()` 执行。
- ADB 和其他子进程命令使用参数数组；不得把浏览器输入拼接成本机 Shell 命令。
- 实时日志通过 `/api/logs` 的 `EventSource` 连接。
- 静态 HTML、JavaScript 和 CSS 使用 `no-store` 响应头，资源链接携带版本参数。

侧边栏只展示二级菜单，三级能力在功能页内使用 Tab：

```text
ADB 工具
  ADB 概览
  部署中心：安装 APK / 签名 APK / 资源部署
  进程管理
  ADB 命令：自定义命令 / 发送广播
  设备工具：屏幕捕获 / 设备文件 / 日志 Pull
  实时日志

本地工具
  离线日志分析
  音频处理：多通道交错 PCM 读取与播放预览
```

## 目录职责

| 路径 | 当前职责 |
| --- | --- |
| `desktop_launcher.py`、`app/desktop.py` | Qt WebEngine 桌面入口、窗口和下载生命周期 |
| `app/runtime.py` | 程序资源、版本信息和平台用户数据目录 |
| `app/storage.py` | 功能域注册、路径创建、原子 JSON 读写 |
| `app/migrations.py` | 各存储域的逐级 schema 迁移 |
| `app/config.py` | 聚合配置视图、按域保存及规则/命令导入导出 |
| `app/android.py` | SDK 工具定位、ADB 执行、设备状态和无线发现 |
| `app/artifacts.py` | APK、Keystore、签名和资源包 |
| `app/device.py` | 进程、拉起、广播、自定义命令和实时日志 |
| `app/logs.py` | 原生 rg 离线日志扫描 |
| `app/audio.py` | 外置 FFmpeg 探测、PCM 文件和 WAV 播放预览 |
| `app/device_logs.py` | 设备日志源扫描、时间筛选和白名单 Pull |
| `app/device_files.py` | 设备文件浏览、新建、有限预览、Pull、上传和删除 |
| `app/captures.py` | Display、截图、录屏、封面、scrcpy 和媒体文件 |
| `app/themes.py` | 内置主题与用户主题的校验和合并 |
| `app/server.py` | HTTP API、SSE、静态文件和服务生命周期 |
| `web/index.html` | 页面结构 |
| `web/app.js` | 浏览器状态、API 调用和渲染 |
| `web/styles.css` | 布局与主题语义样式 |
| `web/themes.json` | 内置主题、颜色令牌和中文用途说明 |
| `web/offline_log_worker.js` | 浏览器模式离线日志分块扫描 |
| `用户须知.md` | 应用内用户须知 |
| `build_desktop.py` | PyInstaller 桌面构建 |
| `package_launcher.py` | 源码分发包生成 |
| `defaults.json` | 新用户数据的只读初始化种子 |
| `release.json` | 当前版本和首页更新记录 |

## 用户数据与配置契约

源码运行和桌面应用都使用平台应用数据目录：

- macOS：`~/Library/Application Support/GlacienWorkbench/`
- Windows：`%LOCALAPPDATA%\GlacienWorkbench\`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/GlacienWorkbench/`

测试可通过 `GLACIEN_DATA_DIR` 覆盖数据根目录。仓库中的 `defaults.json` 只用于初始化，不是运行时配置。

`storage.py` 的 `STORAGE_DOMAINS` 定义功能数据的稳定机器标识、配置文件和受管目录。每份配置包含 `storage_key` 和独立的 `schema_version`。已发布的 key 不随菜单、页面、Tab 或显示名称改变；新增持久化功能使用新 key。字段结构或语义变化时提升对应 schema，并在 `app/migrations.py` 中提供逐级迁移。迁移前备份原文件，拒绝写回 key 不匹配或 schema 高于程序支持版本的数据。

配置写入规则：

- 所有 JSON 写入通过 `storage.write()` 或 `storage.update()` 原子替换。
- 功能设置通过 `/api/config/domain` 按稳定域保存。
- 域内更新保留程序尚未识别的字段。
- 密码仅存在于单次请求中，不得持久化。
- 用户创建且需要分享的实体使用与显示名称分离的永久 ID。
- 规则包只包含可分享的命令、广播和日志规则，不包含本机路径、APK、资源、密钥或密码。
- 自定义命令支持独立导入和导出；导入与现有数据合并，同名冲突使用新名称。

用户数据目录和文件分配以 `app/storage.py` 的 `STORAGE_DOMAINS` 为准，完整说明见 `docs/configuration.md`。

## 安全边界

- APK 只允许来自 `adb-tools/apk-center/files/`。
- 资源包只允许来自 `adb-tools/resource-deployment/files/`。
- 签名文件只允许来自 `adb-tools/apk-center/keystores/`。
- 本地日志目录通过已保存的来源名称建立白名单，查询接口不接受任意路径。
- 设备日志 Pull、截图、录屏和设备文件下载写入各自规定的用户目录或系统下载目录。
- 多设备操作必须验证当前选择的 serial。
- 资源部署会删除设备目标目录内与归档顶层同名的内容，必须验证非根绝对目录和安全顶层名称。
- 设备端 Shell 脚本只用于明确允许的设备命令；主机侧始终禁止拼接不可信 Shell 字符串。

## 关键功能契约

### 无线 ADB

无线发现合并以下来源：

- `adb devices -l` 中在线的 IPv4:port transport。
- `adb mdns services` 中 `_adb._tcp` 和 `_adb-tls-connect._tcp` 服务。
- 当前活动网络的默认网关。
- 当前主机 IPv4 所在 `/24` 网段中开放指定端口的候选地址。

端口开放只代表候选，完成 `adb connect` 握手后才视为 ADB 设备。扫描前只清理状态为 `offline` 且 serial 符合 IPv4:port 的 transport。断开操作只作用于用户选择的无线 endpoint，不影响 USB 和其他无线设备。第三方 Wi-Fi 开启客户端隔离时，局域网设备无法互访，应用应给出明确提示。

### 多设备选择

`android.status()` 返回 `adb devices -l` 的完整结果。仅有一台在线设备且浏览器没有有效选择时可以自动采用；存在多台在线设备时必须由用户选择。浏览器保存的 serial 仅是界面偏好，不写入功能配置或规则包。

所有设备业务路由先调用 `android.selected_device_settings()`，后续调用使用 `android.device_adb()`。实时 Logcat 子进程也必须携带同一 serial。

### APK 与资源

- APK 列表和 Push 使用 `aapt dump badging` 解析真实包名。
- `signed_with` 仅表示根据文件名推测的签名文件，不代表验签结果。
- “证书 SHA-256”使用 `apksigner` 读取 APK 签名证书；已安装应用先从设备 Pull `base.apk` 到临时目录。
- 签名密码和 Alias 仅作为当次请求参数。
- 资源部署使用每个归档独立配置的目标目录。设备端删除、推送和解压均使用参数数组与明确文件名。
- 资源归档顶层名称限制为 `[A-Za-z0-9._-]+`，路径规范化只移除完整的 `./` 前缀。

### 进程、拉起与命令

- 进程页面通过 `dumpsys package android` 与目标包信息判断平台签名状态。
- 应用拉起配置保存于 `app_launches.<package>.command`，内容是 `adb shell` 后的完整设备端命令。后端只允许 `am start` 和 `am start-activity`。
- 自定义命令由 `device.device_shell_args()` 解析，并通过 `android.device_adb()` 执行。主机侧 `connect`、`push`、`pull` 和 `install` 由专用功能负责。
- 风险命令返回 `requires_confirmation`；前端展示最终命令，用户确认后以 `confirmed=true` 再次请求。
- 命令模板支持 `{{name}}` 和 `<name>`。变量值只用于单次请求，并通过单参数字符白名单校验。
- 命令分类和命令实体分别保存；分类改名同步更新引用，仍被命令引用的分类不能删除。

### 实时日志

实时日志按以下顺序建立会话：

1. 启动带所选 serial 的实时 `adb logcat -v threadtime` 子进程。
2. 读取 `adb logcat -d -v threadtime` 缓冲区。
3. 回放匹配的缓冲日志。
4. 持续输出实时匹配行，并定期发送 SSE keep-alive。

先启动实时流再读取缓冲区，用于缩小日志丢失窗口。ADB 文本使用 `errors="replace"` 解码。

“清空显示”只清理页面；“清空日志”停止当前 SSE、执行 `adb logcat -b all -c`，然后按需重新监听。前端使用会话编号忽略旧 EventSource 的在途事件。

日志筛选条件支持 `include_any`、`include_all` 和 `exclude_any`，条件之间为 AND。表达式分别使用 `(a | b)`、`(a & b)` 和 `!(a | b)`，只用于声明式转换；复制 grep/rg 时由前端生成经过 Shell 引号保护的命令。实时与离线日志共用条件行和高亮编辑组件，方案在弹窗中完整展示，不使用折叠层。日志高亮使用固定六色，不属于主题配色。

### 离线日志

离线日志支持两种来源：

- 高速目录：桌面宿主通过 QWebChannel 和系统目录选择器取得路径。保存目录配置后立即检测压缩日志，前端确认且后端验证 `confirmed=true` 后，在包所在目录暂存、完整就位并删除原包；失败则回滚展开内容并保留原包。过滤阶段只调用 `rg --json --pcre2`，不得再次检测或解压。
- 浏览器文件夹：浏览器使用 `File.stream()` 和 `offline_log_worker.js` 分块读取，不上传日志正文；含 NUL 字节或 gzip 标识的文件视为二进制并跳过。

浏览器模式只保留命中行，结果按批次渲染；下载操作包含完整命中结果。分析方案保存筛选条件、六色高亮词和大小写选项，不保存目录路径、日志正文、字体、透明度或导出文件名。

### PCM 音频处理

音频页只处理受管 `inputs/` 中的裸 PCM。采样格式、采样率和 1-32 路通道数由用户明确提供，多路数据按 interleaved 解析。FFmpeg 不随应用分发，后端依次检查用户配置、PATH 和平台常见目录。全部通道超过两路时下混成立体声；指定通道使用受控 `pan` 表达式生成单声道 WAV。预览只保留最近 20 个。

### 主题

内置主题及 `tokenGuide` 位于 `web/themes.json`。当前主题 ID 和用户主题由 `app/themes.py` 校验并保存到用户数据目录的 `runtime/themes.json`。`GET /api/themes` 合并内置主题和用户主题，并返回当前选择供重启恢复。

主题 ID、模式和颜色格式必须校验；缺失颜色继承默认主题。内置主题不能被覆盖或删除。新增组件优先使用已有语义变量；确需增加颜色令牌时，同时更新 `tokenGuide`、所有内置主题和 CSS 回退值。日志高亮色保持独立。

## API 入口

主要 GET 接口：

| 接口 | 作用 |
| --- | --- |
| `/api/status` | ADB 和设备状态 |
| `/api/adb/wireless-suggestion` | 无线地址建议及网络信息 |
| `/api/config` | 聚合配置只读视图及 `_meta` |
| `/api/themes` | 内置与用户主题目录 |
| `/api/apks`、`/api/resources`、`/api/processes` | 部署和进程数据 |
| `/api/log-filters`、`/api/broadcasts`、`/api/adb-commands` | 已保存规则和命令 |
| `/api/offline-log-sources`、`/api/offline-logs/status` | 离线日志来源与 rg 能力 |
| `/api/audio/status`、`/api/audio/files` | FFmpeg 能力与 PCM 文件 |
| `/api/audio/preview` | 支持 Range 的 WAV 播放预览 |
| `/api/device-log-sources` | 设备日志来源 |
| `/api/captures/*` | 屏幕捕获状态和媒体文件 |
| `/api/device-files/*` | 设备目录和已下载文件 |
| `/api/logs` | 实时 Logcat SSE |

主要 POST 接口：

| 接口 | 作用 |
| --- | --- |
| `/api/config/domain` | 按稳定域更新配置 |
| `/api/config/export`、`/api/config/import` | 导出或合并可分享规则 |
| `/api/adb/connect` | 连接指定无线 endpoint |
| `/api/adb/wireless-scan` | 发现当前网络中的无线 ADB 候选 |
| `/api/adb/wireless-cleanup` | 清理 offline 无线 transport |
| `/api/adb/wireless-disconnect` | 断开指定无线 endpoint |
| `/api/adb/root`、`/api/adb/remount`、`/api/adb/reboot` | 设备系统操作 |
| `/api/apks/*`、`/api/resources/*` | APK、签名和资源操作 |
| `/api/processes/*` | 进程停止、拉起、卸载和证书读取 |
| `/api/adb-commands/*`、`/api/broadcasts/send` | 自定义命令和广播 |
| `/api/logs/export`、`/api/logs/clear` | 实时日志导出和清空 |
| `/api/offline-logs/query` | 原生 rg 离线扫描，默认安全展开压缩日志 |
| `/api/offline-logs/archives`、`/api/offline-logs/extract` | 检测压缩日志并在确认后原目录解压 |
| `/api/audio/upload`、`/api/audio/preview` | 导入 PCM、生成播放预览 |
| `/api/audio/ffmpeg/path`、`/api/audio/delete` | 配置 FFmpeg 与删除 PCM |
| `/api/device-logs/*` | 设备日志扫描、Pull 和结果目录打开 |
| `/api/captures/*` | 截图、录屏、scrcpy 和媒体管理 |
| `/api/device-files/*` | 设备文件新建、有限预览、单项/批量 Pull、上传和删除 |
| `/api/themes/import`、`/api/themes/delete` | 用户主题管理 |

## 前端维护约束

- `web/app.js` 的全局状态集中在 `state`。
- `state.logs` 保存当前 EventSource，停止日志时必须关闭。
- `state.adbSerial` 是 Web Profile 中的当前设备选择，不写入功能 JSON。
- 设备状态每 5 秒刷新；只有离线到在线的边沿调用 `refreshAll()`，轮询不重建 Logcat SSE。
- 通用弹窗使用 `openFeatureModal()` 和 `closeFeatureConfig()`。
- `#configModalBody` 是弹窗正文滚动容器，并使用 `overscroll-behavior: contain`。
- 遮罩点击通过 `document` 事件委托处理，弹窗内部点击不关闭弹窗。
- 首页只渲染 `release.json` 中最新三条版本记录，并用省略提示表示更早记录。
- 设置页维护端口、SDK 路径、用户数据入口和规则包导入导出。

## 验证命令

在仓库根目录执行：

```bash
PYTHONPYCACHEPREFIX=/private/tmp/glacien_pycache \
  python3 -m py_compile codes/desktop_launcher.py \
  codes/app/*.py codes/build_desktop.py codes/package_launcher.py

node --check codes/web/app.js
python3 -m json.tool defaults.json
python3 -m json.tool release.json
python3 -m unittest discover -s tests -v
```

桌面产物只在明确需要时通过当前平台的“增量构建”或“全量构建”脚本生成。

