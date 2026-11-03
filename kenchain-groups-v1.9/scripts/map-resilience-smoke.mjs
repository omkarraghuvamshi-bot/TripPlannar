import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const checks=[];
const check=(name,pass)=>checks.push({name,pass:Boolean(pass)});
const listen=(server,port=0)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve(server.address().port));});
const close=server=>new Promise(resolve=>server.close(()=>resolve()));
async function freePort(){const server=net.createServer();const port=await listen(server);await close(server);return port;}

const mockProviders=http.createServer((req,res)=>{
  // Every external place provider deliberately fails to reproduce a real upstream 502.
  res.writeHead(502,{'Content-Type':'text/plain'});
  res.end('mock upstream 502');
});
const mockPort=await listen(mockProviders);
const appPort=await freePort();
const app=spawn(process.execPath,['backend/server.js'],{
  cwd:process.cwd(),
  env:{...process.env,PORT:String(appPort),DATABASE_URL:'',PHOTON_URL:`http://127.0.0.1:${mockPort}/photon/`,NOMINATIM_URL:`http://127.0.0.1:${mockPort}/nominatim`,OVERPASS_API_URL:`http://127.0.0.1:${mockPort}/interpreter`,OVERPASS_API_URLS:'',OVERPASS_DISABLE_PUBLIC_FALLBACKS:'true'},
  stdio:['ignore','pipe','pipe']
});
let output='';
app.stdout.on('data',chunk=>output+=chunk.toString());
app.stderr.on('data',chunk=>output+=chunk.toString());
const base=`http://127.0.0.1:${appPort}/api`;
async function waitForApp(){
  for(let i=0;i<80;i++){
    if(app.exitCode!==null)throw new Error(`App exited before ready. ${output}`);
    try{const r=await fetch(`${base}/health`);if(r.ok)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw new Error(`App did not become ready. ${output}`);
}
async function get(path){
  const response=await fetch(`${base}${path}`);
  const data=await response.json().catch(()=>({}));
  check(`${path} returns a handled JSON response (not 502)`,response.status===200);
  return data;
}
try{
  await waitForApp();
  const suggestions=await get('/places/suggest?q=Gokarna');
  check('Place suggestions use the curated area centre when geocoders fail',Array.isArray(suggestions.items)&&suggestions.items.some(item=>/Gokarna/i.test(item.label||item.name)));

  const beaches=await get('/places/search?area=Gokarna&category=beaches');
  check('Tourist place search returns curated coastal pins when Overpass is down',beaches.live===false&&Array.isArray(beaches.items)&&beaches.items.some(item=>/Om Beach|Kudle Beach/i.test(item.title)));
  check('Fallback place search retains map coordinates',Number.isFinite(beaches.centre?.latitude)&&Number.isFinite(beaches.centre?.longitude));

  const adventures=await get('/adventures/search?area=Gokarna');
  check('Adventure search stays usable when all live place providers return 502',adventures.live===false&&Array.isArray(adventures.items)&&adventures.items.length>0);
  check('Adventure fallback labels itself as curated',/curated/i.test(adventures.source||'')||/curated/i.test(adventures.notice||''));

  const unified=await get('/search/suggest?q=Coorg');
  check('Unified typeahead returns local catalogue suggestions during map-provider outage',Array.isArray(unified.items)&&unified.items.length>0);
} catch(error){
  console.error(`Map resilience smoke test failed: ${error.message}\n${output}`);
  process.exitCode=1;
} finally{
  app.kill('SIGTERM');
  await new Promise(resolve=>{if(app.exitCode!==null)return resolve();app.once('exit',resolve);setTimeout(resolve,3000);});
  await close(mockProviders);
}
for(const result of checks)console.log(`${result.pass?'PASS':'FAIL'} ${result.name}`);
if(checks.some(result=>!result.pass))process.exitCode=1;
if(!process.exitCode)console.log(`\n${checks.length} map resilience checks passed.`);
