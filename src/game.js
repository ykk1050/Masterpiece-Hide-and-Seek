/*
 * 게임 진행 로직 (방, 단계, 술래 차례, 판정)
 *
 * 단계(phase): lobby → hiding → seeking → results
 * 찾기 단계(seek.stage):
 *   choosing : 다음 술래를 고르는 중 (무작위 모드면 잠시 후 자동 선택)
 *   turn     : 술래가 클릭해서 찾는 중
 *   between  : 차례가 끝나고 다음 술래로 넘어가기 전 잠깐 대기
 */
const crypto = require('crypto');
const Shapes = require('../shared/shapes');
const paintings = require('./paintings');

const DEFAULT_SETTINGS = {
  hideSeconds: 300,
  turnSeconds: 40,
  missesAllowed: 1,
  seekerMode: 'random', // 'random' | 'teacher'
  allowEyedropper: true,
  charSize: 'medium', // 'small' | 'medium' | 'large'
  teacherClick: false,
};

const HIT_TOLERANCE = 0.6; // 칸 단위 클릭 여유
const MAGNIFIER_AFTER = 3; // 연속 실패 횟수
const ROULETTE_MS = 3000;
const BETWEEN_MS = 2500;
const ROOM_TTL_MS = 4 * 60 * 60 * 1000;

const rooms = new Map();
let io = null;

function init(socketServer) {
  io = socketServer;
  setInterval(cleanup, 10 * 60 * 1000).unref();
}

function cleanup() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActive > ROOM_TTL_MS) {
      clearTimeout(room.timer);
      rooms.delete(code);
    }
  }
}

function newCode() {
  let code;
  do code = String(Math.floor(1000 + Math.random() * 9000));
  while (rooms.has(code));
  return code;
}

const clampInt = (v, lo, hi, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
};

function sanitizeSettings(input, base) {
  const s = { ...(base || DEFAULT_SETTINGS) };
  if (!input) return s;
  if ('hideSeconds' in input) s.hideSeconds = clampInt(input.hideSeconds, 30, 1800, s.hideSeconds);
  if ('turnSeconds' in input) s.turnSeconds = clampInt(input.turnSeconds, 10, 300, s.turnSeconds);
  if ('missesAllowed' in input) s.missesAllowed = clampInt(input.missesAllowed, 1, 5, s.missesAllowed);
  if (input.seekerMode === 'random' || input.seekerMode === 'teacher') s.seekerMode = input.seekerMode;
  if ('allowEyedropper' in input) s.allowEyedropper = !!input.allowEyedropper;
  if (Shapes.CELL_SIZES[input.charSize]) s.charSize = input.charSize;
  if ('teacherClick' in input) s.teacherClick = !!input.teacherClick;
  return s;
}

function cellSize(room) {
  return Shapes.CELL_SIZES[room.settings.charSize] || Shapes.CELL_SIZES.medium;
}

/* ---------- 상태 전송 ---------- */

function publicState(room) {
  const s = room.seek;
  return {
    code: room.code,
    phase: room.phase,
    settings: room.settings,
    painting: {
      title: room.painting.title,
      artist: room.painting.artist,
      year: room.painting.year,
      url: room.painting.url,
    },
    world: room.world,
    cell: cellSize(room),
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      shape: p.shape,
      connected: p.connected,
      found: p.found,
      foundBy: p.foundBy,
      hasSought: p.hasSought,
      finds: p.finds,
      painted: Math.round(p.painted * 100),
      ready: !!p.ready,
    })),
    phaseDeadline: room.phaseDeadline,
    seek: s && {
      stage: s.stage,
      seekerId: s.seekerId,
      misses: s.misses,
      deadline: s.deadline,
      failStreak: s.failStreak,
      magnifier: s.magnifier,
    },
    teacherOnline: !!room.teacherSocketId,
    serverNow: Date.now(),
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  io.to(room.code).emit('room:state', publicState(room));
}

function characterList(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    shape: p.shape,
    x: p.x,
    y: p.y,
    pixels: p.pixels,
    found: p.found,
  }));
}

/** 찾기 단계부터는 모든 캐릭터가 그림 위에 그려져야 하므로 전체에 공개한다 */
function sendCharacters(room, target) {
  (target || io.to(room.code)).emit('room:characters', characterList(room));
}

