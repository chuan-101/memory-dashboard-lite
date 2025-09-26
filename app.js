const $ = (s)=>document.querySelector(s);
const LS = {user:'md_user_name', asst:'md_asst_name', theme:'md_theme'};
const defaults = {user:'Me', asst:'GPT', theme:'Echoes'};
let lastSummary = null;
let currentNames = {user: defaults.user, asst: defaults.asst};

const state = {
  file: null,
  worker: null
};

const downloadButton = $('#downloadCsv');

function spawnWorker(){
  if(state.worker){
    state.worker.terminate();
  }
  const cacheBust = `v=19&cache=${Date.now()}`;
  state.worker = new Worker(`./parser.worker.js?${cacheBust}`, {type:'module'});
  state.worker.onmessage = onWorkerMessage;
}

function startParse(){
  if(!state.file){
    $('#status').textContent = 'Please choose a JSON file first';
    return;
  }
  $('#status').textContent = 'Parsing…';
  spawnWorker();
  if(state.worker){
    setParsingState(true);
    setDownloadEnabled(false);
    state.worker.postMessage({type:'parse', file: state.file});
  }
}

function setParsingState(isParsing){
  document.body?.classList.toggle('is-parsing', Boolean(isParsing));
}

if(downloadButton){
  downloadButton.addEventListener('click', onDownloadCsv);
  setDownloadEnabled(Boolean(lastSummary));
}

function setDownloadEnabled(canDownload){
  if(downloadButton){
    downloadButton.disabled = !canDownload;
  }
}

const nameUserEl = $('#nameU');
const nameAssistantEl = $('#nameA');
const overviewMetrics = {
  user: buildOverviewMetric('#uChars', '#uMsgs'),
  assistant: buildOverviewMetric('#aChars', '#aMsgs')
};
const timeMetrics = setupTimeElements();
const streakMetrics = setupStreakElements();

// —— 读取与应用偏好
function loadPrefs(){
  return {
    user: localStorage.getItem(LS.user) || defaults.user,
    asst: localStorage.getItem(LS.asst) || defaults.asst,
    theme: localStorage.getItem(LS.theme) || defaults.theme
  };
}
function sanitizeName(s){ return (s||'').trim().slice(0,24).replace(/[<>]/g,''); }

function applyNames(p){
  $('#title').textContent = `Memory：${p.user}&${p.asst}`;
  if(nameUserEl){ nameUserEl.textContent = p.user; }
  if(nameAssistantEl){ nameAssistantEl.textContent = p.asst; }
  $('#nameU2').textContent = p.user; $('#nameA2').textContent = p.asst;
  $('#userName').value = p.user; $('#assistantName').value = p.asst;
  currentNames = {user: p.user, asst: p.asst};
  if(lastSummary){
    renderSummaryBasics(lastSummary);
  }
}
function applyTheme(theme){
  document.body.setAttribute('data-theme', theme);
  document.querySelectorAll('.theme').forEach(btn=>{
    btn.setAttribute('aria-pressed', btn.dataset.theme===theme ? 'true':'false');
  });
}

function buildOverviewMetric(charSelector, msgSelector){
  const chars = $(charSelector);
  const msgs = $(msgSelector);
  return {chars, msgs};
}

function setupTimeElements(){
  const earliest = $('#earliest');
  const hotSlot = $('#hotSlot');
  let detail = null;
  if(hotSlot){
    detail = document.createElement('div');
    detail.className = 'sub mono muted';
    hotSlot.insertAdjacentElement('afterend', detail);
  }
  return {earliest, hotSlot, detail};
}

function setupStreakElements(){
  const nowKpi = $('#streakNow');
  const maxKpi = $('#streakMax');
  const nowMetric = nowKpi ? nowKpi.closest('.metric') : null;
  const maxMetric = maxKpi ? maxKpi.closest('.metric') : null;
  const nowDetail = createStreakDetail(nowKpi);
  const maxDetail = createStreakDetail(maxKpi);
  return {
    now: {kpi: nowKpi, metric: nowMetric, detail: nowDetail},
    max: {kpi: maxKpi, metric: maxMetric, detail: maxDetail}
  };
}

