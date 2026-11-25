import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {chmod,readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const upstreamOrigin='https://dokdo-gapdesk.awakeant23.chatgpt.site';
const readable=new Set(['/api/settings','/api/observations','/api/scan','/api/events','/api/signals','/api/history']);
const quoteRoutes=new Set(['/api/quote','/api/bridges']);
const mime=new Map(Object.entries({
  '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png',
  '.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf'
}));
const maxBodyBytes=32*1024;

function fail(res,code){
  if(res.headersSent){res.destroy();return;}
  res.writeHead(code,{'Content-Type':'text/plain; charset=utf-8'});
  res.end(({400:'잘못된 요청입니다.',403:'접근할 수 없습니다.',404:'페이지를 찾을 수 없습니다.',
    405:'허용되지 않은 요청입니다.',413:'요청 크기를 줄여 주세요.',415:'JSON 요청이 필요합니다.',
    502:'시세 서버에 연결할 수 없습니다.'})[code]);
}

async function serveFile(req,res,root,pathname){
  const relativePath=pathname==='/'?'index.html':pathname.slice(1);
  const type=mime.get(path.extname(relativePath).toLowerCase());
  if(!type||relativePath.split('/').some(segment=>!segment||segment.startsWith('.'))){
    fail(res,404);return;
  }
  let file,info;
  try{
    file=await realpath(path.join(root,relativePath));
    if(!file.startsWith(root+path.sep)){fail(res,404);return;}
    info=await stat(file);
    if(!info.isFile()){fail(res,404);return;}
  }catch{fail(res,404);return;}
  res.setHeader('Content-Type',type);
  res.setHeader('Content-Length',info.size);
  if(req.method==='HEAD'){res.end();return;}
  await pipeline(createReadStream(file),res);
}

async function forward(req,res,url,origin,token,request){
  const settings=url.pathname==='/api/scan'&&url.searchParams.size===1&&url.searchParams.get('mode')==='settings';
  const allowedWrite=req.method==='POST'&&(settings||quoteRoutes.has(url.pathname)&&!url.search);
  if(!allowedWrite&&!(req.method==='GET'&&readable.has(url.pathname))){fail(res,405);return;}
  const headers={'OAI-Sites-Authorization':'Bearer '+token,Accept:'application/json, application/x-ndjson'};
  let body;
  if(allowedWrite){
    if(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'){fail(res,403);return;}
    if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){fail(res,415);return;}
    const chunks=[];
    let total=0;
    for await(const chunk of req){
      total+=chunk.length;
      if(total>maxBodyBytes){fail(res,413);return;}
      chunks.push(chunk);
    }
    body=Buffer.concat(chunks,total);
    headers['Content-Type']='application/json';
  }
  // Forward neither the browser's credentials nor a caller-supplied destination.
  const endpoint=new URL(url.pathname,upstreamOrigin);
  endpoint.search=url.search;
  const abort=new AbortController();
  const onClose=()=>abort.abort();
  res.once('close',onClose);
  try{
    const reply=await request(endpoint,{method:req.method,headers,body,redirect:'error',
      signal:AbortSignal.any([abort.signal,AbortSignal.timeout(120_000)])});
    if(reply.status>=300&&reply.status<400){fail(res,502);return;}
    // Node fetch decodes compressed data. Transfer its decoded stream without
    // upstream encoding/length, preserving NDJSON frame delivery and revisions.
    for(const name of ['content-type','x-observation-revision','etag']){
      if(reply.headers.has(name))res.setHeader(name,reply.headers.get(name));
    }
    res.statusCode=reply.status;
    if(!reply.body){res.end();return;}
    await pipeline(Readable.fromWeb(reply.body),res);
  }finally{res.off('close',onClose);}
}

export async function createGateway({origin,staticDir,token,request=fetch}){
  const site=new URL(origin);
  if(site.protocol!=='https:'||site.origin!==origin||!token?.trim()||/[\r\n]/.test(token)){
    throw Error('Invalid Gapdesk origin or Sites credential');
  }
  const root=await realpath(staticDir);
  if(!(await stat(path.join(root,'index.html'))).isFile())throw Error('Missing Gapdesk frontend');
  return createServer({requestTimeout:30_000,headersTimeout:15_000},async(req,res)=>{
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');
    try{
      if(req.headers.host!==site.host){fail(res,403);return;}
      const target=req.url||'',pathname=target.split('?')[0];
      if(!/^\/[A-Za-z0-9_./-]*$/.test(pathname)||pathname.includes('//')||pathname.split('/').some(s=>s==='.'||s==='..')){
        fail(res,400);return;
      }
      const url=new URL(target,origin);
      if(url.pathname.startsWith('/api/')){
        if(req.headers['sec-fetch-site']==='cross-site'){fail(res,403);return;}
        await forward(req,res,url,origin,token,request);
      }else if(req.method==='GET'||req.method==='HEAD'){
        await serveFile(req,res,root,url.pathname);
      }else fail(res,405);
    }catch{if(!res.destroyed)fail(res,502);}
  });
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const {GAPDESK_ORIGIN:origin,GAPDESK_STATIC_DIR:staticDir,GAPDESK_SOCKET:socket,CREDENTIALS_DIRECTORY}=process.env;
  const port=Number(process.env.GAPDESK_PORT||8787);
  if(!CREDENTIALS_DIRECTORY||!staticDir||(socket?!path.isAbsolute(socket):!Number.isInteger(port)||port<1||port>65535)){
    throw Error('Invalid Gapdesk service configuration');
  }
  const token=(await readFile(path.join(CREDENTIALS_DIRECTORY,'sites-token'),'utf8')).trim();
  const server=await createGateway({origin,staticDir,token});
  if(socket){
    // systemd supplies an isolated RuntimeDirectory owned by the service and
    // proxy group, and removes the socket when the service is stopped.
    process.umask(0o077);
    await new Promise((resolve,reject)=>server.once('error',reject).listen(socket,resolve));
    await chmod(socket,0o660);
  }else server.listen(port,'127.0.0.1');
}
