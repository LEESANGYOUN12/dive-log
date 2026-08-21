/* ============================== 시작 스플래시 ============================== */
// 홈 화면에 설치해서 standalone(주소창 없는) 모드로 실행했을 때만 스플래시를
// 보여준다. 일반 브라우저 탭으로 그냥 열었을 땐 바로 없애서, 매번 방문할
// 때마다 불필요하게 로고를 보게 하지 않는다.
// iOS는 display-mode 미디어쿼리 대신 navigator.standalone 플래그로 판단한다.
const isStandaloneApp = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
if (isStandaloneApp){
  // 페이지가 뜨자마자 보이는 스플래시(#splash)를 최소 이 시간(ms) 동안은
  // 유지했다가 서서히 사라지게 한다. 스크립트 맨 위에서 바로 타이머를 걸어야
  // 실제 화면에 그려진 시점과 최대한 가깝게 시작된다.
  setTimeout(() => {
    const splash = document.getElementById('splash');
    if (!splash) return;
    splash.classList.add('hide');
    setTimeout(() => splash.remove(), 400); // CSS transition(.4s)이 끝난 뒤 완전히 제거
  }, 1500);
} else {
  const splash = document.getElementById('splash');
  if (splash) splash.remove();
}

/* ============================== FIT BINARY PARSER ============================== */
const FIT_EPOCH_OFFSET = 631065600; // 1989-12-31T00:00:00Z 와 유닉스 epoch 사이의 초 차이

// Garmin FIT 바이너리 포맷을 읽는 최소 구현 (Amazfit/Zepp 워치도 이 포맷을 씀).
// .FIT 파일 구조: 헤더 → "definition"(정의) / "data"(데이터) 레코드가 번갈아
// 이어지는 스트림 → CRC(여기선 검증 안 함). definition 레코드는 그 뒤에 오는
// data 레코드들의 바이트 레이아웃을 "local message type"(0-15, 압축 헤더
// 형태에서는 0-3) 별로 정의하므로, data 레코드를 해석하기 전에 그 레이아웃을
// `localDefs`에 기억해둬야 한다. 우리가 필요한 건 global message type 20
// ("record" = GPS/센서 샘플 1개)뿐이며, 이건 extractRecords()에서 걸러낸다.
class FitParser {
  constructor(arrayBuffer){
    this.view = new DataView(arrayBuffer);
    this.messages = [];
  }
  parse(){
    const view = this.view;
    if (view.byteLength < 14) throw new Error('파일이 너무 작습니다');
    const headerSize = view.getUint8(0);
    const magic = String.fromCharCode(view.getUint8(8),view.getUint8(9),view.getUint8(10),view.getUint8(11));
    if (magic !== '.FIT') throw new Error('올바른 FIT 파일이 아닙니다');
    const dataSize = view.getUint32(4, true); // 레코드 스트림의 바이트 길이 (헤더/CRC 제외)
    let offset = headerSize; // 레코드는 헤더 바로 뒤부터 시작
    const dataEnd = Math.min(headerSize + dataSize, view.byteLength);
    const localDefs = {}; // localType -> {globalNum, fields, little, devFields}
    let lastTimestamp = null; // 압축 헤더 타임스탬프를 복원할 때 필요

    while (offset < dataEnd){
      // 레코드 헤더 바이트: 6번 비트 = definition/data 구분, 7번 비트 = 압축
      // 타임스탬프 형태 여부. 압축 형태에서는 5-6번 비트가 local type, 0-4번
      // 비트가 마지막 전체 타임스탬프로부터의 5비트 오프셋을 담는다.
      const recordHeader = view.getUint8(offset); offset += 1;
      const isDefinition = (recordHeader & 0x40) !== 0;
      const isCompressed = (recordHeader & 0x80) !== 0;
      let localType, compressedOffsetVal = null;
      if (isCompressed){
        localType = (recordHeader >> 5) & 0x03;
        compressedOffsetVal = recordHeader & 0x1F;
      } else {
        localType = recordHeader & 0x0F;
      }

      if (isDefinition){
        // definition 레코드: 필드 개수 + 필드별(필드번호, 바이트 크기, 타입)
        // 정보로 구성되며, 이 local type의 data 레코드를 어떻게 해석할지 정의한다.
        offset += 1; // 예약 영역
        const arch = view.getUint8(offset); offset += 1;
        const little = arch === 0; // 0 = little-endian, 1 = big-endian
        const globalNum = view.getUint16(offset, little); offset += 2;
        const numFields = view.getUint8(offset); offset += 1;
        const fields = [];
        for (let i=0;i<numFields;i++){
          const fieldNum = view.getUint8(offset); offset+=1;
          const size = view.getUint8(offset); offset+=1;
          const baseType = view.getUint8(offset); offset+=1;
          fields.push({fieldNum,size,baseType});
        }
        // 일부 기기가 추가하는 커스텀 필드(developer field). 값 자체는 필요
        // 없고, 이후 data 레코드를 해석할 때 이 부분을 건너뛰기 위해 바이트
        // 크기만 기억해둔다.
        const devFlag = (recordHeader & 0x20) !== 0;
        const devFields = [];
        if (devFlag){
          const numDev = view.getUint8(offset); offset += 1;
          for (let i=0;i<numDev;i++){
            offset += 1; // 필드 번호
            const size = view.getUint8(offset); offset += 1;
            offset += 1; // developer 인덱스
            devFields.push({size});
          }
        }
        localDefs[localType] = {globalNum, fields, little, devFields};
      } else {
        // data 레코드: 매칭되는 definition의 레이아웃대로 필드를 해석한다.
        const def = localDefs[localType];
        if (!def){ break; } // definition을 본 적 없는 타입의 data 레코드 — 중단
        const fieldValues = {};
        for (const f of def.fields){
          if (offset + f.size > dataEnd + 4){ offset = dataEnd; break; } // 파일이 잘린 경우 보호
          const val = this._readField(view, offset, f.size, f.baseType, def.little);
          offset += f.size;
          fieldValues[f.fieldNum] = val;
        }
        for (const df of def.devFields){ offset += df.size; } // developer 필드는 값 안 쓰고 건너뛰기만

        // FIT에서 필드 253번은 항상 "timestamp"다. 압축 헤더 레코드는 이 필드를
        // 생략하고 대신 마지막 전체 타임스탬프로부터의 5비트 오프셋만 담으므로,
        // 여기서 절대 시각으로 복원한다(오프셋이 하위 5비트를 넘어가면 +32초 롤오버).
        if (isCompressed && lastTimestamp != null){
          let ts = (lastTimestamp & ~0x1F) | compressedOffsetVal;
          if (compressedOffsetVal < (lastTimestamp & 0x1F)) ts += 0x20;
          lastTimestamp = ts;
          if (fieldValues[253] === undefined) fieldValues[253] = ts;
        } else if (fieldValues[253] !== undefined && fieldValues[253] !== 0xFFFFFFFF){
          lastTimestamp = fieldValues[253];
        }
        this.messages.push({globalNum: def.globalNum, fields: fieldValues});
      }
      if (offset <= 0 || offset > dataEnd + 16) break; // 안전장치: 손상된 스트림이면 무한루프 대신 중단
    }
    return this.messages;
  }
  // FIT 필드 타입 코드에 맞춰 원시 바이트를 값으로 변환한다. 일부 필드는
  // 배열일 수 있는데(예: 여러 개의 수심 하위값을 보내는 기기), `size`가
  // 타입 크기의 배수이면서 요소가 2개 이상이면 배열 그대로 반환하고,
  // 호출부(extractRecords)에서 [0]번째 요소만 사용한다.
  _readField(view, offset, size, baseType, little){
    const readArr = (unit, fn) => {
      const n = Math.max(1, Math.floor(size/unit));
      if (n <= 1) return fn(offset);
      const arr = [];
      for (let i=0;i<n;i++) arr.push(fn(offset+i*unit));
      return arr;
    };
    try{
      switch(baseType){ // FIT 기본 타입 코드 (FIT SDK Profile.xlsx의 "Types" 시트 참고)
        case 0x00: case 0x02: case 0x0A: return readArr(1,(o)=>view.getUint8(o));
        case 0x01: return readArr(1,(o)=>view.getInt8(o));
        case 0x0D: return view.getUint8(offset);
        case 0x83: return readArr(2,(o)=>view.getInt16(o, little));
        case 0x84: case 0x8B: return readArr(2,(o)=>view.getUint16(o, little));
        case 0x85: return readArr(4,(o)=>view.getInt32(o, little));
        case 0x86: case 0x8C: return readArr(4,(o)=>view.getUint32(o, little));
        case 0x88: return view.getFloat32(offset, little);
        case 0x89: return view.getFloat64(offset, little);
        case 0x07: {
          let bytes=[];
          for (let i=0;i<size;i++){ const b=view.getUint8(offset+i); if(b===0) break; bytes.push(b); }
          return bytes.map(b=>String.fromCharCode(b)).join('');
        }
        default: return null;
      }
    } catch(e){ return null; }
  }
}

