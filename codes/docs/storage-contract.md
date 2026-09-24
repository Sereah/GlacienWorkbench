# 用户数据与版本兼容契约

本文是新增或修改 Glacien 功能时必须遵守的数据兼容规范。页面布局、菜单层级、Tab 和显示名称不是数据身份。

## 永久稳定标识

- 应用数据目录名固定为 `GlacienWorkbench`。
- 桌面应用 ID 固定为 `com.glacien.workbench`。
- `storage.STORAGE_DOMAINS` 中已发布的 key 永不改名、删除后复用或随页面迁移而变化。
- 新功能只有在拥有独立配置或文件生命周期时才新增存储域；现有能力的新入口或新 Tab 继续使用原域。

当前稳定 key：

| key | 所有权 |
| --- | --- |
| `app` | 启动端口 |
| `adb` | SDK/ADB 路径 |
| `apk_center` | APK 来源、Push 路径与 APK 文件 |
| `signing` | 签名配置与 Keystore |
| `resources` | 资源部署路径与资源包 |
| `processes` | 进程过滤与拉起配置 |
| `broadcasts` | 广播预设 |
| `live_logs` | 实时日志预设与导出日志 |
| `offline_logs` | 离线日志预设与本地来源 |
| `audio_processing` | FFmpeg 路径、PCM 默认参数、输入文件与播放预览 |
| `device_logs` | 设备日志 Pull 来源 |
| `commands` | 自定义命令与分类 |
| `captures` | 截图、录屏和 scrcpy 配置 |
| `themes` | 用户导入主题 |
| `device_files` | Device Explorer 下载文件 |
| `runtime` | WebEngine Profile 与迁移备份 |

## 修改功能时的判断

1. 仅调整布局、文案、页面、菜单或 Tab：不修改 key、路径或 schema。
2. 新增有默认值的可选字段：保留原 key；读取旧数据时补默认值。
3. 修改字段类型、结构或语义：提高该域 `schema_version`，在 `app/migrations.py` 增加相邻版本迁移。
4. 新增独立持久化功能：在注册表中新增从未使用过的 key、路径、默认值和 schema。
5. 拆分或合并页面：数据域不跟随 UI 移动；确需拆分数据时保留旧 key 作为迁移来源。

## 读写与迁移

- 每个配置 JSON 必须包含与注册表一致的 `storage_key` 和受支持的 `schema_version`。
- 无 `storage_key` 的历史文件按原有 v1 数据处理。key 不匹配时停止，不能猜测或覆盖。
- schema 高于当前程序时停止并提示升级，禁止旧版本回写。
- 迁移必须逐级执行，例如 `v1 -> v2 -> v3`，不能只提供 `v1 -> latest`。
- 迁移前由存储层将原 JSON 复制到 `runtime/migration-backups/<启动时间>/`，再原子替换。
- 迁移只处理所属域 JSON，不删除、移动或重命名 APK、密钥、资源、日志、截图和录屏。
- 域内修改必须使用 `storage.update()` 保留未知字段。前端只通过 `/api/config/domain` 保存所属域。
- `/api/config` 是兼容读取视图，不允许恢复全量 POST 保存。

## 可分享数据

- 分享包使用稳定 feature key 分区；未知 feature 跳过并报告，已知 feature 各自校验 schema。
- 分享包默认排除端口、SDK 路径、本机绝对路径、密码、APK、Keystore、资源、日志和媒体文件。
- 自定义命令的 `id` 是永久身份，`name` 和 `category` 只是可修改的展示信息。
- 命令导入按 ID 和内容去重；同名不同内容自动重命名并存；旧 v1 命令包继续支持。
- 规则分享不等同于完整用户数据备份。未来实现完整备份时必须使用独立格式，并对密钥和大文件提供显式选项。

## 提交前检查

- 新字段是否归属正确的稳定 key。
- 是否误改了已发布 key、用户数据路径、`APP_NAME` 或 `APP_ID`。
- 是否需要提升 schema，并提供迁移及迁移测试。
- 是否使用按域更新，且没有用旧页面快照覆盖其他域。
- 导入是否兼容旧格式、处理重复 ID/内容和同名冲突。
- 是否覆盖“旧数据升级后字段和条目不丢失”“高版本拒绝回写”“其他域字节不变”的测试。
