import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createGateway} from './server.mjs';

const origin='https://gapdesk.example',host='gapdesk.example';

test('owner gateway serves local assets and only proxies the supported browser API',async t=>{
  const staticDir=await mkdtemp(path.join(os.tmpdir(),'gapdesk-gateway-'));
  t.after(()=>rm(staticDir,{recursive:true,force:true}));
  await writeFile(path.join(staticDir,'index.html'),'<!doctype html><title>Gapdesk</title>');
  const calls=[];
  let finishStream;
  const request=async(endpoint,options)=>{
    calls.push({endpoint,options});
    if(endpoint.pathname==='/api/observations')return new Response(null,{status:204,headers:{'X-Observation-Revision':'17'}});
    if(endpoint.pathname==='/api/history')return Response.redirect('https://example.invalid/login',302);
    if(endpoint.searchParams.get('stream')==='1'){
      const stream=new ReadableStream({start(controller){
        controller.enqueue(Buffer.from('{"type":"observation"}\n'));
        finishStream=()=>{controller.enqueue(Buffer.from('{"type":"snapshot"}\n'));controller.close();};
      }});
      return new Response(stream,{headers:{'content-type':'application/x-ndjson'}});
    }
    return Response.json({ok:true});
  };
  const server=await createGateway({origin,token:'test-service-token',staticDir,request});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const send=(target,method='GET',headers={})=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:target,method,headers:{Host:host,...headers}},res=>{
      const data=[];res.on('data',b=>data.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(data).toString()}));
    });req.on('error',reject);req.end(method==='POST'?'{"amount":500}':undefined);
  });
  assert.match((await send('/')).body,/Gapdesk/);
  assert.equal((await send('/','HEAD')).body,'');
  assert.equal((await send('/','GET',{Host:'untrusted.example'})).status,403);
  assert.equal((await send('/%2e%2e/private')).status,400);
  assert.equal((await send('/api/observations?revision=16','GET',{Authorization:'Basic browser',Cookie:'user=private'})).headers['x-observation-revision'],'17');
  assert.equal(calls[0].endpoint.href,'https://dokdo-gapdesk.awakeant23.chatgpt.site/api/observations?revision=16');
  assert.deepEqual(calls[0].options.headers,{'OAI-Sites-Authorization':'Bearer test-service-token',Accept:'application/json, application/x-ndjson'});
  assert.equal(calls[0].options.redirect,'error');
  const headers={Origin:origin,'Content-Type':'application/json'};
  assert.equal((await send('/api/scan?mode=settings','POST',headers)).status,200);
  assert.equal(calls.at(-1).options.body.toString(),'{"amount":500}');
  for(const route of ['/api/bridges','/api/quote'])assert.equal((await send(route,'POST',headers)).status,200);
  const count=calls.length;
  for(const route of ['/api/relay','/api/signal-batches','/api/scan?mode=monitor','/api/observations','/api/scan?mode=settings&mode=monitor']){
    assert.equal((await send(route,'POST',headers)).status,405);
  }
  assert.equal((await send('/api/settings','GET',{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await send('/api/quote','POST',{...headers,Origin:'https://elsewhere.example'})).status,403);
  assert.equal((await send('/api/quote','POST',{'Content-Type':'application/json'})).status,403);
  assert.equal((await send('/api/quote','POST',{Origin:origin,'Content-Type':'text/plain'})).status,415);
  assert.equal(calls.length,count);
  assert.equal((await send('/api/history')).status,502);
  const streamRequest=http.get({host:'127.0.0.1',port:server.address().port,path:'/api/scan?stream=1',headers:{Host:host}});
  const [response]=await once(streamRequest,'response');
  const messages=response[Symbol.asyncIterator]();
  const first=await messages.next();
  assert.match(first.value.toString(),/observation/);
  finishStream();
  const last=await messages.next();
  assert.match(last.value.toString(),/snapshot/);
  assert.ok((await messages.next()).done);
});