/* ============================== 다이빙 데이터 추출 ============================== */
// FIT은 위경도를 도(degree)가 아니라 "semicircle" 단위(int32, 원 한 바퀴가
// 2^32 단위)로 저장하므로, GPS 값을 쓰려면 이 변환을 거쳐야 한다.
function semicircleToDeg(v){ return v * (180 / 2147483648); }

// FIT 메시지들을 시간순 {t, depth, hr, temp, lat, lon} 샘플 배열로 변환한다
// (global type 20 = "record" 메시지 하나당 샘플 하나). 랩/세션/기기정보 등
// 나머지 메시지 타입은 전부 무시한다.
function extractRecords(messages){
  const out = [];
  for (const m of messages){
    if (m.globalNum !== 20) continue; // 'record' 메시지만
    const f = m.fields;
    const rawT = f[253];
    if (rawT === undefined || rawT === 0xFFFFFFFF) continue;
    const t = rawT + FIT_EPOCH_OFFSET;

    // 수심 필드 번호는 제조사마다 다르다: 78은 Garmin 다이빙 컴퓨터에서
    // 흔하고, 92는 Amazfit/Zepp 워치에서 쓰인다. 78을 먼저 시도하고 없으면 92.
    let depthRaw = Array.isArray(f[78]) ? f[78][0] : f[78];
    if (depthRaw === undefined || depthRaw === 0xFFFFFFFF){
      depthRaw = Array.isArray(f[92]) ? f[92][0] : f[92];
    }
    const depth = (depthRaw !== undefined && depthRaw !== 0xFFFFFFFF) ? depthRaw/1000 : null;

    const hrRaw = Array.isArray(f[3]) ? f[3][0] : f[3];
    const hr = (hrRaw !== undefined && hrRaw !== 0xFF) ? hrRaw : null;
    const tempRaw = Array.isArray(f[13]) ? f[13][0] : f[13];
    const temp = (tempRaw !== undefined && tempRaw !== 0x7F) ? tempRaw : null;

    let lat = null, lon = null;
    const latRaw = Array.isArray(f[0]) ? f[0][0] : f[0];
    const lonRaw = Array.isArray(f[1]) ? f[1][0] : f[1];
    if (latRaw !== undefined && lonRaw !== undefined && latRaw !== 0x7FFFFFFF && lonRaw !== 0x7FFFFFFF && !(latRaw===0 && lonRaw===0)){
      lat = semicircleToDeg(latRaw); lon = semicircleToDeg(lonRaw);
    }
    out.push({t, depth, hr, temp, lat, lon});
  }
  out.sort((a,b)=>a.t-b.t);
  return out;
}

// 업로드 하나(전체 기록)를 depth > THRESH 구간 기준으로 잘라 개별 다이빙으로
// 나눈다. 물 위 구간까지 포함된 하나의 .fit 파일이 여러 개의 다이빙 항목이
// 되는 이유가 이것이다. `records`에 대한 [{startIdx, endIdx}] 인덱스 범위를
// 반환한다.
function segmentDives(records){
  const hasDepth = records.some(r=>r.depth != null);
  if (!hasDepth || records.length === 0){
    // 수심 데이터가 아예 없으면(다이빙이 아닌 활동 등) 전체 기록을
    // 다이빙 하나로 취급해서 최소한 어딘가에는 보이도록 한다.
    return records.length ? [{startIdx:0, endIdx: records.length-1}] : [];
  }
  const THRESH = 0.5; // 미터 — 이 값보다 깊으면 "물속"으로 간주
  const MIN_SURFACE_GAP_S = 3; // 이 시간(초) 이상 수면 근처에 머물러야 다이빙이 끝난 것으로 판단(수면 노이즈 필터링)
  const raw = [];
  let inDive = false, start = null, lastUnderwater = null;
  for (let i=0;i<records.length;i++){
    const d = records[i].depth ?? 0;
    if (d > THRESH){
      if (!inDive){ inDive = true; start = i; }
      lastUnderwater = i;
    } else if (inDive && (records[i].t - records[lastUnderwater].t) > MIN_SURFACE_GAP_S){
      raw.push({startIdx:start, endIdx:lastUnderwater});
      inDive = false;
    }
  }
  if (inDive) raw.push({startIdx:start, endIdx:lastUnderwater});
  return raw
    .filter(d => records[d.endIdx].t - records[d.startIdx].t >= 3) // 3초 미만인 짧은 잡음은 제외
    .map(d => ({
      // 앞뒤로 샘플 2개씩 여유를 둬서, 차트가 THRESH 지점에서 뚝 끊기지
      // 않고 수면 진입/이탈 구간도 살짝 보이게 한다.
      startIdx: Math.max(0, d.startIdx-2),
      endIdx: Math.min(records.length-1, d.endIdx+2)
    }));
}

// 다이빙 구간의 각 샘플에 수직 속도(m/s)를 계산해서 붙인다. 연속된 두
// 샘플의 수심 차이로 계산하며, 음수 = 하강, 양수 = 상승
// (computeVSpeedStats/CHART_DEFS도 이 부호 규칙을 그대로 따른다).
function withDerived(slice){
  return slice.map((r,i,arr)=>{
    let vSpeed = null;
    if (i>0 && r.depth!=null && arr[i-1].depth!=null){
      const dt = r.t - arr[i-1].t;
      if (dt > 0) vSpeed = -((r.depth - arr[i-1].depth)/dt);
    }
    return {...r, vSpeed};
  });
}

/* ============================== 저장소 ==============================
   브라우저 localStorage를 써서 이 파일을 직접 열었을 때도(예: 안드로이드에
   저장해서 열거나 홈 화면에 추가한 경우) 방문 사이에 기록이 유지되게
   한다 — 서버 없이, 데이터가 폰 밖으로 나가지 않는다.
   참고: 일부 브라우저는 file://로 직접 연 파일에 대해 localStorage를
   제한한다. 앱을 완전히 종료했을 때 기록이 사라진다면, 로컬 파일로 여는
   대신 이 파일을 어딘가(예: 비공개 GitHub Pages)에 호스팅해서 열어보길
   — 그쪽이 저장소가 훨씬 안정적이다. */
const LS_PREFIX = 'divelog:';
function lsGet(key){
  try{ const raw = localStorage.getItem(LS_PREFIX+key); return raw ? JSON.parse(raw) : null; }
  catch(e){ console.warn('storage read failed', key, e); return null; }
}
function lsSet(key, value){
  try{ localStorage.setItem(LS_PREFIX+key, JSON.stringify(value)); return true; }
  catch(e){ console.warn('storage write failed', key, e); toast('저장 공간이 부족하거나 이 브라우저에서 저장이 제한돼 있어요'); return false; }
}
function lsDel(key){ try{ localStorage.removeItem(LS_PREFIX+key); } catch(e){} }

