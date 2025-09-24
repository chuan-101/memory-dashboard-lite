const $ = (s)=>document.querySelector(s);
const LS_KEYS = {user:'md_user_name', asst:'md_asst_name', filter:'md_filter_mode'};
const defaults = {user:'Me', asst:'GPT', filter:'simple'};

function loadPrefs(){
  return {
    user: localStorage.getItem(LS_KEYS.user) || defaults.user,
    asst: localStorage.getItem(LS_KEYS.asst) || defaults.asst,
    filter: localStorage.getItem(LS_KEYS.filter) || defaults.filter
  };
}
function applyNames(p){
  $('#title').textContent = `Memory：${p.user}&${p.asst}`;
  $('#nameU').textContent = p.user; $('#nameA').textContent = p.asst;
  $('#nameU2').textContent = p.user; $('#nameA2').textContent = p.asst;
  $('#userName').value = p.user; $('#assistantName').value = p.asst;
}
function applyFilter(p){
  document.querySelectorAll('input[name="filter"]').forEach(r=>r.checked = (r.value===p.filter));
  $('#modeText').textContent = p.filter==='simple' ? '简单过滤' : '深度过滤';
}
function sanitizeName(s){
  return (s||'').trim().slice(0,24).replace(/[<>]/g,'');
}

const prefs = loadPrefs();
applyNames(prefs); applyFilter(prefs);

$('#saveNames').onclick = ()=>{
  const u = sanitizeName($('#userName').value) || defaults.user;
  const a = sanitizeName($('#assistantName').value) || defaults.asst;
  localStorage.setItem(LS_KEYS.user, u);
  localStorage.setItem(LS_KEYS.asst, a);
  applyNames({user:u, asst:a, filter: prefs.filter});
};
$('#resetNames').onclick = ()=>{
  localStorage.removeItem(LS_KEYS.user); localStorage.removeItem(LS_KEYS.asst);
  applyNames(defaults);
};
document.querySelectorAll('input[name="filter"]').forEach(r=>{
  r.onchange = ()=>{
    localStorage.setItem(LS_KEYS.filter, r.value);
    applyFilter({filter:r.value});
  };
});

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
    if(ok){
      $('#status').textContent = `预检通过：检测到 ChatGPT 导出结构${hint?`（${hint}）`:''}`;
    }else{
      $('#status').textContent = `预检失败：${reason || '未知原因'}`;
    }
  }
};
