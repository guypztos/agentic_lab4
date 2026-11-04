import base64
import http.client
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import proxy
from capture import Store, Stream
from dashboard import Dashboard


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body=self.rfile.read(int(self.headers['Content-Length']))
        self.server.seen.append((self.path,body,self.headers.get('Authorization')))
        if self.path.endswith('/error'):
            self.send_response(429);self.end_headers();self.wfile.write(b'{"error":"rate limit"}');return
        self.send_response(200)
        self.send_header('Content-Type','text/event-stream');self.end_headers()
        self.wfile.write(b'data: {"type":"response.output_text.delta","delta":"hello"}\n\n');self.wfile.flush()
        time.sleep(.15)
        if self.path.endswith('/broken'):return
        self.wfile.write(b'data: {"type":"response.completed","response":{"output":[]}}\n\n')


class Tests(unittest.TestCase):
    def setUp(self):
        try:
            self.up=ThreadingHTTPServer(('127.0.0.1',0),Upstream)
        except PermissionError as error:
            self.skipTest('Local sockets prohibited by execution sandbox: '+str(error))
        self.up.seen=[]
        proxy.UPSTREAM=f'http://127.0.0.1:{self.up.server_port}/base'
        self.tap=ThreadingHTTPServer(('127.0.0.1',0),proxy.Tap);self.tap.store=Store()
        self.web=ThreadingHTTPServer(('127.0.0.1',0),Dashboard);self.web.daemon_threads=True;self.web.store=self.tap.store
        for s in (self.up,self.tap,self.web):threading.Thread(target=s.serve_forever,daemon=True).start()
    def tearDown(self):
        for s in (self.up,self.tap,self.web):s.shutdown();s.server_close()
    def request(self,path='/responses'):
        c=http.client.HTTPConnection('127.0.0.1',self.tap.server_port)
        c.request('POST',path,b'{"input":[{"role":"developer","content":"rule"}]}',{'Authorization':'Bearer secret','session_id':'abc'})
        r=c.getresponse();b=r.read();c.close();return r.status,b
    def test_concurrent_forwarding(self):
        results=[];threads=[threading.Thread(target=lambda:results.append(self.request())) for _ in range(2)]
        for t in threads:t.start()
        time.sleep(.06)
        self.assertEqual(len(self.tap.store.cards),2)
        self.assertTrue(any(c['state']=='streaming' for c in self.tap.store.cards))
        for t in threads:t.join()
        self.assertEqual([c['id'] for c in self.tap.store.cards],[1,2])
        for status,body in results:self.assertEqual(status,200);self.assertIn(b'hello',body)
        for c in self.tap.store.cards:
            self.assertEqual(c['state'],'completed');self.assertEqual(c['headers']['Authorization'],'[redacted]')
        self.assertEqual(self.up.seen[0][0],'/base/responses')
        self.assertEqual(self.up.seen[0][2],'Bearer secret')
    def test_errors(self):
        self.assertEqual(self.request('/error')[0],429)
        self.assertEqual(self.tap.store.cards[-1]['state'],'failed')
        self.request('/broken');self.assertEqual(self.tap.store.cards[-1]['state'],'failed')
        self.up.shutdown();self.up.server_close()
        self.assertEqual(self.request()[0],502)
        self.assertEqual(self.tap.store.cards[-1]['state'],'failed')
    def test_snapshot_feed_and_static(self):
        self.request()
        for _ in range(2):
            c=http.client.HTTPConnection('127.0.0.1',self.web.server_port)
            c.request('GET','/events',headers={'Last-Event-ID':'stale:0'})
            r=c.getresponse();self.assertEqual(r.status,200)
            self.assertTrue(r.fp.readline().startswith(b'id: '))
            data=json.loads(r.fp.readline().decode()[6:]);self.assertEqual(len(data['cards']),1)
            self.assertEqual(data['session'],self.tap.store.session);c.close()
        c=http.client.HTTPConnection('127.0.0.1',self.web.server_port);c.request('GET','/');r=c.getresponse();self.assertIn(b'Agent Traffic',r.read());c.close()


