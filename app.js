const $ = (s)=>document.querySelector(s);
const LS = {user:'md_user_name', asst:'md_asst_name', filter:'md_filter_mode', theme:'md_theme'};
const defaults = {user:'Me', asst:'GPT', filter:'simple', theme:'Echoes'};

// —— 读取与应用偏好
function loadPrefs(){
  return {
    user: localStorage.getItem(LS.user) || defaults.user,
    asst: localStorage.getItem(LS.asst) || defaults.asst,
    filter: localStorage.getItem(LS.filter) || defaults.filter,
    theme: localStorage.getItem(LS.theme) || defaults.theme
  };
}
function sanitizeName(s){ return (s||'').trim().slice(0,24).replace(/[<>]/g,''); }

function applyNames(p){
  $('#title').textContent = `Memory：${p.user}&${p.asst}`;
  $('#nameU').textContent = p.user; $('#nameA').textContent = p.asst;
  $('#nameU2').textContent = p.user; $('#nameA2').textContent = p.asst;
  $('#userName').value = p.user; $('#assistantName').value = p.asst;
}
function applyFilter(mode){
  document.querySelectorAll('input[name="filter"]').forEach(r=>r.checked=(r.value===mode));
  $('#modeText').textContent = mode==='simple' ? '简单过滤' : '深度过滤';
}
function applyTheme(theme){
  document.body.setAttribute('data-theme', theme);
  document.querySelectorAll('.theme').forEach(btn=>{
    btn.setAttribute('aria-pressed', btn.dataset.theme===theme ? 'true':'false');
  });
}

// —— 初始化
const prefs = loadPrefs();
applyNames(prefs); applyFilter(prefs.filter); applyTheme(prefs.theme);

// —— 事件：名称
$('#saveNames').onclick = ()=>{
  const u = sanitizeName($('#userName').value) || defaults.user;
  const a = sanitizeName($('#assistantName').value) || defaults.asst;
  localStorage.setItem(LS.user, u);
  localStorage.setItem(LS.asst, a);
  applyNames({user:u, asst:a});
};
$('#resetNames').onclick = ()=>{
  localStorage.removeItem(LS.user); localStorage.removeItem(LS.asst);
  applyNames(defaults);
};

// —— 事件：过滤模式
document.querySelectorAll('input[name="filter"]').forEach(r=>{
  r.onchange = ()=>{
    localStorage.setItem(LS.filter, r.value);
    applyFilter(r.value);
  };
});

// —— 事件：主题按钮
document.querySelectorAll('.theme').forEach(btn=>{
  btn.onclick = ()=>{
    const t = btn.dataset.theme;
    localStorage.setItem(LS.theme, t);
    applyTheme(t);
  };
});

// —— 文件与预检（保持原有逻辑）
let fileHandle = null;
$('#file').onchange = (e)=>{ fileHandle = e.target.files?.[0] || null; $('#status').textContent = fileHandle? `已选择：${fileHandle.name}`:'未加载文件'; };
const worker = new Worker('./parser.worker.js?v=7', {type:'module'});
let currentSummary = null;

$('#runPrecheck').onclick = ()=>{
  if(!fileHandle){ $('#status').textContent = '请先选择 JSON 文件'; return; }
  $('#status').textContent = '预检中…';
  worker.postMessage({type:'precheck', file:fileHandle});
};
worker.onmessage = (e)=>{
  const data = e.data || {};
  const {type} = data;
  if(type==='precheck'){
    const {ok, reason, hint} = data;
    $('#status').textContent = ok ? `预检通过：检测到 ChatGPT 导出结构${hint?`（${hint}）`:''}` : `预检失败：${reason || '未知原因'}`;
    if (ok) {
      const mode = localStorage.getItem('md_filter_mode') || 'simple';
      worker.postMessage({ type:'parse', file:fileHandle, mode });
      $('#status').textContent = 'Precheck passed, parsing…';
    }
  } else if(type==='progress'){
    const {pct = 0, loadedBytes = 0, totalBytes = 0} = data;
    const pctText = clampPct(pct);
    $('#status').textContent = `${pctText}% (${formatMB(loadedBytes)}/${formatMB(totalBytes)} MB)`;
  } else if(type==='done'){
    const {summary = null} = data;
    currentSummary = summary;
    renderSummaryBasics(summary);
    const hotSlot = summarizeHotSlot(summary?.timeOfDay);
    $('#hotSlot').textContent = hotSlot || '—';
    const streaks = calcStreaks(summary?.dayActive);
    $('#streakNow').textContent = streaks.now || '—';
    $('#streakMax').textContent = streaks.max || '—';
    let statusText = '解析完成';
    if(summary?.samplingNote === true){
      statusText += '（性能保护：基于抽样）';
    }
    $('#status').textContent = statusText;
  } else if(type==='error'){
    $('#status').textContent = data.message || '未知错误';
  }
};

const hourFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit'
});

function clampPct(pct){
  if(!Number.isFinite(pct)){ return '0'; }
  const safe = Math.max(0, Math.min(100, pct));
  return Math.round(safe).toString();
}

function formatMB(bytes){
  if(!Number.isFinite(bytes) || bytes <= 0){ return '0.00'; }
  return (bytes / (1024 * 1024)).toFixed(2);
}

function formatCount(value){
  if(!Number.isFinite(value)){ return '0'; }
  return Math.trunc(value).toLocaleString();
}

function renderSummaryBasics(summary){
  if(!summary){
    $('#uChars').textContent = '0';
    $('#aChars').textContent = '0';
    $('#uMsgs').textContent = '0';
    $('#aMsgs').textContent = '0';
    $('#earliest').textContent = '—';
    return;
  }

  const userChars = Number(summary?.totalChars?.user ?? 0);
  const asstChars = Number(summary?.totalChars?.assistant ?? 0);
  const userMsgs = Number(summary?.totalMsgs?.user ?? 0);
  const asstMsgs = Number(summary?.totalMsgs?.assistant ?? 0);
  $('#uChars').textContent = formatCount(userChars);
  $('#aChars').textContent = formatCount(asstChars);
  $('#uMsgs').textContent = formatCount(userMsgs);
  $('#aMsgs').textContent = formatCount(asstMsgs);

  const ts = summary?.earliestTs;
  if(ts){
    const dt = new Date(ts);
    dt.setMinutes(0, 0, 0);
    $('#earliest').textContent = hourFormatter.format(dt);
  } else {
    $('#earliest').textContent = '—';
  }
}

function summarizeHotSlot(timeOfDay){
  if(!Array.isArray(timeOfDay) || timeOfDay.length !== 8){ return ''; }
  const values = timeOfDay.map(v => Number(v) || 0);
  const maxVal = Math.max(...values);
  if(maxVal <= 0){ return ''; }
  const tzOffsetMinutes = -new Date().getTimezoneOffset();
  const slots = values
    .map((val, idx) => ({ val, idx }))
    .filter(item => item.val === maxVal)
    .map(item => {
      const utcStartMin = item.idx * 180;
      const localStartMin = (utcStartMin + tzOffsetMinutes + 1440) % 1440;
      return formatSlotRange(localStartMin);
    });
  return slots.join('、');
}

function formatSlotRange(startMinutes){
  const normalizedStart = ((startMinutes % 1440) + 1440) % 1440;
  const rawEnd = normalizedStart + 180;
  const startLabel = formatHourMinute(normalizedStart);
  let endLabel;
  if(rawEnd === 1440){
    endLabel = '24:00';
  }else{
    endLabel = formatHourMinute(rawEnd % 1440);
  }
  return `${startLabel}–${endLabel}`;
}

function formatHourMinute(totalMinutes){
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

function calcStreaks(dayActive){
  if(!Array.isArray(dayActive) || !dayActive.length){
    return {now: '', max: ''};
  }
  const uniqueSorted = Array.from(new Set(dayActive)).sort();
  if(!uniqueSorted.length){
    return {now: '', max: ''};
  }

  const runs = [];
  let runStart = uniqueSorted[0];
  let runEnd = uniqueSorted[0];
  let runLength = 1;

  const toMidnightDate = (str)=> new Date(`${str}T00:00:00`);
  for(let i = 1; i < uniqueSorted.length; i += 1){
    const prevDate = toMidnightDate(uniqueSorted[i - 1]);
    const currDate = toMidnightDate(uniqueSorted[i]);
    const diffDays = Math.round((currDate - prevDate) / 86400000);
    if(diffDays === 1){
      runEnd = uniqueSorted[i];
      runLength += 1;
    }else{
      runs.push({ start: runStart, end: runEnd, length: runLength });
      runStart = uniqueSorted[i];
      runEnd = uniqueSorted[i];
      runLength = 1;
    }
  }
  runs.push({ start: runStart, end: runEnd, length: runLength });

  let maxRun = runs[0];
  for(const run of runs){
    if(run.length > maxRun.length || (run.length === maxRun.length && run.end > maxRun.end)){
      maxRun = run;
    }
  }
  const currentRun = runs[runs.length - 1];

  return {
    now: formatRun(currentRun),
    max: formatRun(maxRun)
  };
}

function formatRun(run){
  if(!run){ return ''; }
  const start = run.start.replaceAll('-', '/');
  const end = run.end.replaceAll('-', '/');
  return `${start}–${end} · ${run.length}天`;
}
