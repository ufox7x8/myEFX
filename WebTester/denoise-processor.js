class MyEFXDenoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'amount', defaultValue: 0, minValue: 0, maxValue: 100, automationRate: 'k-rate' }
    ];
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
    this.bandPower = new Float32Array(this.BANDS);
    this.bandNoise = new Float32Array(this.BANDS);
    this.bandGain = new Float32Array(this.BANDS);
    this.bandTarget = new Float32Array(this.BANDS);
    this.bandEnv = new Float32Array(this.BANDS);
    this.bandOpen = new Uint8Array(this.BANDS);
    this.binBand = new Uint8Array(this.B);
    this.bandLow = new Float32Array(this.BANDS);
    this.bandHigh = new Float32Array(this.BANDS);
    this.bandCenter = new Float32Array(this.BANDS);
    this.olaL = new Float32Array(this.N);
    this.olaR = new Float32Array(this.N);
    this.emitL = new Float32Array(this.H);
    this.emitR = new Float32Array(this.H);
    this.queueSize = 65536;
    this.queueL = new Float32Array(this.queueSize);
    this.queueR = new Float32Array(this.queueSize);
    this.qRead = 0;
    this.qWrite = 0;

    for (let i = 0; i < this.N; i++) {
      this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.N - 1));
    }

    const fMin = 25;
    const fMax = Math.min(18000, sampleRate * 0.46);
    for (let b = 0; b < this.BANDS; b++) {
      const t = b / (this.BANDS - 1);
      this.bandCenter[b] = fMin * Math.pow(fMax / fMin, t);
    }
    for (let b = 0; b < this.BANDS; b++) {
      this.bandLow[b] = b === 0 ? fMin : Math.sqrt(this.bandCenter[b - 1] * this.bandCenter[b]);
      this.bandHigh[b] = b === this.BANDS - 1 ? fMax : Math.sqrt(this.bandCenter[b] * this.bandCenter[b + 1]);
      this.bandGain[b] = 1;
      this.bandTarget[b] = 1;
      this.bandEnv[b] = 0;
      this.bandNoise[b] = 1e-12;
      this.bandOpen[b] = 1;
    }
    for (let k = 0; k < this.B; k++) {
      const f = k * sampleRate / this.N;
      let b = 0;
      while (b < this.BANDS - 1 && f >= this.bandHigh[b]) b++;
      this.binBand[k] = b;
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
          wi = wr * ws + wi * wc;
          wr = tr;
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
      this.queueL[p] = L[i];
      this.queueR[p] = R[i];
      this.qWrite++;
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
    const count = new Uint16Array(this.BANDS);
    for (let k = 1; k < this.B; k++) {
      const p = this.re[k] * this.re[k] + this.im[k] * this.im[k] + 1e-14;
      const b = this.binBand[k];
      this.bandPower[b] += p;
      count[b]++;
    }
    for (let b = 0; b < this.BANDS; b++) {
      if (count[b]) this.bandPower[b] /= count[b];
    }

    // RX Voice De-noise behaviour: 64 psychoacoustic bands act as adaptive gates.
    // Signal above the threshold is passed; only the portion below the threshold is attenuated.
    // Amount changes only the maximum attenuation depth and can never create positive gain.
    const maxReductionDb = 18 * amount;
    const thresholdDb = 1.8;
    const hysteresisDb = 0.7;
    const attack = 0.42;
    const release = 0.075;
    const noiseFollowQuiet = 0.018;
    const noiseFollowActive = 0.00035;

    for (let b = 0; b < this.BANDS; b++) {
      const power = Math.max(1e-12, this.bandPower[b]);
      const prevNoise = Math.max(1e-12, this.bandNoise[b]);
      const levelDb = 10 * Math.log10(power);
      const noiseDb = 10 * Math.log10(prevNoise);
      const gap = levelDb - noiseDb;

      if (!this.ready) {
        this.bandNoise[b] = power;
        this.bandGain[b] = 1;
        this.bandTarget[b] = 1;
        this.bandEnv[b] = levelDb;
        this.bandOpen[b] = 1;
        continue;
      }

      // Adaptive noise floor: follow quiet material relatively quickly, but do not chase strong signal.
      const quiet = gap <= thresholdDb + 1.0;
      const follow = quiet ? noiseFollowQuiet : noiseFollowActive;
      this.bandNoise[b] = Math.max(1e-12, prevNoise + (power - prevNoise) * follow);

      // Short envelope smoothing keeps noisy one-frame spikes from opening/closing the gate violently.
      this.bandEnv[b] += (levelDb - this.bandEnv[b]) * 0.22;
      const envGap = this.bandEnv[b] - 10 * Math.log10(Math.max(this.bandNoise[b], 1e-12));

      const openThreshold = thresholdDb + hysteresisDb;
      const closeThreshold = thresholdDb - hysteresisDb;
      if (this.bandOpen[b]) {
        if (envGap < closeThreshold) this.bandOpen[b] = 0;
      } else if (envGap > openThreshold) {
        this.bandOpen[b] = 1;
      }

      // Soft knee: fully open above threshold, progressive attenuation below it.
      const knee = 3.0;
      const noiseLikelihood = this.clamp((thresholdDb + knee - envGap) / knee, 0, 1);
      const closedBias = this.bandOpen[b] ? 0.18 : 1.0;
      const attenuationDb = Math.min(maxReductionDb, maxReductionDb * Math.pow(noiseLikelihood * closedBias, 1.25));
      const target = Math.pow(10, -attenuationDb / 20);

      // No positive gain is ever allowed.
      this.bandTarget[b] = this.clamp(target, Math.pow(10, -maxReductionDb / 20), 1);
      const speed = this.bandTarget[b] < this.bandGain[b] ? attack : release;
      this.bandGain[b] += (this.bandTarget[b] - this.bandGain[b]) * speed;
      this.bandGain[b] = this.clamp(this.bandGain[b], Math.pow(10, -maxReductionDb / 20), 1);
    }

    this.ready = true;
  }

  processChannel(ring, outRe, outIm) {
    for (let n = 0; n < this.N; n++) {
      const idx = (this.ringPos + n) % this.N;
      outRe[n] = ring[idx] * this.win[n];
      outIm[n] = 0;
    }
    this.fft(outRe, outIm);
    for (let k = 0; k < this.B; k++) {
      const g = this.bandGain[this.binBand[k]];
      outRe[k] *= g;
      outIm[k] *= g;
      if (k > 0 && k < this.B - 1) {
        const mirror = this.N - k;
        outRe[mirror] *= g;
        outIm[mirror] *= g;
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
      this.ringL[this.ringPos] = l;
      this.ringR[this.ringPos] = r;
      this.ringPos = (this.ringPos + 1) % this.N;
      this.samples++;

      if (this.samples >= this.N && ((this.samples - this.N) % this.H) === 0) {
        this.analyseFrame(amount);
        this.processChannel(this.ringL, this.tmpLr, this.tmpLi);
        this.processChannel(this.ringR, this.tmpRr, this.tmpRi);

        // Correct Hann/H=128 overlap-add normalization: steady-state sum(w^2) ~= 3.
        const olaScale = 1 / 3;
        for (let n = 0; n < this.N; n++) {
          this.olaL[n] += this.tmpLr[n] * this.win[n] * olaScale;
          this.olaR[n] += this.tmpRr[n] * this.win[n] * olaScale;
        }
        for (let n = 0; n < this.H; n++) {
          this.emitL[n] = this.olaL[n];
          this.emitR[n] = this.olaR[n];
        }
        this.olaL.copyWithin(0, this.H);
        this.olaR.copyWithin(0, this.H);
        this.olaL.fill(0, this.N - this.H);
        this.olaR.fill(0, this.N - this.H);
        this.push(this.emitL, this.emitR);
      }
    }

    this.pop(output, frames);
    return true;
  }
}

registerProcessor('myefx-denoise', MyEFXDenoiseProcessor);
