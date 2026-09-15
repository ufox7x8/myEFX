@echo off
setlocal
set VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe
if not exist "%VSWHERE%" (
  echo 找不到 vswhere.exe，請確認 Visual Studio 2022 已安裝。
  pause
  exit /b 1
)
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set VSPATH=%%i
if not defined VSPATH (
  echo 找不到可用的 Visual Studio C++ 安裝。
  pause
  exit /b 1
)
call "%VSPATH%\Common7\Tools\VsDevCmd.bat" -arch=x64
cmd /k