// 다크모드: 시스템 설정을 따라가지 않고 사용자가 버튼으로 직접 켠다.
// 선택한 값은 localStorage에 저장해 다음 방문에도 유지한다.
let theme = lsGet('theme') === 'dark' ? 'dark' : 'light';
function applyTheme(){
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('#theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  const meta = $('#theme-color-meta');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#16141f' : '#f2f2f8');
}

// 저장 구조: 'sessions' 키에 업로드 요약 목록 전체가, 'dives:<세션id>'에
// 해당 업로드의 다이빙 메타 목록이, 'records:<다이빙id>'에 다이빙 하나의
// 전체 샘플 배열이 들어간다. 하나의 큰 덩어리로 저장하지 않고 이렇게
// 나눠둔 이유는, 세션 하나를 열 때 다른 모든 세션의 원본 샘플 데이터까지
// 같이 불러올 필요가 없게 하기 위해서다.
const loadSessions = () => lsGet('sessions') || [];
const saveSessions = (list) => lsSet('sessions', list);
const loadSessionDives = (sid) => lsGet('dives:'+sid) || [];
const saveSessionDives = (sid, list) => lsSet('dives:'+sid, list);
const loadDiveRecords = (id) => lsGet('records:'+id);
const saveDiveRecords = (id, records) => lsSet('records:'+id, records);
const deleteDiveRecords = (id) => lsDel('records:'+id);

/* ============================== UI 상태 ============================== */
let sessions = [];        // [{id, fileName, uploadedAt, startTime, endTime, maxDepth, diveCount, gps}]
let currentSessionDives = null; // 현재 열려 있는 세션의 다이빙 메타 목록
let selectedSessionId = null;
let contentsHistoryPushed = false; // #contents를 열 때 히스토리를 쌓았는지 (뒤로가기로 닫기 위함)
let diveChartsHistoryPushed = false; // 다이빙 차트를 처음 펼칠 때 히스토리를 쌓았는지 (뒤로가기로 접기 위함)
let suppressPopCheck = false; // closeSessionView/collapseAllDiveCharts가 자체적으로 유발한 popstate인지 (중복 처리 방지)

const $ = (sel) => document.querySelector(sel);
const fmtTime = (sec) => {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s/60), r = s%60;
  return String(m).padStart(2,'0')+':'+String(r).padStart(2,'0');
};
const fmtDateShort = (unixSec) => {
  const d = new Date(unixSec*1000);
  const days = ['일','월','화','수','목','금','토'];
  return String(d.getFullYear()%100).padStart(2,'0')+'.'+String(d.getMonth()+1).padStart(2,'0')+'.'+String(d.getDate()).padStart(2,'0')+'('+days[d.getDay()]+')';
};
const fmtDateFull = (unixSec) => {
  const d = new Date(unixSec*1000);
  const days = ['일','월','화','수','목','금','토'];
  return `${d.getFullYear()}년 ${String(d.getMonth()+1).padStart(2,'0')}월 ${String(d.getDate()).padStart(2,'0')}일 ${days[d.getDay()]}요일`;
};
const fmtClock = (unixSec) => {
  const d = new Date(unixSec*1000);
  return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
};
const fmtClockSec = (unixSec) => {
  const d = new Date(unixSec*1000);
  return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0');
};

function toast(msg){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._tm);
  toast._tm = setTimeout(()=>t.classList.remove('show'), 2600);
}

// window.confirm 대신 쓰는, 디자인이 입혀진 확인창. 확인을 누르면 true,
// 취소하거나 배경을 클릭하면 false로 resolve된다.
function showConfirm(message, opts){
  opts = opts || {};
  const overlay = $('#confirm-overlay');
  const okBtn = $('#confirm-ok');
  const cancelBtn = $('#confirm-cancel');
  $('#confirm-message').textContent = message;
  okBtn.textContent = opts.okText || '확인';
  cancelBtn.textContent = opts.cancelText || '취소';
  okBtn.classList.toggle('danger', !!opts.danger);
  return new Promise(resolve=>{
    function cleanup(result){
      overlay.classList.remove('show');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    }
    function onOk(){ cleanup(true); }
    function onCancel(){ cleanup(false); }
    function onOverlay(e){ if (e.target === overlay) cleanup(false); }
    function onKeydown(e){ if (e.key === 'Escape') cleanup(false); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKeydown);
    overlay.classList.add('show');
  });
}

/* ============================== 세션(업로드) 목록 ============================== */
// 둘 다 '' 이면 "전체"(필터 없음)를 뜻한다. filterMonth는 filterYear가
// 특정 연도로 선택돼 있을 때만 의미가 있다 — syncFilterSelects() 참고.
let filterYear = '';
let filterMonth = '';

// 현재 연/월 필터를 `sessions`에 적용해 목록 렌더링용으로 걸러낸다.
function getFilteredSessions(){
  return sessions.filter(s=>{
    if (!filterYear) return true;
    const d = new Date(s.startTime*1000);
    if (String(d.getFullYear()) !== filterYear) return false;
    if (filterMonth && String(d.getMonth()+1) !== filterMonth) return false;
    return true;
  });
}

// 실제로 존재하는 세션들을 기준으로 연/월 <select> 옵션 목록을 다시
// 만든다(그래서 데이터가 없는 연/월은 애초에 선택할 수 없다). 현재 선택된
// 연/월에 더 이상 해당하는 세션이 없으면(예: 그 연/월의 마지막 세션을
// 삭제한 경우) filterYear/filterMonth를 "전체"로 되돌린다.
// renderSessionList()가 호출될 때마다 맨 앞에서 호출되므로, 드롭다운은
// 항상 최신 `sessions` 상태를 반영한다.
function syncFilterSelects(){
  const yearSel = $('#filter-year');
  const monthSel = $('#filter-month');
  const years = Array.from(new Set(sessions.map(s=>new Date(s.startTime*1000).getFullYear()))).sort((a,b)=>b-a);
  if (!years.includes(Number(filterYear))){ filterYear = ''; filterMonth = ''; }
  yearSel.innerHTML = `<option value="">전체</option>` + years.map(y=>`<option value="${y}">${y}년</option>`).join('');
  yearSel.value = filterYear;

  if (filterYear){
    // 월 셀렉트는 연도가 선택돼야만 나타나고, 그 해에 실제로 세션이 있는
    // 월만 목록에 표시한다.
    const months = Array.from(new Set(
      sessions.filter(s=>new Date(s.startTime*1000).getFullYear()===Number(filterYear))
        .map(s=>new Date(s.startTime*1000).getMonth()+1)
    )).sort((a,b)=>a-b);
    if (!months.includes(Number(filterMonth))) filterMonth = '';
    monthSel.innerHTML = `<option value="">전체</option>` + months.map(m=>`<option value="${m}">${m}월</option>`).join('');
    monthSel.value = filterMonth;
    monthSel.style.display = '';
  } else {
    filterMonth = '';
    monthSel.style.display = 'none';
  }
}

