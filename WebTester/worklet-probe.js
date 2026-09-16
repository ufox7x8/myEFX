class MyEFXProbeProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || !input.length || !output.length) return true;
    for (let c = 0; c < Math.min(input.length, output.length); c++) output[c].set(input[c]);
    return true;
  }
}
registerProcessor('myefx-probe', MyEFXProbeProcessor);
