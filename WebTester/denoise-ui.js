(()=>{
const css=`.dn-adv{margin:8px 10px 10px;border-top:1px solid #26323e;padding-top:8px}.dn-head{display:flex;align-items:center;justify-content:space-between}.dn-title{font-size:10px;letter-spacing:.08em;color:#8996a4;font-weight:800}.dn-show,.dn-action{height:27px;padding:0 8px;border:1px solid #3a4a58;border-radius:7px;background:#10171f;color:#8998a6;font-size:10px;cursor:pointer}.dn-panel{display:none;margin-top:8px;padding:9px;border:1px solid #2d3945;border-radius:9px;background:#0d141b}.dn-panel.open{display:block}.dn-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.dn-control{min-width:0}.dn-control label{display:block;margin-bottom:4px;font-size:9px;color:#778693;letter-spacing:.05em}.dn-control input[type=range],.dn-control select{width:100%;height:26px}.dn-control select{border:1px solid #3a4a58;border-radius:7px;background:#111820;color:#cbd5dd;padding:0 6px;font-size:10px}.dn-read{float:right;color:#c9d4dc}.dn-row{display:flex;gap:6px;margin-top:8px}.dn-row button{flex:1}.dn-learn{border-color:#466b5a;background:#102019;color:#9fe0b7}.dn-learn.active{border-color:#74d49b;box-shadow:0 0 14px rgba(116,212,155,.13)}@media(max-width:700px){.dn-grid{grid-template-columns:1fr}}`;
const style=document.createElement('style');style.textContent=css;document.head.appendChild(style);
const mk=(tag,attrs={})=>{const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);return e};
const controls=(b)=>`
<div class="dn-grid">
 <div class="dn-control"><label>MODE</label><select id="dnMode${b}"><option value="1">Adaptive</option><option value="0">Manual</option></select></div>
 <div class="dn-control"><label>OPTIMIZE</label><select id="dnOptimize${b}"><option value="0">Dialogue</option><option value="1">Music</option></select></div>
 <div class="dn-control"><label>FILTER TYPE</label><select id="dnFilter${b}"><option value="0">Gentle</option><option value="1">Surgical</option></select></div>
 <div class="dn-control"><label>NOISE TYPE</label><select id="dnNoiseType${b}"><option value="0">Broadband</option><option value="1">Combined</option></select></div>
 <div class="dn-control"><label>THRESHOLD <span class="dn-read" id="dnThreshold${b}Out">0.0 dB</span></label><input id="dnThreshold${b}" type="range" min="-24" max="24" step="0.1" value="0"></div>
 <div class="dn-control"><label>REDUCTION <span class="dn-read" id="dnReduction${b}Out">12.0 dB</span></label><input id="dnReduction${b}" type="range" min="0" max="30" step="0.1" value="12"></div>
 <div class="dn-control"><label>ADAPTATION <span class="dn-read" id="dnAdapt${b}Out">1.0 s</span></label><input id="dnAdapt${b}" type="range" min="0.1" max="4" step="0.1" value="1"></div>
 <div class="dn-control"><label>SOFT KNEE <span class="dn-read" id="dnKnee${b}Out">25%</span></label><input id="dnKnee${b}" type="range" min="0" max="100" step="1" value="25"></div>
 <div class="dn-control"><label>ATTACK <span class="dn-read" id="dnAttack${b}Out">10 ms</span></label><input id="dnAttack${b}" type="range" min="1" max="100" step="1" value="10"></div>
 <div class="dn-control"><label>RELEASE <span class="dn-read" id="dnRelease${b}Out">120 ms</span></label><input id="dnRelease${b}" type="range" min="20" max="500" step="1" value="120"></div>
 <div class="dn-control"><label>MAX ATTENUATION <span class="dn-read" id="dnMaxAtt${b}Out">30.0 dB</span></label><input id="dnMaxAtt${b}" type="range" min="0" max="48" step="0.5" value="30"></div>
 <div class="dn-control"><label>DYNAMIC PROFILE</label><select id="dnDynamic${b}"><option value="1">ON</option><option value="0">OFF</option></select></div>
</div>
<div class="dn-row"><button class="dn-action dn-learn" id="dnLearn${b}" type="button">LEARN NOISE PROFILE</button><button class="dn-action" id="dnReset${b}" type="button">RESET ADVANCED</button></div>`;

document.querySelectorAll('.band').forEach((band,idx)=>{
 const b=idx+1;if(band.querySelector('.dn-adv'))return;
 const wrap=mk('div',{class:'dn-adv'});wrap.innerHTML=`<div class="dn-head"><span class="dn-title">DE-NOISE ADVANCED</span><button class="dn-show" type="button" data-dn-show="${b}">SHOW</button></div><div class="dn-panel" id="dnPanel${b}">${controls(b)}</div>`;
 band.appendChild(wrap);
});
document.querySelectorAll('[data-dn-show]').forEach(btn=>btn.addEventListener('click',()=>{const p=document.getElementById('dnPanel'+btn.dataset.dnShow);if(!p)return;const open=p.classList.toggle('open');btn.textContent=open?'HIDE':'SHOW'}));
})();
