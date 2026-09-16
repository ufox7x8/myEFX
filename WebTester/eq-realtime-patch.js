const fs=require('fs');const p='WebTester/app.js';let s=fs.readFileSync(p,'utf8');
const pairs=[
['s.eq.frequency.setTargetAtTime(freq, now, .004)','s.eq.frequency.setTargetAtTime(freq, now, .0015)'],
['s.eq.Q.setTargetAtTime(q, now, .004)','s.eq.Q.setTargetAtTime(q, now, .0015)'],
['s.eq.gain.setTargetAtTime(b.bypass ? 0 : b.gain, now, .004)','s.eq.gain.setTargetAtTime(b.bypass ? 0 : b.gain, now, .0015)'],
['s.split.frequency.setTargetAtTime(freq, now, .004)','s.split.frequency.setTargetAtTime(freq, now, .0015)'],
['s.split.Q.setTargetAtTime(clamp(q, .25, 18), now, .004)','s.split.Q.setTargetAtTime(clamp(q, .25, 18), now, .0015)'],
['s.deltaBandBP1.frequency.setTargetAtTime(freq, now, .004)','s.deltaBandBP1.frequency.setTargetAtTime(freq, now, .0015)'],
['s.deltaBandBP1.Q.setTargetAtTime(q, now, .004)','s.deltaBandBP1.Q.setTargetAtTime(q, now, .0015)'],
['s.deltaBandBP2.frequency.setTargetAtTime(freq, now, .004)','s.deltaBandBP2.frequency.setTargetAtTime(freq, now, .0015)'],
['s.deltaBandBP2.Q.setTargetAtTime(q, now, .004)','s.deltaBandBP2.Q.setTargetAtTime(q, now, .0015)'],
['s.deltaEQ.frequency.setTargetAtTime(freq, now, .004)','s.deltaEQ.frequency.setTargetAtTime(freq, now, .0015)'],
['s.deltaEQ.Q.setTargetAtTime(q, now, .004)','s.deltaEQ.Q.setTargetAtTime(q, now, .0015)'],
['s.deltaEQ.gain.setTargetAtTime(b.bypass ? 0 : b.gain, now, .004)','s.deltaEQ.gain.setTargetAtTime(b.bypass ? 0 : b.gain, now, .0015)']
];
for(const [a,b] of pairs){if(!s.includes(a))throw new Error('Missing EQ target: '+a);s=s.replaceAll(a,b)}
if(/createDelay\([^)]*\)/.test(s)&&/const eq =/.test(s)){} // DELTA may use a compensation delay; EQ path itself must not.
fs.writeFileSync(p,s,'utf8');console.log('EQ realtime smoothing set to 1.5 ms');