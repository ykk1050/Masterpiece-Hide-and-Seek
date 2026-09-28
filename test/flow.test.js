/*
 * 한 판 전체 흐름 테스트: 교사 1명 + 학생 5명이 실제 서버에 접속해서
 * 입장 → 숨기 → 그리기 완료 자동 시작 → 찾기(성공/실패/무시되는 클릭) → 돋보기 찬스 → 결과 → 다시 하기
 * 실행: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 3911;
const URL = `http://localhost:${PORT}`;
let server;
const sockets = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const connect = () =>
  new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.latest = null;
    s.on('room:state', (st) => { s.latest = st; });
    s.on('room:characters', (c) => { s.chars = c; });
    s.on('connect', () => resolve(s));
  });

/** 조건을 만족하는 상태가 올 때까지 기다린다 */
async function until(s, pred, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (s.latest && pred(s.latest)) return s.latest;
    await sleep(30);
  }
  throw new Error('시간 초과: 기대한 상태가 오지 않음 ' + JSON.stringify(s.latest && { phase: s.latest.phase, seek: s.latest.seek }));
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

test('한 판 전체 흐름', { timeout: 60000 }, async () => {
  /* ---- 방 만들기 ---- */
  const teacher = await connect();
  const created = await emit(teacher, 'teacher:create', {
    painting: { kind: 'preset', id: 'starry-night' },
    settings: { seekerMode: 'teacher', missesAllowed: 1, turnSeconds: 60, charSize: 'xlarge' },
  });
  assert.ok(created.code, '방 번호가 생겨야 함');
  assert.equal(created.state.settings.charSize, 'xlarge');
  await emit(teacher, 'teacher:action', { action: 'worldSize', payload: { w: 1600, h: 1267 } });
  const code = created.code;

  /* ---- 입장 ---- */
  const names = ['가람', '나래', '다온', '라온', '마루'];
  const kids = {};
  for (const n of names) {
    const s = await connect();
    const res = await emit(s, 'player:join', { code, name: n, shape: 'person' });
    assert.ok(res.playerId, n + ' 입장');
    s.id_ = res.playerId;
    kids[n] = s;
  }
  const dup = await connect();
  const dupRes = await emit(dup, 'player:join', { code, name: '가람', shape: 'cat' });
  assert.match(dupRes.error, /같은 이름/, '접속 중인 같은 이름은 막아야 함');
  const wrong = await emit(dup, 'player:join', { code: '0000', name: '누구', shape: 'cat' });
  assert.ok(wrong.error, '없는 방 번호는 막아야 함');

  /* ---- 진행 중 크기 변경은 무시 ---- */
  await emit(teacher, 'teacher:action', { action: 'start' });
  await until(teacher, (st) => st.phase === 'hiding');
  await emit(teacher, 'teacher:action', { action: 'settings', payload: { charSize: 'small' } });
  let st = await until(teacher, (x) => x.phase === 'hiding');
  assert.equal(st.settings.charSize, 'xlarge', '숨는 중에는 캐릭터 크기가 바뀌면 안 됨');
  const cell = st.cell;

  /* ---- 숨기: 겹치지 않게 배치, 색칠 ---- */
  const pos = {};
  names.forEach((n, i) => {
    pos[n] = { x: 100 + i * 280, y: 300 };
    kids[n].emit('player:move', pos[n]);
    kids[n].emit('player:paint', { pixels: '336699'.repeat(20 * 34) });
  });
  await sleep(300);

  /* ---- 그리기 완료: 한 명 빼고 완료 → 아직 숨기, 마지막 완료 → 바로 찾기 ---- */
  for (const n of names.slice(0, 4)) kids[n].emit('player:ready', { ready: true });
  st = await until(teacher, (x) => x.players.filter((p) => p.ready).length === 4);
  assert.equal(st.phase, 'hiding');
  kids['나래'].emit('player:ready', { ready: false });
  await until(teacher, (x) => x.players.filter((p) => p.ready).length === 3);
  kids['나래'].emit('player:ready', { ready: true });
  kids['마루'].emit('player:ready', { ready: true });
  st = await until(teacher, (x) => x.phase === 'seeking');
  assert.equal(st.seek.stage, 'choosing');
  await sleep(200);
  assert.equal(teacher.chars.length, 5, '찾기 시작 때 캐릭터 정보가 전달돼야 함');
  const c0 = teacher.chars.find((c) => c.name === '가람');
  assert.deepEqual({ x: c0.x, y: c0.y }, pos['가람'], '옮긴 위치가 저장돼야 함');
  assert.equal(c0.pixels.slice(0, 6), '336699', '색칠이 저장돼야 함');

  const center = (n) => ({ x: pos[n].x + 10.5 * cell, y: pos[n].y + 15.5 * cell });
  const idOf = (n) => kids[n].id_;
  const choose = async (n) => {
    await until(teacher, (x) => x.seek && x.seek.stage === 'choosing', 6000);
    const r = await emit(teacher, 'teacher:action', { action: 'chooseSeeker', payload: { playerId: idOf(n) } });
    assert.ok(!r.error, r.error);
    return until(teacher, (x) => x.seek.stage === 'turn' && x.seek.seekerId === idOf(n));
  };
  const click = (n, target) => emit(kids[n], 'seek:click', typeof target === 'string' ? center(target) : target);

  /* ---- 1번 술래 가람: 내 캐릭터 클릭(무시) → 나래 찾기 → 이미 찾은 친구(무시) → 빈 곳(실패) ---- */
  await choose('가람');
  let r = await click('가람', '가람');
  assert.match(r.error, /내 캐릭터/);
  r = await click('나래', '다온');
  assert.ok(r.error, '술래가 아닌 학생은 클릭할 수 없음');
  await click('가람', '나래');
  st = await until(teacher, (x) => x.players.find((p) => p.id === idOf('나래')).found);
  assert.equal(st.seek.seekerId, idOf('가람'), '찾으면 같은 술래가 계속');
  assert.equal(st.seek.misses, 0);
  r = await click('가람', '나래');
  assert.match(r.error, /이미 찾은/);
  await click('가람', { x: 800, y: 1200 });
  st = await until(teacher, (x) => x.seek.stage === 'between');
  assert.equal(st.seek.failStreak, 1);

  /* ---- 술래 해 본 학생은 다시 지정 불가 ---- */
  await until(teacher, (x) => x.seek.stage === 'choosing', 6000);
  r = await emit(teacher, 'teacher:action', { action: 'chooseSeeker', payload: { playerId: idOf('가람') } });
  assert.ok(r.error, '이미 술래를 한 학생은 다시 술래가 될 수 없음');

  /* ---- 다온, 라온도 실패 → 연속 실패 3 ---- */
  for (const n of ['다온', '라온']) {
    await choose(n);
    await click(n, { x: 800, y: 1200 });
    await until(teacher, (x) => x.seek.stage === 'between');
  }
  st = teacher.latest;
  assert.equal(st.seek.failStreak, 3);

  /* ---- 마루: 돋보기 찬스 → 가람, 다온, 라온 모두 찾기 ---- */
  st = await choose('마루');
  assert.equal(st.seek.magnifier, true, '3명 연속 실패 뒤 술래는 돋보기 찬스');
  for (const n of ['가람', '다온', '라온']) {
    await click('마루', n);
    await until(teacher, (x) => x.players.find((p) => p.id === idOf(n)).found);
  }
  // 이제 숨은 사람은 술래 마루뿐 → 차례 종료, 아직 술래 안 해 본 나래가 마루를 찾을 차례
  st = await until(teacher, (x) => x.seek.stage === 'choosing', 6000);
  assert.equal(st.seek.magnifier, false, '돋보기는 한 차례만');
  await choose('나래');
  await click('나래', '마루');

  /* ---- 결과 ---- */
  st = await until(teacher, (x) => x.phase === 'results');
  const byName = Object.fromEntries(st.players.map((p) => [p.name, p]));
  assert.equal(byName['마루'].finds, 3);
  assert.equal(byName['가람'].finds, 1);
  assert.equal(byName['나래'].finds, 1);
  assert.ok(st.players.every((p) => p.found), '모두 발견됨');

  /* ---- 끊긴 학생이 같은 이름으로 다시 들어오기 ---- */
  kids['다온'].close();
  await until(teacher, (x) => !x.players.find((p) => p.name === '다온').connected);
  const back = await connect();
  const backRes = await emit(back, 'player:join', { code, name: '다온', shape: 'person' });
  assert.equal(backRes.playerId, idOf('다온'), '같은 이름으로 다시 들어오면 원래 캐릭터로');

  /* ---- 다시 하기 ---- */
  await emit(teacher, 'teacher:action', { action: 'reset' });
  st = await until(teacher, (x) => x.phase === 'lobby');
  assert.equal(st.players.length, 5);
  assert.ok(st.players.every((p) => !p.found && !p.hasSought && !p.ready && p.finds === 0));
});
