/*
 * 기본 제공 명화 목록 (모두 퍼블릭 도메인, Wikimedia Commons)
 * 서버가 처음 요청될 때 한 번 내려받아 cache/ 폴더에 저장해 두고,
 * 학생 기기는 인터넷 대신 교사 PC의 서버에서 그림을 받는다.
 */
const fs = require('fs');
const path = require('path');

const USER_AGENT = 'MasterpieceHideAndSeek/0.1 (https://github.com/ykk1050/Masterpiece-Hide-and-Seek)';
const CACHE_DIR = path.join(__dirname, '..', 'cache');

const PRESETS = [
  { id: 'starry-night', title: '별이 빛나는 밤', artist: '빈센트 반 고흐', year: 1889, file: 'Van Gogh - Starry Night - Google Art Project.jpg' },
  { id: 'bedroom', title: '아를의 침실', artist: '빈센트 반 고흐', year: 1888, file: 'Vincent van Gogh - De slaapkamer - Google Art Project.jpg' },
  { id: 'sunflowers', title: '해바라기', artist: '빈센트 반 고흐', year: 1889, file: 'Vincent van Gogh - Sunflowers - VGM F458.jpg' },
  { id: 'grande-jatte', title: '그랑드 자트 섬의 일요일 오후', artist: '조르주 쇠라', year: 1884, file: 'A Sunday on La Grande Jatte, Georges Seurat, 1884.jpg' },
  { id: 'water-lilies', title: '수련', artist: '클로드 모네', year: 1906, file: 'Claude Monet - Water Lilies - 1906, Ryerson.jpg' },
  { id: 'great-wave', title: '가나가와 해변의 큰 파도', artist: '가쓰시카 호쿠사이', year: 1831, file: 'Tsunami by hokusai 19th century.jpg' },
  { id: 'hunters-snow', title: '눈 속의 사냥꾼', artist: '피터르 브뤼헐', year: 1565, file: 'Pieter Bruegel the Elder - Hunters in the Snow (Winter) - Google Art Project.jpg' },
  { id: 'childrens-games', title: '아이들의 놀이', artist: '피터르 브뤼헐', year: 1560, file: "Children's Games (Bruegel).jpg" },
  { id: 'tower-of-babel', title: '바벨탑', artist: '피터르 브뤼헐', year: 1563, file: 'Pieter Bruegel the Elder - The Tower of Babel (Vienna) - Google Art Project - edited.jpg' },
  { id: 'the-kiss', title: '키스', artist: '구스타프 클림트', year: 1908, file: 'The Kiss - Gustav Klimt - Google Cultural Institute.jpg' },
  { id: 'mona-lisa', title: '모나리자', artist: '레오나르도 다 빈치', year: 1503, file: 'Mona Lisa, by Leonardo da Vinci, from C2RMF retouched.jpg' },
  { id: 'pearl-earring', title: '진주 귀걸이를 한 소녀', artist: '요하네스 페르메이르', year: 1665, file: '1665 Girl with a Pearl Earring.jpg' },
  { id: 'ssireum', title: '씨름', artist: '김홍도', year: 1780, file: 'Danwon Ssireum.jpg' },
  { id: 'inwang', title: '인왕제색도', artist: '정선', year: 1751, file: 'Inwangjesaekdo.jpg' },
  { id: 'geumgang', title: '금강전도', artist: '정선', year: 1734, file: 'Jeong Seon-Geumgangjeondo.jpg' },
];

const SIZES = { image: 1920, thumb: 330 };
const pending = new Map();

function find(id) {
  return PRESETS.find((p) => p.id === id);
}

function list() {
  return PRESETS.map(({ id, title, artist, year }) => ({ id, title, artist, year }));
}

async function resolveThumbUrl(file, width) {
  const params = new URLSearchParams({
    action: 'query',
    titles: 'File:' + file,
    prop: 'imageinfo',
    iiprop: 'url',
    iiurlwidth: String(width),
    format: 'json',
  });
  const res = await fetch('https://commons.wikimedia.org/w/api.php?' + params, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error('Wikimedia API ' + res.status);
  const data = await res.json();
  const page = Object.values(data.query.pages)[0];
  const info = page.imageinfo && page.imageinfo[0];
  if (!info) throw new Error('그림 정보를 찾을 수 없음: ' + file);
  return info.thumburl || info.url;
}

async function download(preset, size) {
  const url = await resolveThumbUrl(preset.file, SIZES[size]);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error('이미지 다운로드 실패 ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(preset.id, size), buf);
  return buf;
}

function cachePath(id, size) {
  return path.join(CACHE_DIR, `${id}-${size}.jpg`);
}

/** 캐시에 있으면 파일 경로를, 없으면 내려받은 뒤 파일 경로를 돌려준다 */
async function getImagePath(id, size) {
  const preset = find(id);
  if (!preset || !SIZES[size]) return null;
  const file = cachePath(id, size);
  if (fs.existsSync(file)) return file;
  const key = id + ':' + size;
  if (!pending.has(key)) {
    pending.set(key, download(preset, size).finally(() => pending.delete(key)));
  }
  await pending.get(key);
  return file;
}

module.exports = { list, find, getImagePath };
