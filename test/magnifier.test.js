/*
 * 돋보기 찬스 테스트: 정한 횟수 연속 실패 → 생김, 실패해도 유지, 찾으면 사라짐, 끄면 안 생김
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 3913;
let server;
const sockets = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const connect = () =>
  new Promise((resolve) => {
    const s = io(`http://localhost:${PORT}`, { transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.on('room:state', (st) => { s.latest = st; });
    s.on('connect', () => resolve(s));
  });
async function until(s, pred, ms = 6000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (s.latest && pred(s.latest)) return s.latest;
    await sleep(30);
  }
  throw new Error('시간 초과 ' + JSON.stringify(s.latest && s.latest.seek));
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

/** 학생 n명이 겹치지 않게 숨은 방을 만들고 찾기 단계까지 진행 */
async function setupRoom(settings, n) {
  const teacher = await connect();
  const { code } = await emit(teacher, 'teacher:create', {
    painting: { kind: 'preset', id: 'starry-night' },
    settings: { seekerMode: 'teacher', turnSeconds: 60, ...settings },
  });
  await emit(teacher, 'teacher:action', { action: 'worldSize', payload: { w: 1600, h: 1267 } });
  const kids = [];
  for (let i = 0; i < n; i++) {
    const s = await connect();
    s.pid = (await emit(s, 'player:join', { code, name: '학생' + i, shape: 'person' })).playerId;
    kids.push(s);
  }
  await emit(teacher, 'teacher:action', { action: 'start' });
  await until(teacher, (x) => x.phase === 'hiding');
  const cell = teacher.latest.cell;
  kids.forEach((k, i) => {
    k.pos = { x: 100 + i * 250, y: 300 };
    k.emit('player:move', k.pos);
    k.center = { x: k.pos.x + 10.5 * cell, y: k.pos.y + 15.5 * cell };
  });
  await sleep(150);
  await emit(teacher, 'teacher:action', { action: 'endHiding' });
  const turn = async (k) => {
    await until(teacher, (x) => x.seek && x.seek.stage === 'choosing');
    await emit(teacher, 'teacher:action', { action: 'chooseSeeker', payload: { playerId: k.pid } });
    return until(teacher, (x) => x.seek.stage === 'turn' && x.seek.seekerId === k.pid);
  };
  const failTurn = async (k) => {
    await turn(k);
    await emit(k, 'seek:click', { x: 1500, y: 1200 });
    await until(teacher, (x) => x.seek.stage !== 'turn');
  };
  return { teacher, kids, turn, failTurn };
}

test('2번 실패하면 생기고, 실패해도 유지되고, 찾으면 사라짐', { timeout: 60000 }, async () => {
  const { teacher, kids, turn, failTurn } = await setupRoom({ magnifierEnabled: true, magnifierAfter: 2 }, 5);
  await failTurn(kids[0]);
  let st = await turn(kids[1]);
  assert.equal(st.seek.magnifier, false, '1번 실패로는 아직 없음');
  await emit(kids[1], 'seek:click', { x: 1500, y: 1200 });
  await until(teacher, (x) => x.seek.stage !== 'turn');

  st = await turn(kids[2]);
  assert.equal(st.seek.magnifier, true, '2번 연속 실패 → 돋보기');
  await emit(kids[2], 'seek:click', { x: 1500, y: 1200 });
  await until(teacher, (x) => x.seek.stage !== 'turn');

  st = await turn(kids[3]);
  assert.equal(st.seek.magnifier, true, '돋보기 술래가 실패해도 다음 술래에게 유지');
  await emit(kids[3], 'seek:click', kids[0].center);
  st = await until(teacher, (x) => x.players.find((p) => p.id === kids[0].pid).found);
  assert.equal(st.seek.magnifier, false, '찾으면 바로 사라짐');
  assert.equal(st.seek.lensUnlocked, false);
  assert.equal(st.seek.failStreak, 0);
});

test('돋보기 끄면 계속 실패해도 안 생김', { timeout: 60000 }, async () => {
  const { kids, turn, failTurn } = await setupRoom({ magnifierEnabled: false, magnifierAfter: 1 }, 3);
  await failTurn(kids[0]);
  await failTurn(kids[1]);
  const st = await turn(kids[2]);
  assert.equal(st.seek.magnifier, false);
});
