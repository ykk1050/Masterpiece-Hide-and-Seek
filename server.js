const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const paintings = require('./src/paintings');
const game = require('./src/game');

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10 * 1024 * 1024 });
game.init(io);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));

/** 학생들이 접속할 주소(같은 와이파이의 교사 PC IP) 안내용 */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
    }
  }
  return out;
}

app.get('/api/info', (req, res) => {
  res.json({ addresses: lanAddresses(), port: PORT });
});

app.get('/api/paintings', (req, res) => {
  res.json(paintings.list());
});

app.get('/api/paintings/:id/:size', async (req, res) => {
  try {
    const file = await paintings.getImagePath(req.params.id, req.params.size);
    if (!file) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(file);
  } catch (e) {
    console.error('[painting]', req.params.id, e.message);
    res.status(502).json({ error: '그림을 내려받지 못했어요. 인터넷 연결을 확인하거나 그림을 직접 업로드해 주세요.' });
  }
});

app.get('/api/rooms/:code/painting', (req, res) => {
  const room = game.getRoom(req.params.code);
  if (!room || !room.painting || room.painting.kind !== 'upload') return res.status(404).end();
  res.set('Content-Type', room.painting.mime);
  res.send(room.painting.buffer);
});

const reply = (cb, value) => {
  if (typeof cb === 'function') cb(value || {});
};

io.on('connection', (socket) => {
  socket.on('teacher:create', (data, cb) => reply(cb, game.createRoom(socket, data || {})));
  socket.on('teacher:rejoin', (data, cb) => reply(cb, game.teacherRejoin(socket, data || {})));
  socket.on('teacher:action', (data, cb) => {
    data = data || {};
    reply(cb, game.teacherAction(socket, data.action, data.payload));
  });

  socket.on('player:join', (data, cb) => reply(cb, game.playerJoin(socket, data || {})));
  socket.on('player:move', (data) => game.playerMove(socket, data || {}));
  socket.on('player:paint', (data) => game.playerPaint(socket, data || {}));
  socket.on('seek:click', (data, cb) => reply(cb, game.playerSeekClick(socket, data || {})));
  socket.on('seek:cursor', (data) => game.playerCursor(socket, data || {}));

  socket.on('disconnect', () => game.disconnect(socket));
});

server.listen(PORT, () => {
  console.log('\n🎨 명화 속 숨바꼭질 서버가 시작되었습니다.');
  console.log(`   교사용:  http://localhost:${PORT}/teacher.html`);
  const addrs = lanAddresses();
  if (addrs.length) {
    console.log('   학생 접속 주소 (같은 와이파이):');
    for (const a of addrs) console.log('     ' + a);
  }
  console.log('');
});
