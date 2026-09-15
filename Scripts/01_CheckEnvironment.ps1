$ErrorActionPreference = 'Stop'
Write-Host '=== myEFX environment check ===' -ForegroundColor Cyan

foreach ($tool in @('cmake.exe','cl.exe')) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if ($cmd) { Write-Host "OK  $tool -> $($cmd.Source)" -ForegroundColor Green }
    else { Write-Host "MISS $tool (cl.exe 請從 Visual Studio Developer Command Prompt 檢查)" -ForegroundColor Yellow }
}

$sdk = Join-Path $PSScriptRoot '..\SDK\VST3_SDK'
$sdk = [IO.Path]::GetFullPath($sdk)
if (Test-Path (Join-Path $sdk 'CMakeLists.txt')) {
    Write-Host "OK  VST3 SDK -> $sdk" -ForegroundColor Green
} else {
    Write-Host "MISS VST3 SDK -> $sdk" -ForegroundColor Red
    Write-Host '請把 Steinberg VST3 SDK 解壓到這個資料夾。' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '下一步：把檢查結果貼回 ChatGPT。' -ForegroundColor Cyan
