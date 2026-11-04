'use strict';
const $=s=>document.querySelector(s);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
const fmt=v=>typeof v==='string'?v:JSON.stringify(v,null,2);
let session=null,version=-1,updates=0,first=true;
const cards=new Map(), detailState=new Map();
// Text labels make every category identifiable without relying on color.
const TAGS={instruction:'Instruction',definition:'Definition',user:'User',assistant:'Assistant',call:'Tool call',result:'Tool result',item:'Item',raw:'Raw capture',text:'Reply text'};
const STATES={'awaiting reply':'◌ Awaiting reply',streaming:'● Streaming',completed:'✓ Completed',failed:'✕ Failed'};
const size=t=>{const n=(t??'').length;return (n<1000?n:n<1e6?(n/1e3).toFixed(1)+'k':(n/1e6).toFixed(1)+'M')+' chars'};
function detail(label,value,key,kind='item'){
 const d=el('details');d.dataset.key=key;d.dataset.kind=kind;d.open=detailState.get(key)||false;
 const text=fmt(value),s=el('summary');s.append(el('span',TAGS[kind]||kind,'tag'),el('span',label,'label'),el('span',size(text),'size'));s.firstChild.dataset.kind=kind;
 const body=el('div',undefined,'body');body.append(el('pre',text));d.append(s,body);
 // Original strings stay intact; a JSON interpretation is additional.
 if(typeof value==='string'){try{const j=JSON.parse(value);body.append(el('p','Parsed JSON (original above)','muted parsed-note'),el('pre',JSON.stringify(j,null,2)))}catch{}}
 if(value&&typeof value==='object'){
  function inspect(v,path){
   if(typeof v==='string'){try{const parsed=JSON.parse(v);body.append(el('p','Parsed embedded JSON · '+path+' (original retained above)','muted parsed-note'),el('pre',JSON.stringify(parsed,null,2)))}catch{}}
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
// Display-only refinement of category(): results and assistant messages get their own visual treatment.
function displayKind(i,where){const [kind]=category(i);const parts=toolParts(i);
 if(kind==='call'&&parts.every(p=>p.kind==='result'))return 'result';
 if(kind==='item'&&(i?.role==='assistant'||where==='Response'))return 'assistant';
 return kind;}
function group(parent,title,count){const g=el('div',undefined,'group');const h=el('h4',title);if(count!==undefined)h.append(el('span',String(count),'count'));g.append(h);parent.append(g);return g}
function httpClass(status){return status==null?'pending':status<300?'ok':status<400?'redirect':'bad'}
// Compare JSON values without depending on object property insertion order.
// Strings (including serialized arguments) remain exact; arrays retain their order.
function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
 return value;
}
function toolSignature(part){
 const v=part.value;
 // IDs are already scoped by the index. Status, item IDs and bookkeeping
 // metadata describe an occurrence, not the requested tool execution.
 const identity=part.kind==='call'?{type:v.type,name:v.name,functionName:v.function?.name,input:v.input,arguments:v.arguments,functionArguments:v.function?.arguments}:v;
 return JSON.stringify(canonical(identity));
}
function toolIndex(captures){
 const logical=new Map(),occurrences=new Map(),interpreted=new Map();
 for(const c of captures){const r=responseItems(c);interpreted.set(c.id,r);
  [...inputs(c),...r.items].forEach((item,index)=>{for(const p of toolParts(item)){
   const key=JSON.stringify([c.scope||'unscoped-capture-'+c.id,p.id||'missing-'+c.id+'-'+index]);
   if(!logical.has(key))logical.set(key,{call:[],result:[],first:c.id,scope:!!c.scope,id:p.id});
   const pair=logical.get(key),signature=toolSignature(p);
   if(!pair[p.kind].some(value=>toolSignature({kind:p.kind,value})===signature))pair[p.kind].push(p.value);
   const occurrenceKey=c.id+':'+index+':'+p.kind+':'+p.id;
   occurrences.set(occurrenceKey,{key,repeated:pair.first!==c.id});
  }});
 }
 return {logical,occurrences,interpreted};
}
function render(snapshot){
 if(snapshot.session!==session){if(session)setFeed('restart','Server restarted — new empty session. Feed connected.');session=snapshot.session;version=-1;cards.clear();$('#cards').replaceChildren();detailState.clear();}
 if(snapshot.version===version)return;version=snapshot.version;
 const visible=[...document.querySelectorAll('details')].find(n=>n.getBoundingClientRect().top>=120);
 const anchor=visible||[...document.querySelectorAll('.card')].find(n=>n.getBoundingClientRect().bottom>120);
 const anchorKey=anchor?.dataset.key;
 const offset=anchor?.getBoundingClientRect().top;
 const active=document.activeElement;const focusKey=active?.closest('details')?.dataset.key;
 // Save nested scroll positions and expanded state before replacing a card.
 document.querySelectorAll('details').forEach(d=>detailState.set(d.dataset.key,d.open));
 const scrolls=new Map([...document.querySelectorAll('.live-text')].map(n=>[n.dataset.key,n.scrollTop]));
 const {logical,occurrences,interpreted}=toolIndex(snapshot.cards);
 if(snapshot.cards.length)$('#cards .empty-state')?.remove();
 for(const c of snapshot.cards){
  const serialized=JSON.stringify([c,[...logical].filter(([k,p])=>k.includes(c.scope||'unscoped-capture-'+c.id))]);
  if(cards.get(c.id)?.signature===serialized)continue;
  const card=el('article',undefined,'card');card.id='capture-'+c.id;card.dataset.state=c.state;
  const head=el('header',undefined,'card-head'),title=el('h2',undefined,'card-title'),pills=el('div',undefined,'pills');
  title.append(el('span','#'+c.id,'cid'),el('span',c.method,'method'),el('code',c.path,'path'));
  const http=el('span','HTTP '+(c.status??'pending'),'pill http '+httpClass(c.status));
  const state=el('span',STATES[c.state]||c.state,'pill state');state.dataset.state=c.state;
  const arrival=new Date(c.arrival),time=el('time',arrival.toLocaleTimeString(),'time');time.dateTime=c.arrival;time.title=arrival.toLocaleString();
  pills.append(http,state,time);head.append(title,pills);card.append(head);
  for(const msg of c.diagnostics){const e=el('div',undefined,'error');e.append(el('strong','Problem'),el('span',msg));card.append(e)}
  if(c.data===null&&c.request){const e=el('div',undefined,'error');e.append(el('strong','Payload'),el('span','Request is not valid JSON. Full original body and bytes remain available.'));card.append(e)}
  const columns=el('div',undefined,'sections'),req=el('section',undefined,'panel request'),res=el('section',undefined,'panel response');columns.append(req,res);card.append(columns);
  req.append(el('h3','Request'));
  const bodyless=!c.request&&(c.data===null||c.data===undefined);
  if(bodyless)req.append(el('p',`No request body (${c.method}). Headers are in the full request below.`,'muted'));
  const instr=[];
  if(c.data?.instructions!==undefined)instr.push(detail('Top-level instructions',c.data.instructions,c.id+'-instructions','instruction'));
  if(c.data?.system!==undefined)instr.push(detail('System instructions',c.data.system,c.id+'-system','instruction'));
  inputs(c).forEach((i,n)=>{if(['system','developer'].includes(i?.role))instr.push(detail(i.role+' instruction · input #'+n,i,c.id+'-instruction-'+n,'instruction'));});
  let gh=null;
  if(!bodyless){
  const gi=group(req,'Instructions',instr.length);gi.append(...instr);if(!instr.length)gi.append(el('p','No instructions captured.','muted'));
  const tools=c.data?.tools||[];
  const gt=group(req,'Tool definitions · available tools',tools.length);
  tools.forEach((i,n)=>gt.append(detail('Definition · '+(i.name||i.function?.name||i.type||n),i,c.id+'-definition-'+n,'definition')));
  if(!tools.length)gt.append(el('p','No tool definitions captured.','muted'));
  gh=group(req,'Conversation history / new input items',inputs(c).length);
  gh.append(el('p','The payload does not reliably mark the history/new-input boundary. The first capture may already contain history. Original order is preserved.','muted hint'));
  }
  const r=interpreted.get(c.id);
  function itemView(i,n,where,parent){const [,label]=category(i);const d=detail(`${where} #${n} · ${label}`,i,`${c.id}-${where}-${n}`,displayKind(i,where));parent.append(d);
   for(const p of toolParts(i)){const o=occurrences.get(c.id+':'+(where==='Input'?n:inputs(c).length+n)+':'+p.kind+':'+p.id);if(!o)continue;
    const pair=logical.get(o.key);const block=el('div',undefined,'pair-block');block.dataset.repeated=o.repeated;
    const link=el('a',`${o.repeated?'↺ Repeated historical appearance':'⇄ Logical tool reference'} · ${p.id||'missing ID'} → #${pair.first}`,'ref');link.href='#capture-'+pair.first;block.append(link);
    if(!pair.scope)block.append(el('p','No explicit conversation scope: cross-request matching is uncertain and disabled.','muted'));
    if(!p.id)block.append(el('p','Missing protocol ID: match is ambiguous.','warn'));
    if(pair.call.length>1||pair.result.length>1)block.append(el('p','Multiple distinct values share this ID. All variants are retained; matching is ambiguous.','warn'));
    const row=el('div',undefined,'pair');const left=el('div',undefined,'side'),right=el('div',undefined,'side');row.append(left,el('span','→','arrow'),right);
    left.append(el('strong','Tool call · requested execution','side-title'));right.append(el('strong','Matching result','side-title'));
    pair.call.forEach((v,j)=>left.append(detail('Call · '+(v.name||v.function?.name||'unknown'),v,`${c.id}-${where}-${n}-call-${j}`,'call')));
    pair.result.forEach((v,j)=>right.append(detail('Result · full content',v,`${c.id}-${where}-${n}-result-${j}`,'result')));
    if(!pair.call.length)left.append(el('p','Unmatched result: no captured call.','empty-slot'));
    if(!pair.result.length)right.append(el('p','Pending: no matching result captured.','empty-slot'));
    block.append(row);parent.append(block);
   }
  }
  if(gh)inputs(c).forEach((i,n)=>itemView(i,n,'Input',gh));
  res.append(el('h3','Model response'));
  const gr=group(res,'Streaming text and items',r.items.length+(r.text?1:0));
  if(r.text){const t=el('div',r.text,'live-text'+(c.state==='streaming'?' streaming':''));t.dataset.key=c.id+'-text';gr.append(t);gr.append(detail('Full streamed reply text',r.text,c.id+'-reply-text','text'));}
  r.items.forEach((i,n)=>itemView(i,n,'Response',gr));
  if(!r.text&&!r.items.length)gr.append(el('p',c.state==='awaiting reply'?'Awaiting upstream reply…':'No interpreted reply yet. Inspect the complete capture below.','muted'+(c.state==='awaiting reply'?' waiting':'')));
  const raw=el('div',undefined,'raw');
  raw.append(detail('Full request · headers, original body, lossless base64 bytes',{headers:c.headers,body:c.request,base64:c.request_base64},c.id+'-raw-request','raw'));
  raw.append(detail('Full response · headers, original body, lossless base64 bytes, parsed events',{headers:c.response_headers,body:c.response,base64:c.response_base64,events:c.events},c.id+'-raw-response','raw'));
  card.append(raw);
  const prev=cards.get(c.id);if(prev)prev.node.replaceWith(card);else{if(!first)card.classList.add('arrived');$('#cards').prepend(card);}
  cards.set(c.id,{node:card,signature:serialized});
 }
 if(!snapshot.cards.length&&!$('#cards .empty-state')){const e=el('div',undefined,'empty-state');e.append(el('strong','Waiting for traffic.'),el('span','Route your agent through port 8041.'));$('#cards').replaceChildren(e)}
 const counts={};for(const c of snapshot.cards)counts[c.state]=(counts[c.state]||0)+1;
 const info=$('#session');info.replaceChildren(el('span','Session','k'),el('code',session,'sid'),el('span',`${snapshot.cards.length} captured requests`,'chip'));
 for(const [s,n] of Object.entries(counts)){const chip=el('span',`${n} ${s}`,'chip');chip.dataset.state=s;info.append(chip)}
 info.append(el('span','memory only','chip'));
 document.querySelectorAll('.live-text').forEach(n=>{n.scrollTop=scrolls.get(n.dataset.key)||0});
 const restored=anchorKey?[...document.querySelectorAll('details')].find(n=>n.dataset.key===anchorKey):document.getElementById(anchor?.id);
 if(restored)window.scrollBy(0,restored.getBoundingClientRect().top-offset);
 if(focusKey){const d=[...document.querySelectorAll('details')].find(d=>d.dataset.key===focusKey);d?.querySelector('summary')?.focus({preventScroll:true});}
 if(!first){updates++;$('#newest').textContent=`New traffic (${updates} ${updates===1?'update':'updates'}) · Return to newest`;$('#newest').classList.add('has-new');}first=false;
}
function setFeed(status,text){const f=$('#feed');f.dataset.status=status;f.textContent=text}
$('#newest').onclick=()=>{window.scrollTo({top:0,behavior:'smooth'});updates=0;$('#newest').textContent='Return to newest';$('#newest').classList.remove('has-new')};
// Theme: follows the system until the viewer picks one; the choice is remembered per browser when storage allows.
const THEME_KEY='agent-traffic-theme',systemDark=matchMedia('(prefers-color-scheme: dark)');
let chosenTheme=null;try{const t=localStorage.getItem(THEME_KEY);if(t==='light'||t==='dark')chosenTheme=t}catch{}
function applyTheme(){
 const theme=chosenTheme||(systemDark.matches?'dark':'light'),next=theme==='dark'?'light':'dark';
 document.documentElement.dataset.theme=theme;
 const b=$('#theme');b.querySelector('.icon').textContent=theme==='dark'?'☀':'☾';
 b.setAttribute('aria-label',`Switch to ${next} theme`);b.title=`Switch to ${next} theme`;
}
$('#theme').onclick=()=>{chosenTheme=document.documentElement.dataset.theme==='dark'?'light':'dark';try{localStorage.setItem(THEME_KEY,chosenTheme)}catch{}applyTheme()};
systemDark.addEventListener('change',applyTheme);
applyTheme();
const feed=new EventSource('/events');
feed.onopen=()=>setFeed('connected','Dashboard feed connected');
feed.onerror=()=>setFeed('disconnected','Dashboard feed disconnected. Reconnecting; upstream proxy capture continues.');
feed.onmessage=e=>{try{render(JSON.parse(e.data));if($('#feed').dataset.status!=='restart')setFeed('connected','Dashboard feed connected')}catch(err){setFeed('error','Dashboard rendering error: '+err.message+'; raw captures remain on server.')}};
