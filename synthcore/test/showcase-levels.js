// Renders every preset holding a 3-note chord (A2-E3-C4 region) for 5 s and reports peak,
// RMS, NaN count and stereo width, so new presets can be matched to the existing ones.
const fs=require('fs'),path=require('path');const src=f=>fs.readFileSync(path.join(__dirname,'..','src',f),'utf8');
const api=new Function(src('params.js')+'\nreturn {PARAMS,PIDX,FACTORY,factorySnapshot,buildWorkletHeader};')();
let Cls;class AWP{constructor(){this.port={postMessage(){},onmessage:null};}}
new Function('AudioWorkletProcessor','registerProcessor','sampleRate',api.buildWorkletHeader()+src('processor.js'))(AWP,(n,c)=>Cls=c,48000);
const only=process.argv[2];
const rows=[];
for(let k=0;k<api.FACTORY.length;k++){
  const f=api.FACTORY[k]; if(only&&!f.name.includes(only)) continue;
  const s=api.factorySnapshot(k);const p=new Cls({processorOptions:{values:api.PARAMS.map(q=>s[q.id])}});
  const mono=s.VOICE_MODE>0; const chord=mono?[45]:[57,60,64,67];
  chord.forEach(n=>p.handleMessage({type:'on',n,v:96,c:0}));
  const L=new Float32Array(128),R=new Float32Array(128);let pk=0,ss=0,n=0,nan=0,sd=0,sm=0;
  const blocks=Math.round(5*48000/128);
  for(let b=0;b<blocks;b++){ if(b===Math.round(4*48000/128)) chord.forEach(n=>p.handleMessage({type:'off',n,c:0}));
    p.process([],[[L,R]]);for(let i=0;i<128;i++){const l=L[i],r=R[i];if(!isFinite(l)||!isFinite(r)){nan++;continue;}
    if(b>48000*1/128){pk=Math.max(pk,Math.abs(l),Math.abs(r));ss+=(l*l+r*r)/2;n++;sd+=(l-r)*(l-r);sm+=(l+r)*(l+r);}}}
  rows.push([f.name,f.cat,pk,10*Math.log10(ss/n+1e-20),nan,Math.sqrt(sd/(sm+1e-20))]);
}
for(const r of rows) console.log(r[0].padEnd(18),r[1].padEnd(20),'peak',r[2].toFixed(3),'rms',r[3].toFixed(1).padStart(6),'dB','nan',r[4],'side/mid',r[5].toFixed(2));
