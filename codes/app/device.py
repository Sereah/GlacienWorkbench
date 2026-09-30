"""设备进程、广播与日志能力。

日志过滤规则在此处解释，HTTP/SSE 传输生命周期在 server.py。
"""
import re, shlex, subprocess, tempfile, time
from pathlib import Path
from datetime import datetime
from . import storage
from . import android
from . import artifacts
from . import proc

COMMAND_TIMEOUT_MIN, COMMAND_TIMEOUT_MAX = 1, 300
TEMPLATE_VARIABLE = re.compile(r"\{\{([A-Za-z][A-Za-z0-9_-]{0,31})\}\}|<([A-Za-z][A-Za-z0-9_-]{0,31})>")
# 命令变量只允许作为一个设备端参数使用，不能带空格、引号或 shell 控制字符。
SAFE_TEMPLATE_VALUE = re.compile(r"[A-Za-z0-9_.:@/+=,-]+")
RISKY_ADB_PREFIXES = (
    ("reboot",), ("root",), ("unroot",), ("remount",),
    ("shell", "pm", "uninstall"), ("shell", "pm", "clear"), ("shell", "pm", "disable"),
    ("shell", "wm", "size"), ("shell", "wm", "density"),
    ("shell", "settings", "put"), ("shell", "settings", "delete"),
    ("shell", "am", "force-stop"), ("shell", "am", "broadcast"),
    ("shell", "setprop"), ("shell", "rm"),
)
PROCESS_NAME = re.compile(r"[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?")
THREADTIME_PID = re.compile(r"^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+(\d+)\s+\d+\s+")
PACKAGE_VERSION_NAME = re.compile(r"^\s*versionName=(.*?)\s*$", re.MULTILINE)
PACKAGE_VERSION_CODE = re.compile(r"^\s*versionCode=(\d+)(?:\s|$)", re.MULTILINE)

def adb_commands(settings):
    """返回当前功能配置的自定义 ADB 命令，配置内容不携带 adb 可执行路径。"""
    return settings.get("adb_commands", {})

def command_variables(template: object) -> list[str]:
    """提取命令模板中的变量，支持推荐的 {{name}} 与兼容的 <name>。"""
    result = []
    for match in TEMPLATE_VARIABLE.finditer(str(template or "")):
        name = match.group(1) or match.group(2)
        if name not in result:
            result.append(name)
    return result

def command_template(template: object, values: object) -> str:
    """使用受限的单参数变量替换模板，避免变量值改变设备端 shell 语义。"""
    text = str(template or "").strip()
    names = command_variables(text)
    if not isinstance(values, dict):
        values = {}
    replacements = {}
    for name in names:
        value = str(values.get(name, "")).strip()
        if not value:
            raise ValueError(f"请填写变量：{name}")
        if not SAFE_TEMPLATE_VALUE.fullmatch(value):
            raise ValueError(f"变量 {name} 只能包含字母、数字、点、下划线、短横线、冒号、斜杠、@、=、+ 或逗号")
        replacements[name] = value
    def replace(match: re.Match) -> str:
        return replacements[match.group(1) or match.group(2)]
    resolved = TEMPLATE_VARIABLE.sub(replace, text)
    # 未被识别的 < 或 > 可能是重定向；通用页不接受这类设备端 shell 语义。
    if "<" in resolved or ">" in resolved:
        raise ValueError("命令模板中的 < 或 > 仅可用于变量占位符，例如 {{package}} 或 <package>")
    return resolved

def device_shell_args(value):
    """将设备端命令整体传给 adb shell sh -c，主机不解释管道与 grep。"""
    text = str(value or "").strip()
    if not text: raise ValueError("请输入 Android 设备端命令，例如：pm list packages -3")
    if text.startswith("adb"):
        raise ValueError("这里仅填写 Android 设备端命令；不要写 adb 前缀")
    # 兼容已保存的旧方案：旧页面曾要求 shell 前缀；现在统一由工具补外层 shell。
    if text.startswith("shell "):
        text = text[len("shell " ):].lstrip()
    if re.search(r"(?:^|\s)logcat(?:\s|$)", text) and not re.search(r"(?:^|\s)-d(?:\s|$)", text):
        raise ValueError("自定义命令页只支持一次性 logcat；请添加 -d，实时日志请使用实时日志页")
    # adb shell 会在设备端重组参数；sh -c 的脚本必须额外整体引号，
    # 才能确保 dumpsys/pm 与管道完整传给 Android shell。
    quoted_script = "'" + text.replace("'", "'\"'\"'") + "'"
    return ["shell", "sh", "-c", quoted_script]

