import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const checks=[];
const check=(name,pass)=>checks.push({name,pass:Boolean(pass)});
const listen=(server,port=0)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve(server.address().port));});
const close=server=>new Promise(resolve=>server.close(()=>resolve()));
const freePort=async()=>{const server=net.createServer();const port=await listen(server);await close(server);return port;};
let photonParams=null;
const indianAreas={
  puri:{name:'Puri',city:'Puri',state:'Odisha',lat:19.8135,lon:85.8312,place:'Shree Jagannath Temple'},
  jaipur:{name:'Jaipur',city:'Jaipur',state:'Rajasthan',lat:26.9124,lon:75.7873,place:'Hawa Mahal'}
};
const providers=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/photon/api/'||url.pathname==='/api/'){
    photonParams=url.searchParams;
    const q=(url.searchParams.get('q')||'').toLowerCase();
    const area=q.includes('jaipur')?indianAreas.jaipur:indianAreas.puri;
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({features:[
      {type:'Feature',geometry:{type:'Point',coordinates:[area.lon,area.lat]},properties:{name:area.name,city:area.city,state:area.state,country:'India',countrycode:'IN'}},
      {type:'Feature',geometry:{type:'Point',coordinates:[-0.1276,51.5072]},properties:{name:'London',city:'London',state:'England',country:'United Kingdom',countrycode:'GB'}}
    ]}));
    return;
  }
  if(url.pathname==='/interpreter'&&req.method==='POST'){
    let body='';for await(const chunk of req)body+=chunk.toString();
    const isJaipur=body.toLowerCase().includes('26.9124')||body.toLowerCase().includes('75.7873');
    const area=isJaipur?indianAreas.jaipur:indianAreas.puri;
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({elements:[{type:'node',id:isJaipur?88002:88001,lat:area.lat+0.001,lon:area.lon+0.001,tags:{name:area.place,amenity:'place_of_worship',tourism:'attraction'}}],osm3s:{timestamp_osm_base:'2026-11-03T00:00:00Z'}}));
    return;
  }
  res.writeHead(404);res.end('not found');
});
const providerPort=await listen(providers);
const appPort=await freePort();
const app=spawn(process.execPath,['backend/server.js'],{
  cwd:process.cwd(),
  env:{...process.env,PORT:String(appPort),DATABASE_URL:'',GOOGLE_MAPS_API_KEY:'',PHOTON_URL:`http://127.0.0.1:${providerPort}/photon/api/`,NOMINATIM_URL:`http://127.0.0.1:${providerPort}/nominatim`,OVERPASS_API_URL:`http://127.0.0.1:${providerPort}/interpreter`,OVERPASS_API_URLS:'',OVERPASS_DISABLE_PUBLIC_FALLBACKS:'true'},
  stdio:['ignore','pipe','pipe']
});
let output='';app.stdout.on('data',chunk=>output+=chunk.toString());app.stderr.on('data',chunk=>output+=chunk.toString());
const base=`http://127.0.0.1:${appPort}/api`;
async function waitForApp(){for(let i=0;i<80;i++){if(app.exitCode!==null)throw new Error(`App exited early: ${output}`);try{const response=await fetch(`${base}/health`);if(response.ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,125));}throw new Error(`App did not start: ${output}`);}
async function get(path){const response=await fetch(`${base}${path}`);const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`${path}: HTTP ${response.status} ${data.error||''}`);return data;}
try{
  await waitForApp();
  const puriSuggestions=await get('/places/suggest?q=Puri');
  check('Puri, Odisha suggestions resolve to an Indian place',puriSuggestions.items?.some(item=>/Puri/.test(item.name)&&/Odisha/.test(item.state)&&item.country==='India'));
  check('Photon fallback does not use fixed Bengaluru latitude/longitude bias',Boolean(photonParams)&&!photonParams.has('lat')&&!photonParams.has('lon'));
  check('Photon fallback filters out non-India suggestions',!(puriSuggestions.items||[]).some(item=>/London/.test(item.name)));

  const puriSearch=await get('/places/search?area=Puri%2C%20Odisha%2C%20India&category=temples');
  check('Explore map search resolves Puri outside Karnataka',Math.abs(puriSearch.centre?.latitude-19.8135)<0.01&&Math.abs(puriSearch.centre?.longitude-85.8312)<0.01);
  check('Puri tourist category returns a mapped local POI',puriSearch.items?.some(item=>item.title==='Shree Jagannath Temple'));
  check('Puri map result is source-attributed OpenStreetMap data',puriSearch.source==='OpenStreetMap'&&puriSearch.attribution?.includes('OpenStreetMap'));

  const jaipurSuggestions=await get('/places/suggest?q=Jaipur');
  check('Jaipur, Rajasthan suggestions resolve in another state',jaipurSuggestions.items?.some(item=>/Jaipur/.test(item.name)&&/Rajasthan/.test(item.state)));
  const jaipurSearch=await get('/places/search?area=Jaipur%2C%20Rajasthan%2C%20India&category=temples');
  check('Explore map search resolves Jaipur outside Karnataka',Math.abs(jaipurSearch.centre?.latitude-26.9124)<0.01&&Math.abs(jaipurSearch.centre?.longitude-75.7873)<0.01);
} catch(error){
  console.error(`India-wide search API smoke failed: ${error.message}\n${output}`);
  process.exitCode=1;
} finally{
  app.kill('SIGTERM');
  await new Promise(resolve=>{if(app.exitCode!==null)return resolve();app.once('exit',resolve);setTimeout(resolve,3000);});
  await close(providers);
}
for(const result of checks)console.log(`${result.pass?'PASS':'FAIL'} ${result.name}`);
if(checks.some(result=>!result.pass))process.exitCode=1;
if(!process.exitCode)console.log(`\n${checks.length} India-wide search API checks passed.`);
