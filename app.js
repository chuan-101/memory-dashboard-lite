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
const worker = new Worker('./parser.worker.js', {type:'module'});

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
    const pctText = pct.toString().padStart(2, '0');
    $('#status').textContent = `Parsing… ${pctText}% (${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)})`;
  } else if(type==='done'){
    const {summary} = data;
    applySummary(summary);
    const sampling = summary?.samplingNote ? ' (sampling enabled)' : '';
    $('#status').textContent = `Parsing complete.${sampling}`;
  } else if(type==='error'){
    $('#status').textContent = `解析失败：${data.message || '未知错误'}`;
  }
};

function formatBytes(bytes){
  if(!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  let idx = 0;
  let value = bytes;
  while(value >= 1024 && idx < units.length - 1){
    value /= 1024;
    idx++;
  }
  const fractionDigits = value >= 100 || idx === 0 ? 0 : (value >= 10 ? 1 : 2);
  return `${value.toFixed(fractionDigits)} ${units[idx]}`;
}

function applySummary(summary){
  if(!summary){ return; }
  $('#uChars').textContent = summary.totalChars?.user ?? 0;
  $('#aChars').textContent = summary.totalChars?.assistant ?? 0;
  $('#uMsgs').textContent = summary.totalMsgs?.user ?? 0;
  $('#aMsgs').textContent = summary.totalMsgs?.assistant ?? 0;

  const ts = summary.earliestTs;
  $('#earliest').textContent = ts ? new Date(ts).toLocaleString() : '—';

  const bestSlot = summarizeHotSlot(summary.timeOfDay);
  $('#hotSlot').textContent = bestSlot || '—';

  const streaks = calcStreaks(summary.dayActive);
  $('#streakNow').textContent = streaks.now;
  $('#streakMax').textContent = streaks.max;

  $('#kw').textContent = summary.keywords?.length ? summary.keywords.join('、') : '';
  $('#monthGrid').textContent = Object.keys(summary.monthDailyChars || {}).length ? '[数据待渲染]' : '';
  $('#monthHint').textContent = '将以纯文本呈现';
}

function summarizeHotSlot(timeOfDay){
  if(!Array.isArray(timeOfDay) || !timeOfDay.length){ return ''; }
  const slots = ['0-3','3-6','6-9','9-12','12-15','15-18','18-21','21-24'];
  let bestIdx = 0;
  let bestVal = -Infinity;
  timeOfDay.forEach((val, idx)=>{
    if((val ?? 0) > bestVal){
      bestVal = val ?? 0;
      bestIdx = idx;
    }
  });
  if(bestVal <= 0){ return ''; }
  return slots[bestIdx] || '';
}

function calcStreaks(dayActive){
  if(!Array.isArray(dayActive) || !dayActive.length){
    return {now: '—', max: '—'};
  }
  const sortedDays = [...dayActive].sort();
  let nowStreak = 1;
  let maxStreak = 1;
  let currentStreak = 1;

  for(let i=1;i<sortedDays.length;i++){
    const prev = new Date(sortedDays[i-1]);
    const curr = new Date(sortedDays[i]);
    const diff = (curr - prev) / (1000*60*60*24);
    if(Math.abs(diff - 1) < 0.01){
      currentStreak += 1;
    } else {
      currentStreak = 1;
    }
    if(currentStreak > maxStreak){ maxStreak = currentStreak; }
  }

  // Determine current streak (ending today)
  const today = new Date();
  const last = new Date(sortedDays[sortedDays.length - 1]);
  const dayDiff = Math.floor((today.setHours(0,0,0,0) - last.setHours(0,0,0,0)) / (1000*60*60*24));
  if(dayDiff === 0){
    nowStreak = currentStreak;
  } else if(dayDiff === 1){
    nowStreak = currentStreak;
  } else {
    nowStreak = '—';
  }

  return {now: nowStreak, max: maxStreak};
}
