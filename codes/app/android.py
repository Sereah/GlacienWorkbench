"""Android SDK、ADB 命令和设备信息的跨平台封装。"""
from __future__ import annotations
import ipaddress, os, platform, re, shutil, signal, socket, subprocess, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import proc

def _configured_tool(name: str, value: object, suffix: str) -> str | None:
    """兼容 SDK 根目录、工具目录和完整工具路径。"""
    text = str(value or "").strip()
    if not text:
        return None
    path = Path(text).expanduser()
    executable_name = name + suffix
    if path.is_file():
        if path.name.lower() == executable_name.lower():
            return str(path)
        path = path.parent
    direct = path / executable_name
    if direct.is_file():
        return str(direct)
    if name == "adb":
        candidate = path / "platform-tools" / executable_name
        return str(candidate) if candidate.is_file() else None
    roots = [path.parent if path.name.lower() == "platform-tools" else path]
    if path.parent.name.lower() == "build-tools":
        roots.insert(0, path.parent.parent)
    for root in roots:
        for folder in sorted((root / "build-tools").glob("*/"), reverse=True):
            candidate = folder / executable_name
            if candidate.is_file():
                return str(candidate)
    return None


def _sdk_roots(settings: dict) -> list[object]:
    """按显式配置、环境变量、平台标准目录返回 SDK 候选。"""
    candidates: list[object] = [settings.get("sdk_root"), os.getenv("ANDROID_SDK_ROOT"), os.getenv("ANDROID_HOME")]
    system = platform.system().lower()
    if system == "darwin":
        candidates.append(Path.home() / "Library" / "Android" / "sdk")
    elif system == "windows":
        local_app_data = os.getenv("LOCALAPPDATA")
        if local_app_data:
            candidates.append(Path(local_app_data) / "Android" / "Sdk")
    else:
        candidates.extend((Path.home() / "Android" / "Sdk", Path.home() / "Android" / "sdk"))
    return candidates


def tool(name: str, settings: dict) -> str | None:
    """查找 SDK 工具；桌面 App 不依赖终端 PATH 才能发现标准 SDK。"""
    suffix = ".exe" if os.name == "nt" else ""
    for root in _sdk_roots(settings):
        if found := _configured_tool(name, root, suffix):
            return found
    return shutil.which(name) or shutil.which(name + suffix)

def run(args: list[str], timeout: int = 30) -> tuple[int, str, str]:
    try:
        # 设备日志偶尔包含非 UTF-8 字节；替换坏字节而不是让整次 ADB 调用失败。
        result = proc.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, check=False)
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except FileNotFoundError: return 127, "", f"未找到命令：{args[0]}"
    except subprocess.TimeoutExpired: return 124, "", "命令执行超时"

def run_bytes(args: list[str], timeout: int = 30) -> tuple[int, bytes, str]:
    """执行可能返回二进制内容的命令，stderr 仍以可读文本返回。"""
    try:
        result = proc.run(args, capture_output=True, timeout=timeout, check=False)
        return result.returncode, result.stdout, result.stderr.decode("utf-8", errors="replace").strip()
    except FileNotFoundError:
        return 127, b"", f"未找到命令：{args[0]}"
    except subprocess.TimeoutExpired:
        return 124, b"", "命令执行超时"

def adb(settings: dict, *args: str, timeout: int = 30) -> tuple[int, str, str]:
    """执行本机 ADB 管理命令；设备业务命令应改用 device_adb()。"""
    executable = tool("adb", settings)
    return run([executable, *args], timeout) if executable else (127, "", "未找到 adb，请安装 Android Platform-Tools，或配置 Android SDK / platform-tools / adb 路径")

def devices(settings: dict, timeout: int = 30) -> list[dict]:
    """读取 adb devices -l，保留未授权/离线设备供 ADB 首页展示。"""
    if not tool("adb", settings):
        return []
    code, output, error = adb(settings, "devices", "-l", timeout=timeout)
    if code:
        raise ValueError(error or "读取 ADB 设备列表失败")
    result = []
    for line in output.splitlines()[1:]:
        columns = line.split()
        if len(columns) < 2:
            continue
        serial, state = columns[0], columns[1]
        if state == "no" and len(columns) >= 3 and columns[2] == "permissions":
            state = "no permissions"
        metadata = {}
        for column in columns[2:]:
            if ":" in column:
                key, value = column.split(":", 1)
                metadata[key] = value
        result.append({
            "serial": serial,
            "state": state,
            "model": metadata.get("model", "").replace("_", " "),
            "product": metadata.get("product", ""),
            "transport_id": metadata.get("transport_id", ""),
        })
    return result