function sendMonitor(room, p) {
  if (room.monitor && room.teacherSocketId) {
    io.to(room.teacherSocketId).emit('monitor:char', {
      id: p.id, shape: p.shape, x: p.x, y: p.y, pixels: p.pixels,
    });
  }
}

/* ---------- 방 만들기 / 입장 ---------- */

function createRoom(socket, { settings, painting }) {
  const code = newCode();
  const room = {
    code,
    teacherToken: crypto.randomBytes(12).toString('hex'),
    teacherSocketId: socket.id,
    settings: sanitizeSettings(settings),
    painting: null,
    world: { w: 1600, h: 1200 },
    phase: 'lobby',
    players: new Map(),
    seek: null,
    phaseDeadline: null,
    timer: null,
    monitor: false,
    lastActive: Date.now(),
  };
  const err = applyPainting(room, painting);
  if (err) return { error: err };
  rooms.set(code, room);
  socket.join(code);
  socket.data = { role: 'teacher', code };
  return { code, teacherToken: room.teacherToken, state: publicState(room) };
}

function applyPainting(room, painting) {
  if (!painting) return '그림을 선택해 주세요.';
  if (painting.kind === 'preset') {
    const preset = paintings.find(painting.id);
    if (!preset) return '알 수 없는 그림입니다.';
    room.painting = {
      kind: 'preset', id: preset.id, title: preset.title, artist: preset.artist, year: preset.year,
      url: `/api/paintings/${preset.id}/image`,
    };
  } else if (painting.kind === 'upload') {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(painting.dataUrl || '');
    if (!m) return '이미지 파일을 읽을 수 없습니다.';
    const version = Date.now().toString(36);
    room.painting = {
      kind: 'upload', title: String(painting.title || '업로드한 그림').slice(0, 60), artist: '', year: null,
      mime: m[1], buffer: Buffer.from(m[2], 'base64'),
      url: `/api/rooms/${room.code}/painting?v=${version}`,
    };
  } else {
    return '그림 정보가 올바르지 않습니다.';
  }
  return null;
}

function teacherRejoin(socket, { code, teacherToken }) {
  const room = rooms.get(String(code));
  if (!room || room.teacherToken !== teacherToken) return { error: '방을 찾을 수 없습니다.' };
  room.teacherSocketId = socket.id;
  socket.join(room.code);
  socket.data = { role: 'teacher', code: room.code };
  broadcast(room);
  if (room.phase === 'seeking' || room.phase === 'results') sendCharacters(room, socket);
  return { code: room.code, teacherToken, state: publicState(room) };
}

function randomSpot(room, shapeId) {
  const s = Shapes.get(shapeId);
  const cell = cellSize(room);
  const w = s.cols * cell, h = s.rows * cell;
  return {
    x: Math.round(Math.random() * Math.max(0, room.world.w - w)),
    y: Math.round(Math.random() * Math.max(0, room.world.h - h)),
  };
}

function playerJoin(socket, { code, name, shape, playerId }) {
  const room = rooms.get(String(code || '').trim());
  if (!room) return { error: '방 번호를 다시 확인해 주세요.' };

  let player = playerId && room.players.get(playerId);
  if (!player) {
    if (room.phase === 'seeking' || room.phase === 'results') {
      return { error: '이미 게임이 진행 중이에요. 다음 판에 참여해 주세요.' };
    }
    name = String(name || '').trim().slice(0, 12);
    if (!name) return { error: '이름을 입력해 주세요.' };
    if (!Shapes.DEFS[shape]) shape = 'person';
    player = {
      id: crypto.randomBytes(8).toString('hex'),
      name, shape,
      socketId: null, connected: false,
      x: 0, y: 0, pixels: Shapes.blankPixels(shape), painted: 0,
      found: false, foundBy: null, hasSought: false, finds: 0,
    };
    if (room.phase === 'hiding') Object.assign(player, randomSpot(room, shape));
    room.players.set(player.id, player);
  }
  player.socketId = socket.id;
  player.connected = true;
  socket.join(room.code);
  socket.data = { role: 'player', code: room.code, playerId: player.id };
  broadcast(room);
  if (room.phase === 'seeking' || room.phase === 'results') sendCharacters(room, socket);
  return { playerId: player.id, you: selfData(player), state: publicState(room) };
}

