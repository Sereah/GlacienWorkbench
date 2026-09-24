"""HTTP API、静态页面服务和应用启动。

本模块只负责编解码与路由；业务逻辑必须继续放在 android/artifacts/device/config 中。
"""
import json,mimetypes,platform,re,threading,time
from urllib.error import URLError
from urllib.request import urlopen
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs,urlparse
from . import android,app_window,artifacts,audio,captures,config,device,device_files,device_logs,logs,runtime,themes

# 前端是只读程序资源；settings、日志和产物由 config.ROOT 指向可写数据目录。
STATIC=runtime.resource_path("web").resolve()
class Server(ThreadingHTTPServer):
    allow_reuse_address=True
    daemon_threads=True

def existing_glacien_url(port):
    """确认指定端口是否已由 Glacien 占用，避免误复用其他本机服务。"""
    url=f"http://127.0.0.1:{port}"
    try:
        with urlopen(f"{url}/api/config",timeout=1) as response:
            payload=json.loads(response.read())
    except (OSError,URLError,json.JSONDecodeError):
        return None
    if not isinstance(payload,dict):
        return None
    meta=payload.get("_meta")
    if payload.get("port")!=port or not isinstance(meta,dict):
        return None
    if not meta.get("data_root") or not meta.get("app_config"):
        return None
    return url

def bind_server():
    """绑定配置端口；若已有 Glacien，则返回其 URL 供窗口复用。"""
    port=int(config.load().get("port",8765));url=f"http://127.0.0.1:{port}"
    try:
        return Server(("127.0.0.1",port),Handler),url
    except OSError as error:
        existing_url=existing_glacien_url(port)
        if existing_url:
            return None,existing_url
        raise OSError(f"端口 {port} 已被其他程序占用，请修改 Glacien 服务端口") from error

