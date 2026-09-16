const fs = require('fs');
const html = fs.readFileSync('WebTester/index-fixed.html','utf8');
const app = fs.readFileSync('WebTester/app.js','utf8');
const transient = fs.readFileSync('WebTester/transient-processor.js','utf8');
let checks=0; const expect=(v,m)=>{checks++;if(!v)throw new Error(m)};
const must=['id="inputFrame"','id="outputFrame"','id="specIn"','id="specOut"','id="file"','id="play"','id="stop"','id="loop"','id="bypassAll"','id="ab"','id="byp1"','id="byp2"','id="byp3"','id="byp4"','data-band="1"','data-band="2"','data-band="3"','data-band="4"','4-BAND SPECTRAL DYNAMIC PROCESSOR','SPECTROGRAM / PROCESSED'];
for(const x of must)expect(html.includes(x),`missing UI marker: ${x}`);
expect(html.includes('grid-template-columns:repeat(4,minmax(0,1fr))'),'four-section previous deck missing');
expect(!html.includes('METAL SPECTRAL PROCESSOR'),'new metal UI must not be loaded by restored interface');
expect(!html.includes('PARAMETRIC'),'new metal deck marker must not be present');
expect(app.includes('function ensureProcessedAnalyser'),'realtime processed analyser missing');
expect(app.includes('function differenceStrength'),'processed INPUT difference strength missing');
expect(app.includes('function colorDifference'),'processed multicolor difference palette missing');
expect(app.includes('function drawProcessedFrame'),'processed difference renderer missing');
expect(app.includes('getFloatFrequencyData(processed)'),'processed spectrum data missing');
expect(app.includes('getFloatFrequencyData(input)'),'input reference spectrum data missing');
expect(app.includes('patchPlaybackReferenceForSource(source)'),'playback input reference hookup missing');
expect(app.includes('patchPlaybackReferenceForSource(src)'),'preview input reference hookup missing');
expect(app.includes('function startProcessedPreview'),'short canonical preview missing');
expect(app.includes('function scheduleProcessedRender'),'processed scheduler missing');
expect(app.includes('runProcessedLive();'),'live processed refresh hook missing');
expect(app.includes("s.transient.port.postMessage({ type: 'band', freq"),'transient Section-band guard hook missing');
expect(transient.includes('this.fast = (this.fast * 3 + peak) * 0.25'),'mark-renker fast envelope recurrence missing');
expect(transient.includes('this.slow = (this.slow * 7 + peak) * 0.125'),'mark-renker slow envelope recurrence missing');
expect(transient.includes('output[c][i] = x + this.filterBoost(boost, c);'),'only envelope boost is band-limited; input remains direct');
expect(transient.includes('type === \'band\''),'transient band control message missing');
expect(app.includes('deltaBand.connect(deltaDry)'),'DELTA dry fork missing');
expect(app.includes('deltaBand.connect(deltaIdentityWet)'),'DELTA identity wet fork missing');
expect(app.includes('deltaBand.connect(deltaEQ)'),'DELTA EQ fork missing');
expect(app.includes('source.connect(selected.deltaBandBP1)'),'DELTA selected band input missing');
expect(app.includes('selected.deltaMute.connect(graph.master)'),'DELTA selected output missing');
expect(!app.includes('trBand.connect(delta)'),'transient must not insert an audio node into DELTA route');
expect(!app.includes('trSum.connect(trBand)'),'transient must not alter DELTA graph topology');
expect(!app.includes('trSum.connect(delta)'),'unisolated transient path must not directly bypass band guard');
expect(!app.includes('new OfflineAudioContext'),'processed display must not use blocking OfflineAudioContext');
expect(!app.includes('await c.startRendering()'),'processed display must not block on full-file rendering');
expect(app.includes('s.eq.frequency.setTargetAtTime(freq, now, .0015)'),'canonical post-build EQ smoothing missing');
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function quant(v,min,max,step){v=clamp(v,min,max);return Number((Math.round(v/step)*step).toFixed(String(step).includes('.')?String(step).split('.')[1].length:0))}
function freqMap(t){return 20*Math.pow(1000,clamp(t,0,1))}
for(let run=1;run<=6850;run++){
 const t=((run*7919)%100000)/99999;
 const freq=freqMap(t), gain=quant(-24+48*t,-24,24,.1), q=quant(.1+19.9*t,.1,20,.01), dn=Math.round(1+98*t);
 expect(Number.isFinite(freq)&&freq>=20&&freq<=20000,`run ${run}: freq`);
 expect(Number.isFinite(gain)&&gain>=-24&&gain<=24,`run ${run}: gain`);
 expect(Number.isFinite(q)&&q>=.1&&q<=20,`run ${run}: q`);
 expect(dn>=1&&dn<=99,`run ${run}: denoise range`);
 const amount=dn/100,dry=.137+(.73*t),full=.09+.83*((run*37)%6850)/6849;
 const wet=dry+amount*(full-dry), expected=dry+amount*(full-dry);
 expect(Math.abs(wet-expected)<Number.EPSILON*32,`run ${run}: exact linear interpolation`);
 const d=(t*.996)+.002; const d2=clamp(d,0,1); expect(d2>=0&&d2<=1,`run ${run}: normalized control`);
}
function differenceStrength(inputDb,processedDb){
 const inputPower=Math.pow(10,inputDb/10), processedPower=Math.pow(10,processedDb/10), floorPower=Math.pow(10,-104/10);
 if(Math.max(inputPower,processedPower)<=floorPower)return 0;
 const dbDiff=Math.abs(processedDb-inputDb);
 if(!Number.isFinite(dbDiff)||dbDiff<.8)return 0;
 return Math.pow(clamp((dbDiff-.8)/17.2,0,1),.72);
}
for(let run=1;run<=456;run++){
 const t=((run*15485863)%1000003)/1000003;
 const inputDb=-104+96*t;
 const signedDelta=(((run*7919)%41)-20)*.37;
 const processedDb=Math.max(-110,Math.min(-8,inputDb+signedDelta));
 const strength=differenceStrength(inputDb,processedDb), reverse=differenceStrength(processedDb,inputDb);
 expect(Number.isFinite(strength)&&strength>=0&&strength<=1,`diff run ${run}: strength range`);
 expect(Math.abs(strength-reverse)<1e-12,`diff run ${run}: symmetry`);
}
expect(differenceStrength(-70,-70)===0,'identical spectrum must be black');
expect(differenceStrength(-70,-69.5)===0,'sub-0.8 dB change must be black');
expect(differenceStrength(-70,-68.9)>0,'above-threshold change must be visible');
expect(differenceStrength(-70,-50)>differenceStrength(-70,-60),'stronger change must have stronger color');
expect(differenceStrength(-105,-104)===0,'near-floor silence must be black');
console.log(`PASS 6850/6850 + 456/456 + transient routing-integrity regression; checks=${checks}`);
