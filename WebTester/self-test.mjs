import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = 4173;
const failures = [];
const fail = msg => failures.push(msg);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const EXPECTED_RANGES = [[20,300],[60,1200],[200,3000],[1000,25000]];
const DEFAULTS = [31.5,125,1000,8000];

function wavFile(filePath, sampleRate = 48000, seconds = 1.5) {
  const frames = Math.floor(sampleRate * seconds), bytes = frames * 2, buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF',0); buf.writeUInt32LE(36 + bytes,4); buf.write('WAVE',8); buf.write('fmt ',12); buf.writeUInt32LE(16,16);
  buf.writeUInt16LE(1,20); buf.writeUInt16LE(1,22); buf.writeUInt32LE(sampleRate,24); buf.writeUInt32LE(sampleRate*2,28); buf.writeUInt16LE(2,32); buf.writeUInt16LE(16,34);
  buf.write('data',36); buf.writeUInt32LE(bytes,40);
  for (let i=0;i<frames;i++){const t=i/sampleRate,s=0.25*Math.sin(2*Math.PI*1000*t)+0.08*Math.sin(2*Math.PI*440*t);buf.writeInt16LE(Math.round(clamp(s,-1,1)*32767),44+i*2)}
  fs.writeFileSync(filePath,buf);
}
const server=http.createServer((req,res)=>{
  let rel=decodeURIComponent((req.url||'/').split('?')[0]); if(rel==='/') rel='/index-fixed.html';
  const file=path.join(root,rel); if(!file.startsWith(root)){res.writeHead(403);return res.end()}
  fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end('not found')}const type=file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'application/octet-stream';res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body)})
});
await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'myefx-')),wav=path.join(tmp,'tone.wav');wavFile(wav);
const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1500,height:1200}});
page.on('pageerror',e=>fail('PAGEERROR: '+e.message));page.on('console',m=>{if(m.type()==='error')fail('CONSOLE: '+m.text())});
try{
  await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'networkidle'});
  const plan60=await page.evaluate(({expected,defaults})=>{const errors=[];for(let i=0;i<60;i++){if(document.querySelectorAll('.knob').length!==24)errors.push('knob-count');if(document.querySelectorAll('.solo').length!==4)errors.push('solo-count');const d=window.myEFX?.currentData?.();if(!d||d.length!==4)errors.push('api');for(let b=1;b<=4;b++){const input=document.querySelector('#freq'+b);if(!input){errors.push('freq-input');continue}if(+input.min!==expected[b-1][0]||+input.max!==expected[b-1][1])errors.push('freq-range');if(Math.abs((d?.[b-1]?.freq??0)-defaults[b-1])>.11)errors.push('default')}const script=document.querySelector('script[src*="app-final.js"]')?.getAttribute('src')||'';if(script!=='app-final.js?v=2')errors.push('path')}return[...new Set(errors)]},{expected:EXPECTED_RANGES,defaults:DEFAULTS});
  if(plan60.length)fail('PLAN60 '+plan60.join(','));else console.log('PLAN 60 precision/range/path checks: PASS');
  await page.locator('#file').setInputFiles(wav);await page.waitForFunction(()=>window.myEFX?.debugState?.().loaded===true);
  const targeted50=await page.evaluate(({expected})=>{const errors=[];for(let i=0;i<50;i++){const band=i%4+1,input=document.querySelector('#freq'+band),[min,max]=expected[band-1],value=min+(max-min)*((i%11)/10);input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));const state=window.myEFX.debugState();if(state.bands[band-1].freq<min||state.bands[band-1].freq>max)errors.push('freq-clamp');if(state.freqRanges[band-1][0]!==min||state.freqRanges[band-1][1]!==max)errors.push('freq-map');document.querySelector('#solo'+band).click();const afterSolo=window.myEFX.debugState();if(!afterSolo.soloBands.includes(band))errors.push('solo-on');document.querySelector('#solo'+band).click();const afterUnsolo=window.myEFX.debugState();if(afterUnsolo.soloBands.includes(band))errors.push('solo-off')}return[...new Set(errors)]},{expected:EXPECTED_RANGES});
  if(targeted50.length)fail('STAGE1 '+targeted50.join(','));else console.log('STAGE1 50 targeted frequency + SOLO checks: PASS');
  const stage2=await page.evaluate(()=>{const errors=[],knobs=[...document.querySelectorAll('.knob-input')],buttons={delta:[...document.querySelectorAll('[data-action="delta"]')],bypass:[...document.querySelectorAll('[data-action="bypass"]')],solo:[...document.querySelectorAll('[data-action="solo"]')],reset:[...document.querySelectorAll('[data-action="reset"]')]};for(let i=0;i<480;i++){const el=knobs[i%knobs.length],min=+el.min,max=+el.max;el.value=String(min+(max-min)*((i%19)/18));el.dispatchEvent(new Event('input',{bubbles:true}));if(i%5===0)buttons.bypass[i%4].click();if(i%7===0)buttons.delta[i%4].click();if(i%9===0)buttons.solo[i%4].click();if(i%11===0)buttons.solo[i%4].click();if(i%13===0)buttons.reset[i%4].click();if(i%17===0)document.querySelector('#bypassAll').click();if(i%19===0)document.querySelector('#loop').click();if(i%23===0)document.querySelector('#ab').click();if(i%29===0)document.querySelector('#sortBtn').click();if(i%31===0)document.querySelector('#resetBands').click();if(i%37===0)document.querySelector('#resetAll').click();const s=window.myEFX.debugState();if(s.bands.length!==4)errors.push('bands');if(s.freqRanges.length!==4)errors.push('ranges');if(s.soloBands.some(x=>x<1||x>4))errors.push('solo-range');if(s.activeBands.some(x=>x<1||x>4))errors.push('active-range');if(s.graphReady&&s.graphMode!=='ScriptProcessor')errors.push('graph')}return[...new Set(errors)]});
  if(stage2.length)fail('STAGE2 '+stage2.join(','));else console.log('STAGE2 480 all-feature stress iterations: PASS');
  await page.locator('#resetAll').click();await page.locator('#play').click();await page.waitForTimeout(350);const play=await page.evaluate(()=>({state:window.myEFX.debugState(),rms:window.myEFX.meterRms()}));console.log('PLAYBACK',JSON.stringify(play));if(!play.state.graphReady||!play.state.playing||play.rms<=1e-5)fail('playback failed: '+JSON.stringify(play));
  const realGraphCheck=await page.evaluate(({expected})=>{const errors=[];for(let b=1;b<=4;b++){const input=document.querySelector('#freq'+b);input.value=String(expected[b-1][1]);input.dispatchEvent(new Event('input',{bubbles:true}))}const s=window.myEFX.debugState();for(let b=0;b<4;b++){const lo=expected[b][0],hi=Math.min(expected[b][1],s.sampleRate/2-.1),actual=s.graphFreqs[b];if(!(actual>=lo&&actual<=hi))errors.push('band-freq-'+(b+1))}return{errors,graphFreqs:s.graphFreqs,ranges:s.freqRanges,sampleRate:s.sampleRate}},{expected:EXPECTED_RANGES});console.log('REAL BANDPASS CHECK',JSON.stringify(realGraphCheck));if(realGraphCheck.errors.length)fail('real BandPass frequency check failed: '+JSON.stringify(realGraphCheck));
  const soloCheck=await page.evaluate(()=>{const gains=['#gain1','#gain2','#gain3','#gain4'].map(s=>document.querySelector(s));gains.forEach(g=>{g.value='12';g.dispatchEvent(new Event('input',{bubbles:true}))});document.querySelector('#solo3').click();const s=window.myEFX.debugState(),expected=JSON.stringify(s.activeBands)===JSON.stringify([3])&&JSON.stringify(s.normalGateTargets)===JSON.stringify([0,0,1,0]);document.querySelector('#solo3').click();return{expected,activeBands:s.activeBands,normalGateTargets:s.normalGateTargets}});console.log('SOLO GATE CHECK',JSON.stringify(soloCheck));if(!soloCheck.expected)fail('solo gate failed: '+JSON.stringify(soloCheck));
  await page.locator('#stop').click();await page.locator('#resetAll').click();await page.evaluate(()=>{const g=document.querySelector('#gain3');g.value='12';g.dispatchEvent(new Event('input',{bubbles:true}));document.querySelectorAll('[data-action="delta"]')[2].click()});await page.locator('#play').click();await page.waitForTimeout(220);const delta=await page.evaluate(()=>({state:window.myEFX.debugState(),rms:window.myEFX.meterRms()}));console.log('DELTA',JSON.stringify(delta));if(!delta.state.playing||delta.state.delta!==3||delta.rms<=1e-7)fail('delta failed: '+JSON.stringify(delta));
  const frame=page.locator('#inputFrame'),box=await frame.boundingBox();if(!box)fail('frame missing');else{await page.mouse.move(box.x+box.width*.2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width*.7,box.y+box.height/2);await page.mouse.up();await page.waitForTimeout(30);const s=await page.evaluate(()=>window.myEFX.debugState());if(!s.loop||s.loopEnd<=s.loopStart)fail('drag-loop failed')}
  const stage3=await page.evaluate(()=>{const errors=[],solo=[...document.querySelectorAll('[data-action="solo"]')];for(let i=0;i<320;i++){if(i%2===0)solo[i%4].click();if(i%3===0)document.querySelector('[data-action="delta"]').click();if(i%5===0)document.querySelector('#bypassAll').click();if(i%7===0)document.querySelector('#bypassAll').click();if(i%11===0)document.querySelector('#ab').click();if(i%13===0)document.querySelector('#sortBtn').click();if(i%17===0)document.querySelector('#resetAll').click();if(i%19===0)document.querySelector('#stop').click();if(i%23===0)document.querySelector('#loop').click();const s=window.myEFX.debugState();if(s.bands.length!==4)errors.push('state');if(s.freqRanges[0][1]!==300||s.freqRanges[1][1]!==1200||s.freqRanges[2][1]!==3000||s.freqRanges[3][1]!==25000)errors.push('range');if(s.soloBands.some(x=>x<1||x>4))errors.push('solo')}return[...new Set(errors)]});
  if(stage3.length)fail('STAGE3 '+stage3.join(','));else console.log('STAGE3 320 final regression iterations: PASS');
  await page.locator('#stop').click();
}catch(e){fail('HARNESS: '+e.stack)}finally{await browser.close();server.close();fs.rmSync(tmp,{recursive:true,force:true})}
if(failures.length){console.error('\nFAILURES');for(const f of failures)console.error(f);process.exit(1)}
console.log('ALL 850 TEST ITERATIONS PASS (PLAN60 + 50 + 480 + 320)');
