# myEFX Web Tester

瀏覽器版 DSP 測試器。

## 現在可以做什麼

- Chrome / Edge 直接開啟 `index.html`
- 拖放或選取 WAV / AIFF
- 播放 / 停止
- Band 1：Freq / Gain / Q 的即時 Peaking EQ
- A/B 兩組 EQ 參數保存
- Bypass
- Dynamic / Transient / De-noise UI 已預留

## 為什麼先用 Web Audio

這一版先用 Web Audio API 把「音檔 → DSP → 播放」的流程跑起來。之後真正的 DSP 核心會獨立成 C++，再用 WebAssembly (Emscripten) 編譯給瀏覽器測試器使用，同一套 DSP 邏輯也會供 VST3 使用。

目標架構：

Web UI → WASM DSP Core → Audio output

VST3 UI → C++ DSP Core → VST3 host

## 下一步

1. 把 EQ 演算法移到獨立 DSP Core
2. 加入 Dynamic EQ
3. 加入頻率選擇式 Transient
4. 加入 De-noise
5. 建立 C++/WASM 雙輸出
