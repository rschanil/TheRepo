const fs=require('fs'),path=require('path');const src=f=>fs.readFileSync(path.join(__dirname,'..','src',f),'utf8');
const api=new Function(src('params.js')+'\nreturn {PARAMS,PIDX,buildWorkletHeader};')();
let Cls;class AWP{constructor(){this.port={postMessage(){},onmessage:null};}}
new Function('AudioWorkletProcessor','registerProcessor','sampleRate',api.buildWorkletHeader()+src('processor.js'))(AWP,(n,c)=>Cls=c,48000);
const P=api.PIDX;let fail=false;const ok=(c,m)=>{console.log((c?'ok  ':'FAIL')+' '+m);if(!c)fail=true;};
function mk(over){const v=api.PARAMS.map(p=>p.def);for(const k in over)v[P[k]]=over[k];const p=new Cls({processorOptions:{values:v}});
 const log=[];let t=0;const on=p.pool.noteOn.bind(p.pool),off=p.pool.noteOff.bind(p.pool);
 p.pool.noteOn=(n,vv,c)=>{log.push(['on',n,t]);on(n,vv,c)};p.pool.noteOff=(n,c)=>{log.push(['off',n,t]);off(n,c)};
 const L=new Float32Array(128),R=new Float32Array(128);
 p.run=s=>{let bad=0;for(let b=0;b<Math.round(s*48000/128);b++){p.process([],[[L,R]]);t+=128;for(let i=0;i<128;i++)if(!isFinite(L[i])||Math.abs(L[i])>1)bad++;}return bad};
 p.log=log;return p;}
const prog=[[57,60,64,67,71],[62,65,69,72,76]];
{const p=mk({BPM:120,CHD_RATE:1});p.handleMessage({type:'chords',list:prog});p.handleMessage({type:'chordplay',on:true});
 const bad=p.run(4.05);const ons=p.log.filter(e=>e[0]==='on');
 const starts=[...new Set(ons.map(e=>e[2]))];
 ok(bad===0,'finite, under ceiling');
 ok(starts.length===3,'1-bar chords at 120 BPM: 3 chord starts in 4.05 s (got '+starts.length+')');
 ok(starts[1]-starts[0]>=95872&&starts[1]-starts[0]<=96128,'chord spacing ~96000 samples ('+(starts[1]-starts[0])+')');
 ok(ons.filter(e=>e[2]===starts[1]).map(e=>e[1]).join()==='62,65,69,72,76','second chord notes');
 ok(p.log.filter(e=>e[0]==='off'&&e[2]===starts[1]).length===5,'previous chord released at change');
 ok(p.pool.voices.filter(v=>v.keyDown).length===5,'5 voices held for the current chord');
 p.handleMessage({type:'chordgo',i:1});p.run(0.01);ok(p.chords.pos===1,'jump to chord 2');
 p.handleMessage({type:'chordplay',on:false});p.run(2.5);ok(p.pool.activeCount()===0&&!p.chords.running,'stop releases everything');}
{const p=mk({BPM:120,ARP_ON:1,CHD_RATE:0});p.handleMessage({type:'chords',list:prog});p.handleMessage({type:'chordplay',on:true});
 p.run(0.9);const h1=Array.from(p.arp.held.slice(0,p.arp.heldN)).join();ok(h1==='57,60,64,67,71','arp holds chord 1 during first half bar');p.run(0.3);const held=Array.from(p.arp.held.slice(0,p.arp.heldN)).join();
 ok(p.arp.running&&held==='62,65,69,72,76','arp switches to chord 2 after 1 s ('+held+')');
 const one=p.log.filter(e=>e[0]==='on');const perStep=new Map();one.forEach(e=>perStep.set(e[2],(perStep.get(e[2])||0)+1));
 ok(Math.max(...perStep.values())===1,'arp plays one note per step while chords run');
 p.handleMessage({type:'panic'});p.run(2.5);ok(!p.chords.running&&!p.arp.running&&p.pool.activeCount()===0,'panic stops chords and arp');}
{const p=mk({});p.handleMessage({type:'chords',list:[[200,-3,'x'],null,[60]]});p.handleMessage({type:'chordplay',on:true});
 ok(p.run(0.5)===0&&p.chords.n===2,'bad input ignored');}
console.log(fail?'FAIL':'PASS');