class CaptureTests(unittest.TestCase):
    def test_split_utf8_and_frames(self):
        store=Store();card=store.create('POST','/',{},b'not json');stream=Stream(store,card,True)
        body='data: {"type":"response.output_text.delta","delta":"שלום 🐈"}\r\n\r\ndata: [DONE]\n\n'.encode()
        for b in body:stream.feed(bytes([b]))
        stream.feed(b'',True)
        self.assertEqual(card['events'][0]['delta'],'שלום 🐈');self.assertTrue(stream.terminal)
        self.assertEqual(card['response'],body.decode());self.assertIsNone(card['data'])

    def test_missing_content_type_incremental_sse(self):
        events = [
            {'type': 'response.created', 'response': {}},
            {'type': 'response.output_text.delta', 'delta': 'שלום 🐈'},
            {'type': 'response.output_item.added', 'output_index': 0,
             'item': {'id': 'tool1', 'type': 'custom_tool_call', 'call_id': 'call1',
                      'name': 'exec_command', 'input': ''}},
            {'type': 'response.custom_tool_call_input.delta', 'item_id': 'tool1',
             'delta': 'cat sample.txt'},
            {'type': 'response.completed'},
        ]
        records = [('event: ' + e['type'] + '\r\ndata: ' +
                    json.dumps(e, ensure_ascii=False) + '\r\n\r\n').encode() for e in events]
        body = b''.join(records)
        # Every byte boundary, plus mixed network chunk sizes, including inside
        # field names, CRLF delimiters, JSON strings and multibyte characters.
        for mode in (None, True):
            for size in (1, 2, 7, 31):
                with self.subTest(mode=mode, size=size):
                    store = Store(); card = store.create('POST', '/', {}, b'{}')
                    stream = Stream(store, card, mode)
                    stream.feed(records[0][:-1])
                    self.assertEqual(card['events'], [])
                    stream.feed(records[0][-1:])
                    self.assertEqual(card['events'], events[:1])
                    rest = b''.join(records[1:])
                    for offset in range(0, len(rest), size):
                        stream.feed(rest[offset:offset + size])
                    self.assertEqual(card['events'], events)  # Before EOF
                    stream.feed(b'', final=True)
                    self.assertTrue(stream.sse); self.assertTrue(stream.terminal)
                    self.assertEqual(base64.b64decode(card['response_base64']), body)
                    self.assertEqual(card['response'], body.decode())

    def test_missing_content_type_non_sse(self):
        for body in (b'{"output":[{"content":"hello"}]}',
                     b'ordinary text\n\nwith paragraphs',
                     b'event: example\ndata: not JSON\n\n',
                     b'data: {"ordinary":"text"}\n\n'):
            with self.subTest(body=body):
                store = Store(); card = store.create('POST', '/', {}, b'{}')
                stream = Stream(store, card, None)
                for byte in body: stream.feed(bytes([byte]))
                stream.feed(b'', final=True)
                self.assertFalse(stream.sse)
                self.assertEqual(card['events'], [])
                self.assertEqual(card['response'], body.decode())
                self.assertEqual(base64.b64decode(card['response_base64']), body)
                self.assertEqual(card['diagnostics'], [])

    def test_snapshot_identity_and_redaction(self):
        store=Store()
        for _ in range(2):
            store.create('POST','/responses',{'Authorization':'secret','Cookie':'secret','session_id':'scope'},b'{"input":[]}')
        snapshot=json.loads(store.snapshot())
        self.assertEqual([c['id'] for c in snapshot['cards']],[1,2])
        self.assertEqual(snapshot['cards'][0]['scope'],'scope')
        self.assertNotIn('secret',store.snapshot())
        self.assertNotEqual(Store().session,store.session)

    def test_malformed_and_unknown_events_retained(self):
        store=Store();card=store.create('POST','/',{},b'{}');stream=Stream(store,card,True)
        stream.feed(b'data: invalid\n\ndata: {"type":"unknown","nested":[1,2]}\n\n')
        self.assertEqual(card['events'][0],{'unparsed_data':'invalid'})
        self.assertEqual(card['events'][1]['nested'],[1,2])


