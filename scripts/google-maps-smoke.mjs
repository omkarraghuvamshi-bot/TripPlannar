import net from 'node:net';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const checks=[];
const check=(name,pass)=>checks.push({name,pass:Boolean(pass)});
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const port=await freePort();
const key='AIzaGoogleMapsSmokeTestKey';
const mapId='kenchain-smoke-map-id';
const app=spawn(process.execPath,['backend/server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),DATABASE_URL:'',GOOGLE_MAPS_API_KEY:key,GOOGLE_MAPS_MAP_ID:mapId},stdio:['ignore','pipe','pipe']});
let output='';app.stdout.on('data',chunk=>output+=chunk.toString());app.stderr.on('data',chunk=>output+=chunk.toString());
const base=`http://127.0.0.1:${port}`;
async function waitForApp(){for(let i=0;i<80;i++){if(app.exitCode!==null)throw new Error(`API exited early: ${output}`);try{const response=await fetch(`${base}/api/health`);if(response.ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,125));}throw new Error(`API did not start: ${output}`);}
try{
  await waitForApp();
  const response=await fetch(`${base}/api/maps/config`),config=await response.json();
  check('maps config API responds successfully',response.ok);
  check('Google Maps key is exposed to the browser map client when configured',config.googleMapsApiKey===key);
  check('Google Map ID is passed through configuration',config.googleMapsMapId===mapId);
  check('Google Maps is selected as the configured default provider',config.provider==='Google Maps'&&config.googleMapsConfigured===true);
  const appSource=await readFile(new URL('../frontend/app.js',import.meta.url),'utf8');
  check('Maps JavaScript loader is configured for async weekly loading',appSource.includes('maps.googleapis.com/maps/api/js')&&appSource.includes('loading=async')&&appSource.includes('auth_referrer_policy=origin'));
  check('Google Place Autocomplete uses the Places Data API and session token',appSource.includes('AutocompleteSuggestion.fetchAutocompleteSuggestions')&&appSource.includes('AutocompleteSessionToken'));
  check('selected place retrieves coordinates and fields from Places',appSource.includes('place.fetchFields({fields:[\'displayName\',\'formattedAddress\',\'location\',\'types\',\'id\']})'));
  check('Google directions use the current Routes API instead of legacy DirectionsService',appSource.includes('Route.computeRoutes')&&!appSource.includes('DirectionsService'));
  check('Google route renders polylines and turn-by-turn instruction steps',appSource.includes('route.createPolylines')&&appSource.includes('step.instructions'));
  check('Google Places Text Search powers live place discovery',appSource.includes('libs.places.Place.searchByText')&&appSource.includes('searchGoogleTouristPlaces'));
  check('Mapbox provider code is removed from the frontend',!appSource.toLowerCase().includes('mapbox'));
  check('Google Maps + Places is the only displayed provider',appSource.includes('Google Maps + Places'));
  const backendSource=await readFile(new URL('../backend/server.js',import.meta.url),'utf8');
  check('Mapbox server tokens and endpoints are removed',!backendSource.toLowerCase().includes('mapbox'));
} catch(error){
  console.error(`Google Maps smoke test failed: ${error.message}\n${output}`);
  process.exitCode=1;
} finally{
  app.kill('SIGTERM');
  await new Promise(resolve=>{if(app.exitCode!==null)return resolve();app.once('exit',resolve);setTimeout(resolve,3000);});
}
for(const result of checks)console.log(`${result.pass?'PASS':'FAIL'} ${result.name}`);
if(checks.some(result=>!result.pass))process.exitCode=1;
if(!process.exitCode)console.log(`\n${checks.length} Google Maps integration checks passed (API wiring only; no paid Google request made).`);
