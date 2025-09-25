importScripts('./vendor/clarinet.min.js');

const RECENT_DAY_MSG_LIMIT = 200;
const RECENT_TEXT_CHAR_LIMIT = 5 * 1024 * 1024; // approximate char cap for sampling

const WORD_REGEX = /\b[\p{L}\p{N}_]+\b/gu;
const REPEATED_CHAR_REGEX = /(.)\1{1,}/gu;

const BASE_STOPWORDS = new Set([
  'a','an','and','are','as','at','be','but','by','can','could','did','do','does','done','doing',
  'for','from','had','has','have','having','here','how','if','in','into','is','it','its','just',
  'like','may','might','more','most','not','of','on','or','our','out','over','so','some','than',
  'that','the','their','them','then','there','these','they','this','those','to','up','very','was',
  'we','were','what','when','where','which','who','why','will','with','would','you','your','yours',
  'i','me','my','mine','ours','us','hers','his','him','her','she','he','itself','yourself','yall',
  'hey','hi','thanks','thank','okay','ok','yeah','yep','nope','yes','no','please','also','been',
  'because','about','again','once','ever','each','either','neither','both','between','through',
  'against','while','before','after','during','below','above','under','until','within','without',
  'didnt','dont','cant','wont','im','youre','theyre','theyll','ill','weve','ive'
]);

const CN_STOPWORDS = new Set([
  '我们','你们','他们','然后','这个','那个','一下','而且','但是','因为','所以','如果','以及','不是','没有',
  '就是','怎么','可以','需要','应该','还有','或者','以及','并且','还是','觉得','可能','已经','这些','那些',
  '有关','关于','为了','因此','其中','的话','那么','的话','的话题'
]);

const DEEP_FILLERS = new Set(['一下','这个','然后','我你','你我']);

const TEXTUAL_TYPES = new Set([
  'text','input_text','output_text','message','assistant_message','user_message','plain_text',
  'thought','reasoning','explanation','response','markdown','rich_text','text_response','note'
]);

