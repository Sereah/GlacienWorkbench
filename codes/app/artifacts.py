"""APK、签名和资源包等本地产物相关业务。

所有前端传入的文件路径都必须重新与固定 target/ 目录扫描结果比对，
避免 HTTP 参数被篡改后读取、删除或签名任意本地文件。
"""
import hashlib, os, re, shutil, tarfile, threading
from datetime import datetime
from pathlib import Path, PurePosixPath
from . import android
from . import config, storage
from .config import ROOT

KEYSTORE_SUFFIXES = {".jks", ".keystore"}
CERT_SHA256_LINE = re.compile(r"^Signer #(\d+) certificate SHA-256 digest:\s*([0-9a-fA-F]{64})$")
CERT_DN_LINE = re.compile(r"^Signer #(\d+) certificate DN:\s*(.*)$")
APK_SIGNATURE_MIN_SDKS = (24, 28, 33)
APK_PACKAGE_LINE = re.compile(r"^package:\s+name='([^']+)'")
INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
WINDOWS_RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL", *(f"COM{index}" for index in range(1, 10)), *(f"LPT{index}" for index in range(1, 10))}
_ARTIFACT_LOCK = threading.RLock()

def target():
    """APK 文件位于 APK Center 自己的用户数据目录。"""
    return config.TARGET_ROOT

def resource_target():
    """资源包位于资源部署功能自己的用户数据目录。"""
    return config.RESOURCE_ROOT