function selfData(p) {
  return { id: p.id, name: p.name, shape: p.shape, x: p.x, y: p.y, pixels: p.pixels };
}

function disconnect(socket) {
  const d = socket.data || {};
  const room = rooms.get(d.code);
  if (!room) return;
  if (d.role === 'teacher' && room.teacherSocketId === socket.id) {
    room.teacherSocketId = null;
    broadcast(room);
  } else if (d.role === 'player') {
    const p = room.players.get(d.playerId);
    if (p && p.socketId === socket.id) {
      p.connected = false;
      const online = [...room.players.values()].filter((x) => x.connected);
      if (room.phase === 'hiding' && online.length && online.every((x) => x.ready)) startSeeking(room);
      else broadcast(room);
    }
  }
}

/* ---------- 교사 조작 ---------- */

function teacherAction(socket, action, payload) {
  const d = socket.data || {};
  const room = rooms.get(d.code);
  if (!room || d.role !== 'teacher' || room.teacherSocketId !== socket.id) return { error: '권한이 없습니다.' };
  payload = payload || {};

  switch (action) {
    case 'settings':
      room.settings = sanitizeSettings(payload, room.settings);
      break;
    case 'painting': {
      if (room.phase !== 'lobby') return { error: '대기실에서만 그림을 바꿀 수 있어요.' };
      const err = applyPainting(room, payload);
      if (err) return { error: err };
      break;
    }
    case 'worldSize': {
      const w = Number(payload.w), h = Number(payload.h);
      if (w > 0 && h > 0 && w <= 4000 && h <= 4000) room.world = { w: Math.round(w), h: Math.round(h) };
      return {};
    }
    case 'monitor':
      room.monitor = !!payload.on;
      if (room.monitor) for (const p of room.players.values()) sendMonitor(room, p);
      return {};
    case 'kick': {
      const p = room.players.get(payload.playerId);
      if (!p) break;
      if (room.phase === 'seeking') return { error: '찾기 중에는 내보낼 수 없어요.' };
      room.players.delete(p.id);
      if (p.socketId) io.to(p.socketId).emit('kicked');
      break;
    }
    case 'start':
      if (room.phase !== 'lobby') return { error: '이미 시작했어요.' };
      if (room.players.size === 0) return { error: '참여한 학생이 없어요.' };
      startHiding(room);
      break;
    case 'addTime':
      if (room.phase !== 'hiding') return {};
      setPhaseTimer(room, room.phaseDeadline - Date.now() + 60 * 1000, () => startSeeking(room));
      break;
    case 'endHiding':
      if (room.phase === 'hiding') startSeeking(room);
      break;
    case 'chooseSeeker': {
      if (room.phase !== 'seeking' || room.seek.stage !== 'choosing') return { error: '지금은 술래를 고를 수 없어요.' };
      const p = payload.random ? pickRandom(eligibleSeekers(room)) : room.players.get(payload.playerId);
      if (!p || !eligibleSeekers(room).includes(p)) return { error: '이 학생은 술래가 될 수 없어요.' };
      startTurn(room, p);
      break;
    }
    case 'skipTurn':
      if (room.phase === 'seeking' && room.seek.stage === 'turn') endTurn(room, 'skip');
      break;
    case 'finish':
      if (room.phase === 'hiding' || room.phase === 'seeking') finish(room);
      break;
    case 'reset':
      resetToLobby(room);
      break;
    case 'seekClick':
      if (!room.settings.teacherClick) return { error: '교사 화면 클릭이 꺼져 있어요.' };
      return seekClick(room, payload.x, payload.y);
    default:
      return { error: '알 수 없는 요청' };
  }
  broadcast(room);
  return {};
}

/* ---------- 학생 조작 ---------- */

function playerOf(socket) {
  const d = socket.data || {};
  const room = rooms.get(d.code);
  if (!room || d.role !== 'player') return {};
  const p = room.players.get(d.playerId);
  if (!p || p.socketId !== socket.id) return {};
  return { room, p };
}