// 현재 필터 상태에 맞춰 상단 업로드 칩 목록을 렌더링한다. 서로 배타적인
// 세 가지 상태 — "아직 업로드 없음", "필터에 맞는 업로드 없음", 목록 자체 —
// 의 표시 여부도 여기서 결정한다.
function renderSessionList(){
  const strip = $('#select-list');
  const empty = $('#select-none');
  const emptyFiltered = $('#select-empty-filtered');
  const resetAll = $('#reset-all');
  const searchWrap = $('#select-search');
  if (sessions.length === 0){
    searchWrap.style.display = 'none';
    empty.style.display = '';
    emptyFiltered.style.display = 'none';
    strip.style.display = 'none';
    resetAll.style.display = 'none';
    return;
  }
  searchWrap.style.display = 'flex';
  resetAll.style.display = 'flex';
  syncFilterSelects();

  const filtered = getFilteredSessions();
  if (filtered.length === 0){
    empty.style.display = 'none';
    emptyFiltered.style.display = '';
    strip.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  emptyFiltered.style.display = 'none';
  strip.style.display = '';
  strip.innerHTML = '';
  filtered.slice().sort((a,b)=>a.startTime-b.startTime).forEach(s=>{
    const chip = document.createElement('li');
    chip.className = selectedSessionId===s.id ? 'selected' : '';
    chip.innerHTML = `
      <button title="삭제">✕</button>
      <h3>${fmtDateShort(s.startTime)}</h3>
      <ul><li>${s.maxDepth.toFixed(1)}m</li><li>${s.diveCount}회</li></ul>
    `;
    chip.addEventListener('click', ()=>openSession(s.id));
    chip.querySelector('button').addEventListener('click', (e)=>{
      e.stopPropagation();
      deleteSession(s.id);
    });
    strip.appendChild(chip);
  });
}

// 업로드 하나를 삭제한다: 다이빙 레코드 → 다이빙 메타 목록 → 세션 자체 순.
async function deleteSession(id){
  if (!(await showConfirm('이 업로드 기록을 삭제할까요? 되돌릴 수 없어요.', {okText:'삭제', danger:true}))) return;
  const dives = loadSessionDives(id);
  dives.forEach(d=>deleteDiveRecords(d.id));
  lsDel('dives:'+id);
  sessions = sessions.filter(s=>s.id!==id);
  saveSessions(sessions);
  if (selectedSessionId === id){
    closeSessionView();
  } else {
    renderSessionList();
  }
  toast('업로드 기록을 삭제했어요');
}

// #contents를 닫는다 — 뒤로가기로 열렸을 때 쌓인 히스토리도 함께 정리한다.
// 차트가 펼쳐진 채로 세션 전체를 닫는 경우(✕ 버튼, 세션 삭제 등) 히스토리가
// 두 단계(차트 + #contents) 쌓여 있을 수 있어 history.go()로 한 번에 정리한다.
// fromPopstate가 true면 popstate 이벤트에 대한 반응이라 이미 그만큼 뒤로
// 이동한 상태이므로 추가로 되돌아가지 않는다 (그러면 무한 루프/불필요한
// 페이지 이탈이 된다).
function closeSessionView(fromPopstate){
  closeAllDiveCharts();
  const hadChartLayer = diveChartsHistoryPushed;
  diveChartsHistoryPushed = false;
  selectedSessionId = null;
  $('#contents').style.display = 'none';
  renderSessionList();
  if (!fromPopstate){
    const popCount = (hadChartLayer ? 1 : 0) + (contentsHistoryPushed ? 1 : 0);
    contentsHistoryPushed = false;
    if (popCount > 0){
      suppressPopCheck = true; // 이 이동으로 발생할 popstate는 정리용이라 무시한다
      history.go(-popCount);
    }
  } else {
    contentsHistoryPushed = false;
  }
}

// 위경도 숫자만 나오는 건 지도 없이는 쓸모가 없어서 일단 꺼둠. 나중에
// 실제 지도 미리보기 등으로 발전시킬 수 있게 로직은 그대로 남겨두고,
// 이 플래그만 켜면 다시 노출된다.
const SHOW_SESSION_GPS = false;

// 세션 상세 패널을 연다: 요약 헤더를 채우고, 모든 다이빙의 레코드를
// 불러와서 세션 전체 평균 심박수를 계산하고, 다이빙 테이블을 채운다
// (각 행은 클릭할 때 자기 차트를 지연 로드한다 — toggleDiveChartRow 참고).
function openSession(id){
  const s = sessions.find(x=>x.id===id);
  if (!s) return;
  closeAllDiveCharts();
  if (diveChartsHistoryPushed){
    // 이전 세션에서 차트를 펼쳐둔 채로 다른 세션을 선택한 경우, 쌓여있던
    // 히스토리도 함께 정리한다. (selectedSessionId가 이미 있을 때만 가능한
    // 상황이라 바로 아래 #contents pushState와 겹치지 않는다.)
    diveChartsHistoryPushed = false;
    suppressPopCheck = true;
    history.back();
  }
  if (selectedSessionId === null){
    history.pushState({diveLogContents:true}, '');
    contentsHistoryPushed = true;
  }
  selectedSessionId = id;
  $('#contents').style.display = '';
  $('#session-title').textContent = fmtDateFull(s.startTime);
  const gpsEl = $('#session-gps');
  if (SHOW_SESSION_GPS && s.gps){
    const lat = s.gps.lat.toFixed(4), lon = s.gps.lon.toFixed(4);
    gpsEl.innerHTML = `📍 <a href="https://maps.google.com/?q=${lat},${lon}" target="_blank" rel="noopener">${lat}, ${lon}</a>`;
    gpsEl.style.display = '';
  } else {
    gpsEl.style.display = 'none';
  }
  $('#sess-time').textContent = fmtClock(s.startTime) + ' – ' + fmtClock(s.endTime);
  $('#sess-duration').textContent = fmtTime(s.endTime - s.startTime);
  $('#sess-dive-count').textContent = s.diveCount + '회';
  $('#sess-max-depth').textContent = s.maxDepth.toFixed(1) + 'm';

  currentSessionDives = loadSessionDives(id);
  const maxDiveSec = currentSessionDives.length ? Math.max(...currentSessionDives.map(d=>d.durationSec)) : 0;
  $('#sess-max-dive-time').textContent = fmtTime(maxDiveSec);
  // 평균 심박수는 다이빙 메타에 캐싱된 hrSum/hrCount로 바로 계산한다 —
  // 세션 상세를 열 때마다 모든 다이빙의 전체 records를 불러올 필요가 없다.
  // 캐싱이 생기기 전 예전 데이터(hrSum/hrCount 없음)는 이번에 한 번만
  // records를 읽어 계산하고, 다음에 또 안 읽어도 되게 메타에 캐싱해둔다.
  let hrSum = 0, hrCount = 0;
  let missingRecords = false;
  let migrated = false;
  currentSessionDives.forEach(d=>{
    if (d.hrSum != null && d.hrCount != null){
      hrSum += d.hrSum;
      hrCount += d.hrCount;
      return;
    }
    const recs = loadDiveRecords(d.id);
    if (!recs){ missingRecords = true; return; }
    let dHrSum = 0, dHrCount = 0;
    recs.forEach(r=>{ if (r.hr != null){ dHrSum += r.hr; dHrCount++; } });
    d.hrSum = dHrSum;
    d.hrCount = dHrCount;
    hrSum += dHrSum;
    hrCount += dHrCount;
    migrated = true;
  });
  if (migrated) saveSessionDives(id, currentSessionDives);
  $('#sess-avg-hr').textContent = hrCount ? Math.round(hrSum/hrCount) + 'bpm' : '–';
  if (missingRecords) toast('일부 다이빙 기록을 불러오지 못했어요');

  const tbody = $('#dive-table-body');
  tbody.innerHTML = '';
  currentSessionDives.forEach((d, i)=>{
    const tr = document.createElement('tr');
    tr.className = 'dive-row';
    tr.innerHTML = `
      <td class="idx">${i+1}</td>
      <td class="time-cell">${fmtClockSec(d.startTime)}</td>
      <td class="time-cell">${fmtTime(d.durationSec)}</td>
      <td class="max-depth">${d.maxDepth.toFixed(1)} m</td>
    `;
    tr.addEventListener('click', ()=>toggleDiveChartRow(tr, d));
    tbody.appendChild(tr);
  });

  renderSessionList();
  $('#contents').scrollIntoView({behavior:'smooth', block:'start'});
}

/* ============================== 차트 렌더링 ============================== */
// 모든 차트는 SVG 좌표계를 하나로 고정해서 쓰고(viewBox 0 0 CHART_W
// CHART_H, svgChart 참고), 실제 표시 너비에는 CSS로만 맞춘다 — 덕분에
// buildChartGeometry()와 드래그 처리 코드는 화면 해상도와 무관하게 하나의
// 단위 체계로만 계산하면 된다.
const CHART_W = 600, CHART_H = 140;
const DOT_R = 3.2;
const PAD = {l:10, t:10, b:16};
// 오른쪽 여백은 최소/최대값 라벨 표시 공간. 박스형은 컨테이너 실제 너비가
// 훨씬 좁아 같은 값이라도 물리적으로 쓸 수 있는 공간이 작으므로, 리스트형/
// 박스형을 따로 조절할 수 있게 분리해뒀다.
const PAD_R = {list: 55, box: 100};
function padR(){ return chartViewMode === 'box' ? PAD_R.box : PAD_R.list; }

// 차트의 `mode`에 따라 y축 최소/최대값을 정한다:
// - 'zero': 0을 기준으로 대칭(수직 속도 — +/- 양쪽 스케일을 같게 해서
//   0선이 항상 가운데 오도록)
// - 'depth': 항상 0(수면)부터 시작하고 최대 수심 위로 약간 여유를 둠
//   (수심은 음수가 될 수 없으므로)
// - 'normal'(심박수/수온): 최소~최대에 약 18% 여백을 줘서 선이 위/아래
//   끝에 딱 붙지 않게 함
function computeScale(values, mode){
  const nums = values.filter(v=>v!=null);
  if (nums.length===0) return {min:0,max:1};
  let min = Math.min(...nums), max = Math.max(...nums);
  if (mode === 'zero'){
    const m = Math.max(Math.abs(min), Math.abs(max), 0.2);
    return {min:-m, max:m};
  }
  if (mode === 'depth'){
    return {min:0, max: Math.max(max*1.12, 1)};
  }
  const pad = (max-min)*0.18 || 1;
  return {min:min-pad, max:max+pad};
}

// 값 배열을 CHART_W x CHART_H 안의 SVG 좌표들 + path `d` 문자열로 변환한다.
// null 값이 있으면 그 지점의 데이터 공백을 이어 그리지(보간) 않고 선을
// 끊어서 별도 구간으로 나눈다(L 대신 M).
function buildChartGeometry(values, mode){
  const scale = computeScale(values, mode);
  const n = values.length;
  const innerW = CHART_W - PAD.l - padR(), innerH = CHART_H - PAD.t - PAD.b;
  const range = (scale.max - scale.min) || 1;
  const mapY = (v) => mode === 'depth'
    ? PAD.t + ((v - scale.min)/range) * innerH
    : PAD.t + innerH - ((v - scale.min)/range) * innerH;
  const pts = values.map((v,i)=>{
    const x = PAD.l + (n<=1 ? 0 : (i/(n-1)) * innerW);
    if (v == null) return {x, y:null, v:null};
    return {x, y: mapY(v), v};
  });
  let d = '', started = false;
  pts.forEach(p=>{
    if (p.y == null){ started=false; return; }
    d += (started?'L':'M') + p.x.toFixed(2) + ' ' + p.y.toFixed(2) + ' ';
    started = true;
  });
  return {pts, d, scale, mapY, innerW, innerH};
}

// 차트 하나의 정적인 SVG 뼈대(그리드선, 그라디언트 채우기, 크로스헤어/점,
// 최소/최대 라벨)를 그리며, 실제 내용은 전부 비워/숨겨둔 상태로 반환한다.
// 실제 선 경로와 라벨 텍스트는 이 마크업이 삽입된 직후 renderInlineCharts()가
// 채우고, 이후 스크럽할 때마다 updateInlineCrosshair()가 갱신한다.
function svgChart(id, color, mode){
  const zeroLineY = mode==='zero' ? PAD.t + (CHART_H-PAD.t-PAD.b)/2 : null;
  return `
  <svg class="chart" id="${id}" viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="${id}-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
      <filter id="${id}-glow" x="-20%" y="-50%" width="140%" height="200%">
        <feGaussianBlur stdDeviation="2.2" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    ${[0.25,0.5,0.75].map(f=>`<line class="chart-grid-line" x1="${PAD.l}" x2="${CHART_W-padR()}" y1="${PAD.t+(CHART_H-PAD.t-PAD.b)*f}" y2="${PAD.t+(CHART_H-PAD.t-PAD.b)*f}" stroke-width="1"/>`).join('')}
    ${zeroLineY!=null ? `<line class="chart-zero-line" x1="${PAD.l}" x2="${CHART_W-padR()}" y1="${zeroLineY}" y2="${zeroLineY}" stroke-dasharray="3,3"/>` : ''}
    <path id="${id}-area" fill="url(#${id}-fill)" stroke="none" d=""></path>
    <path id="${id}-line" fill="none" stroke="${color}" stroke-width="1.8" filter="url(#${id}-glow)" d=""></path>
    <line id="${id}-crosshair" class="chart-crosshair-line" x1="0" x2="0" y1="${PAD.t}" y2="${CHART_H-PAD.b}" stroke-width="2" stroke-dasharray="4,3" style="display:none;"/>
    <ellipse id="${id}-dot" rx="${DOT_R}" ry="${DOT_R}" fill="${color}" style="display:none;"/>
    <text id="${id}-max" class="chart-minmax-label" x="${CHART_W-padR()+4}" y="${PAD.t+4}" text-anchor="start" font-size="9"></text>
    <text id="${id}-min" class="chart-minmax-label" x="${CHART_W-padR()+4}" y="${CHART_H-PAD.b}" text-anchor="start" font-size="9"></text>
  </svg>`;
}

const CHART_DEFS = [
  {key:'depth', mode:'depth', colorHex:'#7c5cfc', unit:'m', fmtValue:(v)=>v.toFixed(1), fmt:(v)=>v==null?'–':v.toFixed(1)+'m', label:'<i>📉</i> <strong>수심</strong> <span>(m)</span>'},
  {key:'vSpeed', mode:'zero', colorHex:'#f6a623', unit:'m/s', fmtValue:(v)=>(v>=0?'+':'')+v.toFixed(2), fmt:(v)=>v==null?'–':(v>=0?'+':'')+v.toFixed(2)+'m/s', label:'<i>〽️</i> <strong>수직 속도</strong> <span>(m/s)</span>'},
  {key:'hr', mode:'normal', colorHex:'#ff5c77', unit:'bpm', fmtValue:(v)=>Math.round(v), fmt:(v)=>v==null?'–':Math.round(v)+'bpm', label:'<i>❤️</i> <strong>심박수</strong> <span>(bpm)</span>'},
  {key:'temp', mode:'normal', colorHex:'#ff7d54', unit:'℃', fmtValue:(v)=>v.toFixed(1), fmt:(v)=>v==null?'–':v.toFixed(1)+'℃', label:'<i>🌡️</i> <strong>수온</strong> <span>(℃)</span>'},
];

// 현재 열려 있는 모든 다이빙의 chart-block-wrap이 공유하는 값이라, 하단
// 고정 바에서 뷰 모드를 한 번 바꾸면 열려 있는 차트 전부가 한꺼번에 다시
// 배치된다.
let chartViewMode = lsGet('chartViewMode') === 'box' ? 'box' : 'list';
// 차트 SVG는 viewBox 비율을 무시하고(preserveAspectRatio="none") 실제
// 렌더링 너비에 맞춰 강제로 늘리거나 줄인다. 그래서 svg 내부 요소도 같이
// 가로로만 늘어나거나 찌그러진다 — 원, 최대/최소 라벨 글자 모두 예외가
// 아니다. x축 스케일의 역수만큼 되돌려 늘어난 만큼 다시 압축해준다.
function fixMinmaxLabelScale(svgEl){
  if (!svgEl) return;
  const scaleX = (svgEl.getBoundingClientRect().width / CHART_W) || 1;
  const f = 1/scaleX;
  svgEl.querySelectorAll('.chart-minmax-label').forEach(t=>{
    const x = parseFloat(t.getAttribute('x')) || 0;
    t.setAttribute('transform', `matrix(${f},0,0,1,${(x*(1-f)).toFixed(2)},0)`);
  });
}

function applyChartViewMode(){
  document.querySelectorAll('.chart-block-wrap').forEach(el=>{
    el.classList.toggle('box-view', chartViewMode === 'box');
  });
  $('#chart-view-list').style.display = chartViewMode === 'box' ? '' : 'none';
  $('#chart-view-box').style.display = chartViewMode === 'list' ? '' : 'none';
  // padR()이 리스트형/박스형마다 다른 값을 돌려주므로, 그리드선/선 경로/
  // 라벨 위치 전부 새 여백 기준으로 다시 계산해야 한다. 이 값들은 차트를
  // 맨 처음 펼칠 때 한 번만 구워지므로, 이미 펼쳐진 차트는 뷰를 전환할
  // 때마다 통째로 다시 그려서 반영한다.
  openChartContainers.forEach(container=>{
    if (!container._records) return;
    if (container._cleanupDrag) container._cleanupDrag();
    if (container._cleanupSticky) container._cleanupSticky();
    renderInlineCharts(container, container._records);
  });
}

/* ============================== 인라인 행 차트(펼치기/접기) ============================== */
// 현재 펼쳐져 있는 모든 차트 <td>를 추적해서, 같은 행을 클릭해 접는 경우
// 뿐 아니라 다른 방식으로 행이 사라질 때도(세션 닫기, 세션 전환, 전체
// 초기화) window 레벨 드래그 리스너와 IntersectionObserver를 정리할 수
// 있게 한다.
let openChartContainers = [];
// fixed-info-bar(하단 고정 정보바)는 다이빙 차트가 펼쳐져 있을 때만
// 의미가 있으므로(스크럽 중인 차트 값을 그대로 보여주는 용도), 표시
// 여부는 그냥 펼쳐진 차트 행이 하나라도 있는지로 결정한다.
function syncFixedInfoBar(){
  const show = openChartContainers.length > 0;
  $('#fixed-info-bar').style.display = show ? '' : 'none';
  document.body.classList.toggle('has-fixed-info-bar', show);
}
function cleanupChartContainer(td){
  if (!td) return;
  if (td._cleanupDrag) td._cleanupDrag();
  if (td._cleanupSticky) td._cleanupSticky();
  const idx = openChartContainers.indexOf(td);
  if (idx !== -1) openChartContainers.splice(idx, 1);
  // td는 <tr class="dive-chart-row"> 안에 있다 — 그 행 자체와, 바로 앞
  // <tr class="dive-row">의 펼침 표시(.expanded)까지 여기서 함께 정리해서
  // closeAllDiveCharts()로 접을 때도(뒤로가기 등) 시각적으로 확실히 접히게 한다.
  const chartRow = td.parentElement;
  if (chartRow && chartRow.classList.contains('dive-chart-row')){
    const diveRow = chartRow.previousElementSibling;
    if (diveRow) diveRow.classList.remove('expanded');
    chartRow.remove();
  }
  syncFixedInfoBar();
}
function closeAllDiveCharts(){
  openChartContainers.slice().forEach(cleanupChartContainer);
}

// 펼쳐진 다이빙 차트를 전부 접는다. 뒤로가기로 쌓인 히스토리가 있으면
// (fromPopstate가 아닐 때) 함께 정리한다 — toggleDiveChartRow가 마지막
// 하나를 접을 때, 그리고 popstate 핸들러가 이 로직을 재사용한다.
function collapseAllDiveCharts(fromPopstate){
  closeAllDiveCharts();
  if (diveChartsHistoryPushed && !fromPopstate){
    diveChartsHistoryPushed = false;
    suppressPopCheck = true;
    history.back();
  } else {
    diveChartsHistoryPushed = false;
  }
}

function toggleDiveChartRow(tr, d){
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('dive-chart-row')){
    cleanupChartContainer(next.querySelector('td')); // 행 제거·expanded 해제까지 여기서 처리
    if (openChartContainers.length === 0) collapseAllDiveCharts();
    return;
  }
  const records = loadDiveRecords(d.id);
  if (!records || !records.length){ toast('다이빙 데이터를 불러올 수 없어요'); return; }

  const chartRow = document.createElement('tr');
  chartRow.className = 'dive-chart-row';
  const td = document.createElement('td');
  td.colSpan = 4;
  chartRow.appendChild(td);
  tr.after(chartRow);
  tr.classList.add('expanded');
  openChartContainers.push(td);
  if (openChartContainers.length === 1){
    history.pushState({diveChart:true}, '');
    diveChartsHistoryPushed = true;
  }
  syncFixedInfoBar();
  renderInlineCharts(td, records);
}

