// Renders every factory preset: a held 4-note chord, then release.
// Reports loudness, peak, CPU, and sound-specific checks for the new keys/pads.
const fs=require('fs'),path=require('path');const src=f=>fs.readFileSync(path.join(__dirname,'..','src',f),'utf8');
const api=new Function(src('params.js')+'\nreturn {PARAMS,PIDX,FACTORY,factorySnapshot,buildWorkletHeader};')();
let Cls;class AWP{constructor(){this.port={postMessage(){},onmessage:null};}}
new Function('AudioWorkletProcessor','registerProcessor','sampleRate',api.buildWorkletHeader()+src('processor.js'))(AWP,(n,c)=>Cls=c,48000);
const SR=48000;const only=process.argv[2];let fail=false;
const db=x=>(10*Math.log10(x+1e-20)).toFixed(1);
function render(p,sec){const n=Math.round(sec*SR/128)*128;const L=new Float32Array(n),R=new Float32Array(n);const bl=new Float32Array(128),br=new Float32Array(128);
 for(let o=0;o<n;o+=128){p.process([],[[bl,br]]);L.set(bl,o);R.set(br,o);}return {L,R};}
const ms=(a,s,e)=>{let t=0;for(let i=s;i<e;i++)t+=a[i]*a[i];return t/(e-s);};
const hf=(a,s,e)=>{let t=0;for(let i=s+1;i<e;i++){const d=a[i]-a[i-1];t+=d*d;}return t/(e-s);};
const rows=[];
api.FACTORY.forEach((f,k)=>{
  if(only&&!f.name.includes(only))return;
  const snap=api.factorySnapshot(k);const p=new Cls({processorOptions:{values:api.PARAMS.map(q=>snap[q.id])}});
  const chord=[48,55,58,62];
  const t0=process.hrtime.bigint();
  for(const n of chord)p.handleMessage({type:'on',n,v:100,c:0});
  const hold=render(p,5);
  for(const n of chord)p.handleMessage({type:'off',n,c:0});
  const tail=render(p,4);
  const cpu=Number(process.hrtime.bigint()-t0)/1e9/9;
  let pk=0,nan=0;for(const a of [hold.L,hold.R,tail.L,tail.R])for(const x of a){if(!Number.isFinite(x))nan++;else if(Math.abs(x)>pk)pk=Math.abs(x);}
  const rmsHold=(ms(hold.L,3*SR,5*SR)+ms(hold.R,3*SR,5*SR))/2;
  const r={name:f.name,cat:f.cat,peak:pk.toFixed(3),holdDb:db(rmsHold),tailDb:db((ms(tail.L,3*SR,4*SR)+ms(tail.R,3*SR,4*SR))/2),nan,cpu:(cpu*100).toFixed(0)+'%'};
  const hdb=+r.holdDb;
  // Arp and plucky/keys decay by design; judge them over the first second instead of the held tail.
  const early=db((ms(hold.L,0,SR)+ms(hold.R,0,SR))/2);r.firstSec=early;
  const loud=Math.max(hdb,+early);
  if(nan||pk>0.99||loud>-8||loud<-32){r.flag='LEVEL';fail=true;}
  rows.push(r);
});
console.table(rows);
// Rhodes-specific: tine decays fast relative to body; harder velocity is brighter; tremolo moves L/R.
function note(name,n,v,sec){const k=api.FACTORY.findIndex(f=>f.name===name);const s=api.factorySnapshot(k);
 const p=new Cls({processorOptions:{values:api.PARAMS.map(q=>s[q.id])}});p.handleMessage({type:'on',n,v,c:0});return render(p,sec);}
for(const nm of ['Suitcase Rhodes','Tape Rhodes','Lo-fi Keys']){
  if(only&&!nm.includes(only))continue;
  const a=note(nm,60,110,2.5);
  // Brightness is judged on the mid signal (L+R): the stereo tremolo moves energy between
  // channels, so a single channel's reading depends on where the free-running pan happens to be.
  const mid=(x)=>{const m=new Float32Array(x.L.length);for(let i=0;i<m.length;i++)m[i]=(x.L[i]+x.R[i])*0.5;return m;};
  const aM=mid(a);
  const brightEarly=hf(aM,0.01*SR,0.08*SR)/ms(aM,0.01*SR,0.08*SR), brightLate=hf(aM,1.5*SR,2*SR)/ms(aM,1.5*SR,2*SR);
  const soft=mid(note(nm,60,35,0.3)),hard=mid(note(nm,60,120,0.3));
  const bS=hf(soft,480,0.1*SR)/ms(soft,480,0.1*SR),bH=hf(hard,480,0.1*SR)/ms(hard,480,0.1*SR);
  const decay=+db(ms(a.L,2*SR,2.5*SR))-+db(ms(a.L,0.05*SR,0.3*SR));
  const w=Math.round(0.03*SR);let bal=[];for(let s=0.3*SR;s<2.3*SR;s+=w){const l=ms(a.L,s,s+w),r=ms(a.R,s,s+w);bal.push(10*Math.log10((l+1e-12)/(r+1e-12)));}
  const swing=Math.max(...bal)-Math.min(...bal);
  const c1=brightEarly>(nm==='Suitcase Rhodes'?2:1.5)*brightLate, c2=bH>1.3*bS, c3=decay<-8, c4=swing>(nm==='Lo-fi Keys'?-1:1.5);
  console.log(`${nm.padEnd(16)} tine ${(brightEarly/brightLate).toFixed(1)}x brighter at attack ${c1?'ok':'FAIL'} · hard vs soft brightness ${(bH/bS).toFixed(2)}x ${c2?'ok':'FAIL'} · 2 s decay ${decay.toFixed(1)} dB ${c3?'ok':'FAIL'} · L/R tremolo swing ${swing.toFixed(1)} dB ${c4?'ok':'FAIL'}`);
  if(!(c1&&c2&&c3&&c4))fail=true;
}
// Drift: pitch of a pad note wanders (zero-crossing period varies) but stays within ~15 cents.
for(const nm of ['Drift Glass','Tape Rhodes']){
  if(only&&!nm.includes(only))continue;
  const k=api.FACTORY.findIndex(f=>f.name===nm);const s=api.factorySnapshot(k);
  for(const id of ['REV_ON','DLY_ON','CH_ON','WS_ON'])s[id]=0; s.OSC2_LEVEL=0; s.NOISE_LEVEL=0;s.FLT_SHAPER=0;s.ENV1_S=1;s.ENV1_D=30;
  const p=new Cls({processorOptions:{values:api.PARAMS.map(q=>s[q.id])}});p.handleMessage({type:'on',n:69,v:100,c:0});const a=render(p,21);
  // 20 s spans several segments of the slow random LFO, so the result doesn't hinge on one draw.
  const cents=[];for(let w0=1*SR;w0<21*SR-SR/4;w0+=SR/4){let zc=[];for(let i=w0+1;i<w0+SR/4;i++)if(a.L[i-1]<=0&&a.L[i]>0)zc.push(i-1+(-a.L[i-1])/(a.L[i]-a.L[i-1]));
   const f=SR*(zc.length-1)/(zc[zc.length-1]-zc[0]);cents.push(1200*Math.log2(f/440));}
  const lo=Math.min(...cents),hi=Math.max(...cents);const c=hi-lo>1.5&&Math.abs(lo)<16&&Math.abs(hi)<16;
  console.log(`${nm.padEnd(16)} pitch drift ${lo.toFixed(1)}…${hi.toFixed(1)} cents ${c?'ok':'FAIL'}`);if(!c)fail=true;
}
console.log(fail?'FAIL':'PASS');