def device_details(settings: dict, serial: str, listed: dict | None = None) -> dict:
    """读取已授权设备属性；serial 来自 adb devices 的可信列表。"""
    details = {"serial": serial}
    for label, prop in [("model", "ro.product.model"), ("android", "ro.build.version.release"), ("api", "ro.build.version.sdk")]:
        _, value, _ = adb(settings, "-s", serial, "shell", "getprop", prop)
        details[label] = value
    if not details.get("model") and listed:
        details["model"] = listed.get("model", "")
    details["access"] = access_status(settings, serial)
    return details

def access_status(settings: dict, serial: str) -> dict:
    """根据设备实时身份和关键分区挂载状态判断 Root/Remount，不缓存操作结果。"""
    id_code, identity, _ = adb(settings, "-s", serial, "shell", "id")
    rooted = id_code == 0 and "uid=0(root)" in identity
    mount_code, mounts, _ = adb(settings, "-s", serial, "shell", "cat", "/proc/mounts")
    writable = {}
    for line in mounts.splitlines() if mount_code == 0 else []:
        columns = line.split()
        if len(columns) < 4 or columns[1] not in {"/system", "/vendor", "/product", "/system_ext"}:
            continue
        writable.setdefault(columns[1], False)
        writable[columns[1]] = writable[columns[1]] or "rw" in columns[3].split(",")
    remounted = bool(writable) and all(writable.values())
    return {"rooted": rooted, "remounted": remounted, "mounts_checked": sorted(writable)}

def selected_device_settings(settings: dict, requested_serial: object = "") -> dict:
    """验证浏览器选择，只允许对 adb devices 中唯一/已选的授权设备执行命令。"""
    requested = str(requested_serial or "").strip()
    available = devices(settings)
    online = [item for item in available if item["state"] == "device"]
    if not requested:
        if len(online) == 1:
            requested = online[0]["serial"]
        elif len(online) > 1:
            raise ValueError("检测到多台已授权 ADB 设备，请先在 ADB 首页选择要操作的设备")
        else:
            raise ValueError("未检测到已授权 ADB 设备")
    selected = next((item for item in online if item["serial"] == requested), None)
    if not selected:
        raise ValueError("当前选择的 ADB 设备未连接或未完成调试授权，请在 ADB 首页重新选择")
    # 该字段只存在于单个 HTTP 请求的内存副本，绝不能写入 settings 文件或分享包。
    return {**settings, "_selected_adb_serial": selected["serial"]}

def device_adb(settings: dict, *args: str, timeout: int = 30) -> tuple[int, str, str]:
    """执行已验证设备命令，强制注入 -s，避免多设备时误操作第一台。"""
    serial = str(settings.get("_selected_adb_serial", "")).strip()
    if not serial:
        raise ValueError("缺少已选择的 ADB 设备，请先在 ADB 首页选择设备")
    return adb(settings, "-s", serial, *args, timeout=timeout)

def device_adb_bytes(settings: dict, *args: str, timeout: int = 30) -> tuple[int, bytes, str]:
    """执行已验证设备命令并保留 stdout 原始字节。"""
    serial = str(settings.get("_selected_adb_serial", "")).strip()
    if not serial:
        raise ValueError("缺少已选择的 ADB 设备，请先在 ADB 首页选择设备")
    executable = tool("adb", settings)
    if not executable:
        return 127, b"", "未找到 adb，请安装 Android Platform-Tools，或配置 Android SDK / platform-tools / adb 路径"
    return run_bytes([executable, "-s", serial, *args], timeout)

def _wireless_serial(value: str) -> tuple[str, int] | None:
    """识别 adb devices 中的 IPv4:port serial。"""
    match = re.fullmatch(r"([^:]+):(\d+)", str(value or "").strip())
    if not match:
        return None
    try:
        address = ipaddress.ip_address(match.group(1))
        port = int(match.group(2))
    except ValueError:
        return None
    return (str(address), port) if address.version == 4 and 1 <= port <= 65535 else None

