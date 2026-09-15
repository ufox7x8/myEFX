myEFX — Audio Plugin Development Project

目標：Windows 11 / Visual Studio 2022 / CMake / Steinberg VST3 SDK。
第一階段先完成 VST3；未來取得 AAX 開發資格後再接 AAX。

目前 Plugin A / MyEQ：
Parametric EQ + Dynamic + Spectral + Transient + Frequency-selective De-noise。
後續可加入 Transient-aware De-noise。

你現在只需要：
1. 安裝 Visual Studio 2022 Community，勾選 Desktop development with C++。
2. 安裝 CMake。
3. 從 Steinberg 官方來源下載 VST3 SDK。
4. 將 SDK 解壓到 SDK/VST3_SDK/，使該目錄直接包含 CMakeLists.txt、base、pluginterfaces、public.sdk、vstgui4 等。
5. 執行 Scripts/01_CheckEnvironment.ps1。
6. 將檢查結果貼回 ChatGPT，再建立第一個可編譯的 MyEQ VST3。

注意：本 Repository 不包含 Steinberg VST3 SDK 本體；請使用官方來源取得並保持版本可控。
