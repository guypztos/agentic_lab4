'use strict';
const $=s=>document.querySelector(s);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
const fmt=v=>typeof v==='string'?v:JSON.stringify(v,null,2);
let session=null,version=-1,updates=0,first=true;
const cards=new Map(), detailState=new Map(), sigCache=new Map(), cardText=new WeakMap();
const F={q:'',kinds:new Set(),status:'',tool:''};
// Text labels make every category identifiable without relying on color.
const TAGS={instruction:'Instruction',definition:'Definition',user:'User',assistant:'Assistant',call:'Tool call',result:'Tool result',item:'Item',raw:'Raw capture',text:'Reply text',seen:'Seen before'};
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
// Links an item to the latest earlier request holding the same item. Matching is exact except that
// Anthropic prompt-cache markers (cache_control), which clients move between turns, are ignored; the badge says when that was the only difference.
const CACHE_KEY='cache_control';
const looseJSON=v=>JSON.stringify(v,(k,x)=>k===CACHE_KEY?undefined:x);
function seenBadge(d,prefix,s){if(!s)return d;const a=el('a',`↺ ${prefix} #${s.id}${s.exact?'':' · cache marker differs'}`,'seen-badge');a.href='#capture-'+s.id;
 a.title=s.exact?`An identical copy appears in request #${s.id}`:`Request #${s.id} has the same item except for its ${CACHE_KEY} marker. The original captured object is shown unchanged.`;d.querySelector(':scope > summary .size').before(a);return d}
function bundle(key,kind,tagText,label){const b=el('details',undefined,'bundle');b.dataset.key=key;b.dataset.kind=kind;b.open=detailState.get(key)||false;
 const s=el('summary'),t=el('span',tagText,'tag');t.dataset.kind=kind;s.append(t,el('span',label,'label'),el('span','','size'));
 const inner=el('div',undefined,'bundle-body');b.append(s,inner);b.addEventListener('toggle',()=>detailState.set(key,b.open));return {box:b,inner,label:s.querySelector('.label')}}
