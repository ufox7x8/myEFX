class MyEFXDenoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'amount', defaultValue: 0, minValue: 0, maxValue: 100, automationRate: 'k-rate' },
      { name: 'threshold', defaultValue: 1.5, minValue: -12, maxValue: 12, automationRate: 'k-rate' },
      { name: 'reduction', defaultValue: 18, minValue: 0, maxValue: 24, automationRate: 'k-rate' },
      { name: 'adaptation', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' },
      { name: 'smoothing', defaultValue: 54, minValue: 0, maxValue: 100, automationRate: 'k-rate' },
      { name: 'transientProtect', defaultValue: 78, minValue: 0, maxValue: 100, automationRate: 'k-rate' },
      { name: 'tonalProtect', defaultValue: 28, minValue: 0, maxValue: 100, automationRate: 'k-rate' },
      { name: 'learn', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    this.N = 2048;
    this.H = 512;
    this.B = this.N / 2 + 1;
    this.win = new Float32Array(this.N);
    this.mid = new Float32Array(this.N);
    this.im = new Float32Array(this.N);
    this.re = new Float32Array(this.N);
    this.workIm = new Float32Array(this.N);
    this.tmp = new Float32Array(this.N);
    this.mag = new Float32Array(this.B);
    this.power = new Float32Array(this.B);
    this.smoothPower = new Float32Array(this.B);
    this.noisePower = new Float32Array(this.B);
    this.minPower = new Float32Array(this.B);
    this.prevCleanPower = new Float32Array(this.B);
    this.prevGain = new Float32Array(this.B);
    this.prevSpp = new Float32Array(this.B);
    this.prevMag = new Float32Array(this.B);
    this.mask = new Float32Array(this.B);
    this.ringL = new Float32Array(this.N);
    this.ringR = new Float32Array(this.N);
    this.ringPos = 0;
    this.samples = 0;
    this.frames = 0;
    this.olaL = new Float32Array(this.N);
    this.olaR = new Float32Array(this.N);
    this.emitL = new Float32Array(this.H);
    this.emitR = new Float32Array(this.H);
    this.queueSize = 65536;
    this.queueL = new Float32Array(this.queueSize);
    this.queueR = new Float32Array(this.queueSize);
    this.qRead = 0;
    this.qWrite = 0;
    this.win.fill(0);
    for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.N - 1));
    this.prevGain.fill(1);
    this.prevSpp.fill(1);
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
      const c = Math.cos(a), s = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let wr = 1, wi = 0;
        const half = len >> 1;
        for (let j = 0; j < half; j++) {
          const x = i + j, y = x + half;
          const vr = re[y] * wr - im[y] * wi;
          const vi = re[y] * wi + im[y] * wr;
          re[y] = re[x] - vr; im[y] = im[x] - vi;
          re[x] += vr; im[x] += vi;
          const tr = wr * c - wi * s;
          wi = wr * s + wi * c;
          wr = tr;
        }
      }
    }
    if (inverse) {
      const k = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= k; im[i] *= k; }
    }
  }

  e1(x) {
    x = Math.max(1e-8, x);
    if (x <= 1) {
      let sum = 0, term = 1;
      for (let k = 1; k <= 12; k++) {
        term *= -x / k;
        sum += term / k;
      }
      return -0.5772156649015329 - Math.log(x) - sum;
    }
    let term = 1, sum = 1;
    for (let k = 1; k <= 12; k++) {
      term *= -k / x;
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-5) break;
    }
    return Math.exp(-x) / x * sum;
  }

  clamp01(v) { return Math.max(0, Math.min(1, v)); }

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

  processChannel(ring, outRe, outIm) {
    for (let n = 0; n < this.N; n++) {
      const idx = (this.ringPos + n) % this.N;
      outRe[n] = ring[idx] * this.win[n];
      outIm[n] = 0;
    }
    this.fft(outRe, outIm, false);
    for (let k = 0; k < this.B; k++) {
      outRe[k] *= this.mask[k];
      outIm[k] *= this.mask[k];
    }
    for (let k = 1; k < this.B - 1; k++) {
      const mirror = this.N - k;
      outRe[mirror] *= this.mask[k];
      outIm[mirror] *= this.mask[k];
    }
    this.fft(outRe, outIm, true);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    if (!input.length || !input[0]?.length) return true;

    const frames = input[0].length;
    const channels = input.length;
    const amount = (parameters.amount?.[0] ?? 0) / 100;

    // True bypass: no FFT, no gain change, no hidden coloration.
    if (amount <= 0.0001) {
      for (let i = 0; i < frames; i++) {
        output[0][i] = input[0][i];
        if (output.length > 1) output[1][i] = channels > 1 ? input[1][i] : input[0][i];
      }
      return true;
    }

    const thresholdDb = parameters.threshold?.[0] ?? 1.5;
    const maxReductionDb = Math.max(0, Math.min(24, parameters.reduction?.[0] ?? 18));
    const adapt = Math.max(0.25, parameters.adaptation?.[0] ?? 1);
    const smooth = (parameters.smoothing?.[0] ?? 54) / 100;
    const transientProtect = (parameters.transientProtect?.[0] ?? 78) / 100;
    const tonalProtect = (parameters.tonalProtect?.[0] ?? 28) / 100;
    const learn = (parameters.learn?.[0] ?? 0) > 0.5;

    const freqSmooth = 0.10 + 0.22 * smooth;
    const timeSmooth = 0.08 + 0.18 * smooth;
    const minDecay = Math.exp(-1 / (sampleRate * (0.20 + 0.45 * adapt)));
    const noiseAttack = Math.exp(-1 / (sampleRate * (0.05 + 0.10 * adapt)));
    const noiseRelease = Math.exp(-1 / (sampleRate * (0.55 + 1.2 * adapt)));
    const minGain = Math.pow(10, -maxReductionDb / 20);

    for (let i = 0; i < frames; i++) {
      const l = input[0][i];
      const r = channels > 1 ? input[1][i] : l;
      this.ringL[this.ringPos] = l;
      this.ringR[this.ringPos] = r;
      this.ringPos = (this.ringPos + 1) % this.N;
      this.samples++;

      if (this.samples < this.N || ((this.samples - this.N) % this.H) !== 0) continue;

      for (let n = 0; n < this.N; n++) {
        const idx = (this.ringPos + n) % this.N;
        this.mid[n] = ((this.ringL[idx] + this.ringR[idx]) * 0.5) * this.win[n];
      }
      this.im.fill(0);
      this.fft(this.mid, this.im, false);

      let flux = 0;
      let total = 1e-12;
      for (let k = 0; k < this.B; k++) {
        const p = this.mid[k] * this.mid[k] + this.im[k] * this.im[k] + 1e-14;
        const m = Math.sqrt(p);
        this.power[k] = p;
        this.mag[k] = m;
        total += p;
        flux += Math.max(0, m - this.prevMag[k]);
      }
      const broadbandTransient = this.clamp01(flux / (Math.sqrt(total) * this.B) * 10);

      for (let k = 0; k < this.B; k++) {
        const p = this.power[k];
        if (this.frames === 0) {
          this.smoothPower[k] = p;
          this.minPower[k] = p;
          this.noisePower[k] = p;
        } else {
          this.smoothPower[k] = this.smoothPower[k] * (1 - freqSmooth) + p * freqSmooth;
          this.minPower[k] = Math.min(
            this.smoothPower[k] * 1.02,
            this.minPower[k] * Math.pow(minDecay, this.H) + this.smoothPower[k] * (1 - minDecay)
          );
          const current = this.noisePower[k];
          const target = Math.max(1e-14, this.minPower[k] * 1.18);
          const posterior = p / Math.max(current, 1e-14);
          const speechLike = posterior > 2.2;
          if (learn) {
            this.noisePower[k] = current * 0.995 + target * 0.005;
          } else if (!speechLike) {
            this.noisePower[k] = current * noiseAttack + target * (1 - noiseAttack);
          } else {
            this.noisePower[k] = current * noiseRelease + target * (1 - noiseRelease);
          }
        }
      }

      for (let k = 0; k < this.B; k++) {
        const p = this.power[k];
        const noise = Math.max(1e-14, this.noisePower[k]);
        const gamma = Math.max(0.05, p / noise);
        const prevClean = Math.max(1e-14, this.prevCleanPower[k]);
        const xiDD = 0.985 * prevClean / noise;
        const xiInst = Math.max(0, gamma - 1);
        const xi = Math.max(1e-4, 0.90 * xiDD + 0.10 * xiInst);

        // Balanced blend: decision-directed Wiener + log-MMSE style gain.
        const gw = xi / (1 + xi);
        const v = Math.max(1e-6, (gamma * xi) / (1 + xi));
        const glsa = this.clamp01((xi / (1 + xi)) * Math.exp(0.5 * this.e1(v)));
        let gain = 0.52 * gw + 0.48 * glsa;

        const gammaDb = 10 * Math.log10(gamma);
        const pSpeechRaw = 1 / (1 + Math.exp(-1.35 * (gammaDb - thresholdDb)));
        const pSpeech = this.prevSpp[k] * 0.70 + pSpeechRaw * 0.30;
        this.prevSpp[k] = pSpeech;
        gain = Math.pow(Math.max(1e-4, gain), 0.75 + 0.25 * pSpeech);

        const left = k > 0 ? this.power[k - 1] : p;
        const right = k + 1 < this.B ? this.power[k + 1] : p;
        const neighbor = (left + p + right) / 3;
        const support = neighbor / Math.max(p, 1e-14);
        const isolated = this.clamp01((0.62 - support) / 0.62);
        const transientBoost = broadbandTransient * (1 - transientProtect * 0.85) * (1 - isolated * 0.75);
        gain += (1 - gain) * transientBoost;

        const localPeak = p / Math.max(neighbor, 1e-14);
        const tonal = this.clamp01((localPeak - 1.22) / 0.90);
        gain += (1 - gain) * tonal * (1 - tonalProtect * 0.55) * pSpeech;

        const k0 = Math.max(0, k - 1), k1 = Math.min(this.B - 1, k + 1);
        const freqPrev = (this.prevGain[k0] + this.prevGain[k] + this.prevGain[k1]) / 3;
        gain = gain * (1 - timeSmooth) + freqPrev * timeSmooth;
        gain = Math.max(minGain, Math.min(1, gain));

        this.prevGain[k] = gain;
        this.prevCleanPower[k] = p * gain * gain;
        this.prevMag[k] = this.mag[k];
        this.mask[k] = 1 - amount * (1 - gain);
      }

      this.processChannel(this.ringL, this.re, this.workIm);
      for (let n = 0; n < this.N; n++) this.tmp[n] = this.re[n];
      this.processChannel(this.ringR, this.mid, this.im);

      const invWindowSum = 2 / 3;
      for (let n = 0; n < this.N; n++) {
        this.olaL[n] += this.tmp[n] * this.win[n] * invWindowSum;
        this.olaR[n] += this.mid[n] * this.win[n] * invWindowSum;
      }

      for (let n = 0; n < this.H; n++) {
        this.emitL[n] = this.olaL[n];
        this.emitR[n] = this.olaR[n];
      }
      this.olaL.copyWithin(0, this.H);
      this.olaR.copyWithin(0, this.H);
      this.olaL.fill(0, this.H);
      this.olaR.fill(0, this.H);

      this.push(this.emitL, this.emitR);
      this.frames++;
    }

    this.pop(output, frames);
    return true;
  }
}

registerProcessor('myefx-denoise', MyEFXDenoiseProcessor);
