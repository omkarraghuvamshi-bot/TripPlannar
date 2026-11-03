import net from 'node:net';
import { spawn } from 'node:child_process';

const checks=[];
const check=(name,pass)=>checks.push({name,pass:Boolean(pass)});
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const port=await freePort();
const app=spawn(process.execPath,['backend/server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),DATABASE_URL:''},stdio:['ignore','pipe','pipe']});
let output='';app.stdout.on('data',chunk=>output+=chunk.toString());app.stderr.on('data',chunk=>output+=chunk.toString());
const base=`http://127.0.0.1:${port}`;
async function wait(){for(let i=0;i<80;i++){if(app.exitCode!==null)throw new Error(`Server exited early: ${output}`);try{const response=await fetch(`${base}/api/health`);if(response.ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,125));}throw new Error(`Server failed to start: ${output}`);}
try{
  await wait();
  const htmlResponse=await fetch(`${base}/`),html=await htmlResponse.text();
  check('homepage responds successfully',htmlResponse.ok);
  check('frontend entrypoint is loaded as an ES module',/<script\s+type="module"\s+src="\/app\.js"/.test(html));
  check('boot watchdog provides a readable retry state',html.includes('showKenchainBootError')&&html.includes('Retry'));
  const jsResponse=await fetch(`${base}/app.js`),js=await jsResponse.text();
  check('app module is served successfully',jsResponse.ok);
  check('app module has JavaScript MIME type',/javascript/i.test(jsResponse.headers.get('content-type')||''));
  check('app module imports the Google Places helper',/^import\s+.*from\s+'\.\/google-places\.js';/m.test(js));
  const placesResponse=await fetch(`${base}/google-places.js`);
  check('Google Places module is served successfully',placesResponse.ok&&/javascript/i.test(placesResponse.headers.get('content-type')||''));
  const [catalog,restaurants,maps]=await Promise.all(['/api/catalog','/api/restaurants','/api/maps/config'].map(path=>fetch(`${base}${path}`)));
  check('initial catalog API is available',catalog.ok);
  check('initial restaurants API is available',restaurants.ok);
  check('map configuration API is available',maps.ok);
} catch(error){
  console.error(`Startup smoke test failed: ${error.message}\n${output}`);process.exitCode=1;
} finally{
  app.kill('SIGTERM');
  await new Promise(resolve=>{if(app.exitCode!==null)return resolve();app.once('exit',resolve);setTimeout(resolve,3000);});
}
for(const result of checks)console.log(`${result.pass?'PASS':'FAIL'} ${result.name}`);
if(checks.some(result=>!result.pass))process.exitCode=1;
if(!process.exitCode)console.log(`\\n${checks.length} startup checks passed.`);
