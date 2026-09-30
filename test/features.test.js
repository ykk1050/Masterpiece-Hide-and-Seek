/*
 * 추가 기능 테스트: 대기실 모양 바꾸기, 회전한 캐릭터 판정, 여러 바퀴 술래, 선생님 참여
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { io } = require('socket.io-client');
const Shapes = require('../shared/shapes');

const PORT = 3912;
const URL = `http://localhost:${PORT}`;
let server;
const sockets = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const connect = () =>
  new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.on('room:state', (st) => { s.latest = st; });
    s.on('room:characters', (c) => { s.chars = c; });
    s.on('connect', () => resolve(s));
  });
async function until(s, pred, ms = 6000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (s.latest && pred(s.latest)) return s.latest;
    await sleep(30);
  }
  throw new Error('시간 초과 ' + JSON.stringify(s.latest && { phase: s.latest.phase, seek: s.latest.seek }));
}

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('서버가 시작')) resolve(); }));
});
after(() => {
  sockets.forEach((s) => s.close());
  server.kill();
});

test('모양 바꾸기 · 회전 · 여러 바퀴 · 선생님 참여', { timeout: 60000 }, async () => {
  const teacher = await connect();
  const created = await emit(teacher, 'teacher:create', {
    painting: { kind: 'preset', id: 'starry-night' },
    settings: { seekerMode: 'teacher', seekRounds: 2, teacherPlays: true, turnSeconds: 60 },
  });
  const { code, teacherPlayToken } = created;
  assert.ok(teacherPlayToken, '선생님 참여용 토큰');
  assert.equal(created.state.settings.seekRounds, 2);
  await emit(teacher, 'teacher:action', { action: 'worldSize', payload: { w: 1600, h: 1267 } });

  /* ---- 선생님 참여 ---- */
  const bad = await connect();
  assert.ok((await emit(bad, 'player:join', { code, name: '가짜', teacherPlayToken: 'nope' })).error, '틀린 토큰은 거절');
  const tp = await connect();
  const tj = await emit(tp, 'player:join', { code, name: '선생님', shape: 'cat', teacherPlayToken });
  assert.ok(tj.you.isTeacher, '선생님 캐릭터로 표시');

  const A = await connect();
  const B = await connect();
  const a = await emit(A, 'player:join', { code, name: '가온', shape: 'person' });
  const b = await emit(B, 'player:join', { code, name: '나린', shape: 'person' });

  /* ---- 대기실에서 모양 바꾸기 ---- */
  const changed = await emit(A, 'player:shape', { shape: 'dog' });
  assert.equal(changed.you.shape, 'dog');
  assert.equal(changed.you.pixels.length, 32 * 24 * 6, '새 모양 크기의 흰 캐릭터');
  let st = await until(teacher, (x) => x.players.find((p) => p.id === a.playerId).shape === 'dog');

  await emit(teacher, 'teacher:action', { action: 'start' });
  await until(teacher, (x) => x.phase === 'hiding');
  assert.ok((await emit(A, 'player:shape', { shape: 'cat' })).error, '게임 중에는 모양을 못 바꿈');

  /* ---- 배치 + 회전 ---- */
  const cell = teacher.latest.cell;
  const chars = {
    A: { shape: 'dog', x: 400, y: 400, rot: Math.PI / 2 },
    B: { shape: 'person', x: 900, y: 300, rot: 0 },
    T: { shape: 'cat', x: 1200, y: 300, rot: -0.5 },
  };
  A.emit('player:move', chars.A);
  B.emit('player:move', chars.B);
  tp.emit('player:move', chars.T);
  await sleep(200);
  // 그림 밖으로 나가게 돌려도 그림 안으로 맞춰짐
  const edge = await connect();
  await emit(edge, 'player:join', { code, name: '다솜', shape: 'person' });
  edge.emit('player:move', { x: 0, y: 0, rot: Math.PI / 4 });
  await sleep(100);
  edge.emit('player:ready', { ready: true });

  for (const s of [A, B, tp]) s.emit('player:ready', { ready: true });
  await until(teacher, (x) => x.phase === 'seeking');

  const pointOn = (ch, c, r) => Shapes.toWorld(ch, cell, c, r);
  const aBody = pointOn(chars.A, 6.5, 12.5); // 강아지 몸통 왼쪽
  const bBody = pointOn(chars.B, 10.5, 15.5);
  const tBody = pointOn(chars.T, 11.5, 19.5);
  assert.ok(Shapes.hitWorld(chars.A, cell, aBody.x, aBody.y, 0), '테스트 좌표가 회전한 강아지 위');
  const miss = { x: 60, y: 1200 };
  const idOf = { A: a.playerId, B: b.playerId, T: tj.playerId };
  const choose = async (id) => {
    await until(teacher, (x) => x.seek.stage === 'choosing');
    const r = await emit(teacher, 'teacher:action', { action: 'chooseSeeker', payload: { playerId: id } });
    assert.ok(!r.error, r.error);
    await until(teacher, (x) => x.seek.stage === 'turn' && x.seek.seekerId === id);
  };
  const found = (id) => until(teacher, (x) => x.players.find((p) => p.id === id).found);

  /* ---- 1바퀴: 가온 실패, 나린 실패, 다솜 실패, 선생님이 회전한 가온 찾고 실패 ---- */
  await choose(idOf.A);
  await emit(A, 'seek:click', miss);
  await until(teacher, (x) => x.seek.stage === 'between');
  await choose(idOf.B);
  await emit(B, 'seek:click', miss);
  await until(teacher, (x) => x.seek.stage === 'between');
  const dasomId = teacher.latest.players.find((p) => p.name === '다솜').id;
  await choose(dasomId);
  await emit(edge, 'seek:click', miss);
  await until(teacher, (x) => x.seek.stage === 'between');
  await choose(idOf.T);
  await emit(tp, 'seek:click', aBody);
  await found(idOf.A);
  await emit(tp, 'seek:click', miss);
  await until(teacher, (x) => x.seek.stage === 'between');

  /* ---- 모두 한 번씩 했지만 숨은 친구가 남아서 2바퀴째 ---- */
  st = await until(teacher, (x) => x.seek.stage === 'choosing');
  assert.equal(st.seek.round, 2, '2바퀴째로 넘어감');
  assert.equal(st.phase, 'seeking');
  assert.ok(!st.players.find((p) => p.id === idOf.A).hasSought, '2바퀴에서는 다시 술래 가능');

  /* ---- 2바퀴: 가온(이미 발견됨)이 술래로 나린, 선생님, 다솜 찾기 → 결과 ---- */
  await choose(idOf.A);
  await emit(A, 'seek:click', bBody);
  await found(idOf.B);
  await emit(A, 'seek:click', tBody);
  await found(idOf.T);
  const dasom = teacher.chars.find((c) => c.id === dasomId);
  // 그림 밖으로 나가지 않게 맞춰진 위치 확인
  const f = Shapes.frame(dasom, cell);
  const half = (f.w * Math.abs(f.cos) + f.h * Math.abs(f.sin)) / 2;
  assert.ok(f.cx >= half - 0.01, '회전해도 그림 왼쪽 밖으로 안 나감');
  await emit(A, 'seek:click', pointOn(dasom, 10.5, 15.5));
  st = await until(teacher, (x) => x.phase === 'results');
  assert.equal(st.players.find((p) => p.id === idOf.A).finds, 3);
  assert.equal(st.players.find((p) => p.id === idOf.T).finds, 1);
});