class RenderingTests(unittest.TestCase):
    def run_dashboard_js(self, checks):
        import shutil
        import subprocess
        from pathlib import Path
        runtime = shutil.which('node') or shutil.which('nodejs')
        if not runtime:
            self.skipTest('JavaScript runtime unavailable; tool matching requires browser validation')
        script = (Path(__file__).resolve().parents[1] / 'web/app.js').read_text()
        script = script.split("$('#newest').onclick=")[0]
        script += r"""
const assert = require('node:assert/strict');
const call = {type:'custom_tool_call', id:'tool1',
 call_id:'call_eef7f2bbd7a1498486b6679a77dc2be3', name:'exec',
 input:'cat sample.txt', status:'completed'};
const result = {type:'custom_tool_call_output', call_id:call.call_id,
 output:[{type:'text',text:'hello'},{type:'json',value:{nested:[1,2]}}]};
const capture = (id, scope, input=[], output=[]) => ({id,scope,data:{input},
 request:JSON.stringify({input}),diagnostics:[],state:'completed',method:'POST',
 path:'/responses',arrival:'2026-11-04T00:00:00Z',status:200,
 events:output.map((item,output_index)=>({type:'response.output_item.done',item,output_index}))});
const freeze = value => {if(value && typeof value==='object'){
 Object.values(value).forEach(freeze); Object.freeze(value);} return value;};
const pairFor = (index, scope, id=call.call_id) => index.logical.get(JSON.stringify([scope,id]));
"""
        completed = subprocess.run([runtime, '-e', script + checks], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)

    def test_metadata_repetitions_pair_and_preserve_originals(self):
        self.run_dashboard_js(r"""
const decorated = {...call, metadata:{turn_id:'turn1',created_at:123,nested:{values:[1,2]}},
 internal_chat_message_metadata_passthrough:{turn_id:'turn1',created_at:123}};
// Reverse outer property order as well as adding the observed metadata.
const reordered = Object.fromEntries(Object.entries(decorated).reverse());
const captures = freeze([capture(1,'session',[],[call]),
 capture(2,'session',[reordered,result]), capture(3,'session',[call,result])]);
const before = JSON.stringify(captures);
const index = toolIndex(captures), pair = pairFor(index,'session');
assert.equal(index.logical.size,1);
assert.equal(pair.call.length,1); assert.equal(pair.result.length,1);
assert.deepEqual(pair.call[0],call); assert.strictEqual(pair.result[0],result);
assert.equal(index.occurrences.size,5);
assert.equal(index.occurrences.get('2:0:call:'+call.call_id).repeated,true);
assert.equal(index.occurrences.get('3:0:call:'+call.call_id).key,
 index.occurrences.get('1:0:call:'+call.call_id).key);
assert.equal(JSON.stringify(captures),before);
assert.equal('metadata' in captures[0].events[0].item,false);
assert.deepEqual(captures[1].data.input[0].metadata,decorated.metadata);
assert.deepEqual(captures[1].data.input[0].internal_chat_message_metadata_passthrough,
 decorated.internal_chat_message_metadata_passthrough);

// Exercise the actual renderer with a small DOM stand-in, without a live feed.
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.classList={add(){}};this.textContent='';}
 append(...nodes){this.children.push(...nodes);}
 prepend(node){this.children.unshift(node);}
 replaceChildren(...nodes){this.children=nodes;}
 get firstChild(){return this.children[0];}
 addEventListener(){}
}
const roots = new Map(['#cards','#session','#newest'].map(k=>[k,new Element('div')]));
global.document={querySelector:s=>roots.get(s)||null,querySelectorAll:()=>[],
 createElement:tag=>new Element(tag),getElementById:()=>null};
const flatten = node => [node,...node.children.flatMap(flatten)];
render({session:'server',version:1,cards:captures});
const nodes=flatten(roots.get('#cards'));
assert.equal(nodes.some(n=>n.textContent.includes('matching is ambiguous')),false);
assert.equal(nodes.filter(n=>n.className==='pair').length,5);
for(const row of nodes.filter(n=>n.className==='pair')){
 assert.equal(row.children[0].children.filter(n=>n.tagName==='details').length,1);
 assert.equal(row.children[2].children.filter(n=>n.tagName==='details').length,1);
}
assert.ok(nodes.some(n=>n.textContent.includes('Repeated historical appearance')));
assert.ok(nodes.some(n=>n.tagName==='pre'&&n.textContent.includes('internal_chat_message_metadata_passthrough')));
// A genuine conflict must still reach the visible warning and both call details.
roots.get('#cards').replaceChildren(); cards.clear();
render({session:'server',version:2,cards:[capture(4,'conflict',[call,{...call,input:'pwd'},result])]});
const conflicting=flatten(roots.get('#cards'));
assert.ok(conflicting.some(n=>n.textContent.includes('matching is ambiguous')));
assert.equal(conflicting.filter(n=>n.className==='pair').length,3);
for(const row of conflicting.filter(n=>n.className==='pair'))
 assert.equal(row.children[0].children.filter(n=>n.tagName==='details').length,2);
""")

    def test_tool_identity_and_input_conflicts(self):
        self.run_dashboard_js(r"""
for(const changed of [{...call,name:'other'}, {...call,type:'function_call'},
 {...call,input:'pwd'}, {...call,arguments:'different'}]){
 const pair=pairFor(toolIndex([capture(1,'scope',[call,changed,result])]),'scope');
 assert.equal(pair.call.length,2); assert.equal(pair.result.length,1);
 assert.strictEqual(pair.call[0],call); assert.strictEqual(pair.call[1],changed);
}
// Supported function/Anthropic/Chat Completions argument representations.
for(const original of [
 {type:'function_call',call_id:call.call_id,name:'exec',arguments:'{"a":1}'},
 {type:'tool_use',id:call.call_id,name:'exec',input:{a:1,b:[2,3]}},
 {id:call.call_id,type:'function',function:{name:'exec',arguments:'{"a":1}'}}
]){
 const wrap = value => original.type==='function'?{role:'assistant',tool_calls:[value]}:value;
 const reordered=Object.fromEntries(Object.entries(original).reverse());
 const same=toolIndex([capture(1,'scope',[wrap(original),wrap(reordered)])]);
 assert.equal(pairFor(same,'scope').call.length,1);
 const changed=original.function?{...original,function:{...original.function,arguments:'{"a":2}'}}:
  original.input?{...original,input:{a:2,b:[2,3]}}:{...original,arguments:'{"a":2}'};
 const conflict=toolIndex([capture(1,'scope',[wrap(original),wrap(changed)])]);
 assert.equal(pairFor(conflict,'scope').call.length,2);
}
const objectCall={...call,input:{a:1,b:[2,3]}};
assert.equal(pairFor(toolIndex([capture(1,'scope',[objectCall,
 {...objectCall,input:{b:[2,3],a:1}}])]),'scope').call.length,1);
assert.equal(pairFor(toolIndex([capture(1,'scope',[objectCall,
 {...objectCall,input:{a:1,b:[3,2]}}])]),'scope').call.length,2);
const resultConflict=pairFor(toolIndex([capture(1,'scope',[call,result,{...result,output:'different'}])]),'scope');
assert.equal(resultConflict.result.length,2);
""")

    def test_tool_ids_and_scopes_remain_separate(self):
        self.run_dashboard_js(r"""
const other={...call,call_id:'other'};
const index=toolIndex([capture(1,'one',[call,other]),capture(2,'two',[call,result]),
 capture(3,'one',[{...result,call_id:'other'}])]);
assert.equal(index.logical.size,3);
assert.equal(pairFor(index,'one').result.length,0);
assert.equal(pairFor(index,'one','other').result.length,1);
assert.equal(pairFor(index,'two').result.length,1);
const unscoped=toolIndex([capture(1,null,[call]),capture(2,null,[result])]);
assert.equal(unscoped.logical.size,2);
assert.equal(pairFor(unscoped,'unscoped-capture-1').result.length,0);
assert.equal(pairFor(unscoped,'unscoped-capture-2').call.length,0);
const missing=toolIndex([capture(1,'scope',[{type:'custom_tool_call',name:'exec',input:''},
 {type:'custom_tool_call_output',output:'unknown'}])]);
assert.equal(missing.logical.size,2);
""")

    def test_parsed_events_render_text_and_tool_items(self):
        import shutil
        import subprocess
        from pathlib import Path
        runtime = shutil.which('node') or shutil.which('nodejs')
        if not runtime:
            self.skipTest('JavaScript runtime unavailable; browser interpretation requires validation')
        script = (Path(__file__).resolve().parents[1] / 'web/app.js').read_text()
        # Execute the actual dashboard interpreter, without starting its live feed.
        script = script.split("$('#newest').onclick=")[0]
        script += r"""
const assert = require('node:assert/strict');
const card = {events: [
 {type:'response.created', response:{}},
 {type:'response.output_text.delta', delta:'שלום 🐈'},
 {type:'response.output_item.added', output_index:0,
  item:{id:'tool1', type:'custom_tool_call', call_id:'call1', name:'exec_command', input:''}},
 {type:'response.custom_tool_call_input.delta', item_id:'tool1', delta:'cat sample.txt'}
]};
const result = responseItems(card);
assert.equal(result.text, 'שלום 🐈');
assert.equal(result.items[0].name, 'exec_command');
assert.equal(result.items[0].input, 'cat sample.txt');
assert.equal(toolParts(result.items[0])[0].id, 'call1');
assert.equal(category(result.items[0])[0], 'call');
assert.equal(card.events[2].item.input, ''); // Interpretation preserves captured events.
assert.equal(responseItems({events:[], response:'{"output":[{"type":"message","content":"hello"}]}'}).items[0].content, 'hello');
assert.deepEqual(responseItems({events:[], response:'plain text'}), {items:[], text:''});
"""
        subprocess.run([runtime, '-e', script], check=True, capture_output=True, text=True)