class Handler(BaseHTTPRequestHandler):
    """统一路由：业务放在 app 子模块，这里只负责 HTTP 编解码。"""
    def log_message(self,*args): pass
    def reply(self,data,status=200):
        body=json.dumps(data,ensure_ascii=False).encode();self.send_response(status);self.send_header("Content-Type","application/json; charset=utf-8");self.send_header("Content-Length",str(len(body)));self.end_headers();self.wfile.write(body)
    def body(self): return json.loads(self.rfile.read(int(self.headers.get("Content-Length","0"))) or b"{}")
    def file_reply(self,path):
        size=path.stat().st_size;start,end=0,size-1;status=200;header=self.headers.get("Range","")
        if header:
            match=re.fullmatch(r"bytes=(\d*)-(\d*)",header.strip())
            if not match: return self.reply({"error":"无效的 Range"},416)
            if match.group(1): start=int(match.group(1));end=int(match.group(2)) if match.group(2) else end
            elif match.group(2): start=max(0,size-int(match.group(2)))
            if start>min(end,size-1): return self.reply({"error":"Range 超出文件范围"},416)
            end=min(end,size-1);status=206
        length=end-start+1;self.send_response(status);self.send_header("Content-Type",mimetypes.guess_type(path.name)[0] or "application/octet-stream");self.send_header("Cache-Control","no-store");self.send_header("Accept-Ranges","bytes");self.send_header("Content-Length",str(length));
        if status==206:self.send_header("Content-Range",f"bytes {start}-{end}/{size}")
        self.end_headers();
        with path.open("rb") as stream:
            stream.seek(start);remaining=length
            while remaining:
                block=stream.read(min(1024*1024,remaining))
                if not block:break
                self.wfile.write(block);remaining-=len(block)
    def multipart(self):
        """解析浏览器上传的单个资源文件。"""
        import cgi
        form=cgi.FieldStorage(fp=self.rfile,headers=self.headers,environ={"REQUEST_METHOD":"POST","CONTENT_TYPE":self.headers.get("Content-Type","")})
        return form.getfirst("profile",""),form["file"].filename,form["file"].file.read()
    def device_file_upload(self):
        import cgi
        form=cgi.FieldStorage(fp=self.rfile,headers=self.headers,environ={"REQUEST_METHOD":"POST","CONTENT_TYPE":self.headers.get("Content-Type","")})
        if "file" not in form or not getattr(form["file"],"filename",""):
            raise ValueError("请选择要上传的文件")
        return form.getfirst("directory",""),form.getfirst("serial",""),form.getfirst("overwrite","") == "true",form.getfirst("relative_path",""),form["file"].filename,form["file"].file.read()
    def do_GET(self):
        parsed=urlparse(self.path);q=parse_qs(parsed.query);settings=config.load()
        try:
            route=parsed.path
            if route=="/api/status": return self.reply({"device":android.status(settings,q.get("serial",[""])[0]),"platform":platform.system(),"adb":bool(android.tool("adb",settings))})
            if route=="/api/adb/restart": return self.reply(android.restart_server(settings))
            if route=="/api/adb/wireless-suggestion": return self.reply(android.wireless_suggestion(settings,q.get("serial",[""])[0]))
            if route=="/api/config": return self.reply(config.payload(settings))
            if route=="/api/user-guide": return self.reply({"markdown":runtime.user_guide_markdown()})
            if route=="/api/themes": return self.reply(themes.catalog())
            if route=="/api/config/export": return self.reply(config.shareable_payload(settings))
            if route=="/api/apks": return self.reply(artifacts.apks(settings))
            if route=="/api/apk-sources": return self.reply(artifacts.source_apks(settings))
            if route=="/api/keystores": return self.reply(artifacts.keystores(settings))
            if route=="/api/keystore-files": return self.reply(artifacts.keystore_files(settings))
            if route=="/api/resources": return self.reply(artifacts.resources(settings))
            if route=="/api/processes": return self.reply(device.processes(android.selected_device_settings(settings,q.get("serial",[""])[0])))
            if route=="/api/log-filters": return self.reply(device.log_filters(settings))
            if route=="/api/log-process":
                selected=android.selected_device_settings(settings,q.get("serial",[""])[0])
                rule=device.saved_log_filter(settings,q.get("preset",[""])[0])
                return self.reply(device.resolve_log_process(selected,rule))
            if route=="/api/broadcasts": return self.reply(device.broadcasts(settings))
            if route=="/api/adb-commands": return self.reply(device.adb_commands(settings))
            if route=="/api/adb-commands/export": return self.reply(config.command_export())
            if route=="/api/offline-log-sources": return self.reply(logs.sources(settings))
            if route=="/api/offline-logs/status": return self.reply(logs.capability())
            if route=="/api/offline-logs/archives": return self.reply(logs.archive_status(settings,q.get("source",[""])[0]))
            if route=="/api/audio/status": return self.reply(audio.capability(settings))
            if route=="/api/audio/files": return self.reply(audio.files())
            if route=="/api/audio/preview": return self.file_reply(audio.resolve_preview(q.get("id",[""])[0]))
            if route=="/api/device-log-sources": return self.reply(device_logs.sources(settings))
            if route=="/api/captures/record/status": return self.reply(captures.recording_status())
            if route=="/api/captures/displays": return self.reply(captures.displays(android.selected_device_settings(settings,q.get("serial",[""])[0])))
            if route=="/api/captures/scrcpy/status": return self.reply(captures.scrcpy_status(settings))
            if route=="/api/captures/files": return self.reply(captures.files(q.get("kind",["all"])[0],q.get("offset",[0])[0],q.get("limit",[50])[0]))
            if route=="/api/captures/file": return self.file_reply(captures.resolve_file(q.get("id",[""])[0]))
            if route=="/api/device-files/list": return self.reply(device_files.list_directory(android.selected_device_settings(settings,q.get("serial",[""])[0]),q.get("path",["/sdcard"])[0]))
            if route=="/api/device-files/download": return self.file_reply(device_files.resolve_download(q.get("id",[""])[0]))
            if route=="/api/logs":
                rule=device.saved_log_filter(settings,q.get("preset",[""])[0])
                selected=android.selected_device_settings(settings,q.get("serial",[""])[0])
                return self.logs(selected,rule)
            return self.static(route)
        except (ValueError,json.JSONDecodeError) as error:self.reply({"error":str(error)},400)
        except Exception as error:self.reply({"error":str(error)},500)
    def do_POST(self):
        try:
            if self.path=="/api/resources/upload":
                settings=config.load();_,filename,content=self.multipart();return self.reply(artifacts.upload_resource(settings,filename,content))
            if self.path=="/api/apks/upload":
                settings=config.load();_,filename,content=self.multipart();return self.reply(artifacts.upload_apk(settings,filename,content))
            if self.path=="/api/keystores/upload":
                settings=config.load();_,filename,content=self.multipart();return self.reply(artifacts.upload_keystore(settings,filename,content))
            if self.path=="/api/device-files/upload":
                settings=config.load();directory,serial,overwrite,relative_path,filename,content=self.device_file_upload();selected=android.selected_device_settings(settings,serial);return self.reply(device_files.upload(selected,directory,filename,content,overwrite,relative_path))
            if self.path=="/api/audio/upload":
                _,filename,content=self.multipart();return self.reply(audio.upload(filename,content))
            settings,body=config.load(),self.body(); route=self.path
            # 先拒绝空/未知日志规则，避免未连接设备时掩盖“全部日志”绕过问题。
            if route=="/api/logs/export": device.saved_log_filter(settings, body.get("preset", ""))
            selected=android.selected_device_settings(settings,body.get("serial","")) if route in {"/api/install","/api/apks/push","/api/resources/push","/api/processes/stop","/api/processes/launch","/api/processes/uninstall","/api/processes/cert-sha256","/api/broadcasts/send","/api/adb-commands/run","/api/logs/export","/api/logs/clear","/api/device-logs/scan","/api/device-logs/pull","/api/captures/screenshot","/api/captures/record/start","/api/captures/scrcpy/launch","/api/device-files/pull","/api/device-files/pull-batch","/api/device-files/delete","/api/device-files/delete-batch","/api/device-files/create-directory","/api/device-files/create-file","/api/device-files/preview","/api/adb/root","/api/adb/remount","/api/adb/reboot"} else settings
            actions={"/api/install":lambda:artifacts.install(selected,body),"/api/apks/md5":lambda:artifacts.checksum(settings,body),"/api/apks/delete":lambda:artifacts.delete(settings,body),"/api/apks/sign":lambda:artifacts.sign(settings,body),"/api/resources/md5":lambda:artifacts.resource_checksum(settings,body),"/api/resources/delete":lambda:artifacts.delete_resource(settings,body),"/api/resources/push":lambda:artifacts.push(selected,body),"/api/processes/stop":lambda:device.stop(selected,body.get("package","")),"/api/processes/launch":lambda:device.launch(selected,body.get("package",""))}
            actions["/api/apks/collect"] = lambda: artifacts.collect_apks(settings, body)
            actions["/api/apks/sha256"] = lambda: artifacts.sha256_checksum(settings, body)
            actions["/api/apks/cert-sha256"] = lambda: artifacts.certificate_checksum(settings, body)
            actions["/api/apks/push"] = lambda: artifacts.push_apk(selected, body)
            actions["/api/broadcasts/send"] = lambda: device.send_broadcast(selected, body)
            actions["/api/keystores/delete"] = lambda: artifacts.delete_keystore_file(settings, body)
            actions["/api/processes/uninstall"] = lambda: device.uninstall(selected, body.get("package", ""), bool(body.get("confirmed")))
            actions["/api/processes/cert-sha256"] = lambda: device.installed_apk_certificate_sha256(selected, body.get("package", ""))
            actions["/api/adb-commands/run"] = lambda: device.run_adb_command(selected, body)
            actions["/api/adb-commands/import"] = lambda: config.command_import(body)
            actions["/api/adb/root"] = lambda: android.root_device(selected)
            actions["/api/adb/remount"] = lambda: android.remount_device(selected)
            actions["/api/adb/reboot"] = lambda: android.reboot_device(selected)
            actions["/api/adb/connect"] = lambda: android.connect_wireless(settings, body)
            actions["/api/adb/wireless-scan"] = lambda: android.scan_wireless(settings, body)
            actions["/api/adb/wireless-disconnect"] = lambda: android.disconnect_wireless(settings, body)
            actions["/api/adb/wireless-cleanup"] = lambda: android.clean_offline_wireless(settings)
            actions["/api/adb/force-kill"] = lambda: android.force_kill_adb()
            actions["/api/offline-logs/query"] = lambda: logs.query(settings, body)
            actions["/api/offline-logs/extract"] = lambda: logs.extract_archives(settings, body)
            actions["/api/audio/ffmpeg/path"] = lambda: audio.save_ffmpeg_path(body.get("path", ""))
            actions["/api/audio/estimate"] = lambda: audio.estimate(body.get("id", ""), body)
            actions["/api/audio/preview"] = lambda: audio.preview(settings, body)
            actions["/api/audio/delete"] = lambda: audio.delete(body.get("id", ""))
            actions["/api/audio/reveal"] = audio.reveal_outputs
            actions["/api/logs/export"] = lambda: device.export(selected, body.get("preset", ""))
            actions["/api/logs/clear"] = lambda: device.clear_logcat(selected)
            actions["/api/device-logs/scan"] = lambda: device_logs.scan(selected, body)
            actions["/api/device-logs/pull"] = lambda: device_logs.pull(selected, body)
            actions["/api/device-logs/reveal"] = lambda: device_logs.reveal_pull_folder(body.get("folder_id", ""))
            actions["/api/captures/screenshot"] = lambda: captures.screenshot(selected, body)
            actions["/api/captures/scrcpy/path"] = lambda: captures.save_scrcpy_path(body.get("path", ""))
            actions["/api/captures/scrcpy/launch"] = lambda: captures.launch_scrcpy(selected, body)
            actions["/api/captures/record/start"] = lambda: captures.start_recording(selected, body)
            actions["/api/captures/record/stop"] = lambda: captures.stop_recording()
            actions["/api/captures/record/open"] = lambda: captures.open_recording(body.get("id", ""))
            actions["/api/captures/reveal"] = lambda: captures.reveal(body.get("id", ""))
            actions["/api/system/reveal-data"] = runtime.reveal_data_root
            actions["/api/captures/delete"] = lambda: captures.delete_file(body.get("id", ""))
            actions["/api/captures/delete-batch"] = lambda: captures.delete_files(body.get("ids"))
            actions["/api/device-files/pull"] = lambda: device_files.pull(selected, body.get("path", ""))
            actions["/api/device-files/pull-batch"] = lambda: device_files.pull_batch(selected, body.get("paths"))
            actions["/api/device-files/delete"] = lambda: device_files.delete(selected, body.get("path", ""), body.get("confirmed"))
            actions["/api/device-files/delete-batch"] = lambda: device_files.delete_batch(selected, body.get("paths"), body.get("confirmed"))
            actions["/api/device-files/create-directory"] = lambda: device_files.create_directory(selected, body.get("directory", ""), body.get("name", ""))
            actions["/api/device-files/create-file"] = lambda: device_files.create_text_file(selected, body.get("directory", ""), body.get("name", ""), body.get("content", ""), body.get("overwrite"))
            actions["/api/device-files/preview"] = lambda: device_files.preview(selected, body.get("path", ""))
            actions["/api/config/import"] = lambda: config.import_shared(body)
            actions["/api/config/domain"] = lambda: config.update_domain(body.get("domain", ""), body.get("values"))
            actions["/api/themes/import"] = lambda: themes.import_theme(body)
            actions["/api/themes/delete"] = lambda: themes.delete_theme(body.get("id", ""))
            if route=="/api/config":
                raise ValueError("聚合配置保存已停用，请使用 /api/config/domain 按稳定存储域保存")
            if route in actions:return self.reply(actions[route]())
            self.reply({"error":"Not found"},404)
        except (ValueError,json.JSONDecodeError) as error:self.reply({"error":str(error)},400)
        except Exception as error:self.reply({"error":str(error)},500)
    def static(self,path):
        item=(STATIC/("index.html" if path in("/","") else path.lstrip("/"))).resolve()
        if not item.is_file() or STATIC not in item.parents:return self.reply({"error":"Not found"},404)
        # 前端以运行时脚本增强初始 HTML。必须禁止浏览器复用旧脚本，
        # 否则刷新后会只剩未增强的初始页面结构。
        data=item.read_bytes();self.send_response(200);self.send_header("Content-Type",mimetypes.guess_type(item.name)[0] or "application/octet-stream");self.send_header("Cache-Control","no-store, no-cache, must-revalidate, max-age=0");self.send_header("Pragma","no-cache");self.send_header("Expires","0");self.send_header("Content-Length",str(len(data)));self.end_headers();self.wfile.write(data)
    def logs(self,settings,rule):
        # 每个 SSE 请求是独立日志会话。先启动实时进程再读缓冲区，
        # 避免“读完缓冲区到订阅实时流之间”丢失日志。
        target=device.resolve_log_process(settings,rule);process_ids=set(target["pids"]) if target["name"] else None
        process=device.logcat(settings);snapshot=device.buffer(settings);self.send_response(200);self.send_header("Content-Type","text/event-stream");self.send_header("Cache-Control","no-cache, no-transform");self.send_header("Connection","keep-alive");self.send_header("X-Accel-Buffering","no");self.end_headers();self.wfile.write(("event: ready\ndata: "+json.dumps({"rule":rule,"replay":True,"process":target},ensure_ascii=False)+"\n\n").encode())
        for line in snapshot:
            if device.matches(line,rule,process_ids): self.wfile.write(("data: "+json.dumps(line,ensure_ascii=False)+"\n\n").encode())
        self.wfile.flush()
        try:
            last_ping=time.monotonic()
            while True:
                line=process.stdout.readline()
                if not line: break
                if device.matches(line,rule,process_ids):self.wfile.write(("data: "+json.dumps(line.rstrip(),ensure_ascii=False)+"\n\n").encode());self.wfile.flush()
                if time.monotonic()-last_ping>15:self.wfile.write(b": keep-alive\n\n");self.wfile.flush();last_ping=time.monotonic()
        except (BrokenPipeError,ConnectionResetError):pass
        finally:process.terminate()

def run():
    """以前台方式启动；终端窗口关闭时 Python 进程也会退出。"""
    server,url=bind_server()
    if server is None:
        method=app_window.open_app_window(url)
        print(f"检测到已运行的 Glacien，界面已通过{method}打开：{url}")
        return
    print(f"Glacien Workbench：{url}")
    def open_window():
        method=app_window.open_app_window(url)
        print(f"界面已通过{method}打开。")
    threading.Timer(.4,open_window).start()
    try:server.serve_forever()
    except KeyboardInterrupt:print("\nGlacien Workbench 已停止。")
