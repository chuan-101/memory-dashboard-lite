importScripts('./vendor/clarinet.min.js');

self.onmessage = async (e) => {
  const { type, file, mode = 'simple' } = e.data || {};
  try {
    if (type === 'precheck') {
      return await precheck(file);
    }
    if (type === 'parse') {
      return await streamAndParse(file, mode);
    }
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.message || err) });
  }
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

async function streamAndParse(file, mode){
  try{
    const summary = await parseFile(file, mode);
    postMessage({ type:'done', summary });
  }catch(err){
    postMessage({ type:'error', message:String(err?.message||err) });
  }
}

async function parseFile(file, mode){
  if(!file){
    throw new Error('No file provided');
  }

  const totalBytes = file.size || 0;
  const chunkSize = 2 * 1024 * 1024; // ~2MB slices
  const td = new TextDecoder();
  const parser = clarinet.parser();

  const counts = { user: 0, assistant: 0 };
  let earliestTs = null;
  let messageFound = false;
  let parseError = null;

  const stack = [];
  let path = [];
  let pendingKey = null;
  const messageStack = [];

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let loaded = 0;
  let lastTick = 0;

  parser.onerror = (err) => {
    if(!parseError){
      parseError = err instanceof Error ? err : new Error(String(err));
    }
  };

  parser.onopenobject = (key) => {
    const segment = enterValue();
    const ctx = { type:'object', segment, messageCtx:null };
    const isMessage = isMessageContainer(path);
    if(isMessage){
      messageFound = true;
      ctx.messageCtx = { role:null, timestamp:null, path: path.slice() };
      messageStack.push(ctx.messageCtx);
    }
    stack.push(ctx);
    if(key !== undefined){
      pendingKey = key;
    }
  };

  parser.oncloseobject = () => {
    const ctx = stack.pop();
    if(ctx?.messageCtx){
      finalizeMessage(ctx.messageCtx);
      if(messageStack.length && messageStack[messageStack.length - 1] === ctx.messageCtx){
        messageStack.pop();
      }else{
        const idx = messageStack.indexOf(ctx.messageCtx);
        if(idx >= 0){ messageStack.splice(idx, 1); }
      }
    }
    if(ctx && ctx.segment !== null){
      path.pop();
    }
  };

  parser.onopenarray = () => {
    const segment = enterValue();
    stack.push({ type:'array', segment });
  };

  parser.onclosearray = () => {
    const ctx = stack.pop();
    if(ctx && ctx.segment !== null){
      path.pop();
    }
  };

  parser.onkey = (key) => {
    pendingKey = key;
  };

  parser.onvalue = (value) => {
    const segment = enterValue();
    if(messageStack.length){
      const msgCtx = messageStack[messageStack.length - 1];
      if(isWithinMessage(path, msgCtx.path)){
        const relative = path.slice(msgCtx.path.length);
        captureMessageField(msgCtx, relative, value);
      }
    }
    if(segment !== null){
      path.pop();
    }
  };

  function enterValue(){
    let segment = null;
    if(stack.length){
      const parent = stack[stack.length - 1];
      if(parent.type === 'array'){
        segment = '#';
      }else if(parent.type === 'object'){
        segment = pendingKey;
        pendingKey = null;
      }
    }
    if(segment !== null && segment !== undefined){
      path.push(segment);
    }
    return segment;
  }

  function isMessageContainer(currentPath){
    if(currentPath.length >= 3 && currentPath[currentPath.length - 1] === 'message' && currentPath[currentPath.length - 3] === 'mapping'){
      return true;
    }
    if(currentPath.length >= 2 && currentPath[currentPath.length - 2] === 'messages' && currentPath[currentPath.length - 1] === '#'){
      return true;
    }
    return false;
  }

  function isWithinMessage(currentPath, basePath){
    if(currentPath.length < basePath.length){ return false; }
    for(let i=0;i<basePath.length;i++){
      if(currentPath[i] !== basePath[i]){
        return false;
      }
    }
    return true;
  }

  function captureMessageField(msgCtx, relativePath, value){
    if(!relativePath.length){ return; }
    const [head, second] = relativePath;

    if(head === 'author' && relativePath.length === 1){
      const role = normalizeRole(value);
      if(role){ msgCtx.role = role; }
      return;
    }
    if(head === 'author' && second === 'role'){
      const role = normalizeRole(value);
      if(role){ msgCtx.role = role; }
      return;
    }
    if(head === 'role' && relativePath.length === 1){
      const role = normalizeRole(value);
      if(role){ msgCtx.role = role; }
      return;
    }

    if(head === 'create_time' && relativePath.length === 1){
      const ts = normalizeTimestamp(value);
      if(ts !== null){ msgCtx.timestamp = earliest(ts, msgCtx.timestamp); }
      return;
    }
    if(head === 'created_at' && relativePath.length === 1){
      const ts = normalizeTimestamp(value);
      if(ts !== null){ msgCtx.timestamp = earliest(ts, msgCtx.timestamp); }
      return;
    }
    if(head === 'timestamp' && relativePath.length === 1){
      const ts = normalizeTimestamp(value);
      if(ts !== null){ msgCtx.timestamp = earliest(ts, msgCtx.timestamp); }
      return;
    }
    if(head === 'metadata' && second === 'create_time'){
      const ts = normalizeTimestamp(value);
      if(ts !== null){ msgCtx.timestamp = earliest(ts, msgCtx.timestamp); }
    }
  }

  function earliest(nextTs, current){
    if(current === null || nextTs < current){
      return nextTs;
    }
    return current;
  }

  function finalizeMessage(msgCtx){
    const role = msgCtx.role;
    if(role === 'user' || role === 'assistant'){
      counts[role] += 1;
      if(msgCtx.timestamp !== null){
        if(earliestTs === null || msgCtx.timestamp < earliestTs){
          earliestTs = msgCtx.timestamp;
        }
      }
    }
  }

  const total = totalBytes || 1;
  let offset = 0;
  while(offset < totalBytes){
    const end = Math.min(offset + chunkSize, totalBytes);
    const buf = await file.slice(offset, end).arrayBuffer();
    offset = end;
    const chunk = new Uint8Array(buf);
    loaded += chunk.byteLength;
    const text = td.decode(chunk, { stream: true });
    if(text){ parser.write(text); }
    if(parseError){ throw parseError; }

    const currentTime = now();
    if(currentTime - lastTick > 500){
      postMessage({
        type:'progress',
        loadedBytes: loaded,
        totalBytes,
        pct: Math.min(99, Math.floor((loaded / total) * 100))
      });
      lastTick = currentTime;
    }
  }

  const remainder = td.decode();
  if(remainder){ parser.write(remainder); }
  parser.close();
  if(parseError){ throw parseError; }

  if(totalBytes){
    postMessage({
      type:'progress',
      loadedBytes: totalBytes,
      totalBytes,
      pct: 100
    });
  }

  if(!messageFound){
    throw new Error('Unrecognized ChatGPT export format');
  }

  const summary = {
    totalChars:{user:0,assistant:0},
    totalMsgs:{ user: counts.user, assistant: counts.assistant },
    earliestTs: earliestTs === null ? null : Math.floor(earliestTs),
    timeOfDay:new Array(8).fill(0),
    dayActive:[],
    monthDailyChars:{},
    keywords:[],
    samplingNote: totalBytes > 50*1024*1024,
    mode
  };

  return summary;

}

function normalizeRole(value){
  if(typeof value === 'string'){
    const role = value.trim().toLowerCase();
    if(role === 'user' || role === 'assistant'){
      return role;
    }
  }
  return null;
}

function normalizeTimestamp(value){
  if(value === null || value === undefined){ return null; }
  if(typeof value === 'number'){
    if(!Number.isFinite(value)){ return null; }
    const abs = Math.abs(value);
    if(abs === 0){ return 0; }
    return abs < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
  }
  if(typeof value === 'string'){
    const trimmed = value.trim();
    if(!trimmed){ return null; }
    const num = Number(trimmed);
    if(!Number.isNaN(num)){
      return normalizeTimestamp(num);
    }
    const ms = Date.parse(trimmed);
    if(!Number.isNaN(ms)){
      return ms;
    }
  }
  return null;
}