class OfflineRelayTests(unittest.TestCase):
    def test_byte_preserving_relay_and_headers(self):
        for content_type in (None, 'text/event-stream', 'application/json', 'text/plain'):
            with self.subTest(content_type=content_type):
                self.check_relay(content_type)

    def check_relay(self, content_type):
        import io
        from types import SimpleNamespace
        from unittest.mock import patch
        chunks=[b'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',b'data: [DONE]\n\n']
        if content_type == 'application/json': chunks = [b'{"output": []}']
        if content_type == 'text/plain': chunks = [b'hello plain text']
        expected = b''.join(chunks)
        response_headers = [('Set-Cookie', 'private'), ('X-Upstream', 'unchanged')]
        if content_type: response_headers.append(('Content-Type', content_type))
        class Reply:
            status=200;reason='OK'
            def getheaders(self):return response_headers
            def getheader(self,k,default=None):return dict(self.getheaders()).get(k,default)
            def read1(self,n):return chunks.pop(0) if chunks else b''
        class Connection:
            sock=SimpleNamespace(settimeout=lambda n:None)
            def __init__(self,*a,**kw):pass
            def connect(self):pass
            def request(self,*a,**kw):self.sent=(a,kw);sent.append(self.sent)
            def getresponse(self):return Reply()
            def close(self):pass
        sent=[];handler=proxy.Tap.__new__(proxy.Tap)
        handler.command='POST';handler.path='/responses';handler.headers={'Content-Length':'2','Authorization':'Bearer private'}
        handler.rfile=io.BytesIO(b'{}');handler.wfile=io.BytesIO();handler.server=SimpleNamespace(store=Store())
        forwarded_headers=[]
        handler.send_response=lambda *a:None;handler.send_header=lambda *a:forwarded_headers.append(a);handler.end_headers=lambda:None
        with patch.object(proxy.http.client,'HTTPConnection',Connection),patch.object(proxy,'UPSTREAM','http://example.test/base'):
            handler.relay()
        self.assertEqual(sent[0][0][:2],('POST','/base/responses'))
        self.assertEqual(sent[0][1]['headers']['Authorization'],'Bearer private')
        card = handler.server.store.cards[0]
        self.assertEqual(handler.wfile.getvalue(), expected)
        self.assertEqual(base64.b64decode(card['response_base64']), expected)
        self.assertEqual(card['response_headers']['Set-Cookie'], '[redacted]')
        self.assertEqual(forwarded_headers, response_headers + [('Connection', 'close')])
        self.assertEqual('Content-Type' in card['response_headers'], content_type is not None)
        self.assertEqual(bool(card['events']), content_type in (None, 'text/event-stream'))
        self.assertEqual(handler.server.store.cards[0]['state'],'completed')

if __name__=='__main__':unittest.main()