/** 그리기 완료 / 취소. 접속 중인 모든 학생이 완료하면 바로 찾기 시작 */
function playerReady(socket, { ready }) {
  const { room, p } = playerOf(socket);
  if (!p || room.phase !== 'hiding') return;
  p.ready = !!ready;
  const online = [...room.players.values()].filter((x) => x.connected);
  if (online.length && online.every((x) => x.ready)) startSeeking(room);
  else broadcast(room);
}

function playerMove(socket, { x, y }) {
  const { room, p } = playerOf(socket);
  if (!p || room.phase !== 'hiding' || p.ready) return;
  const s = Shapes.get(p.shape);
  const cell = cellSize(room);
  x = Number(x); y = Number(y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  p.x = Math.max(0, Math.min(room.world.w - s.cols * cell, x));
  p.y = Math.max(0, Math.min(room.world.h - s.rows * cell, y));
  sendMonitor(room, p);
}

function playerPaint(socket, { pixels }) {
  const { room, p } = playerOf(socket);
  if (!p || room.phase !== 'hiding' || p.ready) return;
  if (!Shapes.isValidPixels(p.shape, pixels)) return;
  p.pixels = pixels;
  const before = Math.round(p.painted * 100);
  p.painted = Shapes.paintedRatio(p.shape, pixels);
  sendMonitor(room, p);
  if (Math.round(p.painted * 100) !== before) broadcastSoon(room);
}

function broadcastSoon(room) {
  if (room.broadcastPending) return;
  room.broadcastPending = true;
  setTimeout(() => {
    room.broadcastPending = false;
    broadcast(room);
  }, 1000);
}

function playerSeekClick(socket, { x, y }) {
  const { room, p } = playerOf(socket);
  if (!p || room.phase !== 'seeking' || !room.seek || room.seek.seekerId !== p.id) return { error: '지금은 차례가 아니에요.' };
  return seekClick(room, x, y);
}

function playerCursor(socket, { x, y }) {
  const { room, p } = playerOf(socket);
  if (!p || room.phase !== 'seeking' || !room.seek || room.seek.seekerId !== p.id) return;
  socket.to(room.code).emit('seek:cursor', { x: Number(x), y: Number(y) });
}

/* ---------- 단계 진행 ---------- */

function setPhaseTimer(room, ms, fn) {
  clearTimeout(room.timer);
  room.phaseDeadline = Date.now() + ms;
  room.timer = setTimeout(fn, ms);
}

function clearPhaseTimer(room) {
  clearTimeout(room.timer);
  room.timer = null;
  room.phaseDeadline = null;
}

function startHiding(room) {
  room.phase = 'hiding';
  room.seek = null;
  for (const p of room.players.values()) {
    Object.assign(p, randomSpot(room, p.shape));
    p.pixels = Shapes.blankPixels(p.shape);
    p.painted = 0;
    p.found = false; p.foundBy = null; p.hasSought = false; p.finds = 0; p.ready = false;
    if (p.socketId) io.to(p.socketId).emit('player:you', selfData(p));
  }
  setPhaseTimer(room, room.settings.hideSeconds * 1000, () => startSeeking(room));
}

function startSeeking(room) {
  clearPhaseTimer(room);
  room.phase = 'seeking';
  room.seek = { stage: 'choosing', seekerId: null, misses: 0, deadline: null, failStreak: 0, magnifier: false };
  sendCharacters(room);
  nextSeeker(room);
  broadcast(room);
}

/** 아직 술래를 해 본 적 없는 접속 중인 학생 중, 자기 말고 숨은 친구가 남아 있는 학생 */
function eligibleSeekers(room) {
  const hidden = [...room.players.values()].filter((p) => !p.found);
  return [...room.players.values()].filter(
    (p) => !p.hasSought && p.connected && hidden.some((h) => h.id !== p.id)
  );
}

function pickRandom(arr) {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}

function nextSeeker(room) {
  const eligible = eligibleSeekers(room);
  if (!eligible.length) return finish(room);
  room.seek.stage = 'choosing';
  room.seek.seekerId = null;
  room.seek.misses = 0;
  if (room.settings.seekerMode === 'random') {
    room.seek.deadline = Date.now() + ROULETTE_MS;
    clearTimeout(room.timer);
    room.timer = setTimeout(() => {
      if (room.phase !== 'seeking' || room.seek.stage !== 'choosing') return;
      const p = pickRandom(eligibleSeekers(room));
      if (p) startTurn(room, p);
      else finish(room);
      broadcast(room);
    }, ROULETTE_MS);
  } else {
    clearTimeout(room.timer);
    room.seek.deadline = null;
  }
}

function startTurn(room, p) {
  p.hasSought = true;
  room.seek.stage = 'turn';
  room.seek.seekerId = p.id;
  room.seek.misses = 0;
  // 3명 연속으로 못 찾으면 이번 술래에게 돋보기 찬스
  room.seek.magnifier = room.seek.failStreak >= MAGNIFIER_AFTER;
  if (room.seek.magnifier) room.seek.failStreak = 0;
  resetTurnTimer(room);
}

function resetTurnTimer(room) {
  clearTimeout(room.timer);
  const ms = room.settings.turnSeconds * 1000;
  room.seek.deadline = Date.now() + ms;
  room.timer = setTimeout(() => {
    if (room.phase === 'seeking' && room.seek.stage === 'turn') {
      io.to(room.code).emit('seek:result', { hit: false, timeout: true, seekerId: room.seek.seekerId });
      room.seek.failStreak++;
      endTurn(room, 'timeout');
      broadcast(room);
    }
  }, ms);
}

function endTurn(room) {
  clearTimeout(room.timer);
  room.seek.stage = 'between';
  room.seek.deadline = Date.now() + BETWEEN_MS;
  room.timer = setTimeout(() => {
    if (room.phase !== 'seeking') return;
    nextSeeker(room);
    broadcast(room);
  }, BETWEEN_MS);
}

function hitTest(room, x, y, seekerId) {
  const cell = cellSize(room);
  const list = [...room.players.values()].reverse(); // 나중에 그려진(위에 있는) 캐릭터부터
  for (const p of list) {
    if (p.found || p.id === seekerId) continue;
    const lx = (x - p.x) / cell, ly = (y - p.y) / cell;
    if (Shapes.hit(p.shape, lx, ly, HIT_TOLERANCE)) return p;
  }
  return null;
}

function seekClick(room, x, y) {
  if (room.phase !== 'seeking' || room.seek.stage !== 'turn') return { error: '지금은 찾을 수 없어요.' };
  x = Number(x); y = Number(y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return {};
  const seeker = room.players.get(room.seek.seekerId);
  const target = hitTest(room, x, y, room.seek.seekerId);

  if (target) {
    target.found = true;
    target.foundBy = seeker ? seeker.id : null;
    if (seeker) seeker.finds++;
    room.seek.failStreak = 0;
    io.to(room.code).emit('seek:result', { hit: true, x, y, foundId: target.id, seekerId: room.seek.seekerId });
    const stillHidden = [...room.players.values()].some((p) => !p.found && p.id !== room.seek.seekerId);
    if (!stillHidden) endTurn(room);
    else resetTurnTimer(room);
  } else {
    room.seek.misses++;
    const out = room.seek.misses >= room.settings.missesAllowed;
    io.to(room.code).emit('seek:result', { hit: false, x, y, seekerId: room.seek.seekerId, turnOver: out });
    if (out) {
      room.seek.failStreak++;
      endTurn(room);
    }
  }
  broadcast(room);
  return {};
}

function finish(room) {
  clearPhaseTimer(room);
  room.phase = 'results';
  if (room.seek) {
    room.seek.stage = 'done';
    room.seek.deadline = null;
  }
  sendCharacters(room);
  broadcast(room);
}

function resetToLobby(room) {
  clearPhaseTimer(room);
  room.phase = 'lobby';
  room.seek = null;
  for (const p of room.players.values()) {
    p.pixels = Shapes.blankPixels(p.shape);
    p.painted = 0;
    p.found = false; p.foundBy = null; p.hasSought = false; p.finds = 0; p.ready = false;
  }
  // 접속이 끊긴 학생은 새 판에서 정리한다
  for (const [id, p] of room.players) if (!p.connected) room.players.delete(id);
}

function getRoom(code) {
  return rooms.get(String(code));
}

module.exports = {
  init, createRoom, teacherRejoin, playerJoin, disconnect, teacherAction,
  playerReady, playerMove, playerPaint, playerSeekClick, playerCursor, getRoom, DEFAULT_SETTINGS,
};
