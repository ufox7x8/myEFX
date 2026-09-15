/* myEFX stability / delta patch
   Keeps the existing DSP/UI, but prevents full-track spectral rendering from blocking input/playback.
*/
(function(){
  const $=id=>document.getElementById(id);
  let fastRenderTimer=0;
  let fastRenderToken=0;

  function fastSpecColor(v){
    const x=Math.max(0,Math.min(1,v));
    let r=Math.floor(255*Math.min(1,Math.max(0,(x-.64)*3.1)));
    let g=Math.floor(255*Math.min(1,Math.max(0,(x-.30)*2.2)));
    let b=Math.floor(255*Math.min(1,Math.max(0,(x-.05)*2.8)));
    if(x<.16){r*=.22;g*=.28;b*=.42}
    return`rgb(${r|0},${g|0},${b|0})`;
  }

  // Low-cost, chunked spectrogram. It deliberately yields to the browser between chunks.
  window.drawSpectrogram=function(audio,canvas){
    if(!audio||!canvas)return;
    const token=++fastRenderToken;
    const frame=512;
    const w=Math.max(640,Math.min(1000,Math.floor(canvas.clientWidth)));
    const h=Math.max(180,Math.min(360,Math.floor(canvas.clientHeight)));
    canvas.width=w; canvas.height=h;
    const g=canvas.getContext('2d',{alpha:false});
    const left=0;
    const top=Math.min(86,Math.max(64,Math.round(h*.22)));
    const specH=h-top;
    const dataL=audio.getChannelData(0);
    const dataR=audio.numberOfChannels>1?audio.getChannelData(1):dataL;
    const re=new Float32Array(frame), im=new Float32Array(frame), win=new Float32Array(frame);
    for(let i=0;i<frame;i++)win[i]=.5-.5*Math.cos(2*Math.PI*i/(frame-1));
    g.fillStyle='#02080c';g.fillRect(0,0,w,h);
    const minDb=-105,maxDb=-24;
    let x=0;
    const chunk=24;
    function paint(){
      if(token!==fastRenderToken)return;
      const end=Math.min(w,x+chunk);
      for(;x<end;x++){
        const center=Math.floor((x/Math.max(1,w-1))*Math.max(0,audio.length-1));
        const start=center-(frame>>1);
        for(let n=0;n<frame;n++){
          const idx=Math.max(0,Math.min(audio.length-1,start+n));
          re[n]=((dataL[idx]+dataR[idx])*.5)*win[n];
          im[n]=0;
        }
        window.fft(re,im);
        for(let y=top;y<h;y++){
          const f=20*Math.pow(1000,1-(y-top)/Math.max(1,specH-1));
          const bin=Math.max(1,Math.min(frame>>1,Math.round(f*frame/audio.sampleRate)));
          const mag=Math.hypot(re[bin],im[bin])/frame;
          const db=20*Math.log10(mag+1e-8);
          g.fillStyle=fastSpecColor((db-minDb)/(maxDb-minDb));
          g.fillRect(x,y,1,1);
        }
      }
      if(x<w){requestAnimationFrame(paint);return;}
      // Re-use the existing MAAT-style response overlay after the spectrogram is complete.
      if(typeof window.drawResponseOverlay==='function')window.drawResponseOverlay(g,w,h,top);
    }
    paint();
  };

  // Heavy processed re-renders never run while playback is active, and are debounced.
  window.scheduleProcessedRender=function(){
    if(!window.buffer)return;
    clearTimeout(fastRenderTimer);
    fastRenderTimer=setTimeout(async()=>{
      if(window.playing){return;}
      try{
        const status=$('status');
        if(status)status.textContent='重新分析 processed spectrogram…';
        if(typeof window.renderOffline!=='function')return;
        const out=await window.renderOffline();
        if(out&&window.playing===false)window.drawSpectrogram(out,$('specOut'));
        if(status)status.textContent='Processed spectrogram 已更新';
      }catch(e){
        console.warn(e);
        const status=$('status');
        if(status)status.textContent='Processed spectrogram 更新失敗：'+(e?.message||e);
      }
    },500);
  };

  // Delta = ONLY the selected band's processed signal minus that band's raw band-pass signal.
  // No other bands are inserted into the output graph.
  window.buildPlayback=function(){
    if(typeof window.disconnectAudio==='function')window.disconnectAudio();
    window.source=window.ctx.createBufferSource();
    window.source.buffer=window.buffer;
    window.source.loop=window.loopEnabled;
    window.source.loopStart=0;
    window.source.loopEnd=window.buffer.duration;
    if(window.bypass){window.source.connect(window.ctx.destination);return;}

    if(window.deltaBand>0){
      const s=window.stages[window.deltaBand-1];
      window.source.connect(s.prePass);
      window.source.connect(s.eq);
      // selected-band post-processing minus selected-band raw input
      try{s.deltaSum.disconnect()}catch{}
      s.deltaSum.connect(window.outputGain);
      window.outputGain.connect(window.analyser);
      window.analyser.connect(window.ctx.destination);
      return;
    }

    let node=window.source;
    for(const s of window.stages){node.connect(s.eq);node=s.out;}
    node.connect(window.outputGain);
    window.outputGain.connect(window.analyser);
    window.analyser.connect(window.ctx.destination);
  };

  window.setDelta=function(i){
    window.deltaBand=(window.deltaBand===i?0:i);
    document.querySelectorAll('[data-action="delta"]').forEach(b=>b.classList.toggle('active',+b.dataset.band===window.deltaBand));
    if(window.playing){
      const p=window.playOffset;
      window.stop();
      window.playOffset=p;
      window.start();
    }
    const status=$('status');
    if(status)status.textContent=window.deltaBand?`DELTA B${window.deltaBand}：只聽該頻段 DELTA`:'Delta OFF';
  };
})();