def command_timeout(value):
    try: timeout = int(value)
    except (TypeError, ValueError): raise ValueError("超时必须是整数秒")
    if not COMMAND_TIMEOUT_MIN <= timeout <= COMMAND_TIMEOUT_MAX:
        raise ValueError(f"超时范围为 {COMMAND_TIMEOUT_MIN}-{COMMAND_TIMEOUT_MAX} 秒")
    return timeout

def is_risky_command(args):
    """危险命令不阻止，但调用方必须明确二次确认。"""
    script = args[3].strip("'\"") if tuple(args[:3]) == ("shell", "sh", "-c") and len(args) > 3 else ""
    risky = re.compile(r"(?:^|[;&|\s])(rm|setprop|reboot|pm\s+(?:uninstall|clear|disable)|wm\s+(?:size|density)|settings\s+(?:put|delete)|am\s+(?:force-stop|broadcast))(?:[;&|\s]|$)")
    return bool(risky.search(script))

def run_adb_command(settings, body):
    """执行用户保存或临时输入的 ADB 参数数组，所有调用均保持 shell=False。"""
    template = body.get("command", "")
    resolved = command_template(template, body.get("variables", {}))
    args, timeout = device_shell_args(resolved), command_timeout(body.get("timeout_seconds", 30))
    risky = is_risky_command(args)
    if risky and not body.get("confirmed"):
        return {"requires_confirmation": True, "risky": True, "command": ["adb", "-s", settings["_selected_adb_serial"], *args], "message": "该命令可能修改设备状态，请确认后执行"}
    started = time.monotonic(); code, output, error = android.device_adb(settings, *args, timeout=timeout); elapsed = round(time.monotonic() - started, 3)
    return {"requires_confirmation": False, "risky": risky, "ok": code == 0, "exit_code": code, "stdout": output, "stderr": error, "elapsed_seconds": elapsed, "command": ["adb", "-s", settings["_selected_adb_serial"], *args]}

def package_version(package_dump: str) -> dict[str, str]:
    """从 dumpsys package 输出中提取面向用户和系统内部版本号。"""
    name_match = PACKAGE_VERSION_NAME.search(package_dump or "")
    code_match = PACKAGE_VERSION_CODE.search(package_dump or "")
    version_name = name_match.group(1).strip() if name_match else ""
    if version_name.lower() == "null":
        version_name = ""
    return {
        "version_name": version_name,
        "version_code": code_match.group(1) if code_match else "",
    }


def processes(settings):
    """按全局包名关键字列应用；刷新阶段只执行包列表和进程列表查询。"""
    keywords=settings.get("process_package_keywords",[])
    _,packages,error=android.device_adb(settings,"shell","pm","list","packages")
    if error: raise ValueError(error)
    _,ps,_=android.device_adb(settings,"shell","ps","-A"); result=[]
    for package in [x.removeprefix("package:") for x in packages.splitlines() if any(k.lower() in x.lower() for k in keywords)]:
        row=next((x for x in ps.splitlines()[1:] if x.split() and (x.split()[-1]==package or x.split()[-1].startswith(package+":"))),None)
        result.append({"package":package,"pid":row.split()[1] if row and len(row.split())>1 else None,"running":bool(row),"signature":"","signature_status":"not_checked","version_name":"","version_code":"","launch_configured":package in launch_configs(settings)})
    return result

