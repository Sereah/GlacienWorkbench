@echo off
REM Windows 资源管理器可双击入口：关闭此命令窗口即停止 Launcher。
cd /d "%~dp0"
py codes\launcher.py
if errorlevel 1 pause
