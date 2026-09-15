/* myEFX stability + Delta + change-only processed spectrogram */
(function(){
 const $=id=>document.getElementById(id);
 let fastRenderTimer=0,fastRenderToken=0;
 const CUT=[54,190,235],BOOST=[255,150,54];
 function paintDiff(db){
   const a=Math.abs(db);
   if(a<0.45)return null;
   const strength=Math.min(1,(a-0.45)/7.5);
   const c=db<0?CUT:BOOST, k=0.35+0.65*strength;
   return `rgba(${c[0]},${c[1]},${c[2]},${k.toFixed(3)})`;
 }
 function drawChangeSpectrogram(input,output,canvas){
   if(!input||!output||!canvas)return;
   const token=++fastRenderToken,frame=512;
   const w=Math.max(640,Math.min(1000,Math.floor(canvas.clientWidth)));
   const h=Math.max(180,Math.min(360,Math.floor(canvas.clientHeight)));
   canvas.width=w;canvas.height=h;
   const g=canvas.getContext('2d',{alpha:false}),top=Math.min(86,Math.max(64,Math.round(h*.22))),specH=h-top;
   g.fillStyle='#02080c';g.fillRect(0,0,w,h);
   const inL=input.getChannelData(0),inR=input.numberOfChannels>1?input.getChannelData(1):inL;
   const outL=output.getChannelData(0),outR=output.numberOfChannels>1?output.getChannelData(1):outL;
   const inRe=new Float32Array(frame),inIm=new Float32Array(frame),outRe=new Float32Array(frame),outIm=new Float32Array(frame),win=new Float32Array(frame);
   for(let i=0;i<frame;i++)win[i]=.5-.5*Math.cos(2*Math.PI*i/(frame-1));
   let x=0;
   function paint(){
     if(token!==fastRenderToken)return;
     const end=Math.min(w,x+18);
     for(;x<end;x++){
       const center=Math.floor((x/Math.max(1,w-1))*Math.max(0,input.length-1));
       const start=center-(frame>>1);
       for(let n=0;n<frame;n++){
         const ii=Math.max(0,Math.min(input.length-1,start+n)),oi=Math.max(0,Math.min(output.length-1,start+n));
         inRe[n]=((inL[ii]+inR[ii])*.5)*win[n];inIm[n]=0;
         outRe[n]=((outL[oi]+outR[oi])*.5)*win[n];outIm[n]=0;
       }
       fft(inRe,inIm);fft(outRe,outIm);
       for(let y=top;y<h;y++){
         const f=20*Math.pow(1000,1-(y-top)/Math.max(1,specH-1));
         const bin=Math.max(1,Math.min(frame>>1,Math.round(f*frame/input.sampleRate)));
         const idb=20*Math.log10(Math.hypot(inRe[bin],inIm[bin])/frame+1e-8);
         const odb=20*Math.log10(Math.hypot(outRe[bin],outIm[bin])/frame+1e-8);
         const diff=odb-idb;
         const color=paintDiff(diff);
         if(color){g.fillStyle=color;g.fillRect(x,y,1,1)}
       }
     }
     if(x<w){requestAnimationFrame(paint);return;}
     if(typeof drawResponseOverlay==='function')drawResponseOverlay(g,w,h,top);
   }
   paint();
 }
 window.drawSpectrogram=function(audio,canvas){
   if(!audio||!canvas)return;
   const token=++fastRenderToken,frame=512,w=Math.max(640,Math.min(1000,Math.floor(canvas.clientWidth))),h=Math.max(180,Math.min(360,Math.floor(canvas.clientHeight)));
   canvas.width=w;canvas.height=h;
   const g=canvas.getContext('2d',{alpha:false}),top=Math.min(86,Math.max(64,Math.round(h*.22))),specH=h-top),dataL=audio.getChannelData(0),dataR=audio.numberOfChannels>1?audio.getChannelData(1):dataL;
   g.fillStyle='#02080c';g.fillRect(0,0,w,h);
   const re=new Float32Array(frame),im=new Float32Array(frame),win=new Float32Array(frame);
   for(let i=0;i<frame;i++)win[i]=.5-.5*Math.cos(2*Math.PI*i/(frame-1));
   let x=0;
   function paint(){if(token!==fastRenderToken)return;const end=Math.min(w,x+18);for(;x<end;x++){const center=Math.floor((x/Math.max(1,w-1))*Math.max(0,audio.length-1)),start=center-(frame>>1);for(let n=0;n<frame;n++){const idx=Math.max(0,Math.min(audio.length-1,start+n));re[n]=((dataL[idx]+dataR[idx])*.5)*win[n];im[n]=0}fft(re,im);for(let y=top;y<h;y++){const f=20*Math.pow(1000,1-(y-top)/Math.max(1,specH-1)),bin=Math.max(1,Math.min(frame>>1,Math.round(f*frame/audio.sampleRate))),db=20*Math.log10(Math.hypot(re[bin],im[bin])/frame+1e-8);g.fillStyle=`rgba(90,180,205,${Math.max(.10,Math.min(.9,(db+105)/50))})`;g.fillRect(x,y,1,1)}}if(x<w){requestAnimationFrame(paint);return}if(typeof drawResponseOverlay==='function')drawResponseOverlay(g,w,h,top)}paint();
 };
 window.scheduleProcessedRender=function(){
   if(!buffer)return;
   clearTimeout(fastRenderTimer);
   fastRenderTimer=setTimeout(async()=>{
     if(playing)return;
     const token=++fastRenderToken;
     try{
       $('status').textContent='分析實際變化中的頻率…';
       const out=await renderOffline();
       if(token!==fastRenderToken||playing||!out)return;
       drawChangeSpectrogram(buffer,out,$('specOut'));
       $('status').textContent='Processed Spectrogram：只顯示實際改動';
     }catch(e){console.warn(e);$('status').textContent='Processed Spectrogram 更新失敗：'+(e?.message||e)}
   },650);
 };
 window.buildPlayback=function(){disconnectAudio();source=ctx.createBufferSource();source.buffer=buffer;source.loop=loopEnabled;source.loopStart=0;source.loopEnd=buffer.duration;if(bypass){source.connect(ctx.destination);return}if(deltaBand>0){const s=stages[deltaBand-1];source.connect(s.prePass);source.connect(s.eq);try{s.deltaSum.disconnect()}catch{}s.deltaSum.connect(outputGain);outputGain.connect(analyser);analyser.connect(ctx.destination);return}let node=source;for(const s of stages){node.connect(s.eq);node=s.out}node.connect(outputGain);outputGain.connect(analyser);analyser.connect(ctx.destination)};
 window.setDelta=function(i){deltaBand=(deltaBand===i?0:i);document.querySelectorAll('[data-action="delta"]').forEach(b=>b.classList.toggle('active',+b.dataset.band===deltaBand));if(playing){const p=playOffset;stop();playOffset=p;start()}$('status').textContent=deltaBand?`DELTA B${deltaBand}：只聽該頻段 DELTA`:'Delta OFF'};
})();
