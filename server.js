import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import multer from 'multer';
import { randomBytes, createHmac, timingSafeEqual, randomUUID, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: process.env.PUBLIC_ORIGIN || false, credentials: true } });
const PORT = Number(process.env.PORT || 3000);
const dataPath = path.resolve(process.env.DATA_FILE || path.join(__dirname, 'data/lunex.json'));
const uploadDir = path.resolve(path.dirname(dataPath), 'uploads');
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 || !process.env.OWNER_PASSWORD)) throw Error('Production requires OWNER_PASSWORD and a SESSION_SECRET of at least 32 characters.');
const sessions = new Map();
const roomLimits = new Map();
let state;
let persistQueue = Promise.resolve();
const vaultKey = scryptSync(process.env.SESSION_SECRET || 'lunex-local-development-key-change-before-deploy', 'lunex-vault-v1', 32);
function encryptVault(notes) { return notes.map(note => { const salt = randomBytes(16); const iv = randomBytes(12); const key = scryptSync(vaultKey, salt, 32); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(JSON.stringify(note), 'utf8'), cipher.final()]); return { encrypted: true, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }; }); }
function decryptVault(notes) { return (notes || []).map(record => { if (!record.encrypted) return record; try { const key = scryptSync(vaultKey, Buffer.from(record.salt, 'base64'), 32); const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64')); decipher.setAuthTag(Buffer.from(record.tag, 'base64')); return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8')); } catch { throw Error('Could not decrypt saved suite notes. Check SESSION_SECRET.'); } }); }