// 차트 라벨(h4) 아래에 표시할 다이빙별 요약 수치(최대수심, 평균하강/상승
// 속도, 평균/최대 심박수, 최저/최고 수온 등)를 차트 종류별로 계산한다.
function chartLabelSubStats(def, records, vs){
  const values = records.map(r=>r[def.key]).filter(v=>v!=null);
  if (!values.length) return [];
  switch(def.key){
    case 'depth':
      return [['최대수심', def.fmt(Math.max(...values))]];
    case 'vSpeed':
      return [['평균하강속도', def.fmt(vs.avgDescent)], ['평균상승속도', def.fmt(vs.avgAscent)]];
    case 'hr':
      return [['평균', def.fmt(values.reduce((a,b)=>a+b,0)/values.length)], ['최대', def.fmt(Math.max(...values))]];
    case 'temp':
      return [['최저', def.fmt(Math.min(...values))], ['최고', def.fmt(Math.max(...values))]];
    default:
      return [];
  }
}

// 다이빙의 vSpeed 샘플을 하강(음수)/상승(양수)으로 나눠서 각각의
// 평균·극값을 계산한다 — 상단 info-bar와 vSpeed 차트 서브 통계
// (chartLabelSubStats) 둘 다 이 값을 쓴다.
function computeVSpeedStats(records){
  const descents = records.map(r=>r.vSpeed).filter(v=>v!=null && v<0);
  const ascents = records.map(r=>r.vSpeed).filter(v=>v!=null && v>0);
  const avg = (arr) => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
  return {
    avgDescent: avg(descents),
    maxDescent: descents.length ? Math.min(...descents) : null,
    avgAscent: avg(ascents),
    maxAscent: ascents.length ? Math.max(...ascents) : null,
  };
}