def details(path):
    stat = path.stat(); return {"name":path.name,"path":str(path),"size":stat.st_size,"modified":datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds")}
def file_digest(path, algorithm):
    """分块计算本地文件摘要，避免大 APK 整体载入内存。"""
    digest=hashlib.new(algorithm)
    with path.open("rb") as stream:
        for block in iter(lambda:stream.read(1024*1024),b""): digest.update(block)
    return digest.hexdigest()
def md5(path): return file_digest(path,"md5")
def sha256(path): return file_digest(path,"sha256")

def apk_package_name(settings, path):
    """读取 APK Manifest 真实包名；工具缺失或解析失败时不阻断 APK 列表。"""
    aapt=android.tool("aapt",settings)
    if not aapt: return ""
    code,output,_=android.run([aapt,"dump","badging",str(path)],60)
    if code or not output: return ""
    match=APK_PACKAGE_LINE.match(output.splitlines()[0].strip())
    return match.group(1) if match and re.fullmatch(r"[A-Za-z0-9._]+",match.group(1)) else ""

def _parse_certificates(output):
    """解析 apksigner 的 signer 输出，兼容单签名与多签名 APK。"""
    values={}
    for line in output.splitlines():
        line=line.strip();digest_match=CERT_SHA256_LINE.match(line);dn_match=CERT_DN_LINE.match(line)
        if digest_match: values.setdefault(int(digest_match.group(1)),{})["sha256"]=digest_match.group(2).lower()
        elif dn_match: values.setdefault(int(dn_match.group(1)),{})["dn"]=dn_match.group(2).strip()
    return [{"signer":index,"sha256":item["sha256"],"dn":item.get("dn","")} for index,item in sorted(values.items()) if item.get("sha256")]

def certificate_info(settings, path):
    """验证 APK 签名并提取证书；兼容仅使用 v2/v3/v3.1 的 APK。"""
    signer=android.tool("apksigner",settings)
    if not signer: raise ValueError("未找到 apksigner，请配置 Android SDK Build-Tools")
    base_args=[signer,"verify","--verbose","--print-certs"]
    code,output,error=android.run([*base_args,str(path)],180)
    if code==0:
        certificates=_parse_certificates(output)
        if certificates: return {"certificates":certificates,"fully_verified":True,"warning":""}
    strict_error=error or output or "APK 签名验证失败"
    for min_sdk in APK_SIGNATURE_MIN_SDKS:
        fallback_code,fallback_output,_=android.run([*base_args,"--min-sdk-version",str(min_sdk),str(path)],180)
        certificates=_parse_certificates(fallback_output)
        if fallback_code==0 and certificates:
            warning=f"证书签名可在 Android API {min_sdk} 及以上验证，但不覆盖 APK 声明支持的全部旧系统：{strict_error}"
            return {"certificates":certificates,"fully_verified":False,"verified_min_sdk":min_sdk,"warning":warning}
    raise ValueError(strict_error)

def certificate_sha256(settings, path):
    """保留证书列表接口，供只关心指纹的内部调用使用。"""
    return certificate_info(settings,path)["certificates"]

def apks(settings):
    folder=target(); suffixes=[Path(item["name"]).stem for item in keystore_files(settings)]
    return [{**details(item),"package_name":apk_package_name(settings,item),"signed_with":next((x for x in suffixes if item.stem.endswith(f"-{x}")),None)} for item in sorted(folder.glob("*.apk"),key=lambda x:x.stat().st_mtime,reverse=True)] if folder.is_dir() else []

def apk_source_roots(settings):
    """解析当前配置允许扫描的 APK 来源；浏览器只能引用来源名称。"""
    configured=settings.get("apk_sources",{})
    if not isinstance(configured,dict): raise ValueError("apk_sources 必须是对象")
    result={}
    for raw_name,raw_path in configured.items():
        name=str(raw_name).strip(); raw=Path(str(raw_path)).expanduser()
        if not name or not str(raw_path).strip(): raise ValueError("APK 来源名称和目录不能为空")
        if not raw.is_absolute(): raise ValueError(f"APK 来源必须使用绝对目录：{name}")
        path=raw.resolve()
        result[name]=path
    return result

def source_apks(settings):
    """递归扫描已配置目录，并标记每个来源最新修改的 APK。"""
    result=[]
    for name,root in apk_source_roots(settings).items():
        items=[]
        if root.is_dir() and not root.is_symlink():
            for item in root.rglob("*.apk"):
                resolved=item.resolve()
                if item.is_file() and not item.is_symlink() and (resolved==root or root in resolved.parents):
                    items.append({**details(item),"source":name,"relative_path":item.relative_to(root).as_posix()})
            items.sort(key=lambda value:value["modified"],reverse=True)
        for index,item in enumerate(items): item["latest"]=index==0
        result.append({"name":name,"path":str(root),"available":root.is_dir() and not root.is_symlink(),"apks":items})
    return result

def source_apk(settings, source_name, relative_path):
    """从重新扫描得到的来源白名单中解析一个 APK，拒绝任意本机路径。"""
    roots=apk_source_roots(settings); root=roots.get(str(source_name))
    if root is None or not root.is_dir() or root.is_symlink(): raise ValueError(f"APK 来源不可用：{source_name}")
    relative=Path(str(relative_path or ""))
    if relative.is_absolute() or ".." in relative.parts: raise ValueError("APK 来源相对路径无效")
    item=(root/relative).resolve()
    if root not in item.parents or not item.is_file() or item.is_symlink() or item.suffix.lower()!=".apk": raise ValueError("APK 不属于已配置来源目录")
    return item

def collect_apks(settings, body):
    """将选中的来源 APK 批量复制到当前目标；覆盖必须由用户显式确认。"""
    selected=body.get("files",[])
    if not isinstance(selected,list) or not selected: raise ValueError("请选择要导入的 APK")
    files=[source_apk(settings,item.get("source",""),item.get("relative_path","")) for item in selected if isinstance(item,dict)]
    if len(files)!=len(selected): raise ValueError("APK 来源选择格式无效")
    names=[item.name for item in files]
    if len(names)!=len(set(names)): raise ValueError("所选来源中存在同名 APK，请只保留其中一个")
    destination=target(); destination.mkdir(parents=True,exist_ok=True)
    conflicts=[name for name in names if (destination/name).exists()]
    if conflicts and not body.get("overwrite"): return {"requires_confirmation":True,"conflicts":conflicts}
    results=[]
    for source in files:
        output=destination/source.name; shutil.copy2(source,output); results.append({"file":source.name,"path":str(output),"ok":True})
    return {"requires_confirmation":False,"results":results}

def managed_apk(settings, body):
    """返回固定 target/ 白名单内 APK；用于安装、签名、删除和摘要检查。"""
    folder=target(); allowed={str(x.resolve()):x for x in folder.glob("*.apk")}
    item=allowed.get(str(Path(body.get("file","")).resolve()))
    if not item: raise ValueError("文件不属于用户数据目录的 target/")
    return item

def renamed_filename(value, suffix, label):
    """生成跨平台安全文件名；前端只编辑主名称，扩展名由后端固定。"""
    stem=str(value or "").strip()
    if stem.lower().endswith(suffix.lower()): stem=stem[:-len(suffix)].rstrip()
    if not stem or stem in {".", ".."}: raise ValueError(f"{label}名称不能为空")
    if INVALID_FILENAME_CHARS.search(stem) or stem.endswith((".", " ")):
        raise ValueError(f"{label}名称包含系统不支持的字符")
    if stem.split(".",1)[0].upper() in WINDOWS_RESERVED_NAMES:
        raise ValueError(f"{label}名称不能使用系统保留名称")
    filename=stem+suffix
    if len(filename.encode("utf-8"))>255: raise ValueError(f"{label}名称过长")
    return filename

def rename_managed_file(source, name, suffix, label):
    if source.is_symlink() or not source.is_file(): raise ValueError(f"{label}不是可重命名的普通文件")
    filename=renamed_filename(name,suffix,label);destination=source.with_name(filename)
    if destination==source: raise ValueError("新文件名与原文件名相同")
    if destination.exists() or destination.is_symlink(): raise ValueError(f"文件已存在：{filename}")
    source.rename(destination)
    return destination

def apk_idsig(apk):
    """返回 APK v4 签名的同目录 sidecar 路径。"""
    return apk.with_name(apk.name+".idsig")

def rename_apk(settings, body):
    """只允许在 APK Center 受管目录内原子重命名，不覆盖已有文件。"""
    with _ARTIFACT_LOCK:
        source=managed_apk(settings,body)
        source_idsig=apk_idsig(source);filename=renamed_filename(body.get("name",""),".apk","APK");output_idsig=source.with_name(filename+".idsig")
        if source_idsig.is_symlink(): raise ValueError("APK 签名旁路文件不是可重命名的普通文件")
        if source_idsig.is_file() and (output_idsig.exists() or output_idsig.is_symlink()): raise ValueError(f"文件已存在：{output_idsig.name}")
        output=rename_managed_file(source,filename,".apk","APK")
        try:
            if source_idsig.is_file(): source_idsig.rename(output_idsig)
        except Exception:
            output.rename(source)
            raise
    suffixes=[Path(item["name"]).stem for item in keystore_files(settings)]
    signed_with=next((name for name in suffixes if output.stem.endswith(f"-{name}")),None)
    return {"ok":True,"file":{**details(output),"signed_with":signed_with},"old_name":source.name}

INSTALL_OPTION_FLAGS = {
    "replace": "-r",
    "downgrade": "-d",
    "grant_permissions": "-g",
    "test_only": "-t",
}

def install_options(value):
    """安装参数使用固定白名单，不允许浏览器传入任意 ADB 选项。"""
    if value is None:
        value = {}
    if not isinstance(value, dict) or set(value)-set(INSTALL_OPTION_FLAGS):
        raise ValueError("APK 安装选项无效")
    options = {"replace": True, "downgrade": False, "grant_permissions": False, "test_only": False}
    for name, enabled in value.items():
        if not isinstance(enabled, bool):
            raise ValueError(f"APK 安装选项 {name} 必须是布尔值")
        options[name] = enabled
    if options["downgrade"] and not options["replace"]:
        raise ValueError("允许版本降级时必须同时允许覆盖已有应用")
    return options

def install(settings, body):
    files=body.get("files",[])
    if not isinstance(files,list) or not files:
        raise ValueError("请选择要安装的 APK")
    user_ids,catalog=android.validated_user_ids(settings,body.get("user_ids"))
    options=install_options(body.get("options"));flags=[flag for name,flag in INSTALL_OPTION_FLAGS.items() if options[name]];results=[]
    for raw in files:
        try:
            item=managed_apk(settings,{**body,"file":raw});package_name=apk_package_name(settings,item)
        except ValueError as error:
            results.extend({"file":str(raw),"package_name":"","user_id":user_id,"ok":False,"output":str(error)} for user_id in user_ids)
            continue
        first_ok=False
        for index,user_id in enumerate(user_ids):
            if index and not options["replace"] and first_ok and package_name:
                code,out,error=android.device_adb(settings,"shell","pm","install-existing","--user",str(user_id),"--wait",package_name,timeout=60)
            else:
                code,out,error=android.device_adb(settings,"install",*flags,"--user",str(user_id),str(item),timeout=180)
            ok=code==0;first_ok=first_ok or(index==0 and ok)
            results.append({"file":item.name,"package_name":package_name,"user_id":user_id,"ok":ok,"output":out or error})
    return {"users":catalog["items"],"options":options,"results":results}

def apk_push_directory(value):
    """校验设备端 APK 目录；目录末级名称将用于生成目标 APK 文件名。"""
    raw=str(value or "").strip()
    if not raw.startswith("/") or any(ord(char) in (0,10,13) for char in raw):
        raise ValueError("APK Push 路径必须是设备端绝对目录")
    segments=raw.split("/")[1:]
    if not segments or any(segment in (".","..") for segment in segments):
        raise ValueError("APK Push 路径不能包含 . 或 ..")
    directory=PurePosixPath(raw)
    name=directory.name
    if not name or not re.fullmatch(r"[A-Za-z0-9._-]+",name):
        raise ValueError("APK Push 目录末级名称只能包含字母、数字、点、下划线或短横线")
    return str(directory), name if name.lower().endswith(".apk") else f"{name}.apk"

def push_apk(settings, body):
    """将当前目标白名单内的单个 APK 推送并按设备目录名重命名。"""
    item=managed_apk(settings,body)
    package_name=apk_package_name(settings,item)
    directory,filename=apk_push_directory(body.get("device_path",""))
    remote=str(PurePosixPath(directory)/filename)
    code,out,error=android.device_adb(settings,"shell","mkdir","-p",directory)
    if code==0: code,out,error=android.device_adb(settings,"push",str(item),remote,timeout=180)
    if code:
        return {"ok":False,"push_ok":False,"file":item.name,"package_name":package_name,"remote_path":remote,"output":out or error}
    reboot=None
    if body.get("reboot"): reboot=android.reboot_device(settings)
    return {"ok":not reboot or reboot.get("ok",False),"push_ok":True,"file":item.name,"package_name":package_name,"remote_path":remote,"output":out or "Push 完成","reboot":reboot}

def delete(settings, body):
    item=managed_apk(settings,body);sidecar=apk_idsig(item);item.unlink();sidecar_deleted=False
    if sidecar.exists() or sidecar.is_symlink(): sidecar.unlink();sidecar_deleted=True
    return {"ok":True,"file":item.name,"idsig_deleted":sidecar_deleted}
def checksum(settings, body):
    item=managed_apk(settings,body); return {"file":item.name,"md5":md5(item)}
def sha256_checksum(settings, body):
    item=managed_apk(settings,body); return {"file":item.name,"sha256":sha256(item)}
def certificate_checksum(settings, body):
    item=managed_apk(settings,body); return {"file":item.name,**certificate_info(settings,item)}

def upload_apk(settings, filename, content):
    """通过 Web 上传 APK 到固定 target/ 目录。"""
    if not filename or Path(filename).name != filename or not filename.lower().endswith(".apk"):
        raise ValueError("只允许上传 .apk 文件")
    folder = target()
    folder.mkdir(parents=True, exist_ok=True)
    output = folder / filename
    if output.exists():
        raise ValueError(f"APK 已存在：{filename}；请先在 Web 页面删除或改名后上传")
    output.write_bytes(content)
    return details(output)

def keystores(settings):
    return [{"name": item["name"], "path": item["path"], "alias": "", "available": True} for item in keystore_files(settings)]

def managed_keystore_path(filename):
    """仅管理 keystore/ 顶层签名文件，禁止浏览器构造任意本机路径。"""
    name = str(filename or "").strip()
    if not name or Path(name).name != name or Path(name).suffix.lower() not in KEYSTORE_SUFFIXES:
        raise ValueError("只允许上传或删除 .jks、.keystore 签名文件")
    root = config.KEYSTORE_ROOT
    if root.is_symlink():
        raise ValueError("keystore 根目录不能是符号链接")
    output = root / name
    if output.parent != root:
        raise ValueError("签名文件必须位于 keystore/ 目录")
    return output

def keystore_files(settings):
    root = config.KEYSTORE_ROOT
    if root.is_symlink():
        raise ValueError("keystore 根目录不能是符号链接")
    if not root.is_dir():
        return []
    result = []
    for item in sorted(root.iterdir(), key=lambda value: value.name.lower()):
        if not item.is_file() or item.is_symlink() or item.suffix.lower() not in KEYSTORE_SUFFIXES:
            continue
        result.append({**details(item), "path": str(item.relative_to(ROOT))})
    return result

def upload_keystore(settings, filename, content):
    output = managed_keystore_path(filename)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise ValueError(f"签名文件已存在：{output.name}；请先在 Web 页面删除或改名后上传")
    output.write_bytes(content)
    return {**details(output), "path": str(output.relative_to(ROOT))}

def delete_keystore_file(settings, body):
    output = managed_keystore_path(body.get("file", ""))
    if not output.exists():
        raise ValueError("签名文件不存在")
    if output.is_symlink() or not output.is_file():
        raise ValueError("签名文件不是可删除的普通文件")
    output.unlink()
    return {"ok": True, "file": output.name}

def sign(settings,body):
    """直接选择受管签名文件签名；alias 仅在多 key 文件时按需填写。"""
    filename=str(body.get("keystore","")).strip(); jks=managed_keystore_path(filename)
    signer=android.tool("apksigner",settings); store=str(body.get("store_password","")); key=str(body.get("key_password","")); alias=str(body.get("alias","")).strip()
    if not signer or not jks.is_file() or not store or not key: raise ValueError("apksigner、签名文件或本次输入的密码不完整")
    name=Path(filename).stem
    aligner=android.tool("zipalign",settings); results=[]
    for raw in body.get("files",[]):
        try:
            source=managed_apk(settings,{**body,"file":raw}); output=source.with_name(f"{source.stem}-{name}.apk"); signing_input=source; temporary=None;output_existed=output.exists();sign_succeeded=False
            try:
                if aligner:
                    temporary=output.with_suffix(".aligned.tmp"); align_code,_,_=android.run([aligner,"-f","-p","4",str(source),str(temporary)],180)
                    if align_code==0: signing_input=temporary
                command=[signer,"sign","--v4-signing-enabled","false","--ks",str(jks),"--ks-pass",f"pass:{store}","--key-pass",f"pass:{key}","--out",str(output)]
                if alias: command.extend(["--ks-key-alias",alias])
                command.append(str(signing_input))
                code,out,error=android.run(command,180)
                sign_succeeded=code==0
            finally:
                if temporary and temporary.exists(): temporary.unlink()
                sidecar=apk_idsig(output)
                if sidecar.exists() or sidecar.is_symlink(): sidecar.unlink()
                if not sign_succeeded and not output_existed and output.exists(): output.unlink()
            results.append({"file":source.name,"ok":code==0,"output":str(output) if code==0 else(out or error)})
        except ValueError as error: results.append({"file":raw,"ok":False,"output":str(error)})
    return {"results":results}

def entries(archive):
    """获取资源包顶层项，并限制字符集以防拼入设备端删除命令时发生路径注入。"""
    with tarfile.open(archive,"r:gz") as bundle:
        names=[]
        for member in bundle.getmembers():
            name=member.name
            while name.startswith("./"): name=name[2:]
            if name and name!=".": names.append(name.split("/",1)[0])
        result=sorted(set(names))
    if any(not re.fullmatch(r"[A-Za-z0-9._-]+",x) for x in result): raise ValueError("资源包包含不安全的顶层路径")
    return result

def resources(settings):
    paths=settings.get("resource_device_paths",{})
    return [{**details(x),"cleanup_entries":entries(x),"device_path":str(paths.get(x.name,""))} for x in sorted(resource_target().glob("*.tar.gz"),key=lambda x:x.stat().st_mtime,reverse=True)]

def profile_resource(settings, body):
    """资源文件白名单，防止前端参数越过固定 target/ 目录。"""
    folder=resource_target()
    allowed={str(x.resolve()):x for x in folder.glob("*.tar.gz")}
    item=allowed.get(str(Path(body.get("file","")).resolve()))
    if not item: raise ValueError("文件不属于用户数据目录的 target/")
    return item

def resource_checksum(settings, body):
    item=profile_resource(settings,body); return {"file":item.name,"md5":md5(item)}

def delete_resource(settings, body):
    item=profile_resource(settings,body); item.unlink(); return {"ok":True,"file":item.name}

def rename_resource(settings, body):
    """重命名资源包并迁移以文件名为键的设备部署路径；配置失败时回滚文件名。"""
    with _ARTIFACT_LOCK:
        source=profile_resource(settings,body);old_name=source.name
        output=rename_managed_file(source,body.get("name",""),".tar.gz","资源包")
        paths=dict(settings.get("resource_device_paths",{}));device_path=paths.pop(old_name,"")
        if device_path:
            paths[output.name]=device_path
            try: storage.update("resources",{"resource_device_paths":paths})
            except Exception:
                output.rename(source)
                raise
    return {"ok":True,"file":{**details(output),"device_path":device_path},"old_name":old_name}

def upload_resource(settings, filename, content):
    """保存 Web 上传的资源包；只接受不带路径的 .tar.gz 文件名。"""
    if not filename or Path(filename).name!=filename or not filename.endswith(".tar.gz"):
        raise ValueError("只允许上传 .tar.gz 资源包")
    folder=resource_target(); folder.mkdir(parents=True,exist_ok=True)
    output=folder/filename; output.write_bytes(content); entries(output)
    return details(output)

def resource_device_directory(value):
    """资源清理是破坏性操作，只允许非根目录的设备绝对路径。"""
    raw=str(value or "").strip()
    if not raw.startswith("/") or any(ord(char) in (0,10,13) for char in raw):
        raise ValueError("资源部署路径必须是设备端绝对目录")
    if raw == "/" or any(part in {".",".."} for part in raw.split("/")):
        raise ValueError("资源部署路径不能是根目录，也不能包含 . 或 ..")
    return str(PurePosixPath(raw))

def push(settings,body):
    """
    按旧脚本语义部署资源：删除设备端同名顶层旧项 -> push -> 解压 -> 删除压缩包。
    这是破坏性操作；前端必须在调用前明确提示用户。
    """
    folder=resource_target(); allowed={str(x.resolve()):x for x in folder.glob("*.tar.gz")}; deployments=body.get("deployments",[])
    if not isinstance(deployments,list) or not deployments: raise ValueError("请选择资源包")
    results=[]
    for deployment in deployments:
        if not isinstance(deployment,dict): raise ValueError("资源部署参数无效")
        archive=allowed.get(str(Path(deployment.get("file","")).resolve()))
        if archive is None: raise ValueError("资源包不属于用户数据目录的 target/")
        device=resource_device_directory(deployment.get("device_path",""))
        archive_entries=entries(archive)
        remote_archive=f"{device.rstrip('/')}/{archive.name}"
        code,out,error=android.device_adb(settings,"shell","mkdir","-p",device)
        if code==0:
            # 设备端 rm 参数必须通过 ADB 参数数组传递，避免 sh -c 的二次解析丢失目标参数。
            for entry in archive_entries:
                code,out,error=android.device_adb(settings,"shell","rm","-rf",f"{device.rstrip('/')}/{entry}")
                if code: break
        if code==0: code,out,error=android.device_adb(settings,"push",str(archive),remote_archive,timeout=180)
        if code==0:
            # Toybox tar 要求先切换目标目录；归档路径仍使用绝对路径，避免相对路径解析错误。
            code,out,error=android.device_adb(settings,"shell","tar","-C",device,"-zxf",remote_archive,timeout=180)
        if code==0:
            missing=[]
            for entry in archive_entries:
                exists,_,_=android.device_adb(settings,"shell","test","-e",f"{device.rstrip('/')}/{entry}")
                if exists: missing.append(entry)
            if missing:
                code=1; out=""; error=f"解压不完整，缺少顶层资源：{', '.join(missing)}；已保留设备端压缩包"
        if code==0: code,out,error=android.device_adb(settings,"shell","rm","-f",remote_archive)
        results.append({"file":archive.name,"ok":code==0,"output":out or error})
    return {"results":results}