const blankSuite = number => ({ number, booking: null, keyHash: null, capacity: 0, occupants: [], messages: [], cinema: null, game: null, library: [], vault: [], bookedAt: null });
function persist() {
  const snapshot = { suites: state.suites.map(s => ({ ...s, occupants: [], messages: s.occupants.length ? s.messages : [], vault: encryptVault(s.vault) })) };
  const write = persistQueue.then(async () => { await mkdir(path.dirname(dataPath), { recursive: true }); await writeFile(dataPath, JSON.stringify(snapshot, null, 2), 'utf8'); });
  persistQueue = write.catch(error => console.error('Could not persist suite data:', error.message));
  return write;
}
async function load() {
  try { const parsed = JSON.parse(await readFile(dataPath, 'utf8')); if (Array.isArray(parsed.suites) && parsed.suites.length === 500) { for (const suite of parsed.suites) { suite.vault = decryptVault(suite.vault); suite.occupants=[]; suite.game=null; } return parsed; } throw Error('Saved suite data is invalid: expected 500 suites.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { suites: Array.from({ length: 500 }, (_, i) => blankSuite(i + 1)) };
}
state = await load();
const safeSuite = s => ({ number: s.number, status: s.keyHash ? (s.occupants.length >= s.capacity ? 'full' : 'occupied') : 'available', occupants: s.occupants.length, capacity: s.capacity });
const safeGame = game => game ? ({ board: game.board, turn: game.turn, labels: game.labels, winner: game.winner }) : null;
const keyDigest = key => createHmac('sha256', process.env.SESSION_SECRET || 'lunex-local-development-key-change-before-deploy').update(key).digest('hex');
const makeKey = () => `LX-${randomBytes(12).toString('hex').toUpperCase()}`;
const cleanName = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
const countRates = (map, id, max, ms) => { const now = Date.now(); const items = (map.get(id) || []).filter(t => now - t < ms); if (items.length >= max) return false; items.push(now); map.set(id, items); return true; };
function fail(res, status, message) { return res.status(status).json({ error: message }); }
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); res.setHeader('Permissions-Policy', 'camera=(), geolocation=()'); res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https://i.ytimg.com; media-src 'self' blob: https:; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self' ws: wss: https://www.youtube.com https://*.googlevideo.com; object-src 'none'; base-uri 'self'; form-action 'self'"); next(); });
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three/build'), { fallthrough: false, maxAge: '1d' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
function activeSessionFromRequest(req) { const token = req.get('authorization')?.replace(/^Bearer\s+/i, ''); const session = sessions.get(token); return session && Date.now() - session.created < 24 * 60 * 60 * 1000 ? { ...session, token } : null; }
function sniffMedia(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ['image/png','.png'];
  if (buffer.length >= 3 && buffer[0]===255 && buffer[1]===216 && buffer[2]===255) return ['image/jpeg','.jpg'];
  if (buffer.length >= 12 && buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP') return ['image/webp','.webp'];
  if (buffer.length >= 12 && buffer.toString('ascii',4,8)==='ftyp') return ['video/mp4','.mp4'];
  if (buffer.length >= 4 && buffer.toString('hex',0,4)==='1a45dfa3') return ['video/webm','.webm'];
  if (buffer.length >= 4 && buffer.toString('ascii',0,4)==='OggS') return ['audio/ogg','.ogg'];
  if (buffer.length >= 12 && buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WAVE') return ['audio/wav','.wav'];
  if (buffer.length >= 3 && (buffer.toString('ascii',0,3)==='ID3' || (buffer[0]===255 && (buffer[1]&0xe0)===0xe0))) return ['audio/mpeg','.mp3'];
  return null;
}
app.post('/api/rooms/media', (req, res, next) => { if (!activeSessionFromRequest(req)) return fail(res, 401, 'Your suite connection expired. Re-enter your key and try again.'); next(); }, upload.single('file'), async (req,res) => {
  if (!req.file) return fail(res,400,'Choose an image, video, or audio file first.');
  const detected=sniffMedia(req.file.buffer); if (!detected) return fail(res,415,'This file type is not supported. Use PNG, JPEG, WebP, MP4, WebM, MP3, WAV, or OGG.');
  const session=activeSessionFromRequest(req); const id=`${randomUUID()}${detected[1]}`; await mkdir(uploadDir,{recursive:true}); await writeFile(path.join(uploadDir,id),req.file.buffer,{flag:'wx'}); await writeFile(path.join(uploadDir,`${id}.json`),JSON.stringify({suite:session.suite,mime:detected[0],name:path.basename(req.file.originalname).slice(0,100)}));
  res.status(201).json({id,mime:detected[0],name:path.basename(req.file.originalname).slice(0,100)});
});
app.get('/api/rooms/media/:id', async (req,res) => {
  const session=activeSessionFromRequest(req); if(!session)return fail(res,401,'Your suite connection expired.');
  if(!/^[0-9a-f-]{36}\.(png|jpg|webp|mp4|webm|ogg|wav|mp3)$/.test(req.params.id))return fail(res,404,'Media not found.');
  try{const meta=JSON.parse(await readFile(path.join(uploadDir,`${req.params.id}.json`),'utf8'));if(meta.suite!==session.suite)return fail(res,404,'Media not found.');res.type(meta.mime);res.setHeader('Cache-Control','private, no-store');res.sendFile(path.join(uploadDir,req.params.id));}catch{return fail(res,404,'Media not found.');}
});

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/api/rooms', (_req, res) => {
  const rooms = state.suites.map(safeSuite); const counts = rooms.reduce((a, r) => { a[r.status]++; return a; }, { available: 0, occupied: 0, full: 0 });
  res.json({ total: 500, ...counts, suites: rooms });
});
app.post('/api/rooms/book', async (req, res) => {
  const displayName = cleanName(req.body?.displayName); const mobile = String(req.body?.mobile || '').trim(); const capacity = Number(req.body?.capacity);
  if (!displayName || !/^[\p{L} ]+$/u.test(displayName) || displayName.length > 48) return fail(res, 400, 'Use a name with letters and spaces only (up to 48 characters).');
  if (!/^\d{10}$/.test(mobile) || /^0{10}$|^1234567890$/.test(mobile)) return fail(res, 400, 'Enter a valid ten-digit mobile number.');
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) return fail(res, 400, 'Choose a suite capacity from 1 to 50.');
  const suite = state.suites.find(s => !s.keyHash); if (!suite) return fail(res, 409, 'All suites are currently reserved. Please try again shortly.');
  const key = makeKey(); suite.keyHash = keyDigest(key); suite.capacity = capacity; suite.booking = { displayName, mobile, bookedAt: new Date().toISOString() }; suite.bookedAt = Date.now();
  await persist(); res.status(201).json({ suite: suite.number, key, capacity, status: 'reserved' });
});
app.post('/api/rooms/enter-by-key', (req, res) => {
  const key = String(req.body?.key || '').trim().toUpperCase(); const ip = req.ip;
  if (!countRates(roomLimits, ip, 12, 60_000)) return fail(res, 429, 'Too many key attempts. Wait a minute and try again.');
  if (!/^LX-[A-F0-9]{24}$/.test(key)) return fail(res, 400, 'That key does not look right. Check it and try again.');
  const digest = keyDigest(key); const suite = state.suites.find(s => s.keyHash && timingSafeEqual(Buffer.from(s.keyHash), Buffer.from(digest)));
  if (!suite) return fail(res, 404, 'We couldn’t find an active suite for that key.');
  const resume = String(req.body?.resumeToken || '');
  const resumable = sessions.get(resume);
  const token = resumable?.suite === suite.number && Date.now() - resumable.created < 24 * 60 * 60 * 1000 ? resume : randomBytes(32).toString('hex');
  if (suite.occupants.length >= suite.capacity && !suite.occupants.some(o => o.token === token)) return fail(res, 409, 'This suite has reached its guest limit.');
  if (!resumable) sessions.set(token, { suite: suite.number, created: Date.now() });
  res.json({ accessToken: token, suite: suite.number, capacity: suite.capacity, guest: `Guest ${String(suite.occupants.length + 1).padStart(2, '0')}` });
});

