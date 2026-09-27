// Assembles the standalone file (double-click from disk), the artifact page
// (published without its own document skeleton), and the processor fallback file.
const fs = require('fs');
const path = require('path');
const R = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
const head = R('head.html'), body = R('body.html'), proc = R('processor.js'), params = R('params.js'), main = R('main.js'), crt = R('crt.js'), pieces = R('pieces.js'), claudeJs = R('claude.js');
for (const [n, t] of [['processor.js', proc], ['params.js', params], ['main.js', main], ['crt.js', crt], ['pieces.js', pieces], ['claude.js', claudeJs]]) {
  if (/<\/script/i.test(t)) throw new Error(n + ' contains a closing script tag');
}
const api0 = new Function(params + '\nreturn { buildWorkletHeader };')();
// Main-thread copy of the DSP for hosts that block AudioWorklet (compatibility engine).
const compat = `<script>\nfunction SYNTHCORE_DSP(AudioWorkletProcessor, registerProcessor, sampleRate) {\n${api0.buildWorkletHeader()}\n${proc}\n}\n</script>\n\n`;
const scripts =
  `<script id="synthcore-processor" type="text/worklet-processor">\n${proc}</script>\n\n` + compat +
  `<script type="module">\n${params}\n${crt}\n${pieces}\n${claudeJs}\n${main}</script>\n`;
const standalone =
  `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
  `${head}</head>\n<body>\n${body}\n${scripts}</body>\n</html>\n`;
const artifact = `${head}\n${body}\n${scripts}`;
const api = new Function(params + '\nreturn { buildWorkletHeader };')();
fs.mkdirSync(path.join(__dirname, 'dist', 'artifact'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'synthcore.html'), standalone);
fs.writeFileSync(path.join(__dirname, 'dist', 'artifact', 'synthcore.html'), artifact);
fs.writeFileSync(path.join(__dirname, 'dist', 'artifact', 'synthcore-processor.js'), api.buildWorkletHeader() + '\n' + proc);
console.log('standalone', standalone.length, 'bytes; artifact', artifact.length, 'bytes');
