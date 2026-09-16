import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(root, 'app-final.js');
let src = fs.readFileSync(file, 'utf8');
if (!src.includes('DENOISE_REWRITE_V4')) throw new Error('DENOISE_REWRITE_V4 not embedded');
if (src.includes('DENOISE_RUNTIME_PROBE_V1')) process.exit(0);

src = src.replace(
  "const state={settings:DEFAULTS[0],bands:Array.from({length:K},mkBand),lastFreq:0,lastQ:0,warm:0,dFast:0,dSlow:0,tFast:0,tSlow:0,bandL:[0,0,0,0,0,0],bandR:[0,0,0,0,0,0]};",
  "const state={settings:DEFAULTS[0],bands:Array.from({length:K},mkBand),lastFreq:0,lastQ:0,warm:0,dFast:0,dSlow:0,tFast:0,tSlow:0,bandL:[0,0,0,0,0,0],bandR:[0,0,0,0,0,0],probeIn:0,probeOut:0,probeBlocks:0};"
);

src = src.replace(
  "        if(Math.abs(punch)>.0001||Math.abs(sustain)>.0001){",
  "        // DENOISE_RUNTIME_PROBE_V1: diagnostics only; no extra audio loop.\n        s.probeIn += (peak*peak-s.probeIn)*.08; s.probeOut += (denPeak*denPeak-s.probeOut)*.08; s.probeBlocks++;\n        if(Math.abs(punch)>.0001||Math.abs(sustain)>.0001){"
);

src = src.replace(
  "return{loaded:!!buffer,playing,loop,loopStart,loopEnd,delta,allBypass,graphReady:!!graph,graphMode,audioState:ctx?.state||'none',sampleRate:ctx?.sampleRate||0,anySolo,soloBands:",
  "return{denoiseProbe:graph?graph.stages.map(s=>({blocks:s.state.probeBlocks,inputRms:Math.sqrt(Math.max(0,s.state.probeIn)),outputRms:Math.sqrt(Math.max(0,s.state.probeOut))})):[],loaded:!!buffer,playing,loop,loopStart,loopEnd,delta,allBypass,graphReady:!!graph,graphMode,audioState:ctx?.state||'none',sampleRate:ctx?.sampleRate||0,anySolo,soloBands:"
);

fs.writeFileSync(file,src,'utf8');
console.log('Embedded DE-NOISE runtime probe V1');