function createStreakDetail(kpi){
  if(!kpi){ return null; }
  const detail = document.createElement('div');
  detail.className = 'sub mono muted';
  kpi.insertAdjacentElement('afterend', detail);
  return detail;
}

// —— 初始化
const prefs = loadPrefs();
applyNames(prefs); applyTheme(prefs.theme);

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

// —— 事件：主题按钮
document.querySelectorAll('.theme').forEach(btn=>{
  btn.onclick = ()=>{
    const t = btn.dataset.theme;
    localStorage.setItem(LS.theme, t);
    applyTheme(t);
  };
});

// —— 文件与预检（保持原有逻辑）
$('#file').onchange = (e)=>{
  state.file = e.target.files?.[0] || null;
  $('#status').textContent = state.file ? `已选择：${state.file.name}` : '未加载文件';
};

$('#runPrecheck').onclick = ()=>{
  if(!state.file){ $('#status').textContent = '请先选择 JSON 文件'; return; }
  $('#status').textContent = '预检中…';
  spawnWorker();
  if(state.worker){
    state.worker.postMessage({type:'precheck', file: state.file});
  }
};

function onWorkerMessage(e){
  const data = e.data || {};
  const {type} = data;
  if(type==='precheck'){
    const {ok, reason, hint} = data;
    $('#status').textContent = ok ? `预检通过：检测到 ChatGPT 导出结构${hint?`（${hint}）`:''}` : `预检失败：${reason || '未知原因'}`;
    if(ok){
      startParse();
      $('#status').textContent = '预检通过，开始解析…';
    }
  } else if(type==='progress'){
    const {pct = 0, loadedBytes = 0, totalBytes = 0} = data;
    const pctText = clampPct(pct);
    $('#status').textContent = `Parsing… ${pctText}% (${formatMB(loadedBytes)}/${formatMB(totalBytes)} MB)`;
  } else if(type==='done'){
    const {summary = null} = data;
    lastSummary = summary;
    if(typeof window !== 'undefined'){
      window.lastSummary = summary;
    }
    setDownloadEnabled(Boolean(summary));
    renderSummaryBasics(summary);
    let statusText = '解析完成';
    if(summary?.samplingNote === true){
      statusText += '（性能保护：基于抽样）';
    }
    $('#status').textContent = statusText;
    renderMonthlyTiles(summary);
    setParsingState(false);
  } else if(type==='error'){
    $('#status').textContent = data.message || '未知错误';
    setParsingState(false);
    setDownloadEnabled(Boolean(lastSummary));
  }
}

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
  renderOverviewMetrics(summary);
  renderTimeMetrics(summary);
  renderStreakMetrics(summary);
}

function renderOverviewMetrics(summary){
  const userData = summary ? {
    chars: Number(summary?.totalChars?.user ?? 0),
    msgs: Number(summary?.totalMsgs?.user ?? 0)
  } : null;
  const assistantData = summary ? {
    chars: Number(summary?.totalChars?.assistant ?? 0),
    msgs: Number(summary?.totalMsgs?.assistant ?? 0)
  } : null;
  updateOverviewMetric(overviewMetrics.user, userData);
  updateOverviewMetric(overviewMetrics.assistant, assistantData);
}

function updateOverviewMetric(target, data){
  if(!target?.chars || !target?.msgs){ return; }
  if(!data){
    target.chars.textContent = '—';
    target.msgs.textContent = '—';
    return;
  }
  const charText = formatCount(data.chars);
  const msgText = formatCount(data.msgs);
  target.chars.textContent = `${charText} 字`;
  target.msgs.textContent = `${msgText} 条`;
}

function renderTimeMetrics(summary){
  const earliestInfo = summary ? formatEarliestLines(summary?.earliestTs) : null;
  updateEarliest(earliestInfo);
  const hotSlotInfo = summary ? summarizeHotSlot(summary?.timeOfDay) : null;
  updateHotSlot(hotSlotInfo);
}

