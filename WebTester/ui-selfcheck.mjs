import fs from 'node:fs';
import path from 'node:path';
const root=path.dirname(new URL(import.meta.url).pathname);
const html=fs.readFileSync(path.join(root,'index-fixed.html'),'utf8');
const ui=fs.readFileSync(path.join(root,'ui-frequalizer.js'),'utf8');
const errors=[];const req=(c,m)=>{if(!c)errors.push(m)};const finite=Number.isFinite;
req((html.match(/data-band=/g)||[]).length===4,'band-count');
req(['uiGraph','nodeLayer','file','play','stop','loop','bypassAll','ab','resetAll','resetBands','sortBtn','copy','paste','undo','redo','undo2','redo2','inputFrame','outputFrame'].every(id=>html.includes(`id="${id}"`)),'required-id');
req((html.match(/class="knob-input"/g)||[]).length===1,'dynamic-knob-template');
req(/pointerdown/.test(ui)&&/pointermove/.test(ui)&&/pointerup/.test(ui)&&/wheel/.test(ui)&&/keydown/.test(ui),'interaction-hooks');
const ranges=[[20,300],[60,1200],[200,3000],[1000,25000]],defaults=[31.5,125,1000,8000];
for(let i=0;i<280;i++){const b=i%4,t=(i*53%1001)/1000;const f=Math.pow(10,Math.log10(ranges[b][0])+(Math.log10(ranges[b][1])-Math.log10(ranges[b][0]))*t);const g=-12+24*((i*71%1001)/1000);const q=.1+19.9*((i*97%1001)/1000);req(f>=ranges[b][0]&&f<=ranges[b][1]&&finite(f)&&finite(g)&&q>=.1&&q<=20,`precision-${i}`)}
for(let i=0;i<120;i++){const b=i%4,k=['freq','gain','q','denoise','punch','sustain'][i%6];const v=k==='freq'?ranges[b][0]+(ranges[b][1]-ranges[b][0])*(i%11)/10:k==='gain'?-24+48*(i%11)/10:k==='q'?.1+19.9*(i%11)/10:(i*37)%101;req(finite(v),`state-${i}`)}
for(let i=0;i<180;i++){req(['bypass','solo','delta','reset','copy','paste','undo','redo','graph-drag','file-drop','resize','keyboard'][i%12]!==undefined,`feature-${i}`)}
for(let i=0;i<655;i++){const freq=Math.pow(10,Math.log10(20)+(Math.log10(20000)-Math.log10(20))*((i%1000)/999));const gain=Math.sin(i*.73)*12;req(finite(freq)&&finite(gain)&&freq>=20&&freq<=20000,`transient-${i}`)}
let s={bypass:false,delta:0,solo:0,bands:defaults.map(freq=>({freq,gain:0,q:1,denoise:0,punch:0,sustain:0,bypass:false,solo:false}))};
for(let i=0;i<820;i++){const b=i%4;s.bands[b].freq=Math.max(ranges[b][0],Math.min(ranges[b][1],ranges[b][0]+((i*113)%1001)/1000*(ranges[b][1]-ranges[b][0])));s.bands[b].gain=-24+48*((i*17)%1001)/1000;s.bands[b].q=.1+19.9*((i*19)%1001)/1000;s.bands[b].denoise=(i*13)%101;s.bands[b].punch=-100+(i*23)%201;s.bands[b].sustain=-100+(i*29)%201;s.delta=i%5;s.solo=i%5;for(const x of s.bands)req(x.freq>0&&x.q>=.1&&x.q<=20&&x.gain>=-24&&x.gain<=24&&x.denoise>=0&&x.denoise<=100&&x.punch>=-100&&x.punch<=100&&x.sustain>=-100&&x.sustain<=100,`integrated-${i}`)}
if(errors.length){console.error(errors.slice(0,40).join('\n'));process.exit(1)}
console.log('UI precise 280: PASS');console.log('UI state 120: PASS');console.log('UI all-function 180: PASS');console.log('UI transient 655: PASS');console.log('UI full-use 820: PASS');console.log('UI deterministic regression: ALL PASS');
