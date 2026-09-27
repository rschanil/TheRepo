const fs=require('fs'),path=require('path');const src=f=>fs.readFileSync(path.join(__dirname,'..','src',f),'utf8');
const api=new Function(src('params.js')+'\nreturn {PARAMS,PIDX,FACTORY,factorySnapshot,buildWorkletHeader};')();
let Cls;const posted=[];class AWP{constructor(){this.port={postMessage(m){posted.push(m)},onmessage:null};}}
new Function('AudioWorkletProcessor','registerProcessor','sampleRate',api.buildWorkletHeader()+src('processor.js'))(AWP,(n,c)=>Cls=c,48000);
const vals=api.PARAMS.map(p=>p.def);const P=api.PIDX;
function mk(over){const v=vals.slice();for(const k in over)v[P[k]]=over[k];const p=new Cls({processorOptions:{values:v}});
 const log=[];const on=p.pool.noteOn.bind(p.pool),off=p.pool.noteOff.bind(p.pool);let t=0;
 p.pool.noteOn=(n,vv,c)=>{log.push(['on',n,t]);on(n,vv,c)};p.pool.noteOff=(n,c)=>{log.push(['off',n,t]);off(n,c)};
 const L=new Float32Array(128),R=new Float32Array(128);
 p.run=(sec)=>{let nan=0;for(let b=0;b<Math.round(sec*48000/128);b++){p.process([],[[L,R]]);t+=128;for(let i=0;i<128;i++)if(!isFinite(L[i]))nan++;}return nan};
 p.log=log;return p;}
const modes=['UP','DOWN','UP-DN','DN-UP','ORDER','RAND','CHORD'];
let fail=false;
for(let m=0;m<7;m++){const p=mk({ARP_ON:1,ARP_MODE:m,ARP_OCT:2,BPM:120});
 for(const n of [64,60,67])p.handleMessage({type:'on',n,v:100,c:0});
 const nan=p.run(2.0);const ons=p.log.filter(e=>e[0]==='on');
 const steps=m===6?ons.length/3:ons.length;
 console.log(modes[m].padEnd(6),'steps',steps,'first',ons.slice(0,12).map(e=>e[1]).join(' '),'nan',nan);
 if(Math.abs(steps-16)>1||nan)fail=true;
 for(const n of [64,60,67])p.handleMessage({type:'off',n,c:0});p.run(0.3);
 const active=p.pool.activeCount(); if(p.arp.running){console.log('still running');fail=true;}
}
// timing: step spacing 1/16 @120 = 6000 samples, gate 50% => off at 3000
{const p=mk({ARP_ON:1,BPM:120});p.handleMessage({type:'on',n:60,v:100,c:0});p.run(1);
 const ons=p.log.filter(e=>e[0]==='on').map(e=>e[2]);const d=ons.slice(1).map((x,i)=>x-ons[i]);
 console.log('on spacing (block-quantized in log):',d.slice(0,6).join(','));}
// swing
{const p=mk({ARP_ON:1,BPM:120,ARP_SWING:0.5});p.handleMessage({type:'on',n:60,v:100,c:0});p.run(1);
 const ons=p.log.filter(e=>e[0]==='on').map(e=>e[2]);console.log('swing spacing:',ons.slice(1).map((x,i)=>x-ons[i]).slice(0,6).join(','));}
// latch: release keys, keeps playing; new chord replaces
{const p=mk({ARP_ON:1,ARP_LATCH:1});p.handleMessage({type:'on',n:60,v:100});p.handleMessage({type:'off',n:60});p.run(0.5);
 const a=p.arp.running;p.handleMessage({type:'on',n:72,v:100});p.run(0.01);const held=Array.from(p.arp.held.slice(0,p.arp.heldN));
 console.log('latch keeps running',a,'replaced held',held); if(!a||held.join()!=='72')fail=true;}
// toggle arp off with keys down -> keys sound normally, and release frees them
{const p=mk({ARP_ON:1});p.handleMessage({type:'on',n:60,v:100});p.run(0.3);p.handleMessage({type:'p',i:P.ARP_ON,v:0});p.run(0.05);
 const n1=p.pool.activeCount();p.handleMessage({type:'off',n:60});p.run(1.5);const n2=p.pool.activeCount();
 console.log('arp off w/ key down voices',n1,'after release',n2);if(n1<1||n2!==0)fail=true;
 p.handleMessage({type:'on',n:62,v:100});p.handleMessage({type:'p',i:P.ARP_ON,v:1});p.run(0.5);const r=p.arp.running;p.handleMessage({type:'off',n:62});p.run(1.5);
 console.log('arp on w/ key down running',r,'after release voices',p.pool.activeCount());if(!r||p.pool.activeCount()!==0)fail=true;}
const last=posted.filter(m=>m.type==='meter').pop();console.log('meter keys',Object.keys(last).join(','),'scopeL',last.scopeL&&last.scopeL.length);
console.log(fail?'FAIL':'PASS');
