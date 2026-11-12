// Bounded data-only YAML subset used by SOG-XT metadata. Native Studio exports
// are JSON (a YAML 1.2 subset). Also accepts ordinary block/flow maps and lists.
// Tags, anchors, aliases, merge keys and multiline scalar syntax are rejected.
export function parseSogXtMetadata(text) {
  const fail=message=>{throw new Error(`SOG-XT metadata: ${message}`);};
  if(typeof text!=='string'||new TextEncoder().encode(text).length>1024*1024)fail('size limit exceeded');
  text=text.replace(/^\uFEFF/,'');
  let nodes=0;
  const scalar=(source,depth=0)=>{
    if(depth>32||++nodes>100000)fail('nesting or node limit exceeded');
    const s=source.trim();
    if(!s||s==='~'||s==='null')return null;
    if(s[0]==='['||s[0]==='{'){
      const end=s[0]==='['?']':'}';if(!s.endsWith(end))fail('unterminated flow value');
      const parts=[];let start=1,level=0,quote='';
      for(let i=1;i<s.length-1;i++){
        const c=s[i];if(quote){if(c===quote&&s[i-1]!=='\\')quote='';continue;}
        if(c==='"'||c==="'"){quote=c;continue;}
        if(c==='['||c==='{')level++;if(c===']'||c==='}')level--;
        if(c===','&&level===0){parts.push(s.slice(start,i));start=i+1;}
      }
      if(quote||level)fail('invalid flow value');if(s.slice(start,-1).trim())parts.push(s.slice(start,-1));
      if(end===']')return parts.map(p=>scalar(p,depth+1));
      const out=Object.create(null);for(const p of parts){const i=p.indexOf(':');if(i<1)fail('invalid flow mapping');const key=keyName(p.slice(0,i));if(Object.hasOwn(out,key))fail('duplicate key');out[key]=scalar(p.slice(i+1),depth+1);}return out;
    }
    if(s[0]==='"'){try{return JSON.parse(s);}catch{fail('invalid quoted string');}}
    if(s[0]==="'"){if(!s.endsWith("'"))fail('invalid quoted string');return s.slice(1,-1).replace(/''/g,"'");}
    if(/^[&*!>|]/.test(s))fail('unsupported YAML feature');
    if(s==='true')return true;if(s==='false')return false;
    if(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s)){const value=Number(s);if(!Number.isFinite(value))fail('non-finite number');return value;}
    return s;
  };
  const keyName=source=>{
    const key=source.trim().replace(/^(?:"(.*)"|'(.*)')$/,'$1$2');
    if(!/^[A-Za-z_][\w-]*$/.test(key)||['__proto__','prototype','constructor'].includes(key))fail('unsafe mapping key');return key;
  };
  if(text.trimStart().startsWith('{')){
    let object;try{object=JSON.parse(text);}catch{
      if(/[\r\n]/.test(text.trim()))fail('multiline flow YAML is unsupported');
      return scalar(text);
    }
    const walk=(value,depth)=>{if(depth>32||++nodes>100000)fail('nesting or node limit exceeded');if(value&&typeof value==='object')for(const [k,v]of Object.entries(value)){if(!Array.isArray(value))keyName(k);walk(v,depth+1);}};
    walk(object,0);return object;
  }
  const lines=[];
  for(const original of text.split(/\r?\n/)){
    if(/^\s*\t/.test(original))fail('tabs are unsupported');
    let line='',quote='';for(let i=0;i<original.length;i++){const c=original[i];if(quote){line+=c;if(c===quote&&original[i-1]!=='\\')quote='';}else if(c==='"'||c==="'"){quote=c;line+=c;}else if(c==='#'&&(i===0||/\s/.test(original[i-1])))break;else line+=c;}
    if(!line.trim()||['---','...'].includes(line.trim()))continue;
    lines.push({indent:line.length-line.trimStart().length,text:line.trim()});
  }
  let cursor=0;
  const sequence=line=>line?.text==='-'||line?.text.startsWith('- ');
  const block=(indent,depth)=>{
    if(depth>32||++nodes>100000)fail('nesting or node limit exceeded');
    const array=sequence(lines[cursor]),out=array?[]:Object.create(null);
    while(cursor<lines.length&&lines[cursor].indent===indent&&sequence(lines[cursor])===array){
      const line=lines[cursor++];
      if(array){
        const value=line.text.slice(1).trim();
        if(/^[\w'"-]+\s*:/.test(value)){
          lines.splice(cursor,0,{indent:indent+2,text:value});out.push(block(indent+2,depth+1));
        }else if(value)out.push(scalar(value,depth+1));
        else out.push(cursor<lines.length&&lines[cursor].indent>indent?block(lines[cursor].indent,depth+1):null);
      }else{
        const separator=line.text.indexOf(':');if(separator<1)fail('expected a mapping');
        const key=keyName(line.text.slice(0,separator));if(Object.hasOwn(out,key))fail('duplicate key');
        const value=line.text.slice(separator+1).trim();
        if(value)out[key]=scalar(value,depth+1);
        else out[key]=cursor<lines.length&&(lines[cursor].indent>indent||(lines[cursor].indent===indent&&sequence(lines[cursor])))?block(lines[cursor].indent,depth+1):null;
      }
    }
    return out;
  };
  if(!lines.length)fail('empty document');const result=block(lines[0].indent,0);if(cursor!==lines.length)fail('inconsistent indentation');return result;
}