function updateEarliest(info){
  const target = timeMetrics.earliest;
  if(!target){ return; }
  if(!info){
    target.textContent = '—';
    return;
  }
  const {dateLine, timeLine} = info;
  if(dateLine && timeLine){
    target.innerHTML = `${dateLine}<br>${timeLine}`;
  }else if(dateLine){
    target.textContent = dateLine;
  }else{
    target.textContent = '—';
  }
}

function updateHotSlot(info){
  const target = timeMetrics.hotSlot;
  if(!target){ return; }
  if(!info){
    target.textContent = '—';
    if(timeMetrics.detail){ timeMetrics.detail.textContent = ''; }
    return;
  }
  target.textContent = info.range || info.start || '—';
  if(timeMetrics.detail){
    if(Number.isFinite(info.count) && info.count > 0){
      timeMetrics.detail.textContent = `· ${formatCount(info.count)} 条`;
    }else{
      timeMetrics.detail.textContent = '';
    }
  }
}

function renderStreakMetrics(summary){
  const streaks = summary ? calcStreaks(summary?.dayActive) : {now:null, max:null};
  const nowRun = streaks?.now || null;
  const maxRun = streaks?.max || null;
  const same = streakRunsEqual(nowRun, maxRun);
  updateStreakMetric(streakMetrics.now, nowRun);
  if(streakMetrics.max?.metric){
    streakMetrics.max.metric.style.display = same ? 'none' : '';
  }
  if(same){
    updateStreakMetric(streakMetrics.max, null);
  }else{
    updateStreakMetric(streakMetrics.max, maxRun);
  }
}

function updateStreakMetric(target, data){
  if(!target?.kpi){ return; }
  if(!data){
    target.kpi.textContent = '—';
    if(target.detail){ target.detail.textContent = ''; }
    return;
  }
  target.kpi.textContent = `${formatCount(data.length)} 天`;
  if(target.detail){
    const start = formatLocalDate(data.start);
    const end = formatLocalDate(data.end);
    target.detail.textContent = start && end ? `${start} → ${end}` : '';
  }
}

function streakRunsEqual(a, b){
  if(!a || !b){ return false; }
  return a.length === b.length && a.start === b.start && a.end === b.end;
}

function formatEarliestLines(ts){
  if(ts === undefined || ts === null){ return null; }
  const dt = new Date(ts);
  if(Number.isNaN(dt.getTime())){ return null; }
  const dateLine = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const normalized = new Date(dt.getTime());
  normalized.setMinutes(0, 0, 0);
  const timeLine = `${String(normalized.getHours()).padStart(2, '0')}:${String(normalized.getMinutes()).padStart(2, '0')}`;
  return {dateLine, timeLine};
}

