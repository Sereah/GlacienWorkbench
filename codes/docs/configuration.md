# 用户数据与功能配置

Glacien 不再使用 `settings.<方案名>.json` 或 `active_settings.json`。源码运行与桌面打包都使用系统标准用户数据目录；仓库根目录的 `defaults.json` 只是首次初始化的只读种子。

用户数据根目录：

- macOS：`~/Library/Application Support/GlacienWorkbench/`
- Windows：`%LOCALAPPDATA%\GlacienWorkbench\`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/GlacienWorkbench/`
- 测试覆盖：`GLACIEN_DATA_DIR=/path`

设置页会显示该路径，并可通过“打开文件夹”调用当前系统的 Finder、资源管理器或默认 Linux 文件管理器。

目录结构：

```text
GlacienWorkbench/
├── app/config.json
├── local-tools/
│   ├── offline-logs/config.json
│   └── audio-processing/
│       ├── config.json
│       ├── inputs/
│       └── previews/
├── adb-tools/
│   ├── adb/config.json
│   ├── apk-center/
│   │   ├── config.json
│   │   ├── signing.json
│   │   ├── files/
│   │   └── keystores/
│   ├── resource-deployment/
│   │   ├── config.json
│   │   └── files/
│   ├── processes/config.json
│   ├── broadcasts/presets.json
│   ├── live-logs/
│   │   ├── presets.json
│   │   └── exports/
│   ├── device-logs/
│   │   └── sources.json
│   ├── bugreports/
│   │   ├── files/
│   │   └── runtime/
│   ├── commands/commands.json
│   └── device-tools/
│       ├── config.json
│       ├── screenshots/
│       ├── recordings/
│       ├── recording-covers/
│       └── downloads/
└── runtime/
    ├── migration-backups/
    ├── themes.json
    └── web-profile/
```

`app/config.json` 只保存端口，`adb-tools/adb/config.json` 保存 SDK 路径，`adb-tools/device-tools/config.json` 保存可选的 scrcpy 自定义可执行文件路径，`local-tools/audio-processing/config.json` 保存 FFmpeg 路径和最近使用的 PCM 参数；这些配置都包含 schema version。`runtime/themes.json` 保存当前主题 ID 和用户导入的主题，内置主题仍位于只读程序资源 `web/themes.json`，因此重启和升级都不会丢失用户选择。其余字段按功能域由 `app/storage.py` 原子写入。`app/config.py` 为现有业务 API 提供合并视图，但不能恢复单一大 settings 文件。

`storage.STORAGE_DOMAINS` 是目录和默认配置的唯一注册表。每次启动都会创建已注册的数据目录；具有配置文件的功能会为缺失 JSON 写入默认值，只有受管文件目录的功能则只创建目录。已存在文件绝不覆盖。因此后续新增功能只需注册配置路径、默认值和数据目录，旧安装也能自动补齐。历史迁移仍由 `.storage-v2` 标记限制为一次，不影响当前结构补齐。

## 版本升级兼容契约

- `STORAGE_DOMAINS` 的 key 是永久功能 ID，与页面名称、菜单层级和 Tab 布局无关。现有 key 不得改名或复用；新增独立功能应新增 key。
- 每个 JSON 保存自己的 `storage_key` 和 `schema_version`。缺少 `storage_key` 的已有文件按旧版数据接入；key 不匹配或 schema 高于程序支持版本时拒绝回写。
- 仅新增可选字段且有默认值时可保持 schema；改变字段类型、结构或含义时必须提高该域 schema，并在 `app/migrations.py` 添加逐级迁移。
- 旧 schema 第一次读取时先将原 JSON 备份到 `runtime/migration-backups/<timestamp>/`，再原子写入迁移结果。迁移只处理配置 JSON，不移动或清理 APK、Keystore、日志、截图和录屏。
- 业务保存使用 `storage.update()`，HTTP 使用 `POST /api/config/domain`，一次只修改一个域并保留未知字段。`GET /api/config` 继续提供前端聚合视图，但不再接受聚合保存。
- 当前 `commands` schema 为 v2，每条自定义命令都有独立 `id`；名称和分类可修改，ID 不变。旧 v1 命令会在首次读取时补 ID。
- 当前 `processes` schema 为 v2，`watched_packages` 保存用户明确关注的包名，原 `process_package_keywords` 继续提供批量匹配；每个包的特殊拉起入口保存为 `app_launches.<package>.command`。旧 v1 的 action、component、activity 和 extras 会在备份后转换成等价的 `am start` 命令。
- 当前 `offline_logs` schema 为 v2，`offline_log_sources` 的绝对路径既可指向日志文件，也可指向日志目录；旧 v1 目录来源会无损保留。

页面调整不触发数据迁移。例如部署中心改名或移动 Tab 仍使用 `apk_center`，日志 Pull 移入设备工具仍使用 `device_logs`，截图和录屏调整布局仍使用 `captures`。只有持久化数据结构变化才提升对应 schema。

设备日志 Pull 是用户主动导出的结果，不再写入应用数据目录；每次 Pull 在系统下载目录创建 `device-logs-<当前时间>/`，不生成 manifest JSON。旧版本已经存在的 `adb-tools/device-logs/pulls/` 保留原样，不自动移动或删除。

`adb-tools/commands/commands.json` 同时保存分类和命令，保证分类改名与引用更新能原子提交。命令导入采用合并语义：本地同名且相同则跳过，内容不同则将导入项重命名为“（导入）”。