function httpClass(status){return status==null?'pending':status<300?'ok':status<400?'redirect':'bad'}
function render(snapshot){
 if(snapshot.session!==session){if(session)setFeed('restart','Server restarted — new empty session. Feed connected.');session=snapshot.session;version=-1;cards.clear();sigCache.clear();$('#cards').replaceChildren();detailState.clear();}
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
 const seen=new Map(),lastSeen=new Map();
 for(const c of snapshot.cards){
  if(!c.data||typeof c.data!=='object')continue;
  let sigs=sigCache.get(c.id);
  if(!sigs){sigs=[];const add=(field,v)=>{if(v!==undefined){const kind=field.split(':')[0]+'|';sigs.push([field,kind+looseJSON(v),kind+JSON.stringify(v)])}};
   add('instructions',c.data.instructions);add('system',c.data.system);add('tools',c.data.tools);inputs(c).forEach((v,n)=>add('input:'+n,v));sigCache.set(c.id,sigs)}
  for(const [field,loose,exact] of sigs){const prev=lastSeen.get(loose);if(prev)seen.set(c.id+':'+field,{id:prev.id,exact:prev.exact===exact});lastSeen.set(loose,{id:c.id,exact})}
 }
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
  const mc=el('span','','pill match-count');mc.hidden=true;
  pills.append(mc,http,state,time);head.append(title,pills);card.append(head);
  for(const msg of c.diagnostics){const e=el('div',undefined,'error');e.append(el('strong','Problem'),el('span',msg));card.append(e)}
  if(c.data===null&&c.request){const e=el('div',undefined,'error');e.append(el('strong','Payload'),el('span','Request is not valid JSON. Full original body and bytes remain available.'));card.append(e)}
  const columns=el('div',undefined,'sections'),req=el('section',undefined,'panel request'),res=el('section',undefined,'panel response');columns.append(req,res);card.append(columns);
  req.append(el('h3','Request'));
  const bodyless=!c.request&&(c.data===null||c.data===undefined);
  if(bodyless)req.append(el('p',`No request body (${c.method}). Headers are in the full request below.`,'muted'));
  const r=interpreted.get(c.id),toolNames=new Set();
  const nameOf=v=>v?.name||v?.function?.name;
  const wrap=(kind,...nodes)=>{const w=el('div',undefined,'item-wrap');w.dataset.kind=kind;w.append(...nodes);return w};
  function itemView(i,n,where,parent,prevSeen){const [,label]=category(i);const kind=displayKind(i,where);
   const d=seenBadge(detail(`${where} #${n} · ${label}`,i,`${c.id}-${where}-${n}`,kind),'Seen in',prevSeen);
   const w=wrap(kind,d);parent.append(w);
   for(const p of toolParts(i)){if(p.kind==='call'&&nameOf(p.value))toolNames.add(nameOf(p.value));
    const o=occurrences.get(c.id+':'+(where==='Input'?n:inputs(c).length+n)+':'+p.kind+':'+p.id);if(!o)continue;
    const pair=logical.get(o.key);const block=el('div',undefined,'pair-block');block.dataset.repeated=o.repeated;
    const link=el('a',`${o.repeated?'↺ Repeated historical appearance':'⇄ Logical tool reference'} · ${p.id||'missing ID'} → #${pair.first}`,'ref');link.href='#capture-'+pair.first;block.append(link);
    if(!pair.scope)block.append(el('p','No explicit conversation scope: cross-request matching is uncertain and disabled.','muted'));
    if(!p.id)block.append(el('p','Missing protocol ID: match is ambiguous.','warn'));
    if(pair.call.length>1||pair.result.length>1)block.append(el('p','Multiple distinct values share this ID. All variants are retained; matching is ambiguous.','warn'));
    const row=el('div',undefined,'pair');const left=el('div',undefined,'side'),right=el('div',undefined,'side');row.append(left,el('span','→','arrow'),right);
    left.append(el('strong','Tool call · requested execution','side-title'));right.append(el('strong','Matching result','side-title'));
    pair.call.forEach((v,j)=>{if(nameOf(v))toolNames.add(nameOf(v));left.append(detail('Call · '+(nameOf(v)||'unknown'),v,`${c.id}-${where}-${n}-call-${j}`,'call'))});
    pair.result.forEach((v,j)=>right.append(detail('Result · full content',v,`${c.id}-${where}-${n}-result-${j}`,'result')));
    if(!pair.call.length)left.append(el('p','Unmatched result: no captured call.','empty-slot'));
    if(!pair.result.length)right.append(el('p','Pending: no matching result captured.','empty-slot'));
    block.append(row);w.append(block);
   }
  }
  if(!bodyless){
   const instr=[];
   if(c.data?.instructions!==undefined)instr.push(seenBadge(detail('Top-level instructions',c.data.instructions,c.id+'-instructions','instruction'),'Same as',seen.get(c.id+':instructions')));
   if(c.data?.system!==undefined)instr.push(seenBadge(detail('System instructions',c.data.system,c.id+'-system','instruction'),'Same as',seen.get(c.id+':system')));
   inputs(c).forEach((i,n)=>{if(['system','developer'].includes(i?.role))instr.push(seenBadge(detail(i.role+' instruction · input #'+n,i,c.id+'-instruction-'+n,'instruction'),'Seen in',seen.get(c.id+':input:'+n)));});
   const gi=group(req,'Instructions',instr.length);gi.append(...instr.map(d=>wrap('instruction',d)));if(!instr.length)gi.append(el('p','No instructions captured.','muted'));
   const tools=Array.isArray(c.data?.tools)?c.data.tools:[];
   const gt=group(req,'Tool definitions · available tools',tools.length);
   if(tools.length){
    // One collapsed row instead of a row per definition; every definition stays inside, in order.
    const names=tools.map((i,n)=>i?.name||i?.function?.name||i?.type||String(n));
    const b=bundle(c.id+'-definitions','definition','Definitions',`${tools.length} tools: ${names.slice(0,5).join(', ')}${names.length>5?` +${names.length-5} more`:''}`);
    seenBadge(b.box,'Same set as',seen.get(c.id+':tools'));
    tools.forEach((i,n)=>b.inner.append(detail('Definition · '+names[n],i,c.id+'-definition-'+n,'definition')));
    gt.append(wrap('definition',b.box));
   }else gt.append(el('p','No tool definitions captured.','muted'));
   const gh=group(req,'Conversation history / new input items',inputs(c).length);
   gh.append(el('p','The payload does not mark the history/new-input boundary. Items already present in an earlier request are folded into “Earlier history”. Matching is exact, ignoring only cache_control markers, and each badge says when a marker differed. Original order and content are preserved.','muted hint'));
   // Consecutive previously seen items fold into one row; unseen items stay visible on their own.
   let run=null;
   inputs(c).forEach((i,n)=>{
    const prev=seen.get(c.id+':input:'+n);
    if(prev===undefined){run=null;itemView(i,n,'Input',gh);return}
    if(!run){run=bundle(`${c.id}-seenrun-${n}`,'seen','Earlier history','');run.box.classList.add('seen-run');run.start=n;run.latest=prev.id;run.count=0;gh.append(run.box)}
    run.count++;run.latest=Math.max(run.latest,prev.id);
    run.label.textContent=`Input #${run.start}${run.count>1?`–#${n}`:''} · ${run.count} item${run.count===1?'':'s'} already seen in earlier requests (latest copy #${run.latest})`;
    itemView(i,n,'Input',run.inner,prev);
   });
  }
  res.append(el('h3','Model response'));
  const gr=group(res,'Streaming text and items',r.items.length+(r.text?1:0));
  if(r.text){const t=el('div',r.text,'live-text'+(c.state==='streaming'?' streaming':''));t.dataset.key=c.id+'-text';gr.append(wrap('assistant',t,detail('Full streamed reply text',r.text,c.id+'-reply-text','text')));}
  r.items.forEach((i,n)=>itemView(i,n,'Response',gr));
  if(!r.text&&!r.items.length)gr.append(el('p',c.state==='awaiting reply'?'Awaiting upstream reply…':'No interpreted reply yet. Inspect the complete capture below.','muted'+(c.state==='awaiting reply'?' waiting':'')));
  card.dataset.tools=[...toolNames].join('\n');
  cardText.set(card,[c.method,c.path,c.request,r.text,JSON.stringify(r.items),...c.diagnostics].join('\n').toLowerCase());
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
 applyFilters();
 document.querySelectorAll('.live-text').forEach(n=>{n.scrollTop=scrolls.get(n.dataset.key)||0});
 const restored=anchorKey?[...document.querySelectorAll('details')].find(n=>n.dataset.key===anchorKey):document.getElementById(anchor?.id);
 if(restored)window.scrollBy(0,restored.getBoundingClientRect().top-offset);
 if(focusKey){const d=[...document.querySelectorAll('details')].find(d=>d.dataset.key===focusKey);d?.querySelector('summary')?.focus({preventScroll:true});}
 if(!first){updates++;$('#newest').textContent=`New traffic (${updates} ${updates===1?'update':'updates'}) · Return to newest`;$('#newest').classList.add('has-new');}first=false;
}
function setFeed(status,text){const f=$('#feed');f.dataset.status=status;f.textContent=text}
$('#newest').onclick=()=>{window.scrollTo({top:0,behavior:'smooth'});updates=0;$('#newest').textContent='Return to newest';$('#newest').classList.remove('has-new')};
// Search and filters: display only. Hidden cards and items stay captured and come back when filters clear.
const textCache=new WeakMap();
const lower=n=>{let t=textCache.get(n);if(t===undefined){t=n.textContent.toLowerCase();textCache.set(n,t)}return t};
const filtersActive=()=>!!(F.q.trim()||F.kinds.size||F.status||F.tool);
function applyFilters(){
 const q=F.q.trim().toLowerCase(),kinds=F.kinds,names=new Set();let shown=0,total=0;
 for(const {node:card} of cards.values()){
  total++;const tools=(card.dataset.tools||'').split('\n').filter(Boolean);tools.forEach(n=>names.add(n));
  let kindHit=!kinds.size,matches=0;
  for(const w of card.querySelectorAll('.item-wrap')){
   const ok=!kinds.size||kinds.has(w.dataset.kind);w.hidden=!ok;if(ok&&kinds.size)kindHit=true;
   const m=!!q&&ok&&lower(w).includes(q);w.classList.toggle('match',m);if(m)matches++;
  }
  for(const run of card.querySelectorAll('.seen-run')){const ws=[...run.querySelectorAll('.item-wrap')];run.hidden=!ws.some(w=>!w.hidden);run.classList.toggle('match-inside',ws.some(w=>w.classList.contains('match')))}
  for(const g of card.querySelectorAll('.group'))g.hidden=kinds.size>0&&![...g.querySelectorAll('.item-wrap')].some(w=>!w.hidden);
  const show=kindHit&&(!F.status||card.dataset.state===F.status)&&(!F.tool||tools.includes(F.tool))&&(!q||(cardText.get(card)||'').includes(q));
  card.hidden=!show;if(show)shown++;
  const mc=card.querySelector('.match-count');mc.hidden=!(q&&show);mc.textContent=matches?`⌕ ${matches} matching item${matches===1?'':'s'}`:'⌕ Match in full capture';
 }
 const sel=$('#f-tool'),want=[...names].sort();if(F.tool&&!names.has(F.tool))want.push(F.tool);
 if([...sel.options].slice(1).map(o=>o.value).join('\n')!==want.join('\n')){sel.replaceChildren(new Option('All tools',''),...want.map(n=>new Option(n,n)));sel.value=F.tool}
 const active=filtersActive();$('#filter-status').hidden=!active;$('#filter-count').textContent=`Showing ${shown} of ${total} requests`;
 $('#no-match').hidden=!(active&&total>0&&shown===0);
}
let qTimer;
$('#q').addEventListener('input',e=>{clearTimeout(qTimer);qTimer=setTimeout(()=>{F.q=e.target.value;applyFilters()},150)});
$('#q').addEventListener('keydown',e=>{if(e.key==='Escape'){e.target.value='';F.q='';applyFilters()}});
$('#f-status').onchange=e=>{F.status=e.target.value;applyFilters()};
$('#f-tool').onchange=e=>{F.tool=e.target.value;applyFilters()};
document.querySelectorAll('#kinds .tag').forEach(b=>b.onclick=()=>{const k=b.dataset.kind;if(F.kinds.has(k))F.kinds.delete(k);else F.kinds.add(k);b.setAttribute('aria-pressed',String(F.kinds.has(k)));applyFilters()});
$('#clear').onclick=()=>{F.q='';F.kinds.clear();F.status='';F.tool='';$('#q').value='';$('#f-status').value='';$('#f-tool').value='';document.querySelectorAll('#kinds .tag').forEach(b=>b.setAttribute('aria-pressed','false'));applyFilters()};
document.addEventListener('keydown',e=>{if(e.key==='/'&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName||'')){e.preventDefault();$('#q').focus()}});
new ResizeObserver(()=>document.documentElement.style.setProperty('--topbar-h',$('.topbar').offsetHeight+'px')).observe($('.topbar'));
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
