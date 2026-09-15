@echo off
set ROOT=%~dp0..
set BUILD=%ROOT%Builds\VST3_SDK_Examples
if not exist "%BUILD%\CMakeCache.txt" (
  echo 請先執行 03_Configure_VST3_SDK.bat
  pause
  exit /b 1
)
cd /d "%BUILD%"
cmake.exe --build . --config Release
if errorlevel 1 (
  echo Build 失敗。
  pause
  exit /b 1
)
echo VST3 SDK examples build 完成。
pause