test('1바퀴 설정이면 모두 술래를 하면 끝', { timeout: 30000 }, async () => {
  const teacher = await connect();
  const { code } = await emit(teacher, 'teacher:create', {
    painting: { kind: 'preset', id: 'starry-night' },
    settings: { seekerMode: 'teacher', seekRounds: 1 },
  });
  await emit(teacher, 'teacher:action', { action: 'worldSize', payload: { w: 1600, h: 1267 } });
  const kids = [];
  for (const n of ['하나', '두리']) {
    const s = await connect();
    s.join = await emit(s, 'player:join', { code, name: n, shape: 'person' });
    kids.push(s);
  }
  await emit(teacher, 'teacher:action', { action: 'start' });
  await until(teacher, (x) => x.phase === 'hiding');
  kids[0].emit('player:move', { x: 100, y: 100 });
  kids[1].emit('player:move', { x: 800, y: 600 });
  await sleep(100);
  await emit(teacher, 'teacher:action', { action: 'endHiding' });
  for (const k of kids) {
    await until(teacher, (x) => x.seek && x.seek.stage === 'choosing');
    await emit(teacher, 'teacher:action', { action: 'chooseSeeker', payload: { playerId: k.join.playerId } });
    await until(teacher, (x) => x.seek.stage === 'turn');
    await emit(k, 'seek:click', { x: 1500, y: 1200 });
    await until(teacher, (x) => x.seek.stage !== 'turn');
  }
  const st = await until(teacher, (x) => x.phase === 'results');
  assert.ok(st.players.every((p) => !p.found), '아무도 못 찾고 끝남');
});
