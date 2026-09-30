# 快速性能看板

“性能诊断”是 ADB 工具下的独立页面，用固定、受控的采样路径快速收集 Android 设备和目标应用状态。它不替代 Android Studio Profiler 或 Perfetto，不要求目标应用为 debuggable。

## 数据目录

稳定存储 key 为 `performance_diagnostics`：

```text
adb-tools/performance-diagnostics/
├── config.json
├── sessions/<session-id>/
│   ├── manifest.json
│   ├── events.jsonl
│   ├── performance.csv
│   └── performance.json
└── runtime/
```

`events.jsonl` 在采样过程中持续追加样本和暂停、恢复、完成事件。停止任务后才原子生成 JSON 和 CSV 导出。`manifest.json` 与 `performance.json` 均包含 `storage_key` 和 `schema_version`。下载接口只接受 32 位十六进制 session ID 和 `csv` / `json` 格式，不读取浏览器提交的本地路径。

页面右上角的“采样记录”用于查看会话占用空间、下载已有 CSV/JSON，以及选择并批量删除历史会话。删除最多一次处理 100 条记录，必须二次确认，且后端拒绝删除正在采样、暂停或归档中的会话。

## 任务模型

- 同一 Workbench 服务进程只允许一个性能采样任务。
- 启动时固定已验证的设备 serial 和应用包名；包名必须已安装在当前设备。
- 采样生命周期属于后端，关闭或刷新页面不会停止任务。
- 暂停会停止新的 ADB 查询，并在事件文件中记录时间点；恢复后的第一组 CPU 数据不跨暂停区间计算。
- 页面只保留最近 180 个样本用于绘图，完整样本始终从 `events.jsonl` 生成导出文件。
- 单项指标失败时记录错误并继续采集，不能用 `0` 代替不支持或无权限的数据。
- CPU 与内存趋势使用带单位坐标、双序列图例、数据点和悬浮详情的 SVG 图表；只有一个有效样本时也必须显示数据点。
- 前台 Activity 使用变化时间线展示。多 Display 同时存在 resumed Activity 时优先展示被采样应用，并保留其 Display ID；目标应用不在前台时展示系统全局 resumed Activity。
- 默认采样间隔为 1 秒。采样线程使用固定节拍扣除 ADB 查询耗时；如果单轮查询本身超过间隔则立即进入下一轮，但不会并发堆积采样命令。

## 指标和频率

每个采样周期读取 `/proc/stat`、`/proc/meminfo`、`df -k /data`、`pidof` 和前台 Activity，目标进程存在时读取 `/proc/<pid>/stat` 和 `/proc/<pid>/status`。PSS 每 3 个周期通过 `dumpsys meminfo <package>` 更新；电池、电流和 Thermal 每 5 个周期更新。多 Display 设备会解析每个 Display 的 resumed Activity，并优先展示目标应用所在 Display。

进程重启后 PID 会重新解析，跨 PID 不计算 CPU 差值。电流同时保存 sysfs 原始值和按微安转换的 mA 值，以便识别厂商单位差异。PSS、Thermal、前台 Activity 等输出格式存在 ROM 差异，解析失败时页面显示不可用，原始 ADB 错误保留在样本中。

## API

- `GET /api/performance/status`：任务状态、最新指标和最近样本。
- `POST /api/performance/start`：使用当前设备、包名和 1-10 秒采样间隔启动。
- `POST /api/performance/pause`、`resume`、`stop`：控制采样生命周期。
- `GET /api/performance/download?id=<session-id>&format=csv|json`：下载已完成会话。

后续诊断快照、前后对比以及录屏/Logcat 联合采集继续使用该稳定域和会话目录，但不得改变已发布字段语义。