def _wireless_endpoint(ip: object, port: object = 5555) -> tuple[str, int]:
    """校验来自请求或 ADB 输出的 IPv4 与端口。"""
    try:
        address = ipaddress.ip_address(str(ip or "").strip())
        number = int(port)
    except (TypeError, ValueError):
        raise ValueError("请输入有效的 IPv4 地址和端口")
    if address.version != 4 or address.is_unspecified or address.is_multicast:
        raise ValueError("请输入可连接的 IPv4 地址")
    if not 1 <= number <= 65535:
        raise ValueError("端口必须是 1-65535 的整数")
    return str(address), number

def _endpoint_text(ip: str, port: int) -> str:
    return f"{ip}:{port}"

def _host_ipv4() -> str:
    """用 UDP 路由选择获取本机活动 IPv4；失败时安全返回空。"""
    connection = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        connection.connect(("8.8.8.8", 80))
        value = connection.getsockname()[0]
        address = ipaddress.ip_address(value)
        return str(address) if address.version == 4 and not address.is_loopback else ""
    except (OSError, ValueError):
        return ""
    finally:
        connection.close()

def _host_subnet(host_ip: str) -> ipaddress.IPv4Network | None:
    """无线发现保守限制在当前 IPv4 的 /24，避免误扫公司或 VPN 大网段。"""
    try:
        address = ipaddress.ip_address(host_ip)
        return ipaddress.ip_network(f"{address}/24", strict=False) if address.version == 4 else None
    except ValueError:
        return None

def _valid_gateway(value: str) -> str:
    try:
        address = ipaddress.ip_address(str(value or "").strip())
        return str(address) if address.version == 4 and not address.is_loopback and not address.is_unspecified and not address.is_multicast else ""
    except ValueError:
        return ""

def _default_gateway() -> tuple[str, str]:
    """读取当前活动网络默认网关和接口，覆盖 macOS/Windows/Linux。"""
    system = platform.system().lower()
    if system == "darwin":
        code, output, _ = run(["netstat", "-rn", "-f", "inet"], 5)
        if code == 0:
            for line in output.splitlines():
                columns = line.split()
                if len(columns) >= 4 and columns[0] == "default":
                    gateway, interface = _valid_gateway(columns[1]), columns[-1]
                    if gateway and interface.startswith("en"):
                        return gateway, interface
    elif system == "windows":
        code, output, _ = run(["route", "print", "-4"], 8)
        if code == 0:
            for line in output.splitlines():
                columns = line.split()
                if len(columns) >= 4 and columns[0] == "0.0.0.0" and columns[1] == "0.0.0.0":
                    gateway = _valid_gateway(columns[2])
                    if gateway:
                        return gateway, columns[3]
    else:
        code, output, _ = run(["ip", "-4", "route", "show", "default"], 5)
        if code == 0:
            for line in output.splitlines():
                columns = line.split()
                if "via" in columns:
                    gateway = _valid_gateway(columns[columns.index("via") + 1])
                    interface = columns[columns.index("dev") + 1] if "dev" in columns else ""
                    if gateway:
                        return gateway, interface
    return "", ""

def _port_open(port: int) -> bool:
    connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    connection.settimeout(.3)
    try:
        return connection.connect_ex(("127.0.0.1", port)) == 0
    finally:
        connection.close()

def _adb_listener_processes(port: int = 5037) -> list[tuple[int, str]]:
    """只解析指定监听端口的进程；恢复前还必须确认进程名为 adb。"""
    result = []
    try:
        if os.name == "nt":
            code, output, _ = run(["netstat", "-ano", "-p", "TCP"], 5)
            pids = []
            for line in output.splitlines() if code == 0 else []:
                columns = line.split()
                if len(columns) >= 5 and columns[-2].upper() == "LISTENING" and columns[-1].isdigit() and columns[1].endswith(f":{port}"):
                    pids.append(int(columns[-1]))
            for pid in sorted(set(pids)):
                _, task_output, _ = run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], 5)
                command = task_output.split(",", 1)[0].strip().strip('\"') if task_output else ""
                result.append((pid, command))
            return result
        code, output, _ = run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fpc"], 5)
        if code == 0 or output:
            pid, command = None, ""
            for line in output.splitlines():
                if line.startswith("p") and line[1:].isdigit():
                    if pid is not None: result.append((pid, command))
                    pid, command = int(line[1:]), ""
                elif line.startswith("c"):
                    command = line[1:]
            if pid is not None: result.append((pid, command))
        return result
    except OSError:
        return []

