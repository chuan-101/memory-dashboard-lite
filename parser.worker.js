self.onmessage = async (e) => {
  const { type, file, mode = 'simple' } = e.data || {};
  if (type === 'precheck') return precheck(file);
  if (type === 'parse')    return streamOnly(file, mode);
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

async function streamOnly(file, mode){
  try{
    const reader = file.stream().getReader();
    const td = new TextDecoder();
    let loaded = 0, lastTick = 0, done = false;

    while(!done){
      const { value, done: d } = await reader.read();
      done = d;
      if (value){
        const text = td.decode(value, {stream:true}); // we only count bytes for progress
        loaded += text.length;
        const now = performance.now();
        if (now - lastTick > 500){
          postMessage({
            type:'progress',
            loadedBytes: loaded,
            totalBytes: file.size,
            pct: Math.min(99, Math.floor(loaded * 100 / file.size))
          });
          lastTick = now;
        }
      }
    }

    postMessage({ type:'done', summary: {
      totalChars:{user:0,assistant:0},
      totalMsgs:{user:0,assistant:0},
      earliestTs:null,
      timeOfDay:new Array(8).fill(0),
      dayActive:[],
      monthDailyChars:{},
      keywords:[],
      samplingNote: file.size > 50*1024*1024,
      mode
    }});
  }catch(err){
    postMessage({ type:'error', message:String(err?.message||err) });
  }
}
