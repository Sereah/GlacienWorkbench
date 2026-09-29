@echo off
setlocal
REM 在 Windows 本机复用缓存构建 dist\Glacien-VERSION.exe。
cd /d "%~dp0"
set "BUILD_VENV=%CD%\.desktop-build-venv"

if exist "%BUILD_VENV%\Scripts\python.exe" goto :venv_ready
py -m venv "%BUILD_VENV%"
if errorlevel 1 goto :error
:venv_ready
"%BUILD_VENV%\Scripts\python.exe" codes\prepare_desktop_build.py
if errorlevel 1 goto :error
"%BUILD_VENV%\Scripts\python.exe" codes\build_desktop.py
if errorlevel 1 goto :error
echo Incremental build completed. Versioned artifact: %CD%\dist
exit /b 0

:error
echo Glacien incremental build failed.
pause
exit /b 1