// 다이빙 하나를 펼쳤을 때의 전체 내용을 만든다: info-bar 2개 + CHART_DEFS
// 항목(수심/수직속도/심박수/수온)마다 chart-block 하나씩(각각 서브 통계
// 줄 포함). `uid`로 이 다이빙의 엘리먼트 id를 구분해서, 여러 다이빙 행을
// 동시에 펼쳐도 id가 겹치지 않게 한다.
function renderInlineCharts(container, records){
  container._records = records; // 뷰 모드 전환 시 다시 그리기 위해 보관
  const uid = 'inline-' + Math.random().toString(36).slice(2,8);
  const totalSec = records.length ? records[records.length-1].t - records[0].t : 0;
  const vs = computeVSpeedStats(records);
  const fmtVs = CHART_DEFS.find(d=>d.key==='vSpeed').fmt;
  container.innerHTML = `
    <div class="info-bar">
      <ul>
        <li class="descent"><div class="k">평균 하강</div><div class="val">${fmtVs(vs.avgDescent)}</div></li>
        <li class="descent"><div class="k">최대 하강</div><div class="val">${fmtVs(vs.maxDescent)}</div></li>
        <li class="ascent"><div class="k">평균 상승</div><div class="val">${fmtVs(vs.avgAscent)}</div></li>
        <li class="ascent"><div class="k">최대 상승</div><div class="val">${fmtVs(vs.maxAscent)}</div></li>
      </ul>
    </div>
    <div class="info-bar-sentinel"></div>
    <div class="info-bar">
      <ul>
        <li class="time"><div class="k">시간</div><div class="val" data-info="time">–</div></li>
        <li class="depth"><div class="k">수심</div><div class="val" data-info="depth">–</div></li>
        <li class="vs"><div class="k">속도</div><div class="val" data-info="vs">–</div></li>
        <li class="hr"><div class="k">심박</div><div class="val" data-info="hr">–</div></li>
        <li class="temp"><div class="k">수온</div><div class="val" data-info="temp">–</div></li>
      </ul>
    </div>
    <div class="chart-block-wrap">
      ${CHART_DEFS.map(def=>{
        const subStats = chartLabelSubStats(def, records, vs);
        const subHtml = subStats.length ? `<ul>${subStats.map(([k,v])=>`<li>${k} <span>${v}</span></li>`).join('')}</ul>` : '';
        return `
      <div class="chart-block">
        <div class="chart-label"><h4>${def.label}</h4>${subHtml}</div>
        <div data-key="${def.key}"></div>
        <div class="chart-time-axis">${[0,1,2,3,4,5,6].map(i=>`<span>${fmtTime(totalSec*i/6).replace(/^0/,'')}</span>`).join('')}</div>
      </div>`;
      }).join('')}
    </div>`;

  container.querySelector('.chart-block-wrap').classList.toggle('box-view', chartViewMode === 'box');

  const geoms = {};
  const chartIds = {};
  CHART_DEFS.forEach(def=>{
    const wrap = container.querySelector(`[data-key="${def.key}"]`);
    const values = records.map(r=>r[def.key]);
    if (!values.some(v=>v!=null)){
      wrap.innerHTML = `<div class="no-data">이 다이빙에는 ${def.key} 데이터가 없어요</div>`;
      return;
    }
    const chartId = uid + '-' + def.key;
    chartIds[def.key] = chartId;
    wrap.innerHTML = svgChart(chartId, def.colorHex, def.mode);
    const geo = buildChartGeometry(values, def.mode);
    geoms[def.key] = geo;
    wrap.querySelector(`#${chartId}-line`).setAttribute('d', geo.d);
    if (geo.d){
      const zeroY = def.mode==='zero' ? geo.mapY(0) : geo.mapY(geo.scale.min);
      wrap.querySelector(`#${chartId}-area`).setAttribute('d', geo.d + `L ${geo.pts[geo.pts.length-1].x.toFixed(2)} ${zeroY.toFixed(2)} L ${geo.pts[0].x.toFixed(2)} ${zeroY.toFixed(2)} Z`);
    }
    const minmaxHtml = (v)=> v==null ? '–' : `${def.fmtValue(v)}<tspan class="chart-minmax-unit">${def.unit}</tspan>`;
    // -max/-min은 "차트 위쪽/아래쪽에 놓인 라벨"이라는 뜻이다. depth 모드만
    // mapY()가 뒤집혀 있어(수심 0이 위, 최대수심이 아래) 위쪽엔 최소값(0),
    // 아래쪽엔 최대수심이 와야 한다 — 다른 모드는 반대로 위=최대, 아래=최소.
    const topVal = def.mode === 'depth' ? geo.scale.min : geo.scale.max;
    const bottomVal = def.mode === 'depth' ? geo.scale.max : geo.scale.min;
    wrap.querySelector(`#${chartId}-max`).innerHTML = minmaxHtml(topVal);
    wrap.querySelector(`#${chartId}-min`).innerHTML = minmaxHtml(bottomVal);
    fixMinmaxLabelScale(wrap.querySelector('svg.chart'));
  });

  updateInlineCrosshair(container, null, records, geoms, chartIds);
  attachInlineDrag(container, records, geoms, chartIds);

  const infoBarSentinel = container.querySelector('.info-bar-sentinel');
  const infoBar = infoBarSentinel ? infoBarSentinel.nextElementSibling : null;
  if (infoBar && infoBarSentinel){
    const stickyObserver = new IntersectionObserver(([entry])=>{
      infoBar.classList.toggle('fixed', !entry.isIntersecting);
    }, {rootMargin: '-98px 0px 0px 0px', threshold: 0});
    stickyObserver.observe(infoBarSentinel);
    container._cleanupSticky = () => stickyObserver.disconnect();
  }
}

