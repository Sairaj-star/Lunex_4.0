import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as connect } from 'socket.io-client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function freePort() { const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const port=server.address().port; await new Promise(resolve=>server.close(resolve)); return port; }
async function waitFor(fn, timeout=8000) { const end=Date.now()+timeout; while(Date.now()<end){try{const value=await fn();if(value)return value;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Timed out waiting for the app.'); }
function event(socket,name,predicate=()=>true,timeout=5000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.off(name,handler);reject(Error(`Timed out waiting for ${name}`));},timeout);const handler=value=>{if(!predicate(value))return;clearTimeout(timer);socket.off(name,handler);resolve(value);};socket.on(name,handler);});}

test('suite lifecycle, private entry, live chat, media access, and owner reset', { timeout: 30000 }, async t => {
  const port=await freePort(); const temp=await mkdtemp(path.join(tmpdir(),'lunex-test-')); const dataFile=path.join(temp,'lunex.json');
  const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),DATA_FILE:dataFile,OWNER_USERNAME:'test-owner',OWNER_PASSWORD:'test-password',SESSION_SECRET:'test-session-secret-which-is-more-than-32-characters'},stdio:['ignore','pipe','pipe']});let serverLogs='';child.stdout.on('data',data=>serverLogs+=data);child.stderr.on('data',data=>serverLogs+=data);
  const base=`http://127.0.0.1:${port}`; const clients=[];
  t.after(async()=>{clients.forEach(client=>client.disconnect());child.kill();await rm(temp,{recursive:true,force:true});});
  await waitFor(async()=>{const r=await fetch(`${base}/health`);return r.ok;});
  const initial=await (await fetch(`${base}/api/rooms`)).json(); assert.equal(initial.total,500);assert.equal(initial.available,500);
  let response=await fetch(`${base}/api/rooms/book`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({displayName:'Test Guest',mobile:'0000000000',capacity:1})});assert.equal(response.status,400);
  response=await fetch(`${base}/api/rooms/book`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({displayName:'Test Guest',mobile:'9876543210',capacity:1})});const booking=await response.json();assert.equal(response.status,201,`${booking.error}\n${serverLogs}`);
  const directory=await (await fetch(`${base}/api/rooms`)).json();assert.equal(directory.total,500);assert.equal(JSON.stringify(directory).includes(booking.key),false);assert.equal(directory.suites[0].status,'occupied');
  response=await fetch(`${base}/api/rooms/enter-by-key`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:booking.key})});assert.equal(response.status,200);const auth=await response.json();
  const client=connect(base,{auth:{accessToken:auth.accessToken},transports:['websocket']});clients.push(client);const room=await event(client,'room:state');assert.equal(room.number,booking.suite);assert.equal(room.occupants.length,1);
  response=await fetch(`${base}/api/rooms/enter-by-key`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:booking.key})});assert.equal(response.status,409);
  const received=event(client,'chat:new',m=>m.type==='text'&&m.text==='hello from test');client.emit('chat:send',{text:'hello from test'});const message=await received;assert.equal(message.sender,'Guest 01');assert.equal('senderToken' in message,false);
  const bytes=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);const form=new FormData();form.set('file',new Blob([bytes],{type:'image/png'}),'image.png');response=await fetch(`${base}/api/rooms/media`,{method:'POST',headers:{authorization:`Bearer ${auth.accessToken}`},body:form});assert.equal(response.status,201);const media=await response.json();
  const mediaEvent=event(client,'chat:new',m=>m.type==='media');client.emit('chat:media',{id:media.id});const mediaMessage=await mediaEvent;assert.equal(mediaMessage.mime,'image/png');
  response=await fetch(`${base}/api/rooms/media/${media.id}`,{headers:{authorization:`Bearer ${auth.accessToken}`}});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
  response=await fetch(`${base}/api/owner/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'test-owner',password:'test-password'})});assert.equal(response.status,200);const owner=await response.json();
  response=await fetch(`${base}/api/owner/suites/${booking.suite}/booking`);assert.equal(response.status,401);response=await fetch(`${base}/api/owner/suites/${booking.suite}/booking`,{headers:{authorization:`Bearer ${owner.token}`}});assert.equal(response.status,200);assert.equal((await response.json()).mobile,'9876543210');
  const closed=event(client,'suite:closed');response=await fetch(`${base}/api/owner/suites/${booking.suite}/reset`,{method:'POST',headers:{authorization:`Bearer ${owner.token}`}});assert.equal(response.status,200);await closed;
  response=await fetch(`${base}/api/rooms/book`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({displayName:'Game Host',mobile:'9876543211',capacity:2})});assert.equal(response.status,201);const gameBooking=await response.json();
  const enter=async()=>{const r=await fetch(`${base}/api/rooms/enter-by-key`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:gameBooking.key})});return r.json();};const a=await enter();const b=await enter();const playerA=connect(base,{auth:{accessToken:a.accessToken},transports:['websocket']});const playerB=connect(base,{auth:{accessToken:b.accessToken},transports:['websocket']});clients.push(playerA,playerB);await Promise.all([event(playerA,'room:state'),event(playerB,'room:state')]);
  const startA=event(playerA,'game:state');const startB=event(playerB,'game:state');playerA.emit('game:start');const game=await startA;await startB;assert.equal(game.board.length,9);assert.equal('players' in game,false);
  const invalid=event(playerB,'operation:error');playerB.emit('game:move',{index:0});assert.match((await invalid).message,/move/i);
  playerA.emit('game:move',{index:0});await event(playerB,'game:state',g=>g.board[0]==='X');playerB.emit('game:move',{index:1});await event(playerA,'game:state',g=>g.board[1]==='O');playerA.emit('game:move',{index:2});await event(playerB,'game:state',g=>g.board[2]==='X');playerB.emit('game:move',{index:3});await event(playerA,'game:state',g=>g.board[3]==='O');playerA.emit('game:move',{index:4});await event(playerB,'game:state',g=>g.board[4]==='X');playerB.emit('game:move',{index:5});await event(playerA,'game:state',g=>g.board[5]==='O');const won=event(playerB,'game:state',g=>g.winner===0);playerA.emit('game:move',{index:8});assert.equal((await won).winner,0);
  const gameCloseA=event(playerA,'suite:closed');const gameCloseB=event(playerB,'suite:closed');response=await fetch(`${base}/api/owner/suites/${gameBooking.suite}/reset`,{method:'POST',headers:{authorization:`Bearer ${owner.token}`}});assert.equal(response.status,200);await Promise.all([gameCloseA,gameCloseB]);
  const final=await (await fetch(`${base}/api/rooms`)).json();assert.equal(final.available,500);
});