const EXCLUDED_SEGMENTS = new Set([
  'metadata','annotations','citation','citations','attachments','files','file','code','language',
  'asset','assets','images','image','additional_kwargs','tool_calls','tool_results','tool_response'
]);

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
  const totalChars = { user: 0, assistant: 0 };
  const timeOfDay = new Array(8).fill(0);
  const dayActive = new Set();
  const monthDailyChars = new Map();
  const recentDayCounts = new Map();
  let totalRecentCharsCounted = 0;
  let earliestTs = null;
  let messageFound = false;
  let parseError = null;

  const recentWindowMonths = buildRecentWindowMonths();
  const keywordTracker = createKeywordTracker(200);

  const stack = [];
  let path = [];
  let pendingKey = null;
  const messageStack = [];

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const parseStart = now();
  let sampling = totalBytes > 50 * 1024 * 1024;
  let samplingUsed = sampling;
  let loaded = 0;
  let lastTick = 0;
  let sinceLastProgressBytes = 0;

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
      ctx.messageCtx = {
        role:null,
        timestamp:null,
        path: path.slice(),
        textChunks:[],
        textLength:0,
        typeHints:new Map()
      };
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
    const last = relativePath[relativePath.length - 1];

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
      return;
    }

    if(typeof value === 'string'){
      if(last === 'type' || last === 'content_type' || last === 'mime_type' || last === 'media_type'){
        setTypeHint(msgCtx, relativePath, value);
      }
      if(shouldCaptureText(relativePath)){
        if(value && isTextualValue(msgCtx, relativePath)){
          msgCtx.textChunks.push(value);
          msgCtx.textLength += value.length;
        }
      }
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
    if(role !== 'user' && role !== 'assistant'){ return; }

    counts[role] += 1;

    let localDayInfo = null;
    if(msgCtx.timestamp !== null){
      if(earliestTs === null || msgCtx.timestamp < earliestTs){
        earliestTs = msgCtx.timestamp;
      }
      const date = new Date(msgCtx.timestamp);
      const hour = date.getUTCHours();
      if(!Number.isNaN(hour)){
        const bucket = Math.max(0, Math.min(7, Math.floor(hour / 3)));
        timeOfDay[bucket] += 1;
      }
      localDayInfo = toLocalDay(date);
      if(localDayInfo){ dayActive.add(localDayInfo.dayString); }
    }

    if(msgCtx.textLength > 0){
      totalChars[role] += msgCtx.textLength;
    }

    if(!localDayInfo){ return; }

    const includeWindow = recentWindowMonths.has(localDayInfo.monthKey);
    if(!includeWindow){ return; }

    let includeRecent = true;
    if(sampling){
      const dayCount = recentDayCounts.get(localDayInfo.dayString) || 0;
      if(dayCount >= RECENT_DAY_MSG_LIMIT){
        includeRecent = false;
      }else if(totalRecentCharsCounted + msgCtx.textLength > RECENT_TEXT_CHAR_LIMIT){
        includeRecent = false;
      }else{
        recentDayCounts.set(localDayInfo.dayString, dayCount + 1);
        totalRecentCharsCounted += msgCtx.textLength;
      }
    }

    if(!includeRecent){ return; }

    const current = monthDailyChars.get(localDayInfo.dayString) || 0;
    monthDailyChars.set(localDayInfo.dayString, current + msgCtx.textLength);

    if(msgCtx.textChunks.length){
      for(const chunk of msgCtx.textChunks){
        const tokens = extractTokens(chunk, mode);
        if(tokens.length){
          for(const token of tokens){
            keywordTracker.add(token);
          }
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
    sinceLastProgressBytes += chunk.byteLength;
    const text = td.decode(chunk, { stream: true });
    if(text){ parser.write(text); }
    if(parseError){ throw parseError; }

    const currentTime = now();
    if(!sampling && currentTime - parseStart > 20000){
      sampling = true;
      samplingUsed = true;
    }

    if(currentTime - lastTick > 1000 || sinceLastProgressBytes >= 5 * 1024 * 1024){
      postMessage({
        type:'progress',
        loadedBytes: loaded,
        totalBytes,
        pct: Math.min(99, Math.floor((loaded / total) * 100))
      });
      lastTick = currentTime;
      sinceLastProgressBytes = 0;
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
    totalChars:{ user: totalChars.user, assistant: totalChars.assistant },
    totalMsgs:{ user: counts.user, assistant: counts.assistant },
    earliestTs: earliestTs === null ? null : Math.floor(earliestTs),
    timeOfDay: timeOfDay.slice(),
    dayActive: Array.from(dayActive).sort(),
    monthDailyChars: mapToObject(monthDailyChars),
    keywords: buildKeywordList(keywordTracker, mode),
    samplingNote: samplingUsed,
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

function shouldCaptureText(relativePath){
  if(!relativePath || !relativePath.length){ return false; }
  for(const segment of relativePath){
    if(EXCLUDED_SEGMENTS.has(segment)){ return false; }
  }

  const last = relativePath[relativePath.length - 1];
  const secondLast = relativePath.length > 1 ? relativePath[relativePath.length - 2] : null;

  if(last === '#'){
    if(secondLast === 'parts' || secondLast === 'content'){ return true; }
  }

  if(last === 'content' && relativePath.length === 1){ return true; }

  if(relativePath.includes('content')){
    if(last === 'text' || last === 'body' || last === 'value' || last === 'plain_text' || last === 'message'){
      return true;
    }
    if(last === '#' && (secondLast === 'children' || secondLast === 'body')){
      return true;
    }
  }

  return false;
}

function setTypeHint(msgCtx, relativePath, value){
  if(!msgCtx || !msgCtx.typeHints){ return; }
  const key = buildPathKey(relativePath.slice(0, -1));
  if(!key){ return; }
  msgCtx.typeHints.set(key, String(value).toLowerCase());
}

function isTextualValue(msgCtx, relativePath){
  if(!msgCtx || !msgCtx.typeHints){ return true; }
  let current = relativePath.slice(0, -1);
  if(!current.length){
    current = relativePath.slice();
  }
  while(current.length){
    const key = buildPathKey(current);
    if(key){
      const type = msgCtx.typeHints.get(key);
      if(type && !isAllowedType(type)){ return false; }
    }
    current = current.slice(0, -1);
  }
  return true;
}

function buildPathKey(parts){
  if(!parts || !parts.length){ return ''; }
  return parts.join('/');
}

function isAllowedType(type){
  if(!type){ return true; }
  const normalized = type.toLowerCase();
  if(TEXTUAL_TYPES.has(normalized)){ return true; }
  if(normalized.startsWith('text')){ return true; }
  if(normalized.includes('text')){ return true; }
  if(normalized.startsWith('input_text') || normalized.startsWith('output_text')){ return true; }
  if(normalized.includes('/')){
    return normalized.startsWith('text/');
  }
  return false;
}

function buildRecentWindowMonths(){
  const months = new Set();
  const cursor = new Date();
  cursor.setDate(1);
  for(let i=0;i<3;i++){
    const year = cursor.getFullYear();
    const month = pad2(cursor.getMonth() + 1);
    months.add(`${year}-${month}`);
    cursor.setMonth(cursor.getMonth() - 1);
  }
  return months;
}

function toLocalDay(input){
  const date = input instanceof Date ? input : new Date(input);
  if(!(date instanceof Date) || Number.isNaN(date.getTime())){ return null; }
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return { dayString: `${year}-${month}-${day}`, monthKey: `${year}-${month}` };
}

function pad2(value){
  return value < 10 ? `0${value}` : String(value);
}

function mapToObject(map){
  const entries = Array.from(map.entries());
  entries.sort(([a],[b]) => a.localeCompare(b));
  const obj = {};
  for(const [key, value] of entries){
    obj[key] = value;
  }
  return obj;
}

function createKeywordTracker(k){
  const capacity = Math.max(1, k | 0);
  const entries = new Map();
  return {
    add(term){
      if(!term){ return; }
      const existing = entries.get(term);
      if(existing){
        existing.count += 1;
        return;
      }
      if(entries.size < capacity){
        entries.set(term, { count:1, error:0 });
        return;
      }
      let minTerm = null;
      let minCount = Infinity;
      for(const [key, info] of entries){
        if(info.count < minCount){
          minCount = info.count;
          minTerm = key;
        }
      }
      if(minTerm === null){ return; }
      entries.delete(minTerm);
      entries.set(term, { count: minCount + 1, error: minCount });
    },
    snapshot(){
      return Array.from(entries.entries()).map(([term, info]) => ({ term, count: info.count, error: info.error }));
    }
  };
}

function buildKeywordList(tracker, mode){
  const items = tracker.snapshot();
  const threshold = mode === 'deep' ? 3 : 1;
  const filtered = items.filter((item) => item.count >= threshold);
  filtered.sort((a, b) => {
    if(b.count !== a.count){ return b.count - a.count; }
    return a.term.localeCompare(b.term);
  });
  return filtered.slice(0, 200).map(({ term, count }) => ({ term, count }));
}

function extractTokens(text, mode){
  if(!text){ return []; }
  let working = String(text);
  if(mode === 'deep'){
    REPEATED_CHAR_REGEX.lastIndex = 0;
    working = working.replace(REPEATED_CHAR_REGEX, '$1');
  }
  const tokens = [];

  WORD_REGEX.lastIndex = 0;
  let match;
  while((match = WORD_REGEX.exec(working))){
    let token = match[0].toLowerCase();
    if(token.length < 2){ continue; }
    if(BASE_STOPWORDS.has(token)){ continue; }
    if(mode === 'deep' && DEEP_FILLERS.has(token)){ continue; }
    tokens.push(token);
  }

  const chars = Array.from(working);
  let buffer = [];
  for(const char of chars){
    if(isCjkChar(char)){
      buffer.push(char);
    }else if(buffer.length){
      pushBigrams(buffer, tokens, mode);
      buffer = [];
    }
  }
  if(buffer.length){
    pushBigrams(buffer, tokens, mode);
  }

  return tokens;
}

function pushBigrams(chars, tokens, mode){
  if(chars.length < 2){ return; }
  for(let i=0;i<chars.length - 1;i++){
    const bigram = chars[i] + chars[i + 1];
    if(bigram.length < 2){ continue; }
    if(CN_STOPWORDS.has(bigram)){ continue; }
    if(mode === 'deep' && DEEP_FILLERS.has(bigram)){ continue; }
    tokens.push(bigram);
  }
}

function isCjkChar(char){
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char);
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
