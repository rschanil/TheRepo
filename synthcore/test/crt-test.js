// Unit checks of the display physics, run in Node with a stub canvas.
const fs=require('fs'),path=require('path');
const code=fs.readFileSync(path.join(__dirname,'..','src','crt.js'),'utf8');
const api=new Function(code+'\nreturn {CRTScreen,Spectrogram,StreamQueue,CRT_TONE};')();
const ctx=()=>({createImageData:(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}),putImageData(){},fillRect(){},drawImage(){},set fillStyle(v){},set globalCompositeOperation(v){}});
const canvas=()=>({width:0,height:0,getContext:ctx});
let fail=false;const ok=(c,m)=>{console.log((c?'ok  ':'FAIL')+' '+m);if(!c)fail=true;};
const SR=48000;
// 1. Energy conservation: total deposited = beam time.
{const s=new api.CRTScreen(canvas(),320,200);for(let i=0;i<4800;i++){const t=i/SR;s.point(160+100*Math.sin(2*Math.PI*220*t),100-80*Math.cos(2*Math.PI*330*t),1/SR);}
 const tot=s.E.reduce((a,b)=>a+b,0);ok(Math.abs(tot-4797/SR)/(4797/SR)<0.01,`energy on screen ${(tot*1000).toFixed(3)} ms of beam time for ${(4797/SR*1000).toFixed(3)} ms drawn`);}
// 2. Dwell brightness: an in-phase X-Y line (x = y = sin) is bright at its ends, dim in the middle.
{const s=new api.CRTScreen(canvas(),320,200);for(let i=0;i<9600;i++){const v=Math.sin(2*Math.PI*200*i/SR);s.point(160+80*v,100-80*v,1/SR);}
 const at=(x,y)=>{let m=0;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)m+=s.E[(y+dy)*320+x+dx];return m;};
 const end=at(238,22),mid=at(160,100);ok(end/mid>4,`turning point is ${(end/mid).toFixed(1)}x brighter than the fast centre crossing`);}
// 3. Resting beam: all energy on one spot.
{const s=new api.CRTScreen(canvas(),320,200);for(let i=0;i<800;i++)s.point(160.5,100.5,1/SR);
 const spot=s.E[100*320+160]+s.E[100*320+161]+s.E[101*320+160]+s.E[101*320+161];const tot=s.E.reduce((a,b)=>a+b,0);ok(spot/tot>0.99,'stationary beam deposits into a single spot');}
// 4. Phosphor decay follows exp(-t/tau) and exposure keeps a typical trace mid-scale.
{const s=new api.CRTScreen(canvas(),320,200);for(let i=0;i<4800;i++){const t=i/SR;s.point(160+100*Math.sin(2*Math.PI*110*t),100-80*Math.sin(2*Math.PI*165*t),1/SR);}
 const before=s.E.reduce((a,b)=>a+b,0);for(let f=0;f<60;f++)s.present(1/60,0.12,1);const after=s.E.reduce((a,b)=>a+b,0);
 ok(Math.abs(after/before-Math.exp(-1/0.12))<0.02,`after 1 s at 120 ms persistence ${(after/before).toExponential(2)} remains (expected ${Math.exp(-1/0.12).toExponential(2)})`);}
{const s=new api.CRTScreen(canvas(),320,200);let t=0;const px=[];
 for(let f=0;f<90;f++){for(let i=0;i<800;i++,t++){const u=t/SR;s.point(160+100*Math.sin(2*Math.PI*110*u),100-80*Math.sin(2*Math.PI*165*u),1/SR);}s.present(1/60,0.12,1);}
 let lit=0,sum=0;for(let i=0;i<s.T.length;i++)if(s.T[i]>0.05){lit++;sum+=s.T[i];}ok(sum/lit>0.25&&sum/lit<0.75,`auto-exposure: mean lit-trace brightness ${(sum/lit).toFixed(2)} (0.25–0.75)`);}
// 5. Spectrogram: 440 Hz at half scale reads ~440 Hz, ~-6 dBFS, noise floor far below.
{const sp=new api.Spectrogram(canvas(),900,200,SR);for(let i=0;i<4096;i++)sp.push(0.5*Math.sin(2*Math.PI*440*i/SR));
 const db=new Float64Array(200);sp.magnitudes(db);let by=0;for(let y=1;y<200;y++)if(db[y]>db[by])by=y;
 const f=sp.freqAt(by+0.5);ok(Math.abs(f/440-1)<0.03,`peak row reads ${f.toFixed(0)} Hz for a 440 Hz tone`);
 ok(Math.abs(db[by]+6.02)<1.5,`level ${db[by].toFixed(1)} dBFS for a half-scale sine (expected −6.0)`);
 ok(db[5]<-80,`far from the tone the floor is ${db[5].toFixed(0)} dBFS`);}
{const sp=new api.Spectrogram(canvas(),900,200,SR);let cols=0;for(let i=0;i<48000;i++)sp.push(0);ok(sp.nCols===Math.min(64,Math.floor(48000/512)),'one column per 512 samples (buffered until drawn)');}
// 6. Stream queue keeps order and drops oldest on overflow.
{const q=new api.StreamQueue(8);q.push(new Float32Array([1,2,3,4,5,6]),null);q.push(new Float32Array([7,8,9,10]),null);ok(q.avail===8&&q.L[q.r%8]===3,'queue overflow keeps the newest 8 samples');}
console.log(fail?'FAIL':'PASS');
