@echo off
set ROOT=%~dp0..
set SDK=%ROOT%SDK\VST3_SDK
set BUILD=%ROOT%Builds\VST3_SDK_Examples
if not exist "%SDK%\CMakeLists.txt" (
  echo 找不到 VST3 SDK：%SDK%
  echo 請先解壓官方 Steinberg VST3 SDK。
  pause
  exit /b 1
)
if not exist "%BUILD%" mkdir "%BUILD%"
cd /d "%BUILD%"
cmake.exe -G "Visual Studio 17 2022" -A x64 "%SDK%" -DSMTG_CREATE_PLUGIN_LINK=0
if errorlevel 1 (
  echo CMake Configure 失敗。
  pause
  exit /b 1
)
echo Configure 完成。
pause
