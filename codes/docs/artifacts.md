# APK、资源与签名

- `app/artifacts.py` 负责 APK、资源包和签名。
- APK 文件路径必须与 `adb-tools/apk-center/files/` 的最新扫描结果比对；资源文件路径必须与 `adb-tools/resource-deployment/files/` 比对。
- `apk_sources` 是命名的本地构建目录白名单。“从构建目录导入”递归扫描其中的 `.apk`，浏览器只提交来源名称和相对路径，后端在复制前重新解析并验证目录边界、文件类型与符号链接。默认勾选每个来源最新 APK，支持多选；来源文件只复制，不移动或删除。
- 批量导入到 `adb-tools/apk-center/files/` 时，同一批次存在同名文件必须拒绝；已有同名 APK 时默认返回覆盖确认，只有用户显式同意后才覆盖。
- APK 列表的 Push 操作只接受 `adb-tools/apk-center/files/` 白名单内的单个 APK。
- APK 和资源包删除成功后只在当前列表中移除对应行，并以淡出、轻移和高度收缩动画让后续行平滑补位；不得为了删除单项重新扫描并重建整个列表，以免页面闪烁、滚动位置或其他行的临时状态丢失。
- APK 和资源包可在列表内重命名。前端只编辑主名称，后端固定保留 `.apk` 或 `.tar.gz` 扩展名并拒绝路径字符、系统保留名称和同名覆盖。资源包名称是 `resource_device_paths` 的映射键，重命名时必须通过 `storage.update()` 同步迁移；配置写入失败时回滚文件名。成功后先更新当前行，再静默同步后端列表；静默同步不得显示扫描占位或丢失勾选、滚动位置和资源路径草稿。
- “安装 APK”和“签名 APK”已有内容时，Tab 切换及手动刷新必须保留当前列表并显示顶部进度动画，新数据返回后再淡入替换；只有首次加载使用骨架屏。刷新期间保留 APK 勾选、签名文件选择及密码输入，并使用独立请求序号忽略快速切换产生的过期响应。
- `apk_push_device_paths` 按 APK Manifest 包名保存最近一次成功 Push 的设备目录；同包名的 debug/release、签名前后 APK 共用映射，不同包名相互隔离。后端通过 `aapt dump badging` 重新解析包名，不信任前端。无法识别包名时仍可 Push，但不保存映射。“Push 成功后重启设备”仅属于本次请求，不持久化。
- `.tar.gz` 只扫描 `adb-tools/resource-deployment/files/`。`resource-deployment/config.json` 按归档文件名保存每个资源包自己的设备部署目录；批量推送请求必须为每个文件携带对应目录。
- APK Center 的 MD5 与 SHA-256 都必须通过 `managed_apk()` 重新验证 `adb-tools/apk-center/files/` 白名单，并按块读取文件。
- 签名证书 SHA-256 必须来自 `apksigner verify --verbose --print-certs` 的 `Signer #N certificate SHA-256 digest`，不能用 APK 文件 SHA-256 或 `dumpsys package` 的短签名摘要代替。支持多个 signer，并同时返回证书 DN。默认先按 APK 声明的最低系统严格验签；若 APK 仅有 v2/v3/v3.1 签名，则按各方案起始 API 24/28/33 逐级验证并返回证书，同时向用户提示该签名不覆盖 APK 声明支持的全部旧系统。
- 签名文件只允许位于 `adb-tools/apk-center/keystores/` 顶层的 `.jks` 或 `.keystore` 普通文件；前端只传文件名，后端重新建立目录白名单。它们独立保存在签名功能目录，由“签名 APK → 管理签名文件”弹窗管理。
- APK 签名密码与可选 Alias 仅由本次 Web 请求提供，不写入配置或日志。
- 当前安装流程使用普通 `adb install -r`，不使用 Android 11 增量安装，因此 `apksigner sign` 必须显式关闭 v4 签名，避免在 APK Center 生成不可见的 `.apk.idsig`。删除 APK 时同步删除同名 sidecar；重命名历史 APK 时若存在 sidecar 则一并重命名。签名失败必须清理本次产生的不完整 APK、对齐临时文件和 sidecar。
- 资源推送会删除设备端与资源包顶层条目同名的旧内容，然后将压缩包推送到明确的设备端文件路径，使用 tar -C <目录> -zxf <远端绝对路径> 解压。Toybox tar 要求目标目录参数位于归档参数之前。解压后必须确认全部顶层条目存在，校验通过才删除远端压缩包；不完整时保留压缩包并返回缺失项。
- rm 的命令和目标路径必须作为独立 ADB 参数传递；若把多个删除命令拼成 sh -c 字符串，部分设备会报 rm need 1 arguments。ADB push 不能只依赖目录目标，否则部分设备会报 no target file。解析归档条目时只能移除完整的 ./ 前缀，不能用 lstrip，否则会破坏 ._speech 等点开头名称。
- 资源包顶层条目必须通过安全字符校验，不能移除该校验。