const ownerSessions = new Map();
const authenticateOwner = (req, _res, next) => {
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, ''); const record = ownerSessions.get(token);
  if (!record || record.expires < Date.now()) return fail(req.res, 401, 'Owner session expired. Sign in again.'); next();
};
app.post('/api/owner/login', (req, res) => {
  if (!countRates(roomLimits, `owner:${req.ip}`, 6, 60_000)) return fail(res, 429, 'Too many attempts. Wait a minute and retry.');
  if (!process.env.OWNER_PASSWORD || req.body?.username !== (process.env.OWNER_USERNAME || 'owner') || req.body?.password !== process.env.OWNER_PASSWORD) return fail(res, 401, 'Those owner credentials weren’t recognized.');
  const token = randomBytes(32).toString('hex'); ownerSessions.set(token, { expires: Date.now() + 8 * 60 * 60 * 1000 }); res.json({ token, expiresIn: 28800 });
});
app.post('/api/owner/logout', authenticateOwner, (req, res) => { ownerSessions.delete(req.get('authorization')?.replace(/^Bearer\s+/i, '')); res.json({ ok: true }); });
app.get('/api/owner/overview', authenticateOwner, (_req, res) => res.json({ total: 500, available: state.suites.filter(s => !s.keyHash).length, occupied: state.suites.filter(s => s.occupants.length > 0).length, reserved: state.suites.filter(s => s.keyHash && !s.occupants.length).length, suites: state.suites.map(safeSuite) }));
app.get('/api/owner/suites/:number/booking', authenticateOwner, (req,res) => { const suite=state.suites[Number(req.params.number)-1]; if(!suite?.booking)return fail(res,404,'No active booking was found for this suite.'); res.json({suite:suite.number,capacity:suite.capacity,bookedAt:suite.booking.bookedAt,displayName:suite.booking.displayName,mobile:suite.booking.mobile}); });
app.post('/api/owner/suites/:number/reset', authenticateOwner, async (req, res) => {
  const suite = state.suites[Number(req.params.number) - 1]; if (!suite) return fail(res, 404, 'Suite not found.');
  for (const [token, session] of sessions) if (session.suite === suite.number) sessions.delete(token);
  io.to(`suite:${suite.number}`).emit('suite:closed', { message: 'This suite was reset by its owner.' });
  const number = suite.number; Object.assign(suite, blankSuite(number)); await persist(); res.json({ ok: true });
});

