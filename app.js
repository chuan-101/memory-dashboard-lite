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
  const {type, ok, reason, hint} = e.data || {};
  if(type==='precheck'){
    $('#status').textContent = ok ? `预检通过：检测到 ChatGPT 导出结构${hint?`（${hint}）`:''}` : `预检失败：${reason || '未知原因'}`;
  }
};
