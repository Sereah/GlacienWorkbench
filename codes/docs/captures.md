# 设备工具：屏幕捕获

“设备工具”提供屏幕捕获、设备文件和日志 Pull 三个独立标签。设备文件浏览、Pull、上传和删除见 [device-files.md](device-files.md)，设备日志导出见 [device-logs.md](device-logs.md)，二者都不能与本地媒体库逻辑混用。

## 截图

- 使用 `adb -s <serial> exec-out screencap -p`，不在设备端创建临时图片。
- 响应必须以 PNG 文件头开头，再原子写入 `adb-tools/device-tools/screenshots/`。
- 浏览器通过受控文件 ID 预览、下载和复制图片；复制失败不能把截图误报为失败。
- 单次截图和连续截图共用 Display 选择。连续截图由浏览器串行调度，每张完成后才等待下一间隔，避免慢设备堆积并发请求；切换功能或离开设备工具时停止后续任务。

## 录屏

- 页面提供三个单次录制模式：`Android 原生（无声音）`、`scrcpy 摄像收音` 和 `scrcpy 混合收音`。选择只影响本次录制，不写入配置；默认保持 Android 原生模式。
- Android 原生模式使用设备端 `screenrecord`，文件固定为 `/data/local/tmp/glacien-screenrecord-<随机ID>.mp4`。后端持有设备端 PID；手动停止时发送 `SIGINT`，等待 MP4 正常收尾后再 Pull。该模式只录制视频。
- scrcpy 摄像收音使用 `--audio-source=mic-camcorder`，通过设备麦克风采集接近手机拍视频的环境声音；scrcpy 混合收音使用 `--audio-source=voice-performance`，尝试同时采集设备麦克风与设备播放声音。实际音频路由受 Android 版本、车机 ROM 和 Audio HAL 限制。
- 两种 scrcpy 模式都使用外部 scrcpy，并固定附加 `--no-window --no-playback --no-control --audio-codec=aac --require-audio`。音频不可用时必须启动失败，不能静默降级为无声视频；输出直接写入受管录屏目录，不经过设备端临时文件和 ADB Pull。
- scrcpy 音频要求 Android 11 或更高版本；Android 11 启动时设备屏幕需要保持解锁，Android 10 及以下只能使用原生无声录制。厂商系统不支持所选音源时由 `--require-audio` 返回明确错误。
- 同一服务进程最多允许一个录制会话。手动停止 scrcpy 时优先发送中断信号以完成 MP4 封装，超时才终止进程。
- 所有模式完成后都必须校验 MP4 的 `mvhd` 媒体时长。scrcpy 模式还必须从 `moov/trak/mdia/hdlr` 确认存在 `soun` 音轨，不能只依赖启动参数。文件非空但时长为 0、未完成封装或有声模式缺少音轨时必须报告为录制失败，不能误报完成；本地异常文件会保留供排查，Android 原生模式的有效文件才删除设备临时文件。录屏固定写入 `adb-tools/device-tools/recordings/`。
- 录屏不使用 WebEngine 内置 `<video>` 预览。录制完成、点击主页面“播放”或媒体库录屏卡片时，通过受控后端接口交给当前系统的默认播放器。
- `--bugreport` 仅用于 Android 原生模式，可附加诊断信息和额外数据轨；默认码率使用 8 Mbps。scrcpy 模式把分辨率选项转换为保持宽高比的 `--max-size`。
- 用户可以在开始录制前填写文件名称；留空时沿用设备序列号和时间戳自动命名。自定义名称由后端校验，自动补 `.mp4`，重名时追加序号且不覆盖已有文件。
- 录屏启动成功后立即通过 `adb exec-out screencap -p` 保存一张近似首帧封面，不依赖 FFmpeg 或 WebEngine 视频解码。封面与最终 MP4 同名关联，只用于最近录屏和媒体库展示；截图失败不影响录制，无封面时回退到播放图标。
- 页面刷新后通过 `/api/captures/record/status` 恢复状态和实际录制模式；达到时间上限后，状态查询负责完成 Pull 或确认 scrcpy 本地文件。
- 时间上限必须在 1-180 秒，码率和分辨率需校验，不接受任意 Shell 参数。