const resolveSession = socket => { const s = sessions.get(socket.handshake.auth?.accessToken); if (!s || Date.now() - s.created > 24 * 60 * 60 * 1000) return null; return { ...s, token: socket.handshake.auth.accessToken }; };
const emitToSuite = (n, event, payload) => io.to(`suite:${n}`).emit(event, payload);
async function removeOccupant(suite, socketId) {
  const i = suite.occupants.findIndex(o => o.socketId === socketId); if (i < 0) return;
  const [occupant] = suite.occupants.splice(i, 1); emitToSuite(suite.number, 'presence:update', { occupants: suite.occupants.map(({ guest }) => guest), capacity: suite.capacity });
  if (suite.game?.players.includes(occupant.token)) { suite.game = null; emitToSuite(suite.number, 'game:state', null); }
  if (suite.occupants.length) { const msg = { id: randomUUID(), type: 'system', text: `${occupant.guest} left the suite`, at: new Date().toISOString() }; suite.messages.push(msg); emitToSuite(suite.number, 'chat:new', msg); }
  else { Object.assign(suite, blankSuite(suite.number)); for (const [token, session] of sessions) if (session.suite === suite.number) sessions.delete(token); }
  await persist();
}
io.use((socket, next) => { const session = resolveSession(socket); if (!session) return next(new Error('Your suite access expired. Enter your key again.')); socket.data.session = session; next(); });
io.on('connection', socket => {
  const suite = state.suites[socket.data.session.suite - 1]; socket.join(`suite:${suite.number}`);
  if (suite.occupants.some(o => o.token === socket.data.session.token)) suite.occupants = suite.occupants.filter(o => o.token !== socket.data.session.token);
  if (suite.occupants.length >= suite.capacity) { socket.emit('suite:error', { message: 'This suite is full.' }); socket.disconnect(true); return; }
  const guest = `Guest ${String(suite.occupants.length + 1).padStart(2, '0')}`; suite.occupants.push({ socketId: socket.id, token: socket.data.session.token, guest });
  socket.emit('room:state', { number: suite.number, capacity: suite.capacity, guest, occupants: suite.occupants.map(o => o.guest), messages: suite.messages.slice(-100).map(({ senderToken, ...message }) => message), cinema: suite.cinema, game: safeGame(suite.game), library: suite.library.map(({ownerToken,...item})=>item), vault: suite.vault });
  emitToSuite(suite.number, 'presence:update', { occupants: suite.occupants.map(o => o.guest), capacity: suite.capacity });
  const joined = { id: randomUUID(), type: 'system', text: `${guest} joined the suite`, at: new Date().toISOString() }; suite.messages.push(joined); emitToSuite(suite.number, 'chat:new', joined); persist();
  socket.on('chat:send', async payload => {
    if (!payload || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 2000 || !countRates(roomLimits, socket.data.session.token, 45, 60_000)) return socket.emit('operation:error', { message: 'Message is empty, too long, or you’re sending too quickly.' });
    const msg = { id: randomUUID(), type: 'text', text: payload.text.trim(), sender: guest, senderToken: socket.data.session.token, at: new Date().toISOString() }; suite.messages.push(msg); const { senderToken, ...publicMessage } = msg; emitToSuite(suite.number, 'chat:new', publicMessage); await persist();
  });
  socket.on('chat:edit', async ({ id, text } = {}) => { const msg = suite.messages.find(m => m.id === id); if (!msg || msg.senderToken !== socket.data.session.token || typeof text !== 'string' || !text.trim() || text.length > 2000) return socket.emit('operation:error', { message: 'You can only edit your own message.' }); msg.text = text.trim(); msg.edited = true; emitToSuite(suite.number, 'chat:changed', { id, text: msg.text, edited: true }); await persist(); });
  socket.on('chat:media', async ({ id } = {}) => { if (typeof id !== 'string' || !/^[0-9a-f-]{36}\.(png|jpg|webp|mp4|webm|ogg|wav|mp3)$/.test(id)) return socket.emit('operation:error',{message:'That upload could not be attached.'}); try { const meta=JSON.parse(await readFile(path.join(uploadDir,`${id}.json`),'utf8')); if(meta.suite!==suite.number)throw Error(); const msg={id:randomUUID(),type:'media',mediaId:id,mime:meta.mime,name:meta.name,sender:guest,senderToken:socket.data.session.token,at:new Date().toISOString()};suite.messages.push(msg);const {senderToken,...publicMessage}=msg;emitToSuite(suite.number,'chat:new',publicMessage);await persist();}catch{return socket.emit('operation:error',{message:'That upload is no longer available in this suite.'});} });
  socket.on('chat:delete', async ({ id } = {}) => { const i = suite.messages.findIndex(m => m.id === id && m.senderToken === socket.data.session.token); if (i < 0) return socket.emit('operation:error', { message: 'You can only remove your own message.' }); suite.messages.splice(i, 1); emitToSuite(suite.number, 'chat:removed', { id }); await persist(); });
  socket.on('cinema:update', async payload => { let parsed; try { parsed = new URL(payload?.url); } catch { return socket.emit('operation:error', { message: 'Choose a supported video URL.' }); } const host=parsed.hostname.replace(/^www\./,''); const youtube=host==='youtu.be'||['youtube.com','m.youtube.com','youtube-nocookie.com'].includes(host); const direct=/\.(mp4|webm)$/i.test(parsed.pathname); const ytId=host==='youtu.be'?parsed.pathname.slice(1):parsed.pathname==='/watch'?parsed.searchParams.get('v')||'':/^\/(embed|shorts)\//.test(parsed.pathname)?parsed.pathname.split('/')[2]:''; if (!['direct','youtube'].includes(payload?.type) || !['http:','https:'].includes(parsed.protocol) || (!youtube&&!direct) || (youtube&&!/^[\w-]{11}$/.test(ytId)) || typeof payload.url!=='string' || payload.url.length>2048 || typeof payload.playing!=='boolean' || !Number.isFinite(payload.position) || payload.position<0 || payload.position>86400) return socket.emit('operation:error', { message: 'Choose a supported video URL.' }); suite.cinema = { type:youtube?'youtube':'direct', url:payload.url, id:youtube?ytId:undefined, playing:payload.playing, position:payload.position, at: Date.now(), updatedBy: guest }; emitToSuite(suite.number, 'cinema:state', suite.cinema); await persist(); });
  socket.on('game:move', async ({ index } = {}) => { const g = suite.game; if (!g || g.winner || !Number.isInteger(index) || index < 0 || index > 8 || g.board[index] || g.players[g.turn] !== socket.data.session.token) return socket.emit('operation:error', { message: 'That move is unavailable.' });
    g.board[index] = g.turn === 0 ? 'X' : 'O'; g.turn = 1 - g.turn; const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]; g.winner = wins.some(line => line.every(i => g.board[i] && g.board[i] === g.board[line[0]])) ? (g.board[index] === 'X' ? 0 : 1) : g.board.every(Boolean) ? 'draw' : null; emitToSuite(suite.number, 'game:state', safeGame(g)); await persist();
  });
  socket.on('game:start', async () => { if (suite.occupants.length < 2) return socket.emit('operation:error', { message: 'Invite one more guest before starting.' }); suite.game = { board: Array(9).fill(null), turn: 0, players: suite.occupants.slice(0, 2).map(o => o.token), labels: suite.occupants.slice(0, 2).map(o => o.guest), winner: null }; emitToSuite(suite.number, 'game:state', safeGame(suite.game)); await persist(); });
  socket.on('library:add', async ({ title, url } = {}) => { try { const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol) || typeof title !== 'string' || !title.trim() || title.length > 100) throw Error(); } catch { return socket.emit('operation:error', { message: 'Add a title and a valid http or https link.' }); } const item = { id: randomUUID(), title: title.trim(), url, by: guest, at: new Date().toISOString() }; suite.library.push(item); emitToSuite(suite.number, 'library:state', suite.library); await persist(); });
  socket.on('library:remove', async ({ id } = {}) => { if(!suite.library.some(x=>x.id===id))return socket.emit('operation:error',{message:'That link is no longer in the shared library.'}); suite.library = suite.library.filter(item => item.id !== id); emitToSuite(suite.number, 'library:state', suite.library); await persist(); });
  socket.on('vault:add', async ({ text } = {}) => { if (typeof text !== 'string' || !text.trim() || text.length > 1000) return socket.emit('operation:error', { message: 'Notes must be between 1 and 1,000 characters.' }); suite.vault.push({ id: randomUUID(), text: text.trim(), by: guest, at: new Date().toISOString() }); emitToSuite(suite.number, 'vault:state', suite.vault); await persist(); });
  socket.on('disconnect', () => removeOccupant(suite, socket.id));
});

app.use((err, _req, res, _next) => { console.error('Request failed:', err.message); const status=err instanceof multer.MulterError?(err.code==='LIMIT_FILE_SIZE'?413:400):(err.status||500);res.status(status).json({ error: status===413?'That file is too large. The limit is 15 MB.':status===400?'Please choose one supported file.':'Something went wrong. Please try again.' }); });
httpServer.listen(PORT, () => console.log(`LUNEX is ready on port ${PORT}`));
