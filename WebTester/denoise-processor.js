class MyEFXDenoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'amount', defaultValue: 0, minValue: 0, maxValue: 100, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.N = 1024;
    this.H = 128;
    this.B = this.N / 2 + 1;
    this.BANDS = 64;

    this.win = new Float32Array(this.N);
    this.re = new Float32Array(this.N);
    this.im = new Float32Array(this.N);
    this.tmpLr = new Float32Array(this.N);
    this.tmpLi = new Float32Array(this.N);
    this.tmpRr = new Float32Array(this.N);
    this.tmpRi = new Float32Array(this.N);
    this.ringL = new Float32Array(this.N);
    this.ringR = new Float32Array(this.N);
    this.ringPos = 0;
    this.samples = 0;
    this.ready = false;

    // 64 overlapping psychoacoustic bands. The filterbank is ERB-spaced rather
    // than hard bin assignment, so neighbouring bands share information smoothly.
    this.bandPower = new Float32Array(this.BANDS);
    this.bandNoise = new Float32Array(this.BANDS);
    this.bandFast = new Float32Array(this.BANDS);
    this.bandGain = new Float32Array(this.BANDS);
    this.bandTarget = new Float32Array(this.BANDS);
    this.bandEnv = new Float32Array(this.BANDS);
    this.bandPrevPower = new Float32Array(this.BANDS);
    this.bandOpen = new Uint8Array(this.BANDS);
    this.bandCenter = new Float32Array(this.BANDS);
    this.bandErb = new Float32Array(this.BANDS);
    this.binLo = new Uint8Array(this.B);
    this.binHi = new Uint8Array(this.B);
    this.binFrac = new Float32Array(this.B);

    // Minimum-statistics memory: 32 analysis frames, about 93 ms at H=128/44.1k.
    this.MIN_FRAMES = 32;
    this.noiseHist = new Float32Array(this.BANDS * this.MIN_FRAMES);
    this.noiseHistPos = 0;

    this.olaL = new Float32Array(this.N);
    this.olaR = new Float32Array(this.N);
    this.emitL = new Float32Array(this.H);
    this.emitR = new Float32Array(this.H);
    this.queueSize = 65536;
    this.queueL = new Float32Array(this.queueSize);
    this.queueR = new Float32Array(this.queueSize);
    this.qRead = 0;
    this.qWrite = 0;

    for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.N - 1));

    const fMin = 25;
    const fMax = Math.min(19000, sampleRate * 0.46);
    const erb = f => 21.4 * Math.log10(1 + 0.00437 * f);
    const invErb = e => (Math.pow(10, e / 21.4) - 1) / 0.00437;
    const e0 = erb(fMin), e1 = erb(fMax);
    for (let b = 0; b < this.BANDS; b++) {
      const e = e0 + (e1 - e0) * b / (this.BANDS - 1);
      this.bandErb[b] = e;
      this.bandCenter[b] = invErb(e);
      this.bandGain[b] = 1;
      this.bandTarget[b] = 1;
      this.bandNoise[b] = 1e-12;
      this.bandFast[b] = 1e-12;
      this.bandPrevPower[b] = 1e-12;
      this.bandOpen[b] = 1;
    }

    // Each FFT bin is interpolated between the two nearest ERB bands.
    for (let k = 0; k < this.B; k++) {
      const f = k * sampleRate / this.N;
      if (f <= this.bandCenter[0]) { this.binLo[k] = 0; this.binHi[k] = 0; this.binFrac[k] = 0; continue; }
      if (f >= this.bandCenter[this.BANDS - 1]) { this.binLo[k] = this.BANDS - 1; this.binHi[k] = this.BANDS - 1; this.binFrac[k] = 0; continue; }
      let lo = 0;
      while (lo < this.BANDS - 2 && f > this.bandCenter[lo + 1]) lo++;
      const hi = lo + 1;
      const frac = (f - this.bandCenter[lo]) / Math.max(1e-9, this.bandCenter[hi] - this.bandCenter[lo]);
      this.binLo[k] = lo;
      this.binHi[k] = hi;
      this.binFrac[k] = Math.max(0, Math.min(1, frac));
    }
  }

  fft(re, im, inverse = false) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const a = (inverse ? 2 : -2) * Math.PI / len;
      const wc = Math.cos(a), ws = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let wr = 1, wi = 0;
        const half = len >> 1;
        for (let j = 0; j < half; j++) {
          const x = i + j, y = x + half;
          const vr = re[y] * wr - im[y] * wi;
          const vi = re[y] * wi + im[y] * wr;
          re[y] = re[x] - vr; im[y] = im[x] - vi;
          re[x] += vr; im[x] += vi;
          const tr = wr * wc - wi * ws;
          wi = wr * ws + wi * wc; wr = tr;
        }
      }
    }
    if (inverse) {
      const s = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; }
    }
  }

  clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  push(L, R) {
    for (let i = 0; i < this.H; i++) {
      const p = this.qWrite % this.queueSize;
      this.queueL[p] = L[i]; this.queueR[p] = R[i]; this.qWrite++;
    }
  }

  pop(output, frames) {
    for (let i = 0; i < frames; i++) {
      if (this.qRead < this.qWrite) {
        const p = this.qRead % this.queueSize;
        output[0][i] = this.queueL[p];
        if (output.length > 1) output[1][i] = this.queueR[p];
        this.qRead++;
      } else {
        output[0][i] = 0;
        if (output.length > 1) output[1][i] = 0;
      }
    }
  }

  analyseFrame(amount) {
    for (let n = 0; n < this.N; n++) {
      const idx = (this.ringPos + n) % this.N;
      this.re[n] = ((this.ringL[idx] + this.ringR[idx]) * 0.5) * this.win[n];
      this.im[n] = 0;
    }
    this.fft(this.re, this.im);

    this.bandPower.fill(1e-12);
    const bandWeight = new Float32Array(this.BANDS);
    for (let k = 1; k < this.B; k++) {
      const p = this.re[k] * this.re[k] + this.im[k] * this.im[k] + 1e-14;
      const lo = this.binLo[k], hi = this.binHi[k], f = this.binFrac[k];
      const w0 = 1 - f, w1 = f;
      this.bandPower[lo] += p * w0; bandWeight[lo] += w0;
      if (hi !== lo) { this.bandPower[hi] += p * w1; bandWeight[hi] += w1; }
    }
    for (let b = 0; b < this.BANDS; b++) this.bandPower[b] /= Math.max(1e-6, bandWeight[b]);

    const maxReductionDb = 24 * amount;
    const thresholdDb = 2.0;
    const hysteresisDb = 0.8;
    const kneeDb = 4.0;
    const attack = 0.55;
    const release = 0.055;

    for (let b = 0; b < this.BANDS; b++) {
      const p = Math.max(1e-12, this.bandPower[b]);
      const pDb = 10 * Math.log10(p);
      const prevNoise = Math.max(1e-12, this.bandNoise[b]);
      const noiseDb = 10 * Math.log10(prevNoise);
      const gap = pDb - noiseDb;

      // Fast estimator only follows material that is close to the current noise floor.
      const nearNoise = gap < thresholdDb + 3.0;
      const fastRate = nearNoise ? 0.055 : 0.0015;
      this.bandFast[b] = prevNoise + (p - prevNoise) * fastRate;

      // Minimum-statistics track: the lowest recent band power is a robust noise candidate.
      const hp = b * this.MIN_FRAMES + this.noiseHistPos;
      this.noiseHist[hp] = p;
      let minP = Infinity;
      for (let j = 0; j < this.MIN_FRAMES; j++) minP = Math.min(minP, this.noiseHist[b * this.MIN_FRAMES + j] || p);
      const minCandidate = Math.max(1e-12, minP * 1.20);

      // Do not let the estimate jump upward with speech/music; allow slow recovery instead.
      const desiredNoise = Math.min(this.bandFast[b] * 1.08, minCandidate);
      const noiseRate = desiredNoise < prevNoise ? 0.16 : 0.004;
      this.bandNoise[b] = Math.max(1e-12, prevNoise + (desiredNoise - prevNoise) * noiseRate);

      // Envelope smoothing reduces one-frame gate chatter.
      this.bandEnv[b] += (pDb - this.bandEnv[b]) * 0.18;
      const envNoiseDb = 10 * Math.log10(Math.max(1e-12, this.bandNoise[b]));
      const envGap = this.bandEnv[b] - envNoiseDb;

      // Hysteresis prevents repeated open/close toggling around the threshold.
      const openThreshold = thresholdDb + hysteresisDb;
      const closeThreshold = thresholdDb - hysteresisDb;
      if (this.bandOpen[b]) {
        if (envGap < closeThreshold) this.bandOpen[b] = 0;
      } else if (envGap > openThreshold) {
        this.bandOpen[b] = 1;
      }

      // Spectral-flux protection: a sudden rise is treated as a likely desired transient,
      // so the gate cannot slam shut on the attack.
      const prevDb = 10 * Math.log10(Math.max(1e-12, this.bandPrevPower[b]));
      const fluxDb = pDb - prevDb;
      this.bandPrevPower[b] = p;
      const transientProtection = this.clamp((fluxDb - 3) / 9, 0, 1);

      const below = this.clamp((thresholdDb + kneeDb - envGap) / kneeDb, 0, 1);
      const gateBias = this.bandOpen[b] ? 0.12 : 1.0;
      let attenuationDb = maxReductionDb * Math.pow(below * gateBias, 1.18);
      attenuationDb *= (1 - 0.72 * transientProtection);
      attenuationDb = this.clamp(attenuationDb, 0, maxReductionDb);

      const minGain = Math.pow(10, -maxReductionDb / 20);
      const target = Math.pow(10, -attenuationDb / 20);
      this.bandTarget[b] = this.clamp(target, minGain, 1);
      const speed = this.bandTarget[b] < this.bandGain[b] ? attack : release;
      this.bandGain[b] += (this.bandTarget[b] - this.bandGain[b]) * speed;
      this.bandGain[b] = this.clamp(this.bandGain[b], minGain, 1);
    }
    this.noiseHistPos = (this.noiseHistPos + 1) % this.MIN_FRAMES;
    this.ready = true;
  }

  processChannel(ring, outRe, outIm) {
    for (let n = 0; n < this.N; n++) {
      const idx = (this.ringPos + n) % this.N;
      outRe[n] = ring[idx] * this.win[n]; outIm[n] = 0;
    }
    this.fft(outRe, outIm);

    // Interpolate the 64 band gains over FFT bins. This avoids hard band edges.
    for (let k = 0; k < this.B; k++) {
      const lo = this.binLo[k], hi = this.binHi[k], f = this.binFrac[k];
      const g = this.bandGain[lo] * (1 - f) + this.bandGain[hi] * f;
      outRe[k] *= g; outIm[k] *= g;
      if (k > 0 && k < this.B - 1) {
        const mirror = this.N - k;
        outRe[mirror] *= g; outIm[mirror] *= g;
      }
    }
    this.fft(outRe, outIm, true);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    if (!input.length || !input[0]?.length) return true;
    const frames = input[0].length;
    const channels = input.length;
    const amount = this.clamp((parameters.amount?.[0] ?? 0) / 100, 0, 1);

    // 0% is a true sample-for-sample bypass: no FFT, no latency, no level change.
    if (amount <= 0.0001) {
      for (let i = 0; i < frames; i++) {
        output[0][i] = input[0][i];
        if (output.length > 1) output[1][i] = channels > 1 ? input[1][i] : input[0][i];
      }
      return true;
    }

    for (let i = 0; i < frames; i++) {
      const l = input[0][i];
      const r = channels > 1 ? input[1][i] : l;
      this.ringL[this.ringPos] = l; this.ringR[this.ringPos] = r;
      this.ringPos = (this.ringPos + 1) % this.N;
      this.samples++;

      if (this.samples >= this.N && ((this.samples - this.N) % this.H) === 0) {
        this.analyseFrame(amount);
        this.processChannel(this.ringL, this.tmpLr, this.tmpLi);
        this.processChannel(this.ringR, this.tmpRr, this.tmpRi);

        // Hann^2 at N/H = 8 has a steady-state sum close to 3.
        // Keep the reconstruction unity-gain at 0 dB reduction.
        const olaScale = 1 / 3;
        for (let n = 0; n < this.N; n++) {
          this.olaL[n] += this.tmpLr[n] * this.win[n] * olaScale;
          this.olaR[n] += this.tmpRr[n] * this.win[n] * olaScale;
        }
        for (let n = 0; n < this.H; n++) { this.emitL[n] = this.olaL[n]; this.emitR[n] = this.olaR[n]; }
        this.olaL.copyWithin(0, this.H); this.olaR.copyWithin(0, this.H);
        this.olaL.fill(0, this.N - this.H); this.olaR.fill(0, this.N - this.H);
        this.push(this.emitL, this.emitR);
      }
    }
    this.pop(output, frames);
    return true;
  }
}

registerProcessor('myefx-denoise', MyEFXDenoiseProcessor);
