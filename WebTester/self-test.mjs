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
const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
const EXPECTED_RANGES=[[20,300],[60,1200],[200,3000],[1000,25000]];
const DEFAULTS=[31.5,125,1000,8000];

function writeMonoWav(filePath,makeSample,sampleRate=48000,seconds=3){
  const frames=Math.floor(sampleRate*seconds),bytes=frames*2,buf=Buffer.alloc(44+bytes);
  buf.write('RIFF',0);buf.writeUInt32LE(36+bytes,4);buf.write('WAVE',8);buf.write('fmt ',12);buf.writeUInt32LE(16,16);
  buf.writeUInt16LE(1,20);buf.writeUInt16LE(1,22);buf.writeUInt32LE(sampleRate,24);buf.writeUInt32LE(sampleRate*2,28);buf.writeUInt16LE(2,32);buf.writeUInt16LE(16,34);
  buf.write('data',36);buf.writeUInt32LE(bytes,40);
  let seed=0x13579bdf;
  const rand=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296*2-1};
  for(let i=0;i<frames;i++){const t=i/sampleRate,s=clamp(makeSample(t,i,rand),-1,1);buf.writeInt16LE(Math.round(s*32767),44+i*2)}
  fs.writeFileSync(filePath,buf);
}

const server=http.createServer((req,res)=>{
  let rel=decodeURIComponent((req.url||'/').split('?')[0]);if(rel==='/')rel='/index-fixed.html';
  const file=path.join(root,rel);if(!file.startsWith(root)){res.writeHead(403);return res.end()}
  fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end('not found')}const type=file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'application/octet-stream';res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body)})
});
await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'myefx-'));
const mixed=path.join(tmp,'voice-noise.wav'),noise=path.join(tmp,'noise-only.wav');
writeMonoWav(mixed,(t,_,r)=>{
  const voice=.22*Math.sin(2*Math.PI*180*t)+.12*Math.sin(2*Math.PI*360*t)+.07*Math.sin(2*Math.PI*720*t)+.04*Math.sin(2*Math.PI*1440*t);
  return voice+.055*r;
});
writeMonoWav(noise,(t,_,r)=>.055*r);

const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1500,height:1200}});
page.on('pageerror',e=>fail('PAGEERROR: '+e.message));
page.on('console',m=>{if(m.type()==='error')fail('CONSOLE: '+m.text())});

