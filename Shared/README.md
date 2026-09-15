# Shared

三顆 Plugin 共用核心。

DSP/
- EQ
- Dynamic
- Spectral
- Transient
- Denoise
- FFT / envelope / filters / oversampling

Core/
- parameters
- state / preset
- plugin metadata

GUI/
- shared widgets
- spectrum analyzer
- band display

Utils/
- math
- smoothing
- denormal handling
- diagnostics

第一原則：DSP 核心盡量與 Plugin format 解耦，未來可由同一套核心接 VST3 與 AAX。