// 모든 차트의 크로스헤어/점을 샘플 인덱스 `idx` 위치로 옮기고 info-bar
// 텍스트를 갱신한다(인라인 바와, 보이는 상태라면 하단 고정 바 둘 다).
// idx === null이면 전부 "스크럽 중 아님"(–) 상태로 되돌린다.
function updateInlineCrosshair(container, idx, records, geoms, chartIds){
  const fixedBar = document.getElementById('fixed-info-bar');
  const setInfo = (key, val) => {
    const el = container.querySelector(`[data-info="${key}"]`);
    if (el) el.textContent = val;
    if (idx != null && fixedBar){
      const fixedEl = fixedBar.querySelector(`[data-info="${key}"]`);
      if (fixedEl) fixedEl.textContent = val;
    }
  };
  if (idx == null){
    CHART_DEFS.forEach(def=>{
      const chartId = chartIds[def.key];
      if (!chartId) return;
      const ch = document.getElementById(chartId+'-crosshair');
      const dot = document.getElementById(chartId+'-dot');
      if (ch) ch.style.display = 'none';
      if (dot) dot.style.display = 'none';
    });
    ['time','depth','vs','temp','hr'].forEach(k=>setInfo(k, '–'));
    return;
  }
  const r = records[idx];
  const t0 = records[0].t;
  setInfo('time', fmtTime(r.t - t0));
  setInfo('depth', r.depth==null? '–' : r.depth.toFixed(1)+'m');
  setInfo('vs', r.vSpeed==null? '–' : (r.vSpeed>=0?'+':'')+r.vSpeed.toFixed(2)+'m/s');
  setInfo('temp', r.temp==null? '–' : r.temp.toFixed(1)+'℃');
  setInfo('hr', r.hr==null? '–' : Math.round(r.hr)+'bpm');

  CHART_DEFS.forEach(def=>{
    const geo = geoms[def.key];
    const chartId = chartIds[def.key];
    if (!geo || !chartId) return;
    const svgEl = document.getElementById(chartId);
    const ch = document.getElementById(chartId+'-crosshair');
    const dot = document.getElementById(chartId+'-dot');
    if (!ch || !dot) return;
    const p = geo.pts[idx];
    ch.setAttribute('x1', p.x); ch.setAttribute('x2', p.x);
    ch.style.display = '';
    if (p.y != null){
      const scaleX = svgEl ? (svgEl.getBoundingClientRect().width / CHART_W) || 1 : 1;
      dot.setAttribute('rx', (DOT_R/scaleX).toFixed(2));
      dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y);
      dot.style.display = '';
    } else {
      dot.style.display = 'none';
    }
  });
}

// 이 다이빙 행에 있는 모든 차트에 크로스헤어 스크럽 기능을 연결한다.
// 마우스: mousedown 즉시 드래그 시작, 방향 판단이 필요 없음.
// 터치: 처음 움직였을 때 가로 스크럽인지(axisLock='x', 크로스헤어를
// 움직이고 preventDefault로 페이지 스크롤을 막음) 세로 스크롤인지
// (axisLock='y', 스크롤에 양보) 판단한다 — onMove 참고. 이 덕분에
// 손가락 하나로 차트를 스크럽할 때 페이지 스크롤과 충돌하지 않는다.
function attachInlineDrag(container, records, geoms, chartIds){
  const svgs = Object.values(chartIds).map(id=>document.getElementById(id)).filter(Boolean);
  if (svgs.length === 0) return;
  let dragging = false;
  let startX = 0, startY = 0, axisLock = null; // axisLock: null(미정) | 'x'(차트 드래그) | 'y'(스크롤 양보)
  let activeSvg = svgs[0]; // 실제로 터치 중인 차트 — 박스뷰에서는 차트가 서로 다른 열에 있어서 중요함
  const n = records.length;
  const SLOP = 6; // 방향 판단 전 허용 오차(px)
  const RELEASE_DY = 64; // 이 이상 세로로 벗어나면 가로 드래그로 확정됐어도 스크롤에 양보

  function indexFromClientX(clientX){
    const rect = activeSvg.getBoundingClientRect();
    const relX = ((clientX - rect.left)/rect.width) * CHART_W;
    const innerW = CHART_W - PAD.l - padR();
    const frac = (relX - PAD.l)/innerW;
    const idx = Math.round(frac * (n-1));
    return Math.max(0, Math.min(n-1, idx));
  }
  function onMove(e){
    const isTouch = !!e.touches;
    const clientX = isTouch ? e.touches[0].clientX : e.clientX;
    const clientY = isTouch ? e.touches[0].clientY : e.clientY;
    if (isTouch && axisLock == null){
      const dx = clientX - startX, dy = clientY - startY;
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      axisLock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axisLock === 'x') dragging = true;
    }
    if (axisLock === 'y') return; // 세로 이동은 스크롤에 양보
    if (!dragging) return;
    if (isTouch){
      // 가로 드래그로 확정된 뒤에도 손가락이 차트 밖으로 한참(세로로) 벗어나면
      // preventDefault를 계속 걸어 스크롤을 막는 대신 놓아준다.
      if (Math.abs(clientY - startY) > RELEASE_DY){
        onUp();
        return;
      }
      e.preventDefault();
    }
    updateInlineCrosshair(container, indexFromClientX(clientX), records, geoms, chartIds);
  }
  function onDown(e){
    activeSvg = e.currentTarget;
    const isTouch = !!e.touches;
    const clientX = isTouch ? e.touches[0].clientX : e.clientX;
    const clientY = isTouch ? e.touches[0].clientY : e.clientY;
    startX = clientX; startY = clientY;
    if (isTouch){
      axisLock = null; // 첫 move에서 방향 결정
      return;
    }
    dragging = true;
    updateInlineCrosshair(container, indexFromClientX(clientX), records, geoms, chartIds);
    e.preventDefault();
  }
  function onUp(){ dragging = false; axisLock = null; }

  svgs.forEach(svg=>{
    svg.addEventListener('mousedown', onDown);
    svg.addEventListener('touchstart', onDown, {passive:true});
  });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, {passive:false});
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchend', onUp);
  window.addEventListener('touchcancel', onUp);

  container._cleanupDrag = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchend', onUp);
    window.removeEventListener('touchcancel', onUp);
  };
}

/* ============================== 파일 업로드 처리 ============================== */
// 선택되거나 드롭된 .fit 파일들을 각각 읽고 파싱한다(FileReader가
// 비동기라 `pending` 카운트다운으로 여러 파일을 병렬 처리). 파일 하나당
// 세션 하나 + 다이빙 메타 목록 + 다이빙별 레코드 배열을 localStorage에
// 저장한다. 모든 파일이 처리(성공이든 실패든) 끝나면 finishUpload()가
// 한 번 호출된다 — 실제로 뭐가 추가됐는지는 `newSessions` 인자를 보면 된다.
function handleFiles(fileList){
  const files = Array.from(fileList).filter(f=>f.name.toLowerCase().endsWith('.fit'));
  if (files.length === 0){ toast('.fit 파일만 업로드할 수 있어요'); return; }
  const newSessions = []; // 이번 업로드에서 실제로 추가된 세션들
  let pending = files.length;

  files.forEach(file=>{
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const buf = reader.result;
        const parser = new FitParser(buf);
        const messages = parser.parse();
        const records = extractRecords(messages);
        if (records.length === 0){ toast(file.name + ': 기록 데이터를 찾을 수 없어요'); return; }
        const dives = segmentDives(records);
        if (dives.length === 0){ toast(file.name + ': 다이빙 구간을 찾을 수 없어요'); return; }

        // 파일명이 아니라 내용 기반 지문(fingerprint)이라, 같은 기록을
        // 다른 파일명으로 다시 올려도 중복으로 잡아낼 수 있다.
        const fingerprint = records[0].t + '_' + records[records.length-1].t + '_' + records.length;
        if (sessions.some(s => s.fingerprint === fingerprint)){
          toast(file.name + ': 이미 업로드된 파일이에요');
          return;
        }

        const uploadedAt = Date.now();
        const sessionId = 's' + uploadedAt + '_' + Math.random().toString(36).slice(2,7);
        const diveMetas = [];
        let sessionMaxDepth = 0;
        let gps = null;

        let storageFailed = false;
        dives.forEach(seg=>{
          if (storageFailed) return;
          const slice = withDerived(records.slice(seg.startIdx, seg.endIdx+1));
          const depths = slice.map(r=>r.depth).filter(v=>v!=null);
          const maxDepth = depths.length ? Math.max(...depths) : 0;
          sessionMaxDepth = Math.max(sessionMaxDepth, maxDepth);
          if (!gps){
            const withGps = slice.find(r=>r.lat!=null);
            if (withGps) gps = {lat:withGps.lat, lon:withGps.lon};
          }
          const diveId = 'd' + uploadedAt + '_' + seg.startIdx + '_' + Math.random().toString(36).slice(2,7);
          if (!saveDiveRecords(diveId, slice)){ storageFailed = true; return; }
          // 세션 상세를 열 때마다 평균 심박수 계산하려고 전체 records를 다시
          // 불러오지 않도록, 업로드 시점에 심박 합계/개수를 다이빙 메타에
          // 캐싱해둔다 (openSession 참고).
          let hrSum = 0, hrCount = 0;
          slice.forEach(r=>{ if (r.hr != null){ hrSum += r.hr; hrCount++; } });
          diveMetas.push({
            id: diveId,
            startTime: slice[0].t,
            durationSec: slice[slice.length-1].t - slice[0].t,
            maxDepth,
            hrSum,
            hrCount
          });
        });

        const sessionMeta = {
          id: sessionId,
          fileName: file.name,
          uploadedAt,
          startTime: records[0].t,
          endTime: records[records.length-1].t,
          maxDepth: sessionMaxDepth,
          diveCount: diveMetas.length,
          gps,
          fingerprint
        };
        if (storageFailed || !saveSessionDives(sessionId, diveMetas)){
          // 이미 저장된 다이빙 레코드가 있다면 롤백해서, 어떤 세션도
          // 가리키지 않는 고아 데이터가 남지 않게 한다.
          diveMetas.forEach(dm=>deleteDiveRecords(dm.id));
          toast(file.name + ': 저장 공간이 부족해 추가하지 못했어요');
          return;
        }
        sessions.push(sessionMeta);
        newSessions.push(sessionMeta);
      } catch(err){
        console.error(err);
        toast(file.name + ': 분석에 실패했어요 (' + err.message + ')');
      } finally {
        pending--;
        if (pending === 0) finishUpload(newSessions);
      }
    };
    reader.onerror = () => {
      toast(file.name + ': 파일을 읽지 못했어요');
      pending--;
      if (pending === 0) finishUpload(newSessions);
    };
    reader.readAsArrayBuffer(file);
  });
}