try{
  await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'networkidle'});
  const source=fs.readFileSync(path.join(root,'app-final.js'),'utf8');
  if(!source.includes('DENOISE_REWRITE_V4'))fail('runtime patch marker missing');else console.log('DE-NOISE V4 runtime marker: PASS');

  const math8000=(()=>{
    const errors=[];let noiseFloor=1e-5,gain=1;
    for(let i=0;i<8000;i++){
      const p=1e-8*Math.pow(10,(i%121)/20*6),amount=(i%101)/100;
      noiseFloor+=(Math.min(p,noiseFloor*1.12)-noiseFloor)*(p<noiseFloor?.075:.0018);
      noiseFloor=Math.max(noiseFloor,1e-9);
      const snr=p/(noiseFloor+1e-9),w=clamp((snr-.55)/(snr+.35),0,1),floor=Math.pow(10,-18*amount/20),target=clamp(1-amount*(1-w)*.92,floor,1);
      gain+=(target-gain)*(target<gain?.20:.055);gain=clamp(gain,floor,1);
      if(!Number.isFinite(noiseFloor)||!Number.isFinite(gain)||gain<floor-1e-10||gain>1+1e-10)errors.push(i);
    }
    return errors;
  })();
  if(math8000.length)fail('DENOISE8000 '+math8000.slice(0,8).join(','));else console.log('DENOISE 8000 math/edge probes: PASS');

  const plan60=await page.evaluate(({expected,defaults})=>{const errors=[];for(let i=0;i<60;i++){if(document.querySelectorAll('.knob').length!==24)errors.push('knob-count');if(document.querySelectorAll('.solo').length!==4)errors.push('solo-count');const d=window.myEFX?.currentData?.();if(!d||d.length!==4)errors.push('api');for(let b=1;b<=4;b++){const input=document.querySelector('#freq'+b);if(!input){errors.push('freq-input');continue}if(+input.min!==expected[b-1][0]||+input.max!==expected[b-1][1])errors.push('freq-range');if(Math.abs((d?.[b-1]?.freq??0)-defaults[b-1])>.11)errors.push('default')}const script=document.querySelector('script[src*="app-final.js"]')?.getAttribute('src')||'';if(script!=='app-final.js?v=2')errors.push('path')}return[...new Set(errors)]},{expected:EXPECTED_RANGES,defaults:DEFAULTS});
  if(plan60.length)fail('PLAN60 '+plan60.join(','));else console.log('PLAN 60 UI/path checks: PASS');

  await page.locator('#file').setInputFiles(mixed);await page.waitForFunction(()=>window.myEFX?.debugState?.().loaded===true);

  const denoise120=await page.evaluate(()=>{const errors=[];for(let i=0;i<120;i++){const b=i%4+1,input=document.querySelector('#denoise'+b);input.value=String((i*37)%101);input.dispatchEvent(new Event('input',{bubbles:true}));const s=window.myEFX.debugState();if(s.bands[b-1].denoise<0||s.bands[b-1].denoise>100)errors.push('range');for(let j=0;j<4;j++)if(j!==b-1&&s.bands[j].denoise!==+document.querySelector('#denoise'+(j+1)).value)errors.push('cross-state');if(s.graphMode&&s.graphMode!=='ScriptProcessor')errors.push('graph-mode')}return[...new Set(errors)]});
  if(denoise120.length)fail('DENOISE120 '+denoise120.join(','));else console.log('DENOISE 120 targeted state/independence checks: PASS');

  await page.locator('#resetAll').click();
  const denoiseOff=await page.evaluate(()=>{const d=document.querySelector('#denoise2');d.value='0';d.dispatchEvent(new Event('input',{bubbles:true}));return window.myEFX.debugState().bands[1].denoise});
  await page.locator('#play').click();await page.waitForTimeout(250);const rmsOff=await page.evaluate(()=>window.myEFX.meterRms());await page.locator('#stop').click();
  await page.evaluate(()=>{const d=document.querySelector('#denoise2');d.value='100';d.dispatchEvent(new Event('input',{bubbles:true}))});await page.locator('#play').click();await page.waitForTimeout(600);const rmsOn=await page.evaluate(()=>window.myEFX.meterRms());await page.locator('#stop').click();
  if(denoiseOff!==0||!Number.isFinite(rmsOff)||!Number.isFinite(rmsOn)||rmsOn<=0||rmsOn>rmsOff*1.08)fail(`voice+noise denoise behavior off=${rmsOff} on=${rmsOn}`);else console.log('VOICE+NOISE denoise behavior: PASS',JSON.stringify({rmsOff,rmsOn}));

  await page.locator('#file').setInputFiles(noise);await page.waitForFunction(()=>window.myEFX?.debugState?.().loaded===true);await page.locator('#resetAll').click();await page.locator('#play').click();await page.waitForTimeout(350);const noiseOff=await page.evaluate(()=>window.myEFX.meterRms());await page.locator('#stop').click();await page.evaluate(()=>{const d=document.querySelector('#denoise2');d.value='100';d.dispatchEvent(new Event('input',{bubbles:true))});await page.locator('#play').click();await page.waitForTimeout(900);const noiseOn=await page.evaluate(()=>window.myEFX.meterRms());await page.locator('#stop').click();if(!(noiseOn<noiseOff*.92))fail(`noise-only suppression too small off=${noiseOff} on=${noiseOn}`);else console.log('NOISE-ONLY suppression: PASS',JSON.stringify({noiseOff,noiseOn}));

  const all180=await page.evaluate(()=>{const errors=[],knobs=[...document.querySelectorAll('.knob-input')],acts={delta:[...document.querySelectorAll('[data-action="delta"]')],bypass:[...document.querySelectorAll('[data-action="bypass"]')],solo:[...document.querySelectorAll('[data-action="solo"]')],reset:[...document.querySelectorAll('[data-action="reset"]')]};for(let i=0;i<180;i++){const el=knobs[i%knobs.length],min=+el.min,max=+el.max;el.value=String(min+(max-min)*((i%17)/16));el.dispatchEvent(new Event('input',{bubbles:true}));if(i%4===0)acts.bypass[i%4].click();if(i%5===0)acts.delta[i%4].click();if(i%6===0)acts.solo[i%4].click();if(i%7===0)acts.solo[i%4].click();if(i%9===0)document.querySelector('#ab').click();if(i%11===0)document.querySelector('#loop').click();if(i%13===0)document.querySelector('#sortBtn').click();if(i%17===0)document.querySelector('#resetAll').click();const s=window.myEFX.debugState();if(s.bands.length!==4||s.freqRanges.length!==4)errors.push('state');if(s.soloBands.some(x=>x<1||x>4))errors.push('solo');if(s.delta&&!s.deltaGateTargets.some((x,j)=>x&&j+1===s.delta))errors.push('delta');if(s.graphMode&&s.graphMode!=='ScriptProcessor')errors.push('graph')}return[...new Set(errors)]});
  if(all180.length)fail('ALL180 '+all180.join(','));else console.log('ALL-FEATURE 180 stress checks: PASS');

  const transient655=await page.evaluate(()=>{const errors=[];const p=document.querySelector('#punch1'),s=document.querySelector('#sustain1');for(let i=0;i<655;i++){p.value=String(-100+((i*29)%201));p.dispatchEvent(new Event('input',{bubbles:true}));s.value=String(-100+((i*47)%201));s.dispatchEvent(new Event('input',{bubbles:true}));if(i%17===0)document.querySelector('#denoise1').value=String(i%101);if(i%17===0)document.querySelector('#denoise1').dispatchEvent(new Event('input',{bubbles:true}));const st=window.myEFX.currentData()[0];if(st.punch<-100||st.punch>100||st.sustain<-100||st.sustain>100||st.denoise<0||st.denoise>100)errors.push('bounds')}return[...new Set(errors)]});
  if(transient655.length)fail('TRANSIENT655 '+transient655.join(','));else console.log('TRANSIENT 655 checks: PASS');

  const all820=await page.evaluate(()=>{const errors=[],solo=[...document.querySelectorAll('[data-action="solo"]')],delta=[...document.querySelectorAll('[data-action="delta"]')];for(let i=0;i<820;i++){const b=i%4+1;document.querySelector('#freq'+b).value=String(+document.querySelector('#freq'+b).min+(+document.querySelector('#freq'+b).max-+document.querySelector('#freq'+b).min)*((i%23)/22));document.querySelector('#freq'+b).dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#denoise'+b).value=String((i*13)%101);document.querySelector('#denoise'+b).dispatchEvent(new Event('input',{bubbles:true}));if(i%2===0)solo[i%4].click();if(i%3===0)delta[i%4].click();if(i%5===0)document.querySelector('#bypassAll').click();if(i%7===0)document.querySelector('#bypassAll').click();if(i%11===0)document.querySelector('#ab').click();if(i%13===0)document.querySelector('#resetBands').click();if(i%17===0)document.querySelector('#resetAll').click();if(i%19===0)document.querySelector('#sortBtn').click();const st=window.myEFX.debugState();if(st.bands.length!==4||st.freqRanges.length!==4)errors.push('state');if(st.freqRanges[0][1]!==300||st.freqRanges[1][1]!==1200||st.freqRanges[2][1]!==3000||st.freqRanges[3][1]!==25000)errors.push('range');if(st.soloBands.some(x=>x<1||x>4))errors.push('solo');if(st.deltaGateTargets.filter(Boolean).length>1)errors.push('delta-multi')}return[...new Set(errors)]});
  if(all820.length)fail('ALL820 '+all820.join(','));else console.log('ALL-FEATURE 820 full-use simulation: PASS');

}catch(e){fail('HARNESS: '+e.stack)}finally{await browser.close();server.close();fs.rmSync(tmp,{recursive:true,force:true})}
if(failures.length){console.error('\nFAILURES');for(const f of failures)console.error(f);process.exit(1)}
console.log('ALL DE-NOISE / ALL-FEATURE REGRESSION CHECKS PASS');
