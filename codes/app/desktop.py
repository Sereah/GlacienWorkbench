"""PySide6 + Qt WebEngine 桌面宿主。"""

from __future__ import annotations

import sys
import threading
from pathlib import Path

from PySide6.QtCore import QCoreApplication, QObject, QStandardPaths, QUrl, Slot
from PySide6.QtGui import QDesktopServices, QIcon
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWidgets import QApplication, QFileDialog, QMainWindow, QMessageBox

from . import runtime,server


APP_TITLE = "Glacien Workbench"
APP_ID = "com.glacien.workbench"
WINDOW_SIZE = (1440, 900)
MINIMUM_SIZE = (1080, 680)


class DesktopBridge(QObject):
    """只把用户在原生对话框中明确选择的目录交给受信 Web 页面。"""

    @Slot(str, result=str)
    def choose_directory(self, initial_directory: str = "") -> str:
        initial = initial_directory if Path(initial_directory).is_dir() else ""
        return QFileDialog.getExistingDirectory(None, "选择离线日志目录", initial)


class GlacienPage(QWebEnginePage):
    """补齐桌面壳的目录选择，并阻止主窗口跳离本机服务。"""

    def chooseFiles(self, mode, old_files, accepted_mime_types):
        if mode == QWebEnginePage.FileSelectionMode.FileSelectUploadFolder:
            folder = QFileDialog.getExistingDirectory(None, "选择日志文件夹", old_files[0] if old_files else "")
            return [folder] if folder else []
        if mode == QWebEnginePage.FileSelectionMode.FileSelectOpenMultiple:
            files, _ = QFileDialog.getOpenFileNames(None, "选择文件", old_files[0] if old_files else "")
            return files
        file, _ = QFileDialog.getOpenFileName(None, "选择文件", old_files[0] if old_files else "")
        return [file] if file else []

    def acceptNavigationRequest(self, url, navigation_type, is_main_frame):
        if is_main_frame and url.scheme() in {"http", "https"} and url.host() not in {"127.0.0.1", "localhost"}:
            QDesktopServices.openUrl(url)
            return False
        return super().acceptNavigationRequest(url, navigation_type, is_main_frame)


class GlacienWindow(QMainWindow):
    def __init__(self, url: str, owned_server):
        super().__init__()
        self.owned_server = owned_server
        self.setWindowTitle(APP_TITLE)
        self.resize(*WINDOW_SIZE)
        self.setMinimumSize(*MINIMUM_SIZE)
        self.webview = QWebEngineView(self)
        self.webview.setPage(GlacienPage(QWebEngineProfile.defaultProfile(), self.webview))
        self.bridge = DesktopBridge(self)
        self.channel = QWebChannel(self.webview.page())
        self.channel.registerObject("glacienDesktop", self.bridge)
        self.webview.page().setWebChannel(self.channel)
        # 本地受信页面需要把筛选命令等文本写入系统剪贴板。
        self.webview.settings().setAttribute(
            QWebEngineSettings.WebAttribute.JavascriptCanAccessClipboard, True
        )
        self.webview.setUrl(QUrl(url))
        self.setCentralWidget(self.webview)

    def closeEvent(self, event):
        self.webview.page().runJavaScript("if (window.stopLogs) window.stopLogs();")
        if self.owned_server is not None:
            # shutdown 不在 GUI 线程中等待，避免活跃 SSE 请求拖住窗口关闭。
            threading.Thread(target=self.owned_server.shutdown, daemon=True).start()
        super().closeEvent(event)


def configure_profile() -> None:
    profile_root = runtime.web_profile_root()
    cache_root = profile_root / "cache"
    profile_root.mkdir(parents=True, exist_ok=True)
    cache_root.mkdir(parents=True, exist_ok=True)
    profile = QWebEngineProfile.defaultProfile()
    profile.setPersistentStoragePath(str(profile_root))
    profile.setCachePath(str(cache_root))

    def download_requested(download):
        suggested = download.downloadFileName() or "download"
        default_dir = QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DownloadLocation)
        target, _ = QFileDialog.getSaveFileName(None, "保存文件", str(Path(default_dir) / suggested))
        if not target:
            download.cancel()
            return
        destination = Path(target)
        download.setDownloadDirectory(str(destination.parent))
        download.setDownloadFileName(destination.name)
        download.accept()

    profile.downloadRequested.connect(download_requested)
    # 保持 Python 回调存活，避免信号连接后被垃圾回收。
    profile._glacien_download_handler = download_requested


def run() -> int:
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
        except (AttributeError, OSError):
            pass
    QCoreApplication.setOrganizationName("Glacien")
    QCoreApplication.setApplicationName("Glacien")
    app = QApplication(sys.argv)
    icon_path = runtime.resource_path("assets/glacien.svg")
    if icon_path.is_file():
        app.setWindowIcon(QIcon(str(icon_path)))
    try:
        owned_server,url=server.bind_server()
    except OSError as error:
        QMessageBox.critical(None, APP_TITLE, str(error))
        return 1
    if owned_server is not None:
        threading.Thread(target=owned_server.serve_forever, name="glacien-http", daemon=True).start()
    configure_profile()
    window=GlacienWindow(url,owned_server)
    app._glacien_window=window
    window.show()
    result=app.exec()
    if owned_server is not None:
        owned_server.shutdown()
        owned_server.server_close()
    return result
