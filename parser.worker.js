self.onmessage = async (e)=>{
  const {type, file} = e.data || {};
  if(type==='precheck'){
    try{
      const chunk = await file.slice(0, 1024 * 1024).text(); // 读前 1MB 作为结构探针
      const looksLikeMapping = /"mapping"\s*:\s*\{/.test(chunk) && /"message"\s*:\s*\{/.test(chunk);
      const looksLikeMessages = /"messages"\s*:\s*\[/.test(chunk); // 兼容其他导出形态
      if(looksLikeMapping || looksLikeMessages){
        const hint = looksLikeMapping ? 'mapping/message 结构' : 'messages 数组结构';
        postMessage({type:'precheck', ok:true, hint});
      } else {
        postMessage({type:'precheck', ok:false, reason:'未检测到 mapping/message 或 messages 关键结构'});
      }
    }catch(err){
      postMessage({type:'precheck', ok:false, reason: String(err && err.message || err)});
    }
  }
};