// handleFiles() 배치의 파일들이 모두 처리된 뒤 한 번 실행된다.
// 전체 세션 중 최신이 아니라 *이번 배치에서* 최신 다이빙을 연다 — 예전
// 백업 파일을 업로드했는데 오늘 다이빙 화면으로 튀는 일이 없도록.
function finishUpload(newSessions){
  if (newSessions.length > 0){
    saveSessions(sessions);
    // 새로 올린 파일이 현재 연/월 필터에 가려 안 보이는 일이 없도록 필터를 초기화한다.
    filterYear = '';
    filterMonth = '';
    renderSessionList();
    toast(newSessions.length + '개의 업로드를 추가했어요');
    const newest = newSessions.slice().sort((a,b)=>b.startTime-a.startTime)[0];
    if (newest) openSession(newest.id);
  }
}

/* ============================== 이벤트 바인딩 / 초기화 ============================== */
// 세션 헤더 바로 위에 있는 1px짜리 감지용 엘리먼트. 이게 화면 밖으로
// 스크롤되면 헤더가 "fixed"(고정처럼 보이는) CSS 상태로 전환된다.
// scroll 이벤트 대신 IntersectionObserver를 쓰는 이유는 스크롤할 때마다
// 매 프레임 계산하지 않기 위해서다.
{
  const sentinel = $('#contents-head-sentinel');
  const contentsHead = document.querySelector('.contents-head');
  if (sentinel && contentsHead){
    new IntersectionObserver(([entry])=>{
      contentsHead.classList.toggle('fixed', !entry.isIntersecting);
    }, {threshold: 0}).observe(sentinel);
  }
}
// PWA 설치 버튼: 브라우저가 "설치 가능" 상태라고 판단해 beforeinstallprompt를
// 쏴줄 때만 버튼을 보여준다. iOS Safari나 이미 설치된 경우, 최근에 설치를
// 취소해서 브라우저가 재안내를 쿨다운 중인 경우엔 이 이벤트 자체가 안 오므로
// 버튼도 자연스럽게 안 뜬다(별도 기기/상태 분기 코드 불필요).
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredInstallPrompt = e;
  $('#install-btn').classList.add('show');
});
$('#install-btn').addEventListener('click', async ()=>{
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $('#install-btn').classList.remove('show');
});
window.addEventListener('appinstalled', ()=>{
  deferredInstallPrompt = null;
  $('#install-btn').classList.remove('show');
});

applyTheme();
$('#theme-toggle').addEventListener('click', ()=>{
  theme = theme === 'dark' ? 'light' : 'dark';
  lsSet('theme', theme);
  applyTheme();
});

applyChartViewMode();
$('#chart-view-list').addEventListener('click', ()=>{ chartViewMode = 'list'; lsSet('chartViewMode', chartViewMode); applyChartViewMode(); });
$('#chart-view-box').addEventListener('click', ()=>{ chartViewMode = 'box'; lsSet('chartViewMode', chartViewMode); applyChartViewMode(); });
$('#file-input').addEventListener('change', (e)=>{
  handleFiles(e.target.files);
  e.target.value = '';
});
$('#select-none').addEventListener('click', ()=>$('#file-input').click());
$('#filter-year').addEventListener('change', (e)=>{
  filterYear = e.target.value;
  filterMonth = '';
  renderSessionList();
});
$('#filter-month').addEventListener('change', (e)=>{
  filterMonth = e.target.value;
  renderSessionList();
});
const dropzone = $('#dropzone');
['dragover'].forEach(evt=>dropzone.addEventListener(evt, e=>{ e.preventDefault(); dropzone.classList.add('drag-over'); }));
['dragleave','drop'].forEach(evt=>dropzone.addEventListener(evt, e=>{ e.preventDefault(); dropzone.classList.remove('drag-over'); }));
dropzone.addEventListener('drop', e=>{
  if (e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

$('#close-session').addEventListener('click', ()=>{
  closeSessionView();
});
$('#reset-all').addEventListener('click', async ()=>{
  if (!(await showConfirm('업로드한 모든 다이빙 기록을 삭제할까요? 이 작업은 되돌릴 수 없어요.', {okText:'초기화', danger:true}))) return;
  sessions.forEach(s=>{
    const dives = loadSessionDives(s.id);
    dives.forEach(d=>deleteDiveRecords(d.id));
    lsDel('dives:'+s.id);
  });
  sessions = [];
  saveSessions(sessions);
  closeSessionView();
  toast('모두 초기화했어요');
});

// 뒤로가기 depth는 두 단계다: #contents(세션 상세)가 열려 있고, 그 위에
// 다이빙 차트까지 펼쳐져 있을 수 있다. 뒤로가기를 누르면 가장 안쪽(차트)부터
// 한 단계씩 닫히고, 둘 다 닫힌 상태에서 누르면 별도 처리 없이 평소
// 브라우저/PWA 동작 그대로 앱을 나간다.
window.addEventListener('popstate', ()=>{
  if (suppressPopCheck){
    suppressPopCheck = false; // closeSessionView/collapseAllDiveCharts가 스스로 유발한 popstate — 무시
    return;
  }
  if (diveChartsHistoryPushed){
    collapseAllDiveCharts(true);
    return;
  }
  if (selectedSessionId !== null){
    closeSessionView(true);
  }
});

// 시작할 때 한 번 실행되는 정리 작업: 지문(fingerprint)이 같은 세션들을
// (지문이 없던 예전 데이터는 startTime+endTime+diveCount가 같은 세션들을)
// 가장 먼저 올린 것 하나만 남기고 나머지는 지운다 — 업로드 시점 지문
// 검사가 생기기 전에 들어온 중복 데이터를 정리하기 위함.
function dedupeExistingSessions(){
  const seen = new Map(); // key -> 남길 세션
  const toRemove = [];
  // 중복 그룹에서 가장 먼저 업로드된 것이 남도록 정렬
  const sorted = sessions.slice().sort((a,b)=>a.uploadedAt-b.uploadedAt);
  sorted.forEach(s=>{
    const key = s.fingerprint || (s.startTime+'_'+s.endTime+'_'+s.diveCount);
    if (seen.has(key)){
      toRemove.push(s.id);
    } else {
      seen.set(key, s.id);
    }
  });
  if (toRemove.length === 0) return 0;
  toRemove.forEach(id=>{
    const dives = loadSessionDives(id);
    dives.forEach(d=>deleteDiveRecords(d.id));
    lsDel('dives:'+id);
  });
  sessions = sessions.filter(s=>!toRemove.includes(s.id));
  saveSessions(sessions);
  return toRemove.length;
}

// 앱 진입점: localStorage에 있던 데이터를 불러오고, 남아있던 중복을
// 조용히 정리한 뒤 첫 렌더링을 한다.
(function init(){
  sessions = loadSessions();
  const removed = dedupeExistingSessions();
  renderSessionList();
  if (removed > 0) toast(removed + '개의 중복 업로드를 정리했어요');
})();
