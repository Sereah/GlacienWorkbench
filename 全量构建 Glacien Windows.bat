@echo off
setlocal
REM 在 Windows 本机清理缓存后构建 dist\Glacien-VERSION.exe。
cd /d "%~dp0"
set "BUILD_VENV=%CD%\.desktop-build-venv"

if exist "%BUILD_VENV%\Scripts\python.exe" goto :venv_ready
py -m venv "%BUILD_VENV%"
if errorlevel 1 goto :error
:venv_ready
"%BUILD_VENV%\Scripts\python.exe" codes\prepare_desktop_build.py
if errorlevel 1 goto :error
"%BUILD_VENV%\Scripts\python.exe" codes\build_desktop.py --clean
if errorlevel 1 goto :error
echo Clean build completed. Versioned artifact: %CD%\dist
exit /b 0

:error
echo Glacien clean build failed.
pause
exit /b 1
