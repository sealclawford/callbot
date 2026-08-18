const WebSocket = require('ws');
const fs = require('fs');
const ws = new WebSocket('wss://callbot-f5rr.onrender.com/media-stream');
let audioChunks = [];
ws.on('open', () => {
  ws.send(JSON.stringify({event:'start', start:{
    streamSid:'MZtest00000000000000000000000000',
    callSid:'CAtest00000000000000000000000000',
    customParameters:{goal:'This is a self-test. Just deliver your opening greeting and stop.', behavior:'', voice:'marin'}
  }}));
});
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.event === 'media') audioChunks.push(m.media.payload);
});
setTimeout(() => {
  ws.close();
  const mulaw = Buffer.concat(audioChunks.map(b=>Buffer.from(b,'base64')));
  fs.writeFileSync('/tmp/greeting.ulaw', mulaw);
  // decode mulaw -> pcm16 8k wav
  const MULAW_BIAS=33;
  function ulaw2lin(u){u=~u&0xFF;const sign=u&0x80;const e=(u>>4)&7;const m=u&15;let v=((m<<3)+132)<<e;v-=132;let o=sign?-v:v;if(o>32767)o=32767;if(o<-32768)o=-32768;return o;}
  const n=mulaw.length;
  const pcm=Buffer.alloc(n*2);
  for(let i=0;i<n;i++) pcm.writeInt16LE(ulaw2lin(mulaw[i]), i*2);
  const hdr=Buffer.alloc(44);
  hdr.write('RIFF',0); hdr.writeUInt32LE(36+pcm.length,4); hdr.write('WAVEfmt ',8);
  hdr.writeUInt32LE(16,16); hdr.writeUInt16LE(1,20); hdr.writeUInt16LE(1,22);
  hdr.writeUInt32LE(8000,24); hdr.writeUInt32LE(16000,28); hdr.writeUInt16LE(2,32); hdr.writeUInt16LE(16,34);
  hdr.write('data',36); hdr.writeUInt32LE(pcm.length,40);
  fs.writeFileSync('/tmp/greeting.wav', Buffer.concat([hdr,pcm]));
  // rms energy (is it non-silence speech?)
  let sum=0; for(let i=0;i<n;i++){const v=pcm.readInt16LE(i*2);sum+=v*v;}
  console.log('audio bytes:',mulaw.length,'~seconds:',(mulaw.length/8000).toFixed(1),'rms:',Math.round(Math.sqrt(sum/n)));
  process.exit(0);
}, 20000);
