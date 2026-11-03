'use strict';
const $=s=>document.querySelector(s);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
const fmt=v=>typeof v==='string'?v:JSON.stringify(v,null,2);
let session=null,version=-1,updates=0,first=true;
const cards=new Map(), detailState=new Map();
function detail(label,value,key,kind='item'){
 const d=el('details');d.dataset.key=key;d.dataset.kind=kind;d.open=detailState.get(key)||false;
 d.append(el('summary',label),el('pre',fmt(value)));
 // Original strings stay intact; a JSON interpretation is additional.
 if(typeof value==='string'){try{const j=JSON.parse(value);d.append(el('p','Parsed JSON (original above)','muted'),el('pre',JSON.stringify(j,null,2)))}catch{}}
 if(value&&typeof value==='object'){
  function inspect(v,path){
   if(typeof v==='string'){try{const parsed=JSON.parse(v);d.append(el('p','Parsed embedded JSON · '+path+' (original retained above)','muted'),el('pre',JSON.stringify(parsed,null,2)))}catch{}}
   else if(v&&typeof v==='object')for(const [k,x] of Object.entries(v))inspect(x,path+'.'+k);
  }
  inspect(value,'value');
 }
 d.addEventListener('toggle',()=>detailState.set(key,d.open));return d;
}
function inputs(c){const d=c.data;if(!d||typeof d!=='object')return [];const v=d.input??d.messages??[];return Array.isArray(v)?v:[{role:'user',content:v}];}
function responseItems(c){
 const items=new Map();let text='';const partial=new Map();
 const put=(i,k)=>{if(i)items.set(i.id||k,i)};
 for(const [n,e] of JSON.parse(JSON.stringify(c.events)).entries()){
  if(!e||typeof e!=='object')continue;
  if(e.type==='response.output_text.delta')text+=e.delta||'';
  if(e.type==='content_block_delta'&&e.delta?.text)text+=e.delta.text;
  if(e.type==='response.output_item.added'||e.type==='response.output_item.done')put(e.item,'output'+e.output_index);
  if(e.type==='response.function_call_arguments.delta'||e.type==='response.custom_tool_call_input.delta'){
   const k=e.item_id||'output'+e.output_index;const i=items.get(k);if(i){const field=e.type.includes('arguments')?'arguments':'input';i[field]=(partial.get(k)||'')+(e.delta||'');partial.set(k,i[field]);}
  }
  if(e.type==='content_block_start')put(e.content_block,'block'+e.index);
  if(e.type==='content_block_delta'&&e.delta?.partial_json){const i=items.get('block'+e.index);if(i)i.input=(typeof i.input==='string'?i.input:'')+e.delta.partial_json;}
  if(e.response?.output)e.response.output.forEach((i,k)=>put(i,'output'+k));
 }
 if(!c.events.length){try{const d=JSON.parse(c.response);(d.output||d.content||d.choices?.map(x=>x.message)||[]).forEach((i,k)=>put(i,'json'+k));}catch{}}
 return {items:[...items.values()],text};
}
function toolParts(item){
 if(!item||typeof item!=='object')return [];
 const t=item.type||'';
 if(['function_call','custom_tool_call','tool_use'].includes(t))return [{kind:'call',id:item.call_id||item.id,value:item}];
 if(['function_call_output','custom_tool_call_output','tool_result'].includes(t)||item.role==='tool')return [{kind:'result',id:item.call_id||item.tool_use_id||item.tool_call_id,value:item}];
 const out=[];
 for(const call of item.tool_calls||[])out.push({kind:'call',id:call.id,value:call});
 if(Array.isArray(item.content))for(const block of item.content)out.push(...toolParts(block));
 return out;
}
function category(i){if(['system','developer'].includes(i?.role))return ['instruction',`${i.role} instruction`];if(toolParts(i).length)return ['call',i.type||i.role||'tool item'];return [i?.role==='user'?'user':'item',i?.role||i?.type||'Unknown item'];}
function render(snapshot){
 if(snapshot.session!==session){if(session)$('#feed').textContent='Server restarted — new empty session.';session=snapshot.session;version=-1;cards.clear();$('#cards').replaceChildren();detailState.clear();}
 if(snapshot.version===version)return;version=snapshot.version;
 const visible=[...document.querySelectorAll('details')].find(n=>n.getBoundingClientRect().top>=120);
 const anchor=visible||[...document.querySelectorAll('.card')].find(n=>n.getBoundingClientRect().bottom>120);
 const anchorKey=anchor?.dataset.key;
 const offset=anchor?.getBoundingClientRect().top;
 const active=document.activeElement;const focusKey=active?.closest('details')?.dataset.key;
 // Save nested scroll positions and expanded state before replacing a card.
 document.querySelectorAll('details').forEach(d=>detailState.set(d.dataset.key,d.open));
 const scrolls=new Map([...document.querySelectorAll('.live-text')].map(n=>[n.dataset.key,n.scrollTop]));
 const logical=new Map(), occurrences=new Map(), interpreted=new Map();
 for(const c of snapshot.cards){const r=responseItems(c);interpreted.set(c.id,r);
  [...inputs(c),...r.items].forEach((item,index)=>{for(const p of toolParts(item)){
   const key=JSON.stringify([c.scope||'unscoped-capture-'+c.id,p.id||'missing-'+c.id+'-'+index]);
   if(!logical.has(key))logical.set(key,{call:[],result:[],first:c.id,scope:!!c.scope,id:p.id});
   const pair=logical.get(key);const signature=JSON.stringify(p.value);
   if(!pair[p.kind].some(x=>JSON.stringify(x)===signature))pair[p.kind].push(p.value);
   const occurrenceKey=c.id+':'+index+':'+p.kind+':'+p.id;
   occurrences.set(occurrenceKey,{key,repeated:pair.first!==c.id});
  }});
 }
 for(const c of snapshot.cards){
  const serialized=JSON.stringify([c,[...logical].filter(([k,p])=>k.includes(c.scope||'unscoped-capture-'+c.id))]);
  if(cards.get(c.id)?.signature===serialized)continue;
  const card=el('article',undefined,'card');card.id='capture-'+c.id;
  card.append(el('h2',`#${c.id} · ${c.method} ${c.path}`),el('p',`${new Date(c.arrival).toLocaleString()} · HTTP ${c.status??'pending'} · ${c.state}`,'meta'));
  for(const msg of c.diagnostics)card.append(el('p',msg,'error'));
  if(c.data===null&&c.request)card.append(el('p','Request is not valid JSON. Full original body and bytes remain available.','error'));
  const columns=el('div',undefined,'sections'),req=el('section'),res=el('section');columns.append(req,res);card.append(columns);
  req.append(el('h3','Request · instructions'));
  if(c.data?.instructions!==undefined)req.append(detail('Top-level instructions',c.data.instructions,c.id+'-instructions','instruction'));
  if(c.data?.system!==undefined)req.append(detail('System instructions',c.data.system,c.id+'-system','instruction'));
  inputs(c).forEach((i,n)=>{if(['system','developer'].includes(i?.role))req.append(detail(i.role+' instruction · input #'+n,i,c.id+'-instruction-'+n,'instruction'));});
  req.append(el('h3','Tool definitions · available tools'));
  (c.data?.tools||[]).forEach((i,n)=>req.append(detail('Definition · '+(i.name||i.function?.name||i.type||n),i,c.id+'-definition-'+n,'definition')));
  req.append(el('h3','Conversation history / new input items'));
  req.append(el('p','The payload does not reliably mark the history/new-input boundary. The first capture may already contain history. Original order is preserved.','muted'));
  const r=interpreted.get(c.id);
  function itemView(i,n,where,parent){const [kind,label]=category(i);const d=detail(`${where} #${n} · ${label}`,i,`${c.id}-${where}-${n}`,kind);parent.append(d);
   for(const p of toolParts(i)){const o=occurrences.get(c.id+':'+(where==='Input'?n:inputs(c).length+n)+':'+p.kind+':'+p.id);if(!o)continue;
    const pair=logical.get(o.key);const row=el('div',undefined,'pair');const left=el('div'),right=el('div');row.append(left,right);
    const link=el('a',`${o.repeated?'Repeated historical appearance':'Logical tool reference'} · ${p.id||'missing ID'} → #${pair.first}`);link.href='#capture-'+pair.first;parent.append(link);
    if(!pair.scope)parent.append(el('p','No explicit conversation scope: cross-request matching is uncertain and disabled.','muted'));
    if(!p.id)parent.append(el('p','Missing protocol ID: match is ambiguous.','error'));
    if(pair.call.length>1||pair.result.length>1)parent.append(el('p','Multiple distinct values share this ID. All variants are retained; matching is ambiguous.','error'));
    left.append(el('strong','Tool call · requested execution'));right.append(el('strong','Matching result'));
    pair.call.forEach((v,j)=>left.append(detail('Call · '+(v.name||v.function?.name||'unknown'),v,`${c.id}-${where}-${n}-call-${j}`,'call')));
    pair.result.forEach((v,j)=>right.append(detail('Result · full content',v,`${c.id}-${where}-${n}-result-${j}`,'result')));
    if(!pair.call.length)left.append(el('p','Unmatched result: no captured call.'));
    if(!pair.result.length)right.append(el('p','Pending: no matching result captured.'));
    parent.append(row);
   }
  }
  inputs(c).forEach((i,n)=>itemView(i,n,'Input',req));
  res.append(el('h3','Model response · streaming text and items'));
  if(r.text){const t=el('div',r.text,'live-text');t.dataset.key=c.id+'-text';res.append(t);res.append(detail('Full streamed reply text',r.text,c.id+'-reply-text'));}
  r.items.forEach((i,n)=>itemView(i,n,'Response',res));
  if(!r.text&&!r.items.length)res.append(el('p',c.state==='awaiting reply'?'Awaiting upstream reply.':'No interpreted reply yet. Inspect the complete capture below.','muted'));
  card.append(detail('Full request · headers, original body, lossless base64 bytes',{headers:c.headers,body:c.request,base64:c.request_base64},c.id+'-raw-request'));
  card.append(detail('Full response · headers, original body, lossless base64 bytes, parsed events',{headers:c.response_headers,body:c.response,base64:c.response_base64,events:c.events},c.id+'-raw-response'));
  const prev=cards.get(c.id);if(prev)prev.node.replaceWith(card);else $('#cards').prepend(card);
  cards.set(c.id,{node:card,signature:serialized});
 }
 if(!snapshot.cards.length)$('#cards').textContent='Waiting for traffic. Route your agent through port 8041.';
 $('#session').textContent=`Session ${session} · ${snapshot.cards.length} captured requests · memory only`;
 document.querySelectorAll('.live-text').forEach(n=>{n.scrollTop=scrolls.get(n.dataset.key)||0});
 const restored=anchorKey?[...document.querySelectorAll('details')].find(n=>n.dataset.key===anchorKey):document.getElementById(anchor?.id);
 if(restored)window.scrollBy(0,restored.getBoundingClientRect().top-offset);
 if(focusKey){const d=[...document.querySelectorAll('details')].find(d=>d.dataset.key===focusKey);d?.querySelector('summary')?.focus({preventScroll:true});}
 if(!first){updates++;$('#newest').textContent=`New traffic (${updates} updates) · Return to newest`;}first=false;
}
$('#newest').onclick=()=>{window.scrollTo({top:0,behavior:'smooth'});updates=0;$('#newest').textContent='Return to newest'};
const feed=new EventSource('/events');
feed.onopen=()=>{$('#feed').textContent='● Dashboard feed connected'};
feed.onerror=()=>{$('#feed').textContent='Dashboard feed disconnected. Reconnecting; upstream proxy capture continues.'};
feed.onmessage=e=>{try{render(JSON.parse(e.data));$('#feed').textContent='● Dashboard feed connected'}catch(err){$('#feed').textContent='Dashboard rendering error: '+err.message+'; raw captures remain on server.'}};
