self.onmessage = async (e) => {
  const { type, file } = e.data || {};
  if (type === 'precheck') return precheck(file);
  if (type === 'parse')    return streamOnly(file);
};

async function precheck(file){
  try{
    const chunk = await file.slice(0, 1024 * 1024).text();
    const looksMapping  = /"mapping"\s*:\s*\{/.test(chunk) && /"message"\s*:\s*\{/.test(chunk);
    const looksMessages = /"messages"\s*:\s*\[/.test(chunk);
    postMessage({ type:'precheck', ok:(looksMapping || looksMessages),
      hint: looksMapping ? 'mapping/message' : (looksMessages ? 'messages[]' : '') });
  }catch(err){
    postMessage({ type:'precheck', ok:false, reason:String(err?.message||err) });
  }
}

async function streamOnly(file){
  let reader;
  let summary = null;
  let errorPosted = false;
  const startTime = performance.now();
  try{
    reader = file.stream().getReader();
    const td = new TextDecoder();
    const chunks = [];
    let loaded = 0;
    let lastTick = 0;
    let done = false;
    let readError = null;

    while(!done){
      let readResult;
      try{
        readResult = await reader.read();
      }catch(loopErr){
        readError = loopErr;
        break;
      }

      const { value, done: d } = readResult;
      done = d;
      if (value){
        const text = td.decode(value, {stream:true});
        if(text){ chunks.push(text); }
        loaded += value.byteLength;
        const now = performance.now();
        if (now - lastTick > 500){
          const pctRaw = file.size > 0 ? Math.floor((loaded * 100) / file.size) : 100;
          postMessage({
            type:'progress',
            loadedBytes: loaded,
            totalBytes: file.size,
            pct: Math.min(99, pctRaw)
          });
          lastTick = now;
        }
      }
    }

    if(readError){
      errorPosted = true;
      postMessage({ type:'error', message:String(readError?.message||readError) });
    }else{
      const flush = td.decode();
      if(flush){ chunks.push(flush); }

      const text = chunks.join('');
      const raw = JSON.parse(text);
      const parseDurationMs = performance.now() - startTime;
      summary = summarizeFile(raw, { fileSize: file.size, parseDurationMs });
    }
  }catch(err){
    if(!errorPosted){
      postMessage({ type:'error', message:String(err?.message||err) });
      errorPosted = true;
    }
  }finally{
    try{
      reader?.releaseLock?.();
    }catch(_err){ /* ignore */ }
    postMessage({ type:'done', summary });
  }
}

function summarizeFile(raw, {fileSize, parseDurationMs}){
  const summary = {
    totalChars:{user:0,assistant:0},
    totalMsgs:{user:0,assistant:0},
    earliestTs:null,
    timeOfDay:new Array(8).fill(0),
    dayActive:[],
    monthDailyChars:{},
    samplingNote:false
  };

  const counted = new WeakSet();
  const daySet = new Set();
  const monthDailyCounts = new Map();

  const handleMessage = (msg)=>{
    if(!msg || typeof msg !== 'object') return false;
    if(counted.has(msg)) return false;
    counted.add(msg);

    const role = normalizeRole(msg);
    if(!role){
      return true;
    }

    const visibleText = extractContent(msg);
    const ts = extractTimestamp(msg);

    if(role === 'user' || role === 'assistant'){
      const bucket = role === 'user' ? 'user' : 'assistant';
      summary.totalMsgs[bucket] += 1;
      summary.totalChars[bucket] += visibleText.length;

      if(ts != null){
        if(summary.earliestTs == null || ts < summary.earliestTs){
          summary.earliestTs = ts;
        }
        const date = new Date(ts);
        const slot = Math.min(7, Math.max(0, Math.floor(date.getUTCHours() / 3)));
        summary.timeOfDay[slot] = (summary.timeOfDay[slot] ?? 0) + 1;
        const dayKey = formatLocalDate(date);
        daySet.add(dayKey);
        const existing = monthDailyCounts.get(dayKey) || 0;
        monthDailyCounts.set(dayKey, existing + visibleText.length);
      }
    }
    return true;
  };

  const processNode = (node)=>{
    parseMapping(node, handleMessage);
    parseMessagesArray(node, handleMessage);
    fallbackScan(node, handleMessage);
  };

  if(Array.isArray(raw?.conversations)){
    for(const convo of raw.conversations){
      processNode(convo);
    }
  }else{
    processNode(raw);
  }

  summary.dayActive = Array.from(daySet).sort();

  const monthWindow = computeMonthWindowBounds();
  const samplingBySize = fileSize > 50*1024*1024;
  const samplingByTime = typeof parseDurationMs === 'number' && parseDurationMs > 5000;
  summary.samplingNote = samplingBySize || samplingByTime;

  const monthDailyEntries = Array.from(monthDailyCounts.entries());
  if(summary.samplingNote){
    const filtered = {};
    for (const [dayKey, count] of monthDailyEntries){
      if(isWithinMonthWindow(dayKey, monthWindow.allowedMonths)){
        filtered[dayKey] = count;
      }
    }
    summary.monthDailyChars = filtered;
  }else{
    const full = {};
    for (const [dayKey, count] of monthDailyEntries){
      full[dayKey] = count;
    }
    summary.monthDailyChars = full;
  }

  return summary;
}

function computeMonthWindowBounds(){
  const now = new Date();
  const allowedMonths = new Set();
  for(let offset = 0; offset < 3; offset += 1){
    const point = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const key = `${point.getFullYear()}-${String(point.getMonth() + 1).padStart(2, '0')}`;
    allowedMonths.add(key);
  }
  return { allowedMonths };
}

function isWithinMonthWindow(dayKey, allowedMonths){
  if(!dayKey) return false;
  const monthKey = dayKey.slice(0, 7);
  return allowedMonths.has(monthKey);
}

function formatLocalDate(date){
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseMapping(raw, handle){
  if(!raw || typeof raw !== 'object') return false;
  const { mapping } = raw;
  if(!mapping || typeof mapping !== 'object') return false;
  let hit = false;
  for (const key of Object.keys(mapping)){
    const node = mapping[key];
    if(node && typeof node === 'object'){
      if(node.message){
        hit = true;
        handle(node.message);
      }
    }
  }
  return hit;
}

function parseMessagesArray(raw, handle){
  if(!raw || typeof raw !== 'object') return false;
  const { messages } = raw;
  if(!Array.isArray(messages) || messages.length === 0) return false;
  let hit = false;
  for (const message of messages){
    if(message && typeof message === 'object'){
      hit = true;
      handle(message);
    }
  }
  return hit;
}

function fallbackScan(value, handle){
  if(!value || typeof value !== 'object') return false;
  let hit = false;
  if(Array.isArray(value)){
    for(const item of value){
      if(fallbackScan(item, handle)) hit = true;
    }
    return hit;
  }

  const keys = Object.keys(value);
  const hasRole = keys.includes('role') || keys.includes('author');
  const hasContent = keys.includes('content') || keys.includes('parts');
  if(hasRole && hasContent){
    if(handle(value)) hit = true;
  }

  for (const key of keys){
    if(fallbackScan(value[key], handle)) hit = true;
  }
  return hit;
}

function normalizeRole(msg){
  const rawRole = firstString([
    msg?.role,
    msg?.author?.role,
    msg?.author
  ]);
  if(!rawRole) return null;
  const lower = rawRole.toLowerCase();
  if(lower === 'user' || lower === 'human') return 'user';
  if(lower === 'assistant' || lower === 'gpt' || lower === 'chatgpt' || lower === 'model') return 'assistant';
  if(lower === 'system') return 'system';
  return null;
}

function extractContent(msg){
  const texts = [];

  const pushText = (val)=>{
    if(typeof val === 'string' && val){ texts.push(val); }
  };

  const { content, parts } = msg || {};

  if(typeof content === 'string'){
    pushText(content);
  }else if(Array.isArray(content)){
    for (const part of content){
      if(typeof part === 'string'){
        pushText(part);
      }else if(part && typeof part === 'object'){
        if(typeof part.text === 'string'){
          pushText(part.text);
        }else if(part.type === 'text'){
          if(typeof part.text === 'string'){
            pushText(part.text);
          }else if(part.text && typeof part.text.value === 'string'){
            pushText(part.text.value);
          }
        }
      }
    }
  }

  if(Array.isArray(parts)){
    for (const part of parts){
      if(typeof part === 'string'){
        pushText(part);
      }else if(part && typeof part === 'object' && typeof part.text === 'string'){
        pushText(part.text);
      }
    }
  }

  if(texts.length === 0 && content && typeof content === 'object'){
    const maybeText = content.text;
    if(typeof maybeText === 'string'){
      pushText(maybeText);
    }else if(maybeText && typeof maybeText.value === 'string'){
      pushText(maybeText.value);
    }
    if(Array.isArray(content.parts)){
      for (const part of content.parts){
        if(typeof part === 'string'){
          pushText(part);
        }else if(part && typeof part === 'object'){
          if(typeof part.text === 'string'){
            pushText(part.text);
          }else if(part.text && typeof part.text.value === 'string'){
            pushText(part.text.value);
          }
        }
      }
    }
  }

  return texts.join('\n');
}

function extractTimestamp(msg){
  const sources = [
    msg?.create_time,
    msg?.created_at,
    msg?.timestamp,
    msg?.metadata?.create_time
  ];
  for(const source of sources){
    const ts = parseTimestamp(source);
    if(ts != null) return ts;
  }
  return null;
}

function parseTimestamp(val){
  if(val == null) return null;
  if(typeof val === 'number'){
    if(val > 1e12) return val;
    if(val > 1e3) return Math.floor(val * 1000);
    return Math.floor(val * 1000);
  }
  if(typeof val === 'string'){
    const num = Number(val);
    if(Number.isFinite(num)){
      return parseTimestamp(num);
    }
    const parsed = Date.parse(val);
    if(!Number.isNaN(parsed)) return parsed;
    return null;
  }
  if(typeof val === 'object'){
    if(val && typeof val.value === 'number'){
      return parseTimestamp(val.value);
    }
    if(val && typeof val.value === 'string'){
      return parseTimestamp(val.value);
    }
  }
  return null;
}

function firstString(candidates){
  for (const candidate of candidates){
    if(typeof candidate === 'string' && candidate.trim()){
      return candidate.trim();
    }
  }
  return null;
}
