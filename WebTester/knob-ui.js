/* Universal knob UI for the 8-band section controls. */
(function(){
  const $=id=>document.getElementById(id);
  const keys=['freq','gain','q','denoise','punch','sustain'];
  function stepFor(id){
    if(id.startsWith('freq'))return 1;
    if(id.startsWith('gain'))return .1;
    if(id.startsWith('q'))return .01;
    return 1;
  }
  function format(id,v){
    const n=Number(v);
    if(id.startsWith('freq')) return n>=1000?`${(n/1000).toFixed(n>=10000?1:2)} kHz`:`${n%1?n.toFixed(1):Math.round(n)} Hz`;
    if(id.startsWith('gain')) return `${n.toFixed(1)} dB`;
    if(id.startsWith('q')) return n.toFixed(2);
    return `${Math.round(n)}%`;
  }
  function angle(input){
    const min=Number(input.min),max=Number(input.max),v=Number(input.value);
    return -135+270*((v-min)/Math.max(1,max-min));
  }
  function render(input){
    const knob=document.querySelector(`.knob[data-target="${input.id}"]`); if(!knob)return;
    const pointer=knob.querySelector('.knob-pointer');
    if(pointer)pointer.style.transform=`translateX(-50%) rotate(${angle(input)}deg)`;
    const out=$(input.id+'Out'); if(out)out.textContent=format(input.id,input.value);
  }
  function setValue(input,v){
    const min=Number(input.min),max=Number(input.max),step=Number(input.step)||stepFor(input.id);
    const decimals=(String(step).split('.')[1]||'').length;
    v=Math.max(min,Math.min(max,v));
    v=Number((Math.round(v/step)*step).toFixed(decimals));
    input.value=String(v);
    input.dispatchEvent(new Event('input',{bubbles:true}));
    render(input);
  }
  function init(){
    document.querySelectorAll('.knob[data-target]').forEach(knob=>{
      const input=$(knob.dataset.target); if(!input)return;
      let active=false,startY=0,startValue=0;
      render(input);
      knob.addEventListener('pointerdown',e=>{
        active=true;startY=e.clientY;startValue=Number(input.value);
        knob.setPointerCapture?.(e.pointerId);e.preventDefault();
      });
      knob.addEventListener('pointermove',e=>{
        if(!active)return;
        const range=Number(input.max)-Number(input.min);
        const sensitivity=range/190;
        setValue(input,startValue+(startY-e.clientY)*sensitivity);
        e.preventDefault();
      });
      const end=e=>{if(!active)return;active=false;try{knob.releasePointerCapture?.(e.pointerId)}catch{}};
      knob.addEventListener('pointerup',end);knob.addEventListener('pointercancel',end);
      knob.addEventListener('wheel',e=>{
        e.preventDefault();
        setValue(input,Number(input.value)+(e.deltaY<0?stepFor(input.id):-stepFor(input.id)));
      },{passive:false});
      knob.addEventListener('dblclick',e=>{
        e.preventDefault();
        setValue(input,input.id.startsWith('freq')?Number(input.defaultValue):input.id.startsWith('q')?1:0);
      });
      knob.addEventListener('keydown',e=>{
        const s=stepFor(input.id);let v=Number(input.value);
        if(e.key==='ArrowUp'||e.key==='ArrowRight')v+=s;
        else if(e.key==='ArrowDown'||e.key==='ArrowLeft')v-=s;
        else if(e.key==='Home')v=Number(input.min);
        else if(e.key==='End')v=Number(input.max);
        else if(e.key==='Enter')v=input.id.startsWith('freq')?Number(input.defaultValue):input.id.startsWith('q')?1:0;
        else return;
        e.preventDefault();setValue(input,v);
      });
      input.addEventListener('input',()=>render(input));
      input.addEventListener('change',()=>render(input));
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
