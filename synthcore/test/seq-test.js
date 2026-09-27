const fs=require('fs'),path=require('path');const src=f=>fs.readFileSync(path.join(__dirname,'..','src',f),'utf8');
const api=new Function(src('params.js')+'\nreturn {PARAMS,PIDX,buildWorkletHeader};')();
let Cls;class AWP{constructor(){this.port={postMessage(){},onmessage:null};}}
new Function('AudioWorkletProcessor','registerProcessor','sampleRate',api.buildWorkletHeader()+src('processor.js'))(AWP,(n,c)=>Cls=c,48000);
const P=api.PIDX;let fail=false;const ok=(c,m)=>{console.log((c?'ok  ':'FAIL')+' '+m);if(!c)fail=true;};
function mk(bpm){const v=api.PARAMS.map(p=>p.def);v[P.BPM]=bpm;const p=new Cls({processorOptions:{values:v}});const log=[];let t=0;
 const on=p.pool.noteOn.bind(p.pool),off=p.pool.noteOff.bind(p.pool);p.pool.noteOn=(n,vv,c)=>{log.push(['on',n,t,vv]);on(n,vv,c)};p.pool.noteOff=(n,c)=>{log.push(['off',n,t]);off(n,c)};
 const L=new Float32Array(128),R=new Float32Array(128);p.run=s=>{let bad=0;for(let b=0;b<Math.round(s*48000/128);b++){p.process([],[[L,R]]);for(let i=0;i<128;i++){if(!isFinite(L[i]))bad++;} t+=128;}return bad};p.log=log;return p;}
// C E G quarter notes then a held chord; plus an overlapping repeat of the same pitch
const notes=[[0,60,1,90],[1,64,1,80],[2,67,1,70],[3,60,2,100],[3,64,2,100],[3,67,2,100],[3.5,60,0.5,60]];
function flat(ns){const ev=[];for(const [t,n,d,v] of ns){ev.push([t,n,v,1],[t+d,n,v,0]);}ev.sort((a,b)=>a[0]-b[0]||a[3]-b[3]);return ev.flat();}
{const p=mk(120);p.handleMessage({type:'seq',events:flat(notes),len:8});p.handleMessage({type:'seqplay',on:true});
 const bad=p.run(4.2);const ons=p.log.filter(e=>e[0]==='on');
 ok(bad===0,'clean output');
 ok(ons.map(e=>e[1]).join()==='60,64,67,60,64,67,60','notes in order: '+ons.map(e=>e[1]).join(' '));
 const t1=ons[1][2]-ons[0][2];ok(Math.abs(t1-24000)<=128,'one beat at 120 BPM = 24000 samples ('+t1+', block-quantized log)');
 ok(ons[0][3]===90&&ons[2][3]===70,'velocities carried');
 const offs60=p.log.filter(e=>e[0]==='off'&&e[1]===60).map(e=>e[2]);
 ok(offs60.some(x=>Math.abs(x-5*24000)<=256),'overlapping repeat of C4 does not cut the held chord note early (last C4 off at beat 5)');
 ok(!p.seq.running&&p.pool.voices.every(v=>!v.keyDown),'stops by itself at the end, nothing held');}
{const p=mk(60);p.handleMessage({type:'seq',events:flat(notes),len:8});p.handleMessage({type:'seqplay',on:true});p.run(1.01);
 p.handleMessage({type:'p',i:P.BPM,v:240});p.run(0.3);const ons=p.log.filter(e=>e[0]==='on');ok(ons.length>=3,'tempo change applies live (60→240 BPM reached beat 2 in 1.3 s)');}
{const p=mk(240);p.handleMessage({type:'seq',events:flat(notes),len:8});p.handleMessage({type:'seqplay',on:true,loop:true});p.run(4.3);
 ok(p.log.filter(e=>e[0]==='on'&&e[1]===64).length>=4&&p.seq.running,'loop repeats the piece');
 p.handleMessage({type:'panic'});p.run(2);ok(!p.seq.running&&p.pool.activeCount()===0,'panic stops playback, all voices free');}
{const p=mk(120);p.handleMessage({type:'seq',events:[NaN,60,1,1,0,500,1,1,-1,60,1,1,0,61,100,1],len:4});ok(p.seq.n===1,'bad events rejected');}
console.log(fail?'FAIL':'PASS');