def installed_apk_certificate_sha256(settings, package):
    """临时 Pull 已安装包的 base.apk，并复用 apksigner 解析证书 SHA-256。"""
    if not package or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._" for char in package):
        raise ValueError("非法包名")
    code,output,error=android.device_adb(settings,"shell","pm","path",package,timeout=30)
    if code: raise ValueError(error or output or f"无法读取 {package} 的 APK 路径")
    paths=[line[len("package:"):].strip() for line in output.splitlines() if line.strip().startswith("package:") and line.strip()[len("package:"):].strip().startswith("/") and line.strip()[len("package:"):].strip().endswith(".apk")]
    if not paths: raise ValueError(f"未找到 {package} 的已安装 APK 路径")
    base=next((path for path in paths if path.rsplit("/",1)[-1]=="base.apk"),paths[0])
    with tempfile.TemporaryDirectory(prefix="glacien-cert-") as temporary:
        local=Path(temporary)/"base.apk"
        code,pull_output,pull_error=android.device_adb(settings,"pull",base,str(local),timeout=300)
        if code: raise ValueError(pull_error or pull_output or f"Pull APK 失败：{base}")
        certificate_result=artifacts.certificate_info(settings,local)
    return {"package":package,"apk_path":base,**certificate_result}

def stop(settings, package):
    if not package or any(x not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._" for x in package): raise ValueError("非法包名")
    code,out,error=android.device_adb(settings,"shell","am","force-stop",package); return {"ok":code==0,"output":out or error}

def uninstall(settings, package, confirmed=False):
    """卸载设备应用是破坏性操作，后端必须要求前端二次确认。"""
    if not package or any(x not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._" for x in package):
        raise ValueError("非法包名")
    if not confirmed:
        return {"requires_confirmation": True, "package": package, "message": "卸载会删除设备上的应用及其数据"}
    code, out, error = android.device_adb(settings, "uninstall", package, timeout=60)
    return {"requires_confirmation": False, "ok": code == 0, "output": out or error, "package": package}

def launch_configs(settings):
    """返回包名到启动入口的映射；入口由用户在 settings 中显式配置。"""
    launches = settings.get("app_launches", {})
    if not isinstance(launches, dict):
        return {}
    return {
        package: config
        for package, config in launches.items()
        if isinstance(config, dict) and str(config.get("command", "")).strip()
    }

def _launch_args(command):
    """解析受限的设备端拉起命令，不经宿主机 Shell 执行。"""
    text = str(command or "").strip()
    if not text:
        raise ValueError("拉起命令不能为空")
    if "\n" in text or "\r" in text:
        raise ValueError("拉起命令不能包含换行")
    try:
        args = shlex.split(text, posix=True)
    except ValueError as error:
        raise ValueError(f"拉起命令格式无效：{error}") from error
    if len(args) < 2 or args[:2] not in (["am", "start"], ["am", "start-activity"]):
        raise ValueError("拉起命令必须以 am start 或 am start-activity 开头")
    blocked = {";", "&&", "||", "|", "&", ">", ">>", "<", "<<"}
    if any(arg in blocked or "`" in arg or "$(" in arg for arg in args):
        raise ValueError("拉起命令不能包含 Shell 管道、重定向或命令替换")
    return args

def launch(settings, package):
    """执行用户为该包显式保存的受限 `am start` 设备端命令。"""
    config = launch_configs(settings).get(package)
    if not isinstance(config, dict):
        raise ValueError(f"未配置 {package} 的拉起命令")
    # adb shell 最终仍由设备端 Shell 解释；逐参数引用后作为单条命令传入，避免参数中的特殊字符变成额外命令。
    args = ["shell", shlex.join(_launch_args(config.get("command")))]
    code, output, error = android.device_adb(settings, *args, timeout=30)
    return {"ok": code == 0, "output": output or error, "command": ["adb", "-s", settings["_selected_adb_serial"], *args]}

def broadcasts(settings):
    """返回当前配置文件中的广播预设。"""
    return settings.get("broadcasts", {})

def send_broadcast(settings, body):
    """以参数数组调用 am broadcast，避免把用户输入拼成 shell 命令。"""
    action = str(body.get("action", "")).strip()
    package = str(body.get("package", "")).strip()
    if not action: raise ValueError("广播 Action 不能为空")
    args = ["shell", "am", "broadcast", "-a", action]
    if package: args.extend(["-p", package])
    for item in body.get("extras", []):
        key, value, value_type = str(item.get("key", "")).strip(), str(item.get("value", "")), item.get("type", "string")
        if not key: raise ValueError("Extra 的 key 不能为空")
        option = {"string": "--es", "int": "--ei", "long": "--el", "bool": "--ez", "float": "--ef"}.get(value_type)
        if not option: raise ValueError(f"不支持的 Extra 类型：{value_type}")
        if value_type in {"int", "long"}:
            try: int(value)
            except ValueError: raise ValueError(f"{key} 必须是整数")
        if value_type == "float":
            try: float(value)
            except ValueError: raise ValueError(f"{key} 必须是小数")
        if value_type == "bool" and value.lower() not in {"true", "false"}: raise ValueError(f"{key} 必须是 true 或 false")
        args.extend([option, key, value])
    code, output, error = android.device_adb(settings, *args, timeout=30)
    return {"ok": code == 0, "output": output or error, "command": ["adb", "-s", settings["_selected_adb_serial"], *args]}

def log_filters(settings):
    """读取声明式日志规则，替代在配置中执行任意 shell pipeline。"""
    return settings.get("log_filters", {})

def normalize_log_filter(rule):
    """统一新旧实时日志条件；连续条件之间始终为 AND。"""
    if not isinstance(rule, dict): raise ValueError("日志规则格式无效")
    modes={"include_any","include_all","exclude_any"}; filters=[]; terms_count=0
    raw_filters=rule.get("filters")
    if raw_filters is None:
        raw_filters=[]
        for mode in ("include_any","include_all"):
            terms=rule.get(mode,[])
            if terms: raw_filters.append({"mode":mode,"terms":terms})
    if not isinstance(raw_filters,list): raise ValueError("日志规则 filters 必须是数组")
    for item in raw_filters:
        if not isinstance(item,dict) or item.get("mode") not in modes: raise ValueError("日志规则包含不支持的筛选方式")
        terms=list(dict.fromkeys(str(term).strip() for term in item.get("terms",[]) if str(term).strip()))
        if not terms: continue
        terms_count+=len(terms);filters.append({"mode":item["mode"],"terms":terms})
    process_name=str(rule.get("process_name","") or "").strip()
    if process_name and not PROCESS_NAME.fullmatch(process_name): raise ValueError("进程名格式无效，请填写完整进程名，例如 com.example.app:service")
    if not filters: raise ValueError("日志规则必须至少包含一个整体过滤关键词")
    if len(filters)>30 or terms_count>100: raise ValueError("日志规则最多支持 30 条条件和 100 个关键词")
    return {**rule,"filters":filters,"process_name":process_name}

def saved_log_filter(settings, name):
    """实时 Logcat 只能运行已保存规则，禁止无筛选全量流拖慢浏览器。"""
    clean_name = str(name or "").strip()
    if not clean_name:
        raise ValueError("请先选择并保存日志规则，再启动实时日志")
    rule = log_filters(settings).get(clean_name)
    if not isinstance(rule, dict):
        raise ValueError("所选日志规则不存在，请刷新后重新选择")
    return normalize_log_filter(rule)


def log_session_filter(settings, name, process_name=None):
    """为单次监听叠加进程筛选，不要求把运行参数写入分析方案。"""
    rule = saved_log_filter(settings, name)
    if process_name is None:
        return rule
    return normalize_log_filter({**rule, "process_name": str(process_name or "").strip()})


def selected_filter(settings, name):
    """兼容调用点名称；不再接受临时关键词或空规则。"""
    return saved_log_filter(settings, name)

def term_matches(term: str, target: str) -> bool:
    """关键词匹配：* 匹配任意字符序列（含空），其余字符按字面量子串匹配。"""
    parts = term.lower().split("*")
    if len(parts) == 1:
        return term.lower() in target
    pos = 0
    for i, part in enumerate(parts):
        if not part:
            continue
        idx = target.find(part, pos)
        if idx < 0:
            return False
        if i == 0 and not term.startswith("*") and idx != 0:
            return False
        pos = idx + len(part)
    if not term.endswith("*") and pos < len(target):
        last = parts[-1]
        if last:
            end = target.rfind(last)
            if end + len(last) != len(target):
                return False
    return True

def process_pids(settings, process_name):
    """按 ps 的 NAME 列精确解析目标进程；支持主进程和冒号子进程名。"""
    name=str(process_name or "").strip()
    if not name: return []
    if not PROCESS_NAME.fullmatch(name): raise ValueError("进程名格式无效，请填写完整进程名，例如 com.example.app:service")
    code,output,error=android.device_adb(settings,"shell","ps","-A")
    if code: raise ValueError(error or "读取设备进程失败")
    lines=output.splitlines()
    if not lines: raise ValueError("设备进程列表为空")
    header=lines[0].split()
    try: pid_index=header.index("PID")
    except ValueError: pid_index=1
    pids=[]
    for line in lines[1:]:
        columns=line.split()
        if len(columns)>pid_index and columns[-1]==name and columns[pid_index].isdigit(): pids.append(int(columns[pid_index]))
    if not pids: raise ValueError(f"目标进程未运行：{name}")
    return sorted(set(pids))

def resolve_log_process(settings, rule):
    name=str(rule.get("process_name","") or "").strip()
    return {"name":name,"pids":process_pids(settings,name) if name else []}

def log_line_pid(line):
    match=THREADTIME_PID.match(line)
    return int(match.group(1)) if match else None

def matches(line, rule, process_ids=None):
    """连续实时筛选条件与离线日志语义一致：条件之间为 AND。"""
    if process_ids is not None and log_line_pid(line) not in process_ids: return False
    target=line.lower()
    filters=rule.get("filters") if isinstance(rule,dict) else None
    if not isinstance(filters,list): filters=normalize_log_filter(rule)["filters"]
    for filter_data in filters:
        terms=filter_data["terms"]
        if filter_data["mode"]=="include_all" and not all(term_matches(t,target) for t in terms): return False
        if filter_data["mode"]=="include_any" and not any(term_matches(t,target) for t in terms): return False
        if filter_data["mode"]=="exclude_any" and any(term_matches(t,target) for t in terms): return False
    return True

def logcat(settings):
    """返回实时 logcat 子进程；由 HTTP SSE 客户端断开时关闭。"""
    executable=android.tool("adb",settings)
    if not executable: raise ValueError("未找到 adb")
    # errors=replace 与缓冲区读取保持一致，单条坏日志不能中断整条 SSE 流。
    serial=str(settings.get("_selected_adb_serial", "")).strip()
    if not serial: raise ValueError("缺少已选择的 ADB 设备，请先在 ADB 首页选择设备")
    return proc.Popen([executable,"-s",serial,"logcat","-v","threadtime"],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding="utf-8",errors="replace",bufsize=1)

def buffer(settings):
    """读取当前 Logcat 缓冲区，供新会话回放和导出使用。"""
    code, output, error = android.device_adb(settings, "logcat", "-d", "-v", "threadtime", timeout=60)
    if code: raise ValueError(error or "读取 Logcat 缓冲区失败")
    return output.splitlines()

def clear_logcat(settings):
    """清空当前所选设备的全部 Logcat 环形缓冲区。"""
    code, output, error = android.device_adb(settings, "logcat", "-b", "all", "-c", timeout=30)
    if code: raise ValueError(error or output or "清空设备 Logcat 缓冲区失败")
    return {"ok": True, "message": "设备 Logcat 缓冲区已清空"}

def export(settings, preset, process_name=None):
    """只导出已保存规则命中的 Logcat，避免“全部日志”造成无意义的大文件。"""
    rule = log_session_filter(settings, preset, process_name)
    process=resolve_log_process(settings,rule);process_ids=set(process["pids"]) if process["name"] else None
    lines = buffer(settings)
    lines = [line for line in lines if matches(line, rule, process_ids)]
    folder = storage.data_dir("live_logs", "exports")
    # 文件名仅保留跨平台安全字符；筛选导出附带规则名便于检索。
    rule_name = re.sub(r"[^\w.-]+", "_", preset, flags=re.UNICODE).strip("_.") or "custom"
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = folder / f"logcat_filtered_{rule_name}_{stamp}.log"
    header = ["# Glacien Workbench Logcat export: saved rule", f"# Rule: {rule}", ""]
    path.write_text("\n".join(header + lines) + "\n", encoding="utf-8")
    return {"path": str(path), "lines": len(lines), "preset": preset}