function formatLocalDate(dateStr){
  if(!dateStr){ return ''; }
  const parts = dateStr.split('-').map(part => Number(part));
  if(parts.length !== 3 || parts.some(part => !Number.isFinite(part))){
    return dateStr.replaceAll('/', '-');
  }
  const [year, month, day] = parts;
  const dt = new Date(year, month - 1, day);
  if(Number.isNaN(dt.getTime())){ return dateStr; }
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function summarizeHotSlot(timeOfDay){
  if(!Array.isArray(timeOfDay) || timeOfDay.length !== 8){ return null; }
  const values = timeOfDay.map(v => Number(v) || 0);
  const maxVal = Math.max(...values);
  if(maxVal <= 0){ return null; }
  const tzOffsetMinutes = -new Date().getTimezoneOffset();
  const slots = values
    .map((val, idx) => ({ val, idx }))
    .filter(item => item.val === maxVal)
    .map(item => {
      const utcStartMin = item.idx * 180;
      const localStartMin = (utcStartMin + tzOffsetMinutes + 1440) % 1440;
      return {
        start: formatHourMinute(localStartMin),
        range: formatSlotRange(localStartMin),
        count: Math.round(maxVal)
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
  if(!slots.length){ return null; }
  const primary = slots[0];
  const rangeLabel = slots.length > 1 ? slots.map(slot => slot.range).join('、') : primary.range;
  return {
    start: primary.start,
    range: rangeLabel,
    count: Math.round(maxVal)
  };
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
    return {now: null, max: null};
  }
  const uniqueSorted = Array.from(new Set(dayActive)).sort();
  if(!uniqueSorted.length){
    return {now: null, max: null};
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
    now: normalizeRun(currentRun),
    max: normalizeRun(maxRun)
  };
}

function normalizeRun(run){
  if(!run){ return null; }
  return {
    start: run.start,
    end: run.end,
    length: run.length
  };
}

function renderMonthlyTiles(summary){
  const container = $('#monthGrid');
  if(!container){ return; }

  const monthDailyChars = summary?.monthDailyChars || {};
  console.log('[monthly] tiles render', Object.keys(monthDailyChars).length);

  if(!summary){
    container.innerHTML = '';
    return;
  }

  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const months = [];
  for(let i = 0; i < 3; i += 1){
    months.push(new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - i, 1));
  }

  const fragment = document.createDocumentFragment();

  months.forEach(monthDate => {
    const year = monthDate.getFullYear();
    const monthIndex = monthDate.getMonth();
    const monthKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const firstDay = new Date(year, monthIndex, 1);
    const totalDays = new Date(year, monthIndex + 1, 0).getDate();
    const offset = (firstDay.getDay() + 6) % 7;

    const monthSection = document.createElement('section');
    monthSection.className = 'month';

    const titleEl = document.createElement('div');
    titleEl.className = 'month-title';
    titleEl.textContent = monthKey;
    monthSection.appendChild(titleEl);

    const dowEl = document.createElement('div');
    dowEl.className = 'dow month-grid';
    weekdayLabels.forEach(label => {
      const cell = document.createElement('div');
      cell.textContent = label;
      dowEl.appendChild(cell);
    });
    monthSection.appendChild(dowEl);

    const monthGrid = document.createElement('div');
    monthGrid.className = 'month-grid';

    for(let i = 0; i < offset; i += 1){
      const emptyCell = document.createElement('div');
      emptyCell.className = 'day empty';
      monthGrid.appendChild(emptyCell);
    }

    for(let day = 1; day <= totalDays; day += 1){
      const dayKey = `${monthKey}-${String(day).padStart(2, '0')}`;
      let safeCount = Number(monthDailyChars?.[dayKey]);
      if(!Number.isFinite(safeCount)){
        safeCount = 0;
      }else{
        safeCount = Math.trunc(safeCount);
      }

      const dayEl = document.createElement('div');
      dayEl.className = 'day';
      if(safeCount <= 0){
        dayEl.classList.add('zero');
      }

      const dayNumber = document.createElement('div');
      dayNumber.className = 'd';
      dayNumber.textContent = String(day);
      dayEl.appendChild(dayNumber);

      const countEl = document.createElement('div');
      countEl.className = 'cnt';
      countEl.textContent = formatCount(safeCount);
      dayEl.appendChild(countEl);

      monthGrid.appendChild(dayEl);
    }

    while(monthGrid.children.length % 7 !== 0){
      const emptyCell = document.createElement('div');
      emptyCell.className = 'day empty';
      monthGrid.appendChild(emptyCell);
    }

    monthSection.appendChild(monthGrid);
    fragment.appendChild(monthSection);
  });

  container.innerHTML = '';
  container.appendChild(fragment);
}

function onDownloadCsv(){
  if(!lastSummary){ return; }
  const names = currentNames || defaults;
  const summaryCsv = buildSummaryCsv(lastSummary, names);
  const dailyCsv = buildDailyCharsCsv(lastSummary);
  triggerCsvDownload('summary.csv', summaryCsv);
  triggerCsvDownload('daily_chars_recent3m.csv', dailyCsv);
}

function buildSummaryCsv(summary, names){
  const userName = ensureName(names?.user, defaults.user);
  const assistantName = ensureName(names?.asst, defaults.asst);
  const headers = [
    `${userName} chars`,
    `${userName} msgs`,
    `${assistantName} chars`,
    `${assistantName} msgs`,
    'earliest_local (YYYY-MM-DD HH:mm)',
    'hot_time_slots_local',
    'hot_time_count',
    'current_streak_days',
    'current_streak_start',
    'current_streak_end',
    'max_streak_days',
    'max_streak_start',
    'max_streak_end'
  ];

  const earliestLocal = formatEarliestLocal(summary?.earliestTs);
  const hotDetails = getHotSlotDetails(summary?.timeOfDay);
  const streaks = calcStreaks(summary?.dayActive);
  const currentRun = streaks?.now || null;
  const maxRun = streaks?.max || null;

  const values = [
    toSafeInteger(summary?.totalChars?.user),
    toSafeInteger(summary?.totalMsgs?.user),
    toSafeInteger(summary?.totalChars?.assistant),
    toSafeInteger(summary?.totalMsgs?.assistant),
    earliestLocal,
    hotDetails.ranges.join(', '),
    hotDetails.count,
    currentRun?.length || 0,
    formatDateForCsv(currentRun?.start),
    formatDateForCsv(currentRun?.end),
    maxRun?.length || 0,
    formatDateForCsv(maxRun?.start),
    formatDateForCsv(maxRun?.end)
  ];

  return `${toCsvLine(headers)}\n${toCsvLine(values)}\n`;
}

function formatEarliestLocal(ts){
  if(ts === undefined || ts === null){ return ''; }
  const dt = new Date(ts);
  if(Number.isNaN(dt.getTime())){ return ''; }
  dt.setMinutes(0, 0, 0);
  const year = dt.getFullYear();
  const month = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  const hour = String(dt.getHours()).padStart(2, '0');
  const minute = String(dt.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function getHotSlotDetails(timeOfDay){
  if(!Array.isArray(timeOfDay) || timeOfDay.length !== 8){
    return {ranges: [], count: 0};
  }
  const values = timeOfDay.map(v => Number(v) || 0);
  const maxVal = Math.max(...values);
  if(maxVal <= 0){
    return {ranges: [], count: 0};
  }
  const tzOffsetMinutes = -new Date().getTimezoneOffset();
  const ranges = values
    .map((val, idx) => ({val, idx}))
    .filter(item => item.val === maxVal)
    .map(item => {
      const utcStartMin = item.idx * 180;
      const localStartMin = (utcStartMin + tzOffsetMinutes + 1440) % 1440;
      return {start: localStartMin, label: formatSlotRange(localStartMin)};
    })
    .sort((a, b) => a.start - b.start)
    .map(item => item.label);
  return {ranges, count: Math.round(maxVal)};
}

function formatDateForCsv(dateStr){
  if(!dateStr){ return ''; }
  return formatLocalDate(dateStr);
}

function buildDailyCharsCsv(summary){
  const monthDailyChars = summary?.monthDailyChars || {};
  const dates = Object.keys(monthDailyChars).sort();
  const lines = dates.map(date => {
    const chars = toSafeInteger(monthDailyChars[date]);
    return toCsvLine([date, chars]);
  });
  const header = toCsvLine(['date', 'chars']);
  return [header, ...lines].join('\n') + '\n';
}

function toCsvLine(values){
  return values.map(escapeCsvValue).join(',');
}

function escapeCsvValue(value){
  if(value === null || value === undefined){ return ''; }
  const str = String(value);
  if(str.includes('"') || str.includes(',') || str.includes('\n')){
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toSafeInteger(value){
  const num = Number(value);
  if(!Number.isFinite(num)){ return 0; }
  return Math.round(num);
}

function ensureName(name, fallback){
  const str = typeof name === 'string' ? name.trim() : '';
  return str || fallback;
}

function triggerCsvDownload(filename, content){
  try{
    const blob = new Blob([content], {type: 'text/csv;charset=utf-8;'});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(()=>{
      URL.revokeObjectURL(link.href);
      link.remove();
    }, 0);
  }catch(err){
    console.error('CSV download failed', err);
  }
}
