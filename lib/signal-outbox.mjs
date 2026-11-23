import {mkdir,readdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';

// Keep public market observations until the private Site acknowledges the D1 write.
export async function createSignalOutbox(dir,send,onError){
  await mkdir(dir,{recursive:true});
  let draining=false,sequence=0,lastError=0;
  async function flush(){
    if(draining)return;
    draining=true;
    try{
      for(const file of (await readdir(dir)).filter(x=>/^\d+-\d+-\d+\.gz$/.test(x)).sort()){
        const path=join(dir,file);
        if(Date.now()-Number(file.split('-')[0])<7*86400000)await send(await readFile(path));
        await unlink(path);
      }
    }catch(e){if(Date.now()-lastError>30000){lastError=Date.now();onError(e)}}
    finally{draining=false;}
  }
  async function put(frame){
    const key=Date.now()+'-'+String(sequence++).padStart(8,'0')+'-'+process.pid;
    const path=join(dir,key+'.gz');
    await writeFile(path+'.part',gzipSync(JSON.stringify(frame),{level:3}));
    await rename(path+'.part',path);
    void flush();
  }
  void flush();
  return {put,flush};
}