def _wait_port_closed(port: int, seconds: float = 2.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not _port_open(port): return True
        time.sleep(.1)
    return not _port_open(port)

def _terminate_stuck_adb_server(port: int = 5037) -> bool:
    processes = _adb_listener_processes(port)
    if not processes:
        return not _port_open(port)
    invalid = [(pid, command) for pid, command in processes if Path(command).name.lower() not in {"adb", "adb.exe"}]
    if invalid:
        detail = "、".join(f"{command or 'unknown'}({pid})" for pid, command in invalid)
        raise ValueError(f"5037 端口监听者不是 adb：{detail}；为安全起见未终止")
    for pid, _ in processes:
        try:
            if os.name == "nt": run(["taskkill", "/PID", str(pid), "/T", "/F"], 5)
            else: os.kill(pid, signal.SIGTERM)
        except OSError as error:
            raise ValueError(f"无法终止卡住的 ADB server PID {pid}：{error}")
    if _wait_port_closed(port): return True
    for pid, _ in processes:
        try:
            if os.name != "nt": os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    return _wait_port_closed(port)

def ensure_adb_server(settings: dict) -> dict:
    """检测默认 ADB server；卡死时仅终止已确认的 5037 adb 监听进程。"""
    code, _, error = adb(settings, "devices", "-l", timeout=2)
    if code == 0:
        return {"recovered": False, "message": "ADB server 正常"}
    adb(settings, "kill-server", timeout=2)
    if _port_open(5037) and not _terminate_stuck_adb_server(5037):
        raise ValueError("无法停止卡住的本机 ADB server")
    code, output, start_error = adb(settings, "start-server", timeout=10)
    if code:
        raise ValueError(start_error or output or error or "ADB server 启动失败")
    code, _, verify_error = adb(settings, "devices", "-l", timeout=5)
    if code:
        raise ValueError(verify_error or "ADB server 恢复后仍无法响应")
    return {"recovered": True, "message": "本机 ADB server 已自动恢复"}

def _device_wifi_ipv4(settings: dict, serial: str) -> str:
    """从可信 adb devices 项读取车机 wlan0 IPv4。"""
    code, output, _ = adb(settings, "-s", serial, "shell", "ip", "-o", "-4", "addr", "show", "wlan0", timeout=15)
    if code:
        return ""
    match = re.search(r"\binet\s+(\d+\.\d+\.\d+\.\d+)/\d+", output)
    if not match:
        return ""
    try:
        address = ipaddress.ip_address(match.group(1))
        return str(address) if address.version == 4 and not address.is_loopback else ""
    except ValueError:
        return ""

def wireless_suggestion(settings: dict, requested_serial: object = "") -> dict:
    """推荐无线 ADB 地址：已连无线、USB 设备 wlan0、历史无线地址依次降级。"""
    try:
        available = devices(settings, timeout=3)
    except ValueError:
        # 离线 TCP transport 可能拖住 adb devices；建议失败不能阻止手动连接。
        available = []
    connected_wireless = next(((_wireless_serial(item["serial"]), item) for item in available if item["state"] == "device" and _wireless_serial(item["serial"])), None)
    requested = str(requested_serial or "").strip()
    usb_online = [item for item in available if item["state"] == "device" and not _wireless_serial(item["serial"])]
    usb = next((item for item in usb_online if item["serial"] == requested), None) or (usb_online[0] if len(usb_online) == 1 else None)
    gateway, gateway_interface = _default_gateway()
    ip, port, source, usb_serial = "", 5555, "none", usb["serial"] if usb else ""
    if connected_wireless:
        (ip, port), _ = connected_wireless; source = "connected_wireless"
    elif usb:
        ip = _device_wifi_ipv4(settings, usb["serial"]); source = "usb_device_wifi" if ip else "none"
    if not ip and gateway:
        ip, source = gateway, "wifi_gateway"
    if not ip:
        historical = next((_wireless_serial(item["serial"]) for item in available if _wireless_serial(item["serial"])), None)
        if historical:
            ip, port = historical; source = "adb_history"
    host_ip = _host_ipv4()
    subnet = ".".join(host_ip.split(".")[:3]) + ".x" if host_ip else ""
    return {"ip": ip, "port": port, "source": source, "usb_serial": usb_serial, "can_enable_tcpip": bool(usb_serial), "host_ipv4": host_ip, "gateway_ipv4": gateway, "gateway_interface": gateway_interface, "subnet_hint": subnet}

def _mdns_wireless_endpoints(settings: dict) -> list[tuple[str, int]]:
    """读取 ADB 可连接的 mDNS 服务；配对服务不能直接 connect，因此不纳入。"""
    code, output, _ = adb(settings, "mdns", "services", timeout=5)
    if code:
        return []
    endpoints = []
    for line in output.splitlines():
        columns = line.split()
        if len(columns) < 3 or columns[-2] not in {"_adb._tcp", "_adb-tls-connect._tcp"}:
            continue
        parsed = _wireless_serial(columns[-1])
        if parsed and parsed not in endpoints:
            endpoints.append(parsed)
    return endpoints

def _tcp_endpoint_open(ip: str, port: int, timeout: float = .22) -> bool:
    connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    connection.settimeout(timeout)
    try:
        return connection.connect_ex((ip, port)) == 0
    except OSError:
        return False
    finally:
        connection.close()

def _offline_wireless_serials(items: list[dict]) -> list[str]:
    return [item["serial"] for item in items if item.get("state") == "offline" and _wireless_serial(item.get("serial", ""))]

def clean_offline_wireless(settings: dict) -> dict:
    """只移除 ADB 列表中的离线 TCP transport，不触碰 USB 设备。"""
    stale = _offline_wireless_serials(devices(settings, timeout=5))
    removed = []
    for serial in stale:
        code, output, error = adb(settings, "disconnect", serial, timeout=5)
        if code:
            raise ValueError(error or output or f"清理离线连接失败：{serial}")
        removed.append(serial)
    return {"ok": True, "removed": removed, "message": f"已清理 {len(removed)} 个离线无线连接" if removed else "没有需要清理的离线无线连接"}

def _add_wireless_candidate(candidates: dict[str, dict], ip: str, port: int, source: str, state: str = "discovered", model: str = "") -> None:
    endpoint = _endpoint_text(ip, port)
    candidate = candidates.setdefault(endpoint, {"serial": endpoint, "ip": ip, "port": port, "state": state, "model": model, "sources": []})
    if source not in candidate["sources"]:
        candidate["sources"].append(source)
    if state == "device":
        candidate["state"] = state
    if model:
        candidate["model"] = model

def scan_wireless(settings: dict, body: dict) -> dict:
    """通过已有连接、ADB mDNS、热点网关和受限 /24 端口扫描发现无线 ADB。"""
    _, port = _wireless_endpoint("127.0.0.1", body.get("port", 5555))
    cleanup = clean_offline_wireless(settings)
    available = devices(settings, timeout=5)
    host_ip = _host_ipv4()
    gateway, gateway_interface = _default_gateway()
    network = _host_subnet(host_ip)
    candidates: dict[str, dict] = {}
    for item in available:
        parsed = _wireless_serial(item.get("serial", ""))
        if parsed and item.get("state") == "device":
            _add_wireless_candidate(candidates, *parsed, "connected", "device", item.get("model", ""))
    for ip, mdns_port in _mdns_wireless_endpoints(settings):
        _add_wireless_candidate(candidates, ip, mdns_port, "mdns")
    probe_ips = []
    if gateway and gateway != host_ip:
        probe_ips.append(gateway)
    if network:
        probe_ips.extend(str(address) for address in network.hosts() if str(address) not in {host_ip, gateway})
    with ThreadPoolExecutor(max_workers=48) as executor:
        open_states = executor.map(lambda ip: _tcp_endpoint_open(ip, port), probe_ips)
        for ip, is_open in zip(probe_ips, open_states):
            if is_open:
                _add_wireless_candidate(candidates, ip, port, "gateway" if ip == gateway else "subnet")
    ordered = sorted(candidates.values(), key=lambda item: (item["state"] != "device", "mdns" not in item["sources"], ipaddress.ip_address(item["ip"]), item["port"]))
    return {
        "devices": ordered, "cleaned_offline": cleanup["removed"], "host_ipv4": host_ip,
        "gateway_ipv4": gateway, "gateway_interface": gateway_interface,
        "subnet": str(network) if network else "", "scan_port": port,
        "message": f"发现 {len(ordered)} 个无线 ADB 候选" if ordered else "未发现无线 ADB；请确认设备端已监听，并检查 Wi-Fi 客户端隔离",
    }

def disconnect_wireless(settings: dict, body: dict) -> dict:
    """断开指定无线 transport；目标必须是明确的 IPv4:port。"""
    ip, port = _wireless_endpoint(body.get("ip"), body.get("port", 5555))
    endpoint = _endpoint_text(ip, port)
    code, output, error = adb(settings, "disconnect", endpoint, timeout=8)
    if code:
        raise ValueError(error or output or f"断开失败：{endpoint}")
    return {"ok": True, "serial": endpoint, "message": output or f"已断开 {endpoint}"}

def connect_wireless(settings: dict, body: dict) -> dict:
    """可选先让可信 USB 设备监听 TCP，再连接用户确认的 IPv4:port。"""
    ip, port = _wireless_endpoint(body.get("ip"), body.get("port", 5555))
    tcpip_output = ""
    recovery = ensure_adb_server(settings)
    if body.get("enable_tcpip"):
        selected = selected_device_settings(settings, body.get("usb_serial", ""))
        serial = selected["_selected_adb_serial"]
        if _wireless_serial(serial):
            raise ValueError("启用 TCP 模式需要选择 USB 连接的设备")
        code, output, error = device_adb(selected, "tcpip", str(port), timeout=30)
        if code:
            raise ValueError(error or output or "启用无线 ADB 监听失败")
        tcpip_output = output or error
    endpoint = _endpoint_text(ip, port)
    connect_output = ""
    # 先移除同 endpoint 的离线 transport，避免旧连接拖慢 devices/connect。
    adb(settings, "disconnect", endpoint, timeout=2)
    code, output, error = adb(settings, "connect", endpoint, timeout=10)
    connect_output = output or error
    recovered_network = False
    # macOS VPN/网络切换后，旧 ADB server 可能仍返回 No route，而新 socket 已可达。
    if code and _tcp_endpoint_open(ip, port, timeout=.5) and any(text in connect_output.lower() for text in ("no route to host", "network is unreachable")):
        restart = restart_server(settings)
        if restart["ok"]:
            code, output, error = adb(settings, "connect", endpoint, timeout=10)
            connect_output = output or error
            recovered_network = True
    normalized = connect_output.lower()
    if code == 0 and ("connected to" in normalized or "already connected to" in normalized):
        return {"ok": True, "serial": endpoint, "message": connect_output or f"已连接 {endpoint}", "tcpip_output": tcpip_output, "recovered": recovery["recovered"] or recovered_network}
    try:
        current = devices(settings, timeout=3)
    except ValueError:
        current = []
    if any(item["serial"] == endpoint and item["state"] == "device" for item in current):
        return {"ok": True, "serial": endpoint, "message": connect_output or f"已连接 {endpoint}", "tcpip_output": tcpip_output, "recovered": recovery["recovered"] or recovered_network}
    adb(settings, "disconnect", endpoint, timeout=3)
    raise ValueError(connect_output or f"无法连接 {endpoint}")

def restart_server(settings: dict) -> dict:
    """重启本机 ADB server，再读取设备列表验证它已恢复。"""
    executable = tool("adb", settings)
    if not executable:
        raise ValueError("未找到 adb，请安装 Android Platform-Tools，或配置 Android SDK / platform-tools / adb 路径")
    kill_code, kill_out, kill_error = run([executable, "kill-server"], 20)
    devices_code, devices_out, devices_error = run([executable, "devices", "-l"], 30)
    return {"ok": kill_code == 0 and devices_code == 0, "kill_output": kill_out or kill_error, "devices_output": devices_out or devices_error}

def force_kill_adb() -> dict:
    """执行用户明确要求的固定 pkill 命令；不接受任何外部命令或参数。"""
    if os.name == "nt":
        raise ValueError("当前系统不支持 pkill -9 -x adb")
    executable = shutil.which("pkill")
    if not executable:
        raise ValueError("当前系统未找到 pkill")
    code, output, error = run([executable, "-9", "-x", "adb"], 5)
    if code == 0:
        return {"ok": True, "killed": True, "message": "已执行 pkill -9 -x adb"}
    if code == 1:
        return {"ok": True, "killed": False, "message": "未找到正在运行的 adb 进程"}
    raise ValueError(error or output or f"pkill 执行失败，退出码 {code}")

def root_device(settings: dict) -> dict:
    """请求当前已验证设备以 Root 身份重启 adbd，并等待它重新上线。"""
    serial = str(settings.get("_selected_adb_serial", "")).strip()
    before = access_status(settings, serial)
    if before["rooted"]:
        return {"ok": True, "message": "设备已处于 Root 状态", "access": before}
    code, output, error = device_adb(settings, "root", timeout=30)
    if code == 0:
        adb(settings, "-s", serial, "wait-for-device", timeout=30)
    access = access_status(settings, serial)
    return {"ok": code == 0 and access["rooted"], "message": output or error or ("ADB Root 完成" if access["rooted"] else "ADB Root 未生效"), "access": access}

def remount_device(settings: dict) -> dict:
    """请求当前已验证设备 remount；最终结果以关键分区实际挂载状态为准。"""
    serial = str(settings.get("_selected_adb_serial", "")).strip()
    before = access_status(settings, serial)
    if not before["rooted"]:
        return {"ok": False, "message": "请先执行 ADB Root", "access": before}
    if before["remounted"]:
        return {"ok": True, "message": "关键分区已处于可写状态", "access": before}
    code, output, error = device_adb(settings, "remount", timeout=60)
    access = access_status(settings, serial)
    return {"ok": code == 0 and access["remounted"], "message": output or error or ("ADB Remount 完成" if access["remounted"] else "ADB Remount 未生效"), "access": access}

def reboot_device(settings: dict) -> dict:
    """重启当前已验证设备；设备离线与恢复继续由前端状态轮询处理。"""
    code, output, error = device_adb(settings, "reboot", timeout=15)
    return {"ok": code == 0, "message": output or error or ("设备正在重启" if code == 0 else "设备重启失败")}

def status(settings: dict, requested_serial: object = "") -> dict:
    """返回所有 ADB 设备与当前选择；多设备时绝不偷偷选择列表第一台。"""
    if not tool("adb", settings):
        return {"state": "missing", "message": "未找到 adb", "details": {}, "devices": [], "selected_serial": "", "requested_serial": ""}
    requested = str(requested_serial or "").strip()
    available = devices(settings)
    online = [item for item in available if item["state"] == "device"]
    selected = next((item for item in online if item["serial"] == requested), None) if requested else None
    if selected:
        return {"state": "online", "message": "设备已连接", "details": device_details(settings, selected["serial"], selected), "devices": available, "selected_serial": selected["serial"], "requested_serial": requested}
    if requested:
        current = next((item for item in available if item["serial"] == requested), None)
        message = f"已选择的设备 {requested} 当前未连接" if not current else f"设备 {requested} 当前状态：{current['state']}"
        return {"state": "offline", "message": message, "details": {}, "devices": available, "selected_serial": "", "requested_serial": requested}
    if len(online) == 1:
        selected = online[0]
        return {"state": "online", "message": "设备已连接", "details": device_details(settings, selected["serial"], selected), "devices": available, "selected_serial": selected["serial"], "requested_serial": ""}
    if len(online) > 1:
        return {"state": "selection_required", "message": f"检测到 {len(online)} 台已授权 ADB 设备，请选择要操作的设备", "details": {}, "devices": available, "selected_serial": "", "requested_serial": ""}
    return {"state": "offline", "message": "未检测到已授权设备", "details": {}, "devices": available, "selected_serial": "", "requested_serial": ""}

def signature(text: str) -> str:
    match = re.search(r"signatures:\[([0-9a-fA-F]+)\]", text)
    return match.group(1).lower() if match else ""
