const fs=require('fs'),path=require('path');const src=f=>fs.readFileSync(path.join(__dirname,'..','src',f),'utf8');
const api=new Function(src('params.js')+'\nreturn {PARAMS,PIDX,FACTORY,factorySnapshot,buildWorkletHeader};')();
let Cls;class AWP{constructor(){this.port={postMessage(){},onmessage:null};}}
new Function('AudioWorkletProcessor','registerProcessor','sampleRate',api.buildWorkletHeader()+src('processor.js'))(AWP,(n,c)=>Cls=c,48000);
for(let k=0;k<8;k++){const s=api.factorySnapshot(k);const p=new Cls({processorOptions:{values:api.PARAMS.map(q=>s[q.id])}});
p.handleMessage({type:'on',n:57,v:100,c:0});const L=new Float32Array(128),R=new Float32Array(128);let pk=0,ss=0,n=0;
for(let b=0;b<375;b++){p.process([],[[L,R]]);for(let i=0;i<128;i++){pk=Math.max(pk,Math.abs(L[i]),Math.abs(R[i]));ss+=L[i]*L[i];n++;}}
console.log(api.FACTORY[k].name.padEnd(10),'1-note peak',pk.toFixed(3),'rms dB',(10*Math.log10(ss/n)).toFixed(1));}