## Display 与 scrcpy

- 页面通过 `dumpsys display` 展示逻辑 Display ID、名称和分辨率；截图与 `screenrecord` 使用 `uniqueId=local:<id>` 对应的 SurfaceFlinger 物理 ID，scrcpy 使用逻辑 Display ID，不能混用。无法获得物理 ID 的屏幕不得静默回退主屏。
- scrcpy 投屏和有声录屏使用系统安装的外部可执行文件。默认检查 PATH 和三端常见路径；自定义路径持久化在 `adb-tools/device-tools/config.json`，后端必须重新验证其解析后为 `scrcpy` / `scrcpy.exe` 可执行文件，并始终用参数数组启动。启动时通过 `ADB` 环境变量传入 Workbench 已解析的 adb，捕获启动与录制日志；进程提前退出时向页面返回最后一条可读错误。
- scrcpy 投屏启动后作为独立桌面进程运行，HTTP 请求不等待投屏窗口退出；scrcpy 录屏进程则由录制会话持有，以支持状态恢复、手动停止和文件收尾。

## 截图对比

- 对比功能只读取媒体库返回的受控截图 ID，在浏览器中叠加两张图片并通过滑块调整分界线，不读取任意本地路径，也不生成额外文件。
- 默认载入最近 100 张截图供选择；对比画布限制在当前视口内，避免撑高屏幕捕捉页。

## 文件与预览边界

- 浏览器只能提交 `screenshots/<文件>` 或 `recordings/<文件>` 形式的受控 ID，不能传本机路径。
- 系统播放器接口只接受 `recordings/` 下重新校验后的 `.mp4`，不能打开浏览器提交的任意本机路径。
- 媒体接口支持 HTTP Range，用于录屏下载和其他媒体读取。
- “打开文件位置”仅对已验证文件执行系统命令：macOS/Linux 打开文件父目录，Windows 使用 `explorer /select` 选中文件；全部使用参数数组并同步检查退出码。LaunchServices 或桌面会话不可用时返回目录路径，前端自动尝试复制路径，绝不能提示已打开。
- `captures/` 位于系统用户数据目录，不进入源码包或桌面应用包。

## 媒体库

- 页面不依赖 Finder、Explorer 或 xdg-open，使用统一 Web 媒体库列出 `captures/` 内容，因此 macOS、Ubuntu 和 Windows 逻辑一致。
- `GET /api/captures/files` 只扫描 PNG/MP4，按修改时间倒序并固定分页上限。
- 截图以懒加载缩略图展示并进入统一大预览弹窗；录屏卡片不加载 Web 播放器，点击后直接调用系统默认播放器。
- 删除只接受已验证文件 ID，必须二次确认；删除当前页面正在预览的文件时同步清空预览。
- 媒体库支持逐项选择、全选当前已加载列表和批量删除。勾选只局部更新卡片和工具栏；删除成功后让目标卡片淡出，并通过 FLIP 位移动画让其余卡片补位，不能重新渲染整个弹窗造成闪烁。批量接口最多接收 100 个 ID，每个 ID 都必须独立执行相同的受控目录校验，并返回成功与失败明细。
- 录屏封面保存在独立的 `recording-covers/` 目录，不能通过删除接口单独删除；删除录屏时同步清理对应封面。
- 录屏 completed 状态返回前必须重新校验本地 MP4；媒体库删除当前录屏时同步清空会话。外部删除文件后状态自动回退到 idle，不能向前端返回已经不存在的媒体。
- 设备工具主页面明确标注“最近截图”和“最近录屏”，并在文件摘要前显示小尺寸预览图或录屏封面。卡片中的删除按钮只删除当前最近文件，成功后自动递补同类型的下一条最新文件；媒体库统一从功能页顶部进入。
- 当前录屏会话状态与历史录屏摘要分开处理：`idle` 只表示当前没有录制任务，不能清空仍然存在的最近录屏。截图完成后自动打开统一预览弹窗；录屏完成后自动调用系统默认播放器。
