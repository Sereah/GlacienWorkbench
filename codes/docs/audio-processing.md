# PCM 音频处理

`app/audio.py` 管理外置 FFmpeg、裸 PCM 输入和浏览器可播放的 WAV 预览。页面位于“本地工具 → 音频处理”。

## FFmpeg

桌面包不分发 FFmpeg。查找顺序为用户配置的绝对路径、进程 PATH、当前平台常见安装目录。自定义文件必须名为 `ffmpeg` 或 `ffmpeg.exe`、可执行，并通过 `ffmpeg -version` 验证。后端始终使用参数数组运行子进程，不使用主机 Shell。

## PCM 契约

裸 PCM 不携带格式信息，调用方必须提供采样格式、采样率和 1-32 的通道数。支持 `u8`、`s16le`、`s24le`、`s32le`、`f32le` 和 `f64le`；多通道样本按 interleaved 布局读取。

- 全部通道：1-2 路保持原通道数，超过 2 路由 FFmpeg 下混成立体声。
- 指定通道：使用受控的 `pan=mono|c0=cN` 过滤器提取一路，页面通道编号从 1 开始。
- 输出固定为 PCM S16LE WAV，仅用于浏览器播放预览，不修改输入文件。

输入只允许保存在 `local-tools/audio-processing/inputs/`，预览只允许保存在 `previews/`。API 使用不可变文件 ID，不接受浏览器提交的本机路径。音频响应支持 HTTP Range，以便浏览器拖动播放位置。
