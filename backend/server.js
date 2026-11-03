import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const DATA_FILE = path.join(__dirname, 'data', 'store.json');
// Tiny .env reader keeps local setup dependency-free. Existing process variables win.
try {
  const envFile = await fs.readFile(path.join(ROOT, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
} catch (error) {
  if (error.code !== 'ENOENT') console.warn('Could not read optional .env file:', error.message);
}
let databasePool = null;
const PORT = Number(process.env.PORT || 4000);
// Google Maps JavaScript API key is a browser key: expose it only to the map client
// via /api/maps/config and restrict it by HTTP referrer + API in Google Cloud.
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const GOOGLE_MAPS_MAP_ID = process.env.GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID';
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon' };
const loginFailures = new Map();
const json = (res, status, payload) => { const body = JSON.stringify(payload); res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Content-Length':Buffer.byteLength(body), 'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'*' }); res.end(body); };
async function initializeStorage(){
  if(!process.env.DATABASE_URL) return;
  const { Pool } = await import('pg');
  databasePool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  await databasePool.query(`
    CREATE TABLE IF NOT EXISTS kenchain_bookings (
      reference text PRIMARY KEY, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS kenchain_users (
      id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, phone text NOT NULL DEFAULT '', password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS kenchain_sessions (
      token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES kenchain_users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS kenchain_sessions_expiry_idx ON kenchain_sessions(expires_at);
  `);
  await databasePool.query(`DELETE FROM kenchain_sessions WHERE expires_at < now()`);
}
async function readStore(){
  const store = JSON.parse(await fs.readFile(DATA_FILE,'utf8'));
  store.users ||= []; store.sessions ||= []; store.vehicles ||= [];
  if(databasePool){
    const result = await databasePool.query('SELECT payload FROM kenchain_bookings ORDER BY created_at DESC');
    store.bookings = result.rows.map(row => row.payload);
  }
  return store;
}
async function writeStore(data){
  if(!databasePool){
    const tmp = `${DATA_FILE}.tmp`;
    await fs.writeFile(tmp,JSON.stringify(data,null,2));
    await fs.rename(tmp,DATA_FILE);
    return;
  }
  const client = await databasePool.connect();
  try {
    await client.query('BEGIN');
    for(const booking of data.bookings){
      await client.query(
        `INSERT INTO kenchain_bookings(reference,payload,created_at,updated_at)
         VALUES($1,$2::jsonb,COALESCE($3::timestamptz,now()),now())
         ON CONFLICT(reference) DO UPDATE SET payload=EXCLUDED.payload, updated_at=now()`,
        [booking.reference, JSON.stringify(booking), booking.createdAt || null]
      );
    }
    await client.query('COMMIT');
  } catch(error){
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function bodyJson(req){ let raw=''; for await(const chunk of req) { raw += chunk; if(raw.length > 1_000_000) throw new Error('Request is too large'); } return raw ? JSON.parse(raw) : {}; }
const scrypt = (password, salt) => new Promise((resolve,reject) => crypto.scrypt(password,salt,64,(error,key)=>error?reject(error):resolve(key.toString('hex'))));
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const parseCookies = header => Object.fromEntries(String(header||'').split(';').map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf('=');return [v.slice(0,i),decodeURIComponent(v.slice(i+1))];}));
function setSessionCookie(res, token, maxAge=60*60*24*30){
  const secure=process.env.NODE_ENV==='production'?' Secure':'';
  res.setHeader('Set-Cookie',`kg_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}
async function findUserByEmail(email){
  if(databasePool){const r=await databasePool.query('SELECT id,name,email,phone,password_hash,created_at FROM kenchain_users WHERE email=$1',[email]);return r.rows[0]||null;}
  const store=await readStore();return store.users.find(u=>u.email===email)||null;
}
async function saveUser(user){
  if(databasePool){await databasePool.query('INSERT INTO kenchain_users(id,name,email,phone,password_hash,created_at) VALUES($1,$2,$3,$4,$5,$6)',[user.id,user.name,user.email,user.phone,user.passwordHash,user.createdAt]);return;}
  const store=await readStore();store.users.push(user);await writeLocalStore(store);
}
async function writeLocalStore(store){const tmp=`${DATA_FILE}.tmp`;await fs.writeFile(tmp,JSON.stringify(store,null,2));await fs.rename(tmp,DATA_FILE);}
async function createSession(userId){
  const token=crypto.randomBytes(32).toString('base64url'), tokenHash=hashToken(token), expiresAt=new Date(Date.now()+30*86400000).toISOString();
  if(databasePool) await databasePool.query('INSERT INTO kenchain_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[tokenHash,userId,expiresAt]);
  else {const store=await readStore();store.sessions=store.sessions.filter(s=>new Date(s.expiresAt)>new Date());store.sessions.push({tokenHash,userId,expiresAt});await writeLocalStore(store);}
  return token;
}
async function currentUser(req){
  const token=parseCookies(req.headers.cookie).kg_session;if(!token)return null;const tokenHash=hashToken(token);
  if(databasePool){const r=await databasePool.query(`SELECT u.id,u.name,u.email,u.phone FROM kenchain_sessions s JOIN kenchain_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`,[tokenHash]);return r.rows[0]||null;}
  const store=await readStore(),session=store.sessions.find(s=>s.tokenHash===tokenHash&&new Date(s.expiresAt)>new Date());if(!session)return null;const user=store.users.find(u=>u.id===session.userId);return user?{id:user.id,name:user.name,email:user.email,phone:user.phone}:null;
}
async function deleteSession(req){const token=parseCookies(req.headers.cookie).kg_session;if(!token)return;const tokenHash=hashToken(token);if(databasePool)await databasePool.query('DELETE FROM kenchain_sessions WHERE token_hash=$1',[tokenHash]);else{const store=await readStore();store.sessions=store.sessions.filter(s=>s.tokenHash!==tokenHash);await writeLocalStore(store);}}
const touristCategories={
  temples:{label:'Temples & sacred places',tags:`nwr(around:R,LAT,LON)["amenity"="place_of_worship"];`,activities:['Temple architecture walks','Cultural and heritage tours','Photography','Local food trails'],image:'/assets/place-fallbacks/temples.svg'},
  beaches:{label:'Beaches & coastlines',tags:`nwr(around:R,LAT,LON)["natural"="beach"];nwr(around:R,LAT,LON)["leisure"="beach_resort"];`,activities:['Kayaking with local operators','Surf lessons','Coastal hikes','Beach camping'],image:'/assets/place-fallbacks/beaches.svg'},
  waterfalls:{label:'Waterfalls & nature',tags:`nwr(around:R,LAT,LON)["natural"="waterfall"];nwr(around:R,LAT,LON)["waterway"="waterfall"];`,activities:['Guided nature hikes','Landscape photography','Birdwatching','Canyoning only with licensed operators'],image:'/assets/place-fallbacks/waterfalls.svg'},
  heritage:{label:'Heritage & monuments',tags:`nwr(around:R,LAT,LON)["historic"];nwr(around:R,LAT,LON)["tourism"="museum"];nwr(around:R,LAT,LON)["tourism"="attraction"];`,activities:['Guided heritage walks','Museum visits','Architecture tours','Local craft experiences'],image:'/assets/place-fallbacks/heritage.svg'},
  wildlife:{label:'Wildlife & nature reserves',tags:`nwr(around:R,LAT,LON)["leisure"="nature_reserve"];nwr(around:R,LAT,LON)["boundary"="protected_area"];nwr(around:R,LAT,LON)["tourism"="zoo"];`,activities:['Guided wildlife safaris','Birdwatching','Nature interpretation trails','Wildlife photography'],image:'/assets/place-fallbacks/wildlife.svg'},
  hills:{label:'Hill stations & viewpoints',tags:`nwr(around:R,LAT,LON)["natural"="peak"];nwr(around:R,LAT,LON)["mountain_pass"];nwr(around:R,LAT,LON)["tourism"="alpine_hut"];`,activities:['Guided trekking','Camping','Cycling','Sunrise viewpoints'],image:'/assets/place-fallbacks/hills.svg'},
  lakes:{label:'Lakes & rivers',tags:`nwr(around:R,LAT,LON)["natural"="water"]["water"~"lake|reservoir"];nwr(around:R,LAT,LON)["waterway"="riverbank"];`,activities:['Boating where officially permitted','Kayaking with operators','Birdwatching','Lakeside nature walks'],image:'/assets/place-fallbacks/lakes.svg'}
};
const placeSearchCache=new Map();
const commonsImageCache = new Map();
const PLACE_IMAGE_CATEGORIES = new Set(['temples','beaches','waterfalls','heritage','wildlife','hills','lakes','stays']);
const categoryFallback = category => `/assets/place-fallbacks/${PLACE_IMAGE_CATEGORIES.has(String(category||'').toLowerCase()) ? String(category).toLowerCase() : 'heritage'}.svg`;
const plainText = value => clean(String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, ' ')).replace(/\s+/g, ' ');
const imageStopWords = new Set(['temple','temples','beach','beaches','waterfall','waterfalls','heritage','wildlife','hill','hills','lake','lakes','india','photo','image','view','tourism','tourist','place','district','city']);
function placeNameTokens(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(token => token.length > 2 && !imageStopWords.has(token));
}
async function findCommonsImage(title, category='heritage', location='') {
  const normalizedTitle=String(title).toLowerCase().trim();
  const normalizedLocation=String(location).toLowerCase().trim();
  const key = `${normalizedTitle}|${normalizedLocation}|${category}`;
  const cached = commonsImageCache.get(key);
  const cacheTtl=cached?.value?.matched?24*60*60*1000:2*60*1000;
  if (cached && Date.now() - cached.at < cacheTtl) return cached.value;
  const fallback = { imageUrl: categoryFallback(category), pageUrl: '', credit: 'Kenchain Groups category artwork', license: 'Illustrative fallback', matched: false };
  try {
    const query = new URL('https://commons.wikimedia.org/w/api.php');
    query.search = new URLSearchParams({
      action: 'query', generator: 'search', gsrsearch: `\"${title}\" ${normalizedLocation} ${category} India`,
      gsrnamespace: '6', gsrlimit: '8', prop: 'imageinfo', iiprop: 'url|extmetadata',
      iiurlwidth: '1200', format: 'json', origin: '*'
    }).toString();
    const response = await fetch(query, {
      headers: { 'User-Agent': 'KenchainGroups/1.6 (place-specific destination images; contact: hello@kenchaingroups.example)' },
      signal: AbortSignal.timeout(6500)
    });
    if (!response.ok) throw new Error(`Wikimedia Commons returned ${response.status}`);
    const payload = await response.json();
    const tokens = placeNameTokens(title);
    const locationTokens = placeNameTokens(location);
    const pages = Object.values(payload.query?.pages || {}).filter(row => row.imageinfo?.[0]?.thumburl || row.imageinfo?.[0]?.url);
    const ranked = pages.map(page => {
      const fileTokens = placeNameTokens(String(page.title || '').replace(/^File:/i, ''));
      const matchedTokens = tokens.filter(token => fileTokens.includes(token));
      const locationHits = locationTokens.filter(token => fileTokens.includes(token)).length;
      const titleScore = tokens.length ? matchedTokens.length / tokens.length : 0;
      return { page, score: titleScore + (locationTokens.length ? (locationHits / locationTokens.length) * 0.12 : 0), hitCount: matchedTokens.length, locationHits };
    }).sort((a,b) => b.score - a.score || b.hitCount - a.hitCount || b.locationHits - a.locationHits);
    // Require a meaningful match to the actual place name. A related category or city
    // alone is not enough to label a photograph as depicting this specific landmark.
    const best = ranked[0];
    const minimumHits = tokens.length > 1 ? Math.min(2, tokens.length) : tokens.length;
    if (!best || best.hitCount < minimumHits) {
      commonsImageCache.set(key, { at: Date.now(), value: fallback });
      return fallback;
    }
    const page = best.page;
    const info = page.imageinfo[0];
    const metadata = info.extmetadata || {};
    const value = {
      imageUrl: info.thumburl || info.url || categoryFallback(category),
      pageUrl: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(page.title || '').replaceAll(' ', '_'))}`,
      credit: plainText(metadata.Artist?.value || metadata.Credit?.value || 'Wikimedia Commons contributor').slice(0, 180),
      license: plainText(metadata.LicenseShortName?.value || metadata.UsageTerms?.value || 'See file page').slice(0, 80),
      matched: true
    };
    commonsImageCache.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    commonsImageCache.set(key, { at: Date.now(), value: fallback });
    return fallback;
  }
}
const stalePlaceSearchCache=new Map();
// Known Indian area centres are a resilience layer when a public geocoder is busy.
// Results returned from this table are explicitly labelled as curated fallback data.
const AREA_CENTRES = [
  { terms:['coorg','madikeri'], name:'Madikeri, Karnataka',lat:12.4244,lon:75.7382 },
  { terms:['gokarna'], name:'Gokarna, Karnataka',lat:14.5479,lon:74.3188 },
  { terms:['dandeli'], name:'Dandeli, Karnataka',lat:15.2470,lon:74.6290 },
  { terms:['hampi','hosapete','hospet'], name:'Hampi, Karnataka',lat:15.3350,lon:76.4600 },
  { terms:['mysuru','mysore'], name:'Mysuru, Karnataka',lat:12.2958,lon:76.6394 },
  { terms:['bengaluru','bangalore'], name:'Bengaluru, Karnataka',lat:12.9716,lon:77.5946 },
  { terms:['kudremukh','kalasa'], name:'Kudremukh, Karnataka',lat:13.2300,lon:75.2500 },
  { terms:['chikkamagaluru','chikmagalur'], name:'Chikkamagaluru, Karnataka',lat:13.3161,lon:75.7720 },
  { terms:['mulki'], name:'Mulki, Karnataka',lat:13.0910,lon:74.7930 },
  { terms:['udupi'], name:'Udupi, Karnataka',lat:13.3409,lon:74.7421 },
  { terms:['malpe'], name:'Malpe, Udupi, Karnataka',lat:13.36197,lon:74.69753 },
  { terms:['kaup','kapu'], name:'Kaup, Udupi, Karnataka',lat:13.2238,lon:74.7367 },
  { terms:['padubidri'], name:'Padubidri, Udupi, Karnataka',lat:13.13194,lon:74.76222 },
  { terms:['mattu beach','mattu'], name:'Mattu, Udupi, Karnataka',lat:13.27348,lon:74.72496 },
  { terms:['hoode'], name:'Hoode, Udupi, Karnataka',lat:13.40754,lon:74.69705 },
  { terms:['delta beach','kodi bengre','kodibengre'], name:'Kodi Bengre, Udupi, Karnataka',lat:13.44596,lon:74.69392 }
];
function knownAreaCentre(area){
  const q=String(area||'').toLowerCase();
  return AREA_CENTRES.find(entry=>entry.terms.some(term=>q.includes(term)))||null;
}
function overpassEndpoints(){
  const configured=[process.env.OVERPASS_API_URL,...String(process.env.OVERPASS_API_URLS||'').split(',')]
    .map(value=>String(value||'').trim()).filter(Boolean)
    .map(value=>value.endsWith('/api/')?`${value}interpreter`:value);
  const defaults=process.env.OVERPASS_DISABLE_PUBLIC_FALLBACKS==='true'?[]:[
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ];
  return [...new Set([...configured,...defaults])].filter(value=>{
    try{return ['http:','https:'].includes(new URL(value).protocol);}catch{return false;}
  });
}
async function fetchOverpassElements(query){
  const failures=[];
  for(const endpoint of overpassEndpoints()){
    const host=(()=>{try{return new URL(endpoint).host;}catch{return 'configured map provider';}})();
    try{
      const response=await fetch(endpoint,{
        method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept':'application/json','User-Agent':'KenchainGroups/1.9 (OpenStreetMap place discovery)'},
        body:new URLSearchParams({data:query}),
        signal:AbortSignal.timeout(7000)
      });
      if(!response.ok){failures.push(`${host}: HTTP ${response.status}`);continue;}
      const payload=await response.json();
      if(!Array.isArray(payload.elements)){failures.push(`${host}: invalid map response`);continue;}
      return {payload,endpoint};
    }catch(error){failures.push(`${host}: ${error.name==='TimeoutError'?'timeout':error.message}`);}
  }
  throw new Error(failures.length?`Live place providers unavailable (${failures.join('; ')}).`:'No live place providers are configured.');
}
function normalizeTouristElements(elements,{area,category,def,lat,lon}){
  const seen=new Set();
  return (elements||[]).map(el=>{
    const tags=el.tags||{},pLat=Number(el.lat??el.center?.lat),pLon=Number(el.lon??el.center?.lon);
    if(!tags.name||!Number.isFinite(pLat)||!Number.isFinite(pLon))return null;
    const osmId=`${el.type}/${el.id}`;if(seen.has(osmId))return null;seen.add(osmId);
    return {id:`place-${el.type}-${el.id}`,title:tags.name,category,categoryLabel:def.label,location:tags['addr:city']||tags['addr:town']||tags['addr:district']||area,distanceKm:Number(haversineKm(lat,lon,pLat,pLon).toFixed(1)),latitude:pLat,longitude:pLon,description:tags.description||def.label,activities:def.activities,image:categoryFallback(category),imageAlt:`${tags.name} · ${def.label} near ${area}`,osmId,osmUrl:`https://www.openstreetmap.org/${osmId}`,source:'openstreetmap',live:true};
  }).filter(Boolean).sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,50);
}
function curatedTouristFallback(area,category,centre,def){
  const q=String(area||'').toLowerCase(),items=[];
  const add=(title,lat,lon,description,kind=category,extra={})=>items.push({id:`curated-${category}-${title.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`,title,category,categoryLabel:def.label,location:extra.location||centre.name,distanceKm:Number(haversineKm(centre.lat,centre.lon,lat,lon).toFixed(1)),latitude:lat,longitude:lon,description,duration:'Plan your visit',activities:extra.activities||def.activities,image:categoryFallback(kind),imageAlt:`${title} near ${extra.location||centre.name}`,osmUrl:`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=14/${lat}/${lon}`,source:'kenchain-curated-fallback',live:false,...extra});
  if(q.includes('gokarna')){
    if(category==='temples')add('Mahabaleshwar Temple',14.5439,74.3188,'Historic Shiva temple in Gokarna. Verify visitor access and timings.');
    if(category==='beaches'){add('Om Beach',14.5095,74.3185,'Popular Gokarna cove. Check tides and local access.');add('Kudle Beach',14.5251,74.3207,'Coastal beach and walking destination.');add('Half Moon Beach',14.5107,74.3252,'Small coastal cove reached by local trail or boat when operating.');}
    if(category==='heritage')add('Mirjan Fort',14.4772,74.4180,'Historic fort in the Gokarna region.');
  }else if(['udupi','malpe','kaup','kapu','padubidri','mattu','hoode','kodi bengre','kodibengre','delta beach'].some(term=>q.includes(term))){
    if(category==='beaches'){
      add('Malpe Beach',13.36197,74.69753,'Popular Udupi beach and fishing-harbour waterfront. Water sports, the sea walk and boat services towards St. Mary’s Island depend on current operator schedules, sea conditions and seasonal restrictions.','beaches',{location:'Malpe, Udupi',activities:['Beach and sea-walk visit','Water sports with authorised local operators','Boat trip to St. Mary’s Island when services operate','Sunset photography'],sourceUrl:'https://karnatakatourism.org/en/attractions/malpe-beach/'});
      add('Kaup (Kapu) Beach',13.21873,74.73868,'A sandy coastal stretch known for its historic lighthouse. Check lighthouse visitor hours locally before planning a visit.','beaches',{location:'Kaup (Kapu), Udupi',activities:['Kaup Lighthouse visit during published hours','Coastal walks and sunset viewing','Shoreline photography','Birdwatching around the lagoon when conditions allow'],sourceUrl:'https://karnatakatourism.org/en/attractions/kapu-beach/'});
      add('Padubidri Blue Flag Beach',13.13194,74.76222,'A Blue Flag-recognised beach in Udupi district. Follow beach safety flags and lifeguard instructions; access and water activities may vary by season.','beaches',{location:'Padubidri, Udupi',activities:['Beach walk and relaxation','Shoreline and sunset photography','Use designated supervised swimming zones only','Local coastal food stops'],sourceUrl:'https://karnatakatourism.org/en/attractions/padubidri-beach-udupi-district/'});
      add('Mattu Beach',13.27348,74.72496,'A quieter coastal stretch near Katapady, known for coconut groves and its traditional fishing setting.','beaches',{location:'Mattu, Udupi',activities:['Quiet coastal walks','Scenic cycling or village-road drives','Photography of coconut groves and coastline','Respectful observation of local fishing activity'],sourceUrl:'https://karnatakatourism.org/en/attractions/mattu-beach/'});
      add('Hoode Beach',13.40754,74.69705,'A beach on the northern Udupi coast near Kemmannu and the Swarna backwaters. Check local access and sea conditions before entering the water.','beaches',{location:'Hoode, Udupi',activities:['Coastal walks','Sunset and landscape photography','Explore nearby backwater scenery','Birdwatching where locally permitted'],sourceUrl:'https://karnatakatourism.org/en/attractions/'});
      add('Delta Beach (Kodi Bengre)',13.44596,74.69392,'A coastal estuary setting where the Swarna River meets the Arabian Sea. Backwater kayaking or boating should only be arranged with authorised local operators.','beaches',{location:'Kodi Bengre, Udupi',activities:['View the river-meets-sea estuary','Backwater kayaking with authorised operators','Mangrove and birdwatching from permitted areas','Fishing-village and coastal photography'],sourceUrl:'https://karnatakatourism.org/en/attractions/delta-beach-udupi-district/'});
    }
  }else if(q.includes('hampi')||q.includes('hosapete')||q.includes('hospet')){
    if(category==='temples'){add('Virupaksha Temple',15.3350,76.4600,'Major temple complex in the Hampi heritage landscape.');add('Vijaya Vittala Temple',15.3470,76.4740,'Historic temple complex known for its stone architecture.');}
    if(category==='heritage'){add('Hampi Archaeological Museum',15.3280,76.4650,'Museum and heritage interpretation in Hampi.');add('Hemakuta Hill monuments',15.3310,76.4630,'Cluster of historic monuments and viewpoints.');}
    if(category==='hills')add('Matanga Hill',15.3320,76.4648,'Popular Hampi viewpoint; check trail conditions.');
    if(category==='lakes')add('Tungabhadra River',15.3400,76.4700,'River landscape and local boat activity subject to conditions.');
  }else if(q.includes('coorg')||q.includes('madikeri')){
    if(category==='temples'){add('Omkareshwara Temple',12.4218,75.7380,'Historic temple in Madikeri.');add('Bhagamandala Temple area',12.3940,75.5180,'Sacred temple and river confluence area.');}
    if(category==='waterfalls')add('Abbey Falls',12.4588,75.7288,'Waterfall viewpoint; seasonal conditions and access restrictions may apply.');
    if(category==='heritage')add('Madikeri Fort',12.4230,75.7385,'Historic fort complex in Madikeri.');
    if(category==='hills')add("Raja's Seat",12.4208,75.7345,'Hilltop garden and valley viewpoint.');
    if(category==='wildlife')add('Nagarhole National Park',12.0460,76.0940,'Protected landscape. Safari access must be confirmed through official channels.');
  }else if(q.includes('dandeli')){
    if(category==='wildlife')add('Dandeli Wildlife Sanctuary',15.2450,74.6250,'Protected forest landscape; use authorised safari operators.');
    if(category==='lakes')add('Kali River',15.2450,74.6300,'River corridor; rafting and water activities require local operator confirmation.');
    if(category==='hills')add('Syntheri Rocks',15.3950,74.5100,'Rock formation and forest destination.');
  }else if(q.includes('mysuru')||q.includes('mysore')){
    if(category==='temples')add('Chamundeshwari Temple',12.2720,76.6700,'Hilltop temple with city views.');
    if(category==='heritage')add('Mysore Palace',12.3052,76.6552,'Historic royal palace and museum.');
    if(category==='lakes')add('Kukkarahalli Lake',12.3150,76.6350,'Urban lake and walking destination.');
    if(category==='wildlife')add('Sri Chamarajendra Zoological Gardens',12.3020,76.6640,'City zoological garden. Check current entry information.');
  }else if(q.includes('bengaluru')||q.includes('bangalore')){
    if(category==='temples'){add('Bull Temple',12.9435,77.5680,'Historic temple in Basavanagudi.');add('ISKCON Bengaluru',13.0108,77.5511,'Large temple complex in Rajajinagar.');}
    if(category==='heritage'){add('Bangalore Palace',12.9987,77.5920,'Historic palace and grounds.');add('Tipu Sultan Summer Palace',12.9604,77.5733,'Historic palace and museum.');}
    if(category==='lakes'){add('Ulsoor Lake',12.9817,77.6197,'Urban lake and walking destination.');add('Sankey Tank',13.0068,77.5713,'Urban lake and walking destination.');}
  }else if(q.includes('kudremukh')||q.includes('kalasa')){
    if(category==='hills')add('Kudremukh Peak trail area',13.2300,75.2500,'Mountain trekking region. Forest department permits and guided access are required.');
    if(category==='waterfalls')add('Hanuman Gundi Falls',13.1850,75.1900,'Waterfall near Kudremukh; check seasonal access.');
    if(category==='wildlife')add('Kudremukh National Park',13.2300,75.2500,'Protected biodiversity area; follow park rules and permits.');
  }
  return items;
}
async function discoverTouristPlaces(area,category,coordinateHint=null){
  const def=touristCategories[category];if(!def)throw new Error('Choose a valid place category.');
  const key=`${area.toLowerCase().trim()}|${category}|${coordinateHint?.lat||''},${coordinateHint?.lon||''}`;
  const cached=placeSearchCache.get(key);if(cached&&Date.now()-cached.at<15*60*1000)return cached.data;
  const stale=stalePlaceSearchCache.get(key);
  let location;
  if(coordinateHint&&Number.isFinite(Number(coordinateHint.lat))&&Number.isFinite(Number(coordinateHint.lon)))location={lat:String(coordinateHint.lat),lon:String(coordinateHint.lon),name:area,display_name:area};
  else location=await geocodeArea(area);
  const lat=Number(location.lat),lon=Number(location.lon),radius=35000;
  const query=def.tags.replaceAll('R',String(radius)).replaceAll('LAT',String(lat)).replaceAll('LON',String(lon));
  const overpass=`[out:json][timeout:25];(${query});out center tags 80;`;
  try{
    const {payload,endpoint}=await fetchOverpassElements(overpass);
    const items=normalizeTouristElements(payload.elements,{area:location.name||area,category,def,lat,lon});
    if(items.length){
      const data={area:location.display_name||area,category,categoryLabel:def.label,centre:{latitude:lat,longitude:lon},count:items.length,items,activities:def.activities,source:'OpenStreetMap',live:true,provider:new URL(endpoint).host,attribution:'© OpenStreetMap contributors'};
      placeSearchCache.set(key,{at:Date.now(),data});stalePlaceSearchCache.set(key,{at:Date.now(),data});return data;
    }
    // A successful Overpass response can still contain no matches for a category.
    // Use a curated area list when available, rather than presenting an empty 502-style failure.
    const known=knownAreaCentre(area),centre=known?{...known}:{name:location.display_name||area,lat,lon};
    const fallback=curatedTouristFallback(area,category,centre,def);
    const data={area:centre.name||area,category,categoryLabel:def.label,centre:{latitude:centre.lat,longitude:centre.lon},count:fallback.length,items:fallback,activities:def.activities,source:fallback.length?'Kenchain Groups curated backup':'OpenStreetMap',live:!fallback.length,provider:new URL(endpoint).host,notice:fallback.length?'No matching live map features were returned. Showing curated destination pins instead.':'The map search succeeded, but no places in this category were mapped nearby. Try a neighbouring category or area.',attribution:fallback.length?'Curated destination information; verify local access before travel.':'© OpenStreetMap contributors'};
    if(fallback.length)stalePlaceSearchCache.set(key,{at:Date.now(),data});else placeSearchCache.set(key,{at:Date.now(),data});
    return data;
  }catch(error){
    console.warn('Live place providers unavailable; using safe fallback:',error.message);
    if(stale?.data&&Date.now()-stale.at<48*60*60*1000){
      const isOsm=stale.data.source==='OpenStreetMap';
      return {...stale.data,live:false,source:isOsm?'cached-openstreetmap':stale.data.source,notice:isOsm?'Showing recently cached OpenStreetMap places while live providers recover.':(stale.data.notice||'Showing saved destination pins while live map providers recover.')};
    }
    const known=knownAreaCentre(area),centre=known?{...known}:{name:location.display_name||area,lat,lon};
    const fallback=curatedTouristFallback(area,category,centre,def);
    const data={area:centre.name||area,category,categoryLabel:def.label,centre:{latitude:centre.lat,longitude:centre.lon},count:fallback.length,items:fallback,activities:def.activities,source:fallback.length?'Kenchain Groups curated backup':'map-provider-fallback',live:false,notice:fallback.length?'Live place providers returned an error. Showing curated destination pins with map coordinates.':'The map is centred on your searched area, but live place data is temporarily unavailable and no curated pins are listed for this category. You can still pan and zoom the map or try another category.',attribution:'© OpenStreetMap contributors; curated pins are labelled separately.'};
    stalePlaceSearchCache.set(key,{at:Date.now(),data});return data;
  }
}

const suggestionCache=new Map(),suggestionInflight=new Map();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let nominatimQueue=Promise.resolve(),lastNominatimRequest=0;
async function queryNominatimSuggestion(url){
  const task=nominatimQueue.then(async()=>{
    const pause=Math.max(0,1100-(Date.now()-lastNominatimRequest));
    if(pause)await wait(pause);
    lastNominatimRequest=Date.now();
    const response=await fetch(url,{headers:{'User-Agent':`KenchainGroups/1.9 (${process.env.CONTACT_EMAIL||'support@kenchaingroups.example'})`,'Referer':process.env.APP_URL||'https://kenchain-groups-updo.onrender.com'},signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error(`Nominatim returned ${response.status}`);
    return response.json();
  });
  nominatimQueue=task.catch(()=>{});
  return task;
}
function normalizePhoton(payload){
  return (payload.features||[]).map(feature=>{
    const p=feature.properties||{},coords=feature.geometry?.coordinates||[],name=p.name||p.street||p.city||p.county;
    const countryCode=String(p.countrycode||p.countryCode||'').toUpperCase();
    const country=String(p.country||'').trim();
    // Suggestions are intentionally scoped to India. Photon may return matches
    // worldwide when no city bias is supplied, so discard known non-India rows.
    if(countryCode&&countryCode!=='IN')return null;
    if(country&&!/^(india|bharat)$/i.test(country))return null;
    if(!name||coords.length<2||!Number.isFinite(Number(coords[0]))||!Number.isFinite(Number(coords[1])))return null;
    const latitude=Number(coords[1]),longitude=Number(coords[0]);
    if(latitude<6||latitude>38||longitude<67||longitude>99)return null;
    const context=[p.city,p.state,country||'India'].filter(Boolean).filter((v,i,a)=>v!==name&&a.indexOf(v)===i);
    return {label:[name,...context].join(', '),value:[name,...context].join(', '),name,city:p.city||p.county||'',state:p.state||'',country:country||'India',latitude,longitude,kind:'place'};
  }).filter(Boolean);
}
function normalizeNominatim(payload){
  return (payload||[]).map(row=>{
    const a=row.address||{},name=row.name||a.road||a.suburb||a.city||a.town||a.village||row.display_name?.split(',')[0];
    const lat=Number(row.lat),lon=Number(row.lon);if(!name||!Number.isFinite(lat)||!Number.isFinite(lon))return null;
    const context=[a.city||a.town||a.village||a.county,a.state,a.country].filter(Boolean).filter((v,i,arr)=>v!==name&&arr.indexOf(v)===i);
    const label=[name,...context].join(', ');return {label,value:label,name,city:a.city||a.town||a.village||a.county||'',state:a.state||'',country:a.country||'',latitude:lat,longitude:lon,kind:'place'};
  }).filter(Boolean);
}
async function placeSuggestions(q,ip='unknown'){
  const key=q.toLowerCase().trim(),cached=suggestionCache.get(key);if(cached&&Date.now()-cached.at<5*60*1000)return cached.items;
  if(suggestionInflight.has(key))return suggestionInflight.get(key);
  const task=(async()=>{
    const params=new URLSearchParams({q,limit:'10',lang:'en'});
    const photonEndpoint=process.env.PHOTON_URL||'https://photon.komoot.io/api/';
    try{
      const response=await fetch(`${photonEndpoint}?${params}`,{headers:{'User-Agent':'KenchainGroups/1.9 (place autocomplete)'},signal:AbortSignal.timeout(6500)});
      if(!response.ok)throw new Error(`Photon returned ${response.status}`);
      const items=normalizePhoton(await response.json()).slice(0,8);if(items.length){suggestionCache.set(key,{at:Date.now(),items});return items;}
    }catch(error){console.warn('Photon autocomplete unavailable:',error.message);}
    try{
      const url=new URL(`${(process.env.NOMINATIM_URL||'https://nominatim.openstreetmap.org').replace(/\/$/,'')}/search`);
      url.search=new URLSearchParams({q,format:'jsonv2',limit:'8',countrycodes:'in',addressdetails:'1'}).toString();
      const items=normalizeNominatim(await queryNominatimSuggestion(url)).slice(0,8);suggestionCache.set(key,{at:Date.now(),items});return items;
    }catch(error){console.warn('Nominatim autocomplete unavailable:',error.message);}
    const known=knownAreaCentre(q);
    const knownParts=known?.name.split(',').map(part=>part.trim())||[];
    const items=known?[{label:known.name,value:known.name,name:knownParts[0],city:knownParts[0],state:knownParts[1]||'',country:'India',latitude:known.lat,longitude:known.lon,kind:'place',source:'curated-fallback'}]:[];
    suggestionCache.set(key,{at:Date.now(),items});return items;
  })();
  suggestionInflight.set(key,task);
  try{return await task;}finally{suggestionInflight.delete(key);}
}

const demoFleet = [
  {
    vehicleId: 'KG-BUS-DEMO', vehicleType: 'Tourist bus', registration: 'KA 01 DEMO',
    routeName: 'Bengaluru → Mysuru scenic corridor', origin: 'Bengaluru', destination: 'Mysuru',
    speedKmh: 58, durationSeconds: 720, phaseOffset: 0,
    route: [[12.9716,77.5946],[12.91,77.53],[12.84,77.45],[12.76,77.34],[12.72,77.28],[12.68,77.24],[12.65,77.20],[12.62,77.13],[12.60,77.08],[12.58,77.04],[12.56,76.98],[12.54,76.93],[12.52,76.89],[12.48,76.80],[12.45,76.75],[12.42,76.69],[12.37,76.66],[12.2958,76.6394]]
  },
  {
    vehicleId: 'KG-VAN-DEMO', vehicleType: 'Travel van', registration: 'KA 05 DEMO',
    routeName: 'Mysuru → Madikeri / Coorg', origin: 'Mysuru', destination: 'Madikeri',
    speedKmh: 46, durationSeconds: 540, phaseOffset: 215,
    route: [[12.2958,76.6394],[12.30,76.55],[12.30,76.45],[12.30,76.34],[12.31,76.25],[12.33,76.17],[12.34,76.10],[12.38,76.04],[12.42,75.99],[12.46,75.95],[12.47,75.90],[12.46,75.85],[12.44,75.80],[12.4244,75.7382]]
  },
  {
    vehicleId: 'KG-COURIER-DEMO', vehicleType: 'Courier mini-van', registration: 'KA 03 DEMO',
    routeName: 'Bengaluru city delivery loop', origin: 'Indiranagar', destination: 'MG Road',
    speedKmh: 28, durationSeconds: 420, phaseOffset: 93,
    route: [[12.9784,77.6408],[12.9795,77.6270],[12.9754,77.6140],[12.9716,77.6040],[12.9750,77.5940],[12.9710,77.5850],[12.9660,77.5780],[12.9600,77.5850],[12.9580,77.6000],[12.9660,77.6150],[12.9784,77.6408]]
  }
];
function interpolateRoute(route, progress) {
  const segmentCount = route.length - 1;
  const position = Math.max(0, Math.min(0.999999, progress)) * segmentCount;
  const index = Math.floor(position), fraction = position - index;
  const a = route[index], b = route[index + 1];
  return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
}
function simulatedVehicle(def, now = Date.now()) {
  const cycleSeconds = def.durationSeconds * 2;
  const elapsed = ((now / 1000 + def.phaseOffset) % cycleSeconds + cycleSeconds) % cycleSeconds;
  const outbound = elapsed <= def.durationSeconds;
  const oneWayProgress = outbound ? elapsed / def.durationSeconds : 1 - (elapsed - def.durationSeconds) / def.durationSeconds;
  const route = outbound ? def.route : [...def.route].reverse();
  const position = interpolateRoute(route, Math.max(0, Math.min(.999, outbound ? oneWayProgress : 1 - oneWayProgress)));
  const trail = [];
  for (let i = 7; i >= 0; i--) {
    const time = now - i * 12000;
    const cycle = ((time / 1000 + def.phaseOffset) % cycleSeconds + cycleSeconds) % cycleSeconds;
    const isOut = cycle <= def.durationSeconds;
    const progress = isOut ? cycle / def.durationSeconds : 1 - (cycle - def.durationSeconds) / def.durationSeconds;
    const path = isOut ? def.route : [...def.route].reverse();
    const point = interpolateRoute(path, Math.max(0, Math.min(.999, isOut ? progress : 1 - progress)));
    trail.push([point[0], point[1], new Date(time).toISOString()]);
  }
  const speed = Math.round(def.speedKmh * (0.82 + 0.18 * Math.sin(now / 19000 + def.phaseOffset)));
  const progressPercent = Math.round(oneWayProgress * 100);
  const status = progressPercent < 8 ? 'Departing · simulated' : progressPercent > 92 ? 'Approaching stop · simulated' : 'On route · simulated';
  return {
    vehicleId: def.vehicleId, vehicleType: def.vehicleType, registration: def.registration,
    routeName: def.routeName, origin: def.origin, destination: def.destination,
    latitude: position[0], longitude: position[1], speedKmh: speed,
    heading: 0, status, lastUpdated: new Date(now).toISOString(), trackingMode: 'demo',
    source: 'simulation', isLive: false, progressPercent, etaMinutes: Math.max(1, Math.round((100 - progressPercent) / 100 * def.durationSeconds / 60)),
    trail, route: def.route, simulationLabel: 'DEMO ROUTE · NOT A REAL VEHICLE'
  };
}
async function getVehicle(vehicleId) {
  const def = demoFleet.find(item => item.vehicleId.toLowerCase() === String(vehicleId).toLowerCase());
  return def ? simulatedVehicle(def) : null;
}
const clean = value => String(value ?? '').trim();
const money = value => Math.round(Number(value) || 0);

// Real, user-triggered adventure discovery from OpenStreetMap.
// Nominatim calls are serialized to respect its public 1 request/second policy;
// successful area searches are cached to avoid repeat upstream traffic.
const adventureCache = new Map();
const ADVENTURE_CACHE_MS = 15 * 60 * 1000;
async function geocodeArea(area){
  const suggestions=await placeSuggestions(area);
  const first=suggestions[0];
  if(first&&Number.isFinite(Number(first.latitude))&&Number.isFinite(Number(first.longitude))){
    return {lat:String(first.latitude),lon:String(first.longitude),name:first.name||area,display_name:first.label||area,address:{city:first.city||first.name||area,state:first.state||'',country:first.country||'India'}};
  }
  const known=knownAreaCentre(area);
  if(known)return {lat:String(known.lat),lon:String(known.lon),name:known.name,display_name:known.name,address:{city:known.name.split(',')[0],state:known.name.split(',')[1]?.trim()||'',country:'India'}};
  throw new Error('We could not locate that area. Try a city, town or district name.');
}
function activityKind(tags){
  const sport = clean(tags.sport).toLowerCase();
  if (sport.includes('climb') || sport.includes('bouldering')) return 'Rock climbing';
  if (sport.includes('raft') || sport.includes('canyon') || tags.whitewater) return 'White-water / river activity';
  if (sport.includes('kayak') || sport.includes('canoe') || tags.canoe) return 'Kayaking / canoeing';
  if (sport.includes('surf')) return 'Surfing';
  if (sport.includes('div') || sport.includes('snorkel')) return 'Diving / snorkelling';
  if (sport.includes('horse')) return 'Horse riding';
  if (sport.includes('sail') || sport.includes('swim')) return 'Sailing / swimming';
  if (sport.includes('paraglid') || tags.aerialway === 'zip_line') return tags.aerialway === 'zip_line' ? 'Zipline' : 'Paragliding';
  if (sport.includes('cycle') || tags.route === 'mtb') return 'Cycling / mountain biking';
  if (sport.includes('hiking') || sport.includes('trekking') || tags.route === 'hiking' || tags.tourism === 'alpine_hut') return 'Hiking / trekking';
  if (tags.natural === 'waterfall' || tags.waterway === 'waterfall' || tags.waterway === 'rapids') return tags.waterway === 'rapids' ? 'White-water / river activity' : 'Waterfall / nature trail';
  if (tags.natural === 'peak' || tags.natural === 'cliff') return 'Hiking / climbing destination';
  if (tags.natural === 'cave' || tags.natural === 'cave_entrance') return 'Caving / cave visit';
  if (tags.natural === 'hot_spring') return 'Natural hot spring';
  if (tags.natural === 'beach') return 'Beach / water activity';
  if (tags.tourism === 'camp_site') return 'Camping';
  if (tags.leisure === 'water_park') return 'Water park';
  if (tags.leisure === 'sports_centre') return 'Outdoor sports centre';
  if (tags.leisure === 'nature_reserve') return 'Nature reserve / outdoor trail';
  return 'Outdoor activity';
}
function haversineKm(aLat,aLon,bLat,bLon){
  const rad = n => n * Math.PI / 180;
  const dLat=rad(bLat-aLat), dLon=rad(bLon-aLon);
  const x=Math.sin(dLat/2)**2+Math.cos(rad(aLat))*Math.cos(rad(bLat))*Math.sin(dLon/2)**2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function adventureImage(kind){
  const value=String(kind||'').toLowerCase();
  if(/kayak|canoe|raft|river|waterfall|white-water|diving|snorkel|sail|swim/.test(value)) return 'https://images.unsplash.com/photo-1530866495561-507c9faab2ed?auto=format&fit=crop&w=1200&q=82';
  if(/climb|cav/.test(value)) return 'https://images.unsplash.com/photo-1522163182402-834f871fd851?auto=format&fit=crop&w=1200&q=82';
  if(/cycl|mountain bik/.test(value)) return 'https://images.unsplash.com/photo-1517649763962-0c623066013b?auto=format&fit=crop&w=1200&q=82';
  if(/paraglid|zipline|horse riding/.test(value)) return 'https://images.unsplash.com/photo-1500534623283-312aade485b7?auto=format&fit=crop&w=1200&q=82';
  if(/beach|surf|water sport/.test(value)) return 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=82';
  if(/camp/.test(value)) return 'https://images.unsplash.com/photo-1478131143081-80f7f84ca84d?auto=format&fit=crop&w=1200&q=82';
  return 'https://images.unsplash.com/photo-1551632811-561732d1e306?auto=format&fit=crop&w=1200&q=82';
}
function curatedAdventureFallback(area,centre){
  const mapping={beaches:'Coastal walk / beach activity',waterfalls:'Waterfall / nature trail',hills:'Hiking / viewpoint',lakes:'River / lakeside activity',wildlife:'Nature reserve / wildlife trail'};
  const results=[];
  for(const category of Object.keys(mapping)){
    const def=touristCategories[category];
    for(const place of curatedTouristFallback(area,category,centre,def)){
      const activityType=mapping[category];
      results.push({...place,id:`fallback-adventure-${place.id}`,category:'adventure',categoryLabel:'Outdoor destination',activityType,duration:'Confirm with a local operator',price:0,rating:null,reviews:null,tag:'Curated area backup',description:`${activityType} destination. ${place.description} Confirm operator availability, permits, conditions and safety arrangements before travelling.`,source:'kenchain-curated-fallback',live:false,includes:['Map location from curated destination data','Confirm activity operator and current availability','Check local permits and safety requirements']});
    }
  }
  return results.sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,30);
}
async function discoverAdventurePlaces(area, coordinateHint=null){
  const key=`${area.toLowerCase().replace(/\s+/g,' ').trim()}|${coordinateHint?.lat||''},${coordinateHint?.lon||''}`;
  const cached=adventureCache.get(key);
  if(cached && Date.now()-cached.at<ADVENTURE_CACHE_MS) return cached.data;
  const location=coordinateHint&&Number.isFinite(Number(coordinateHint.lat))&&Number.isFinite(Number(coordinateHint.lon))?{lat:String(coordinateHint.lat),lon:String(coordinateHint.lon),name:area,display_name:area}:await geocodeArea(area);
  const lat=Number(location.lat), lon=Number(location.lon), radius=25000;
  const q=`[out:json][timeout:25];(\n`+
    `nwr(around:${radius},${lat},${lon})["sport"~"climbing|bouldering|mountaineering|rafting|canyoning|kayak|canoe|surfing|snorkeling|diving|scuba_diving|sailing|swimming|horse_riding|paragliding|cycling|hiking|trekking|mountain_biking",i];\n`+
    `nwr(around:${radius},${lat},${lon})["leisure"~"water_park|sports_centre|nature_reserve"];\n`+
    `nwr(around:${radius},${lat},${lon})["tourism"~"camp_site|alpine_hut"];\n`+
    `nwr(around:${radius},${lat},${lon})["aerialway"="zip_line"];\n`+
    `nwr(around:${radius},${lat},${lon})["whitewater"~"rapid|put_in|egress"];\n`+
    `nwr(around:${radius},${lat},${lon})["route"~"hiking|mtb"];\n`+
    `nwr(around:${radius},${lat},${lon})["natural"~"peak|waterfall|beach|cave|cliff|hot_spring|cave_entrance"];\n`+
    `nwr(around:${radius},${lat},${lon})["waterway"~"waterfall|rapids"];\n`+
    `);out center tags 80;`;
  try{
    const {payload,endpoint}=await fetchOverpassElements(q);
    const seen=new Set();
    const items=(payload.elements||[]).map(el=>{
      const tags=el.tags||{},itemLat=Number(el.lat??el.center?.lat),itemLon=Number(el.lon??el.center?.lon);
      if(!tags.name||!Number.isFinite(itemLat)||!Number.isFinite(itemLon))return null;
      const osmKey=`${el.type}/${el.id}`;if(seen.has(osmKey))return null;seen.add(osmKey);
      const local=tags['addr:city']||tags['addr:town']||tags['addr:village']||tags['addr:district']||location.name||area;
      const kind=activityKind(tags);
      return {id:`osm-${el.type}-${el.id}`,category:'adventure',source:'openstreetmap',live:true,osmId:osmKey,title:tags.name,location:local,duration:'Check with local operator',price:0,rating:null,reviews:null,tag:'Mapped local place',image:categoryFallback(/water|river|kayak|raft|waterfall/i.test(kind)?'waterfalls':/beach|surf/i.test(kind)?'beaches':/wildlife|nature reserve|bird/i.test(kind)?'wildlife':/trek|climb|hiking|cycling/i.test(kind)?'hills':'heritage'),imageAlt:`${tags.name} · ${kind}`,description:`${kind}. ${tags.description||'This is a real place mapped in OpenStreetMap. Confirm current activity operations, access, safety arrangements and availability with the local operator before travelling.'}`,activityType:kind,latitude:itemLat,longitude:itemLon,distanceKm:Number(haversineKm(lat,lon,itemLat,itemLon).toFixed(1)),osmUrl:`https://www.openstreetmap.org/${el.type}/${el.id}`,website:tags.website||tags['contact:website']||'',phone:tags.phone||tags['contact:phone']||'',includes:['OpenStreetMap place record','Confirm operator and current availability','Check safety requirements before booking']};
    }).filter(Boolean).sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,60);
    if(items.length){
      const data={area:location.display_name||area,centre:{latitude:lat,longitude:lon},radiusKm:25,count:items.length,items,source:'OpenStreetMap',live:true,provider:new URL(endpoint).host,osmDataTimestamp:payload.osm3s?.timestamp_osm_base||null,attribution:'© OpenStreetMap contributors'};
      adventureCache.set(key,{at:Date.now(),data});return data;
    }
    const known=knownAreaCentre(area),centre=known?{...known}:{name:location.display_name||area,lat,lon};
    const fallback=curatedAdventureFallback(area,centre);
    const data={area:centre.name||area,centre:{latitude:centre.lat,longitude:centre.lon},radiusKm:25,count:fallback.length,items:fallback,source:fallback.length?'Kenchain Groups curated backup':'OpenStreetMap',live:!fallback.length,provider:new URL(endpoint).host,notice:fallback.length?'No live outdoor features matched this area. Showing curated nearby destination ideas instead.':'No outdoor features are mapped in this area yet. Try a nearby city or explore another category.',attribution:fallback.length?'Curated destination information; verify local access before travel.':'© OpenStreetMap contributors'};
    adventureCache.set(key,{at:Date.now(),data});return data;
  }catch(error){
    console.warn('Adventure live providers unavailable; using curated area backup:',error.message);
    const known=knownAreaCentre(area),centre=known?{...known}:{name:location.display_name||area,lat,lon};
    const items=curatedAdventureFallback(area,centre);
    const data={area:centre.name||area,centre:{latitude:centre.lat,longitude:centre.lon},radiusKm:25,count:items.length,items,source:'Kenchain Groups curated backup',live:false,notice:'Live map providers are temporarily busy. These curated outdoor destinations remain searchable and mapped; confirm local operators before booking.',attribution:'Curated destination information; verify local access before travel.'};
    adventureCache.set(key,{at:Date.now(),data});return data;
  }
}

const server = http.createServer(async (req,res) => {
  try {
    if(req.method === 'OPTIONS'){ res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type' }); return res.end(); }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = decodeURIComponent(url.pathname);

    if(p === '/api/health' && req.method === 'GET') return json(res,200,{status:'ok',service:'Kenchain Groups API'});
    if(p === '/api/maps/config' && req.method==='GET') return json(res,200,{provider:'Google Maps',googleMapsApiKey:GOOGLE_MAPS_API_KEY,googleMapsMapId:GOOGLE_MAPS_MAP_ID,googleMapsConfigured:Boolean(GOOGLE_MAPS_API_KEY)});
    if(p === '/api/auth/me' && req.method==='GET') return json(res,200,{user:await currentUser(req)});
    if(p === '/api/auth/register' && req.method==='POST'){
      const data=await bodyJson(req),name=clean(data.name),email=clean(data.email).toLowerCase(),phone=clean(data.phone),password=String(data.password||'');
      if(name.length<2||name.length>90)return json(res,400,{error:'Enter your name (2–90 characters).'});
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json(res,400,{error:'Enter a valid email address.'});
      if(password.length<10||password.length>128)return json(res,400,{error:'Use a password between 10 and 128 characters.'});
      if(phone&&!/^[6-9]\d{9}$/.test(phone.replace(/\s/g,'')))return json(res,400,{error:'Enter a valid 10-digit Indian mobile number.'});
      if(await findUserByEmail(email))return json(res,409,{error:'An account with this email already exists. Sign in instead.'});
      const salt=crypto.randomBytes(16).toString('hex'),passwordHash=`scrypt$${salt}$${await scrypt(password,salt)}`;
      const user={id:crypto.randomUUID(),name,email,phone,passwordHash,createdAt:new Date().toISOString()};await saveUser(user);const token=await createSession(user.id);setSessionCookie(res,token);
      return json(res,201,{user:{id:user.id,name:user.name,email:user.email,phone:user.phone}});
    }
    if(p === '/api/auth/login' && req.method==='POST'){
      const ip=req.socket.remoteAddress||'unknown',now=Date.now(),record=loginFailures.get(ip)||{count:0,until:0};
      if(record.until>now&&record.count>=8)return json(res,429,{error:'Too many sign-in attempts. Please wait 15 minutes and try again.'});
      if(record.until&&record.until<=now)loginFailures.delete(ip);
      const data=await bodyJson(req),email=clean(data.email).toLowerCase(),password=String(data.password||''),user=await findUserByEmail(email);
      if(password.length>128||!user||!user.passwordHash?.startsWith('scrypt$')){const next=record.until>now?record:{count:0,until:now+15*60*1000};next.count++;if(next.count>=8)next.until=now+15*60*1000;loginFailures.set(ip,next);return json(res,401,{error:'Email or password is incorrect.'});}
      const [,salt,stored]=user.passwordHash.split('$'),candidate=await scrypt(password,salt);
      if(!crypto.timingSafeEqual(Buffer.from(stored,'hex'),Buffer.from(candidate,'hex'))){const next=record.until>now?record:{count:0,until:now+15*60*1000};next.count++;if(next.count>=8)next.until=now+15*60*1000;loginFailures.set(ip,next);return json(res,401,{error:'Email or password is incorrect.'});}
      loginFailures.delete(ip);const token=await createSession(user.id);setSessionCookie(res,token);return json(res,200,{user:{id:user.id,name:user.name,email:user.email,phone:user.phone}});
    }
    if(p === '/api/auth/logout' && req.method==='POST') {await deleteSession(req);setSessionCookie(res,'',0);return json(res,200,{ok:true});}
    if(p === '/api/search/suggest' && req.method==='GET'){
      const q=clean(url.searchParams.get('q')).toLowerCase();if(q.length<2||q.length>100)return json(res,200,{items:[]});
      const store=await readStore();const items=[];
      for(const item of (store.catalog||[])){if(`${item.title||''} ${item.location||''} ${item.description||''} ${item.category||''}`.toLowerCase().includes(q))items.push({value:item.title,label:item.title,name:item.title,city:[item.location,item.category].filter(Boolean).join(' · '),kind:'experience',category:item.category,id:item.id});}
      for(const restaurant of (store.restaurants||[])){const menu=(restaurant.items||[]).some(item=>`${item.name||''} ${item.description||''}`.toLowerCase().includes(q));if(`${restaurant.name||''} ${restaurant.type||''} ${restaurant.location||''}`.toLowerCase().includes(q)||menu)items.push({value:restaurant.name,label:restaurant.name,name:restaurant.name,city:[restaurant.type,restaurant.location].filter(Boolean).join(' · '),kind:'restaurant',id:restaurant.id});}
      let places=[];try{places=await placeSuggestions(q,req.socket.remoteAddress||'unknown');}catch(error){console.warn('Global search place suggestions:',error.message);}
      for(const place of places)items.push({...place,value:place.label,kind:'place'});
      return json(res,200,{items:items.slice(0,10)});
    }
    if(p === '/api/search' && req.method==='GET'){
      const q=clean(url.searchParams.get('q')).toLowerCase();if(q.length<2||q.length>100)return json(res,400,{error:'Enter at least 2 characters to search.'});
      const store=await readStore();
      const experiences=(store.catalog||[]).filter(item=>`${item.title||''} ${item.location||''} ${item.description||''} ${item.category||''}`.toLowerCase().includes(q)).slice(0,18);
      const restaurants=(store.restaurants||[]).filter(item=>`${item.name||''} ${item.type||''} ${item.location||''} ${(item.items||[]).map(x=>`${x.name||''} ${x.description||''}`).join(' ')}`.toLowerCase().includes(q)).slice(0,12);
      let places=[];try{places=(await placeSuggestions(q,req.socket.remoteAddress||'unknown')).slice(0,8);}catch(error){console.warn('Global search mapped places:',error.message);}
      return json(res,200,{query:q,experiences,restaurants,places});
    }
    if(p === '/api/places/suggest' && req.method==='GET'){
      const q=clean(url.searchParams.get('q'));if(q.length<2||q.length>100)return json(res,200,{items:[]});
      try{return json(res,200,{items:await placeSuggestions(q,req.socket.remoteAddress||'unknown'),degraded:false});}catch(error){console.warn('Place suggestions:',error.message);return json(res,200,{items:[],degraded:true,notice:'Suggestions are temporarily limited. You can still enter the full location.'});}
    }
    if(p === '/api/places/images' && req.method==='POST'){
      const data=await bodyJson(req);
      const entries=Array.isArray(data.items)?data.items.slice(0,24):[];
      const images = new Array(entries.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < entries.length) {
          const index = cursor++;
          const item = entries[index];
          const title = clean(item?.title).slice(0,120), location = clean(item?.location).slice(0,120), category = clean(item?.category).toLowerCase();
          if (!title) { images[index] = {id:clean(item?.id),imageUrl:categoryFallback(category),matched:false}; continue; }
          const match = await findCommonsImage(title,category,location);
          images[index] = {id:clean(item?.id),...match};
        }
      };
      await Promise.all(Array.from({length:Math.min(6,entries.length)},worker));
      return json(res,200,{images,source:'Wikimedia Commons',attribution:'Image authors and licence are shown with each matched image.'});
    }
    if(p === '/api/places/curated' && req.method==='GET'){
      const area=clean(url.searchParams.get('area')),category=clean(url.searchParams.get('category')).toLowerCase();
      if(area.length<2||area.length>100)return json(res,400,{error:'Enter a city, town or district.'});
      const def=touristCategories[category];if(!def)return json(res,400,{error:'Choose a valid place category.'});
      const known=knownAreaCentre(area);
      if(!known)return json(res,200,{area,category,count:0,items:[],centre:null,source:'Kenchain curated backup',live:false,notice:'No curated destination pins are available for this area yet.'});
      const centre={...known},items=curatedTouristFallback(area,category,centre,def);
      return json(res,200,{area:centre.name||area,category,categoryLabel:def.label,count:items.length,items,activities:def.activities,centre:{latitude:centre.lat,longitude:centre.lon},source:'Kenchain Groups curated destination backup',live:false,notice:items.length?'Showing known destination locations as a backup to live Google Places results. Verify local access, conditions and activity operators before travel.':'No curated destinations are listed for this category in this area yet.',attribution:'Destination notes reference Karnataka Tourism; coordinates are approximate mapping points.'});
    }
    if(p === '/api/places/search' && req.method==='GET'){
      const area=clean(url.searchParams.get('area')),category=clean(url.searchParams.get('category')).toLowerCase();if(area.length<2||area.length>100)return json(res,400,{error:'Enter a city, town or district.'});
      try{const latRaw=url.searchParams.get('lat'),lonRaw=url.searchParams.get('lon'),lat=Number(latRaw),lon=Number(lonRaw),hint=latRaw!==null&&lonRaw!==null&&latRaw!==''&&lonRaw!==''&&Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180?{lat,lon}:null;return json(res,200,await discoverTouristPlaces(area,category,hint));}catch(error){console.error('Tourist places search:',error.message);return json(res,200,{area,category,count:0,items:[],centre:null,live:false,source:'map-provider-fallback',notice:error.message||'Live map search is temporarily unavailable. You can still use the destination catalogue.'});}
    }
    if(p === '/api/vehicles' && req.method==='GET'){
      const q=clean(url.searchParams.get('q')).toLowerCase();
      const items=demoFleet.map(item=>simulatedVehicle(item)).filter(vehicle=>!q||`${vehicle.vehicleId} ${vehicle.registration} ${vehicle.routeName} ${vehicle.vehicleType}`.toLowerCase().includes(q));
      return json(res,200,{items,trackingMode:'demo',notice:'All displayed vehicle positions and routes are simulated examples.'});
    }
    const vehicleMatch=p.match(/^\/api\/vehicles\/([^/]+)$/);
    if(vehicleMatch&&req.method==='GET'){
      const vehicle=await getVehicle(vehicleMatch[1]);
      if(vehicle)return json(res,200,{vehicle,trackingMode:'demo',notice:'This is a simulated vehicle route, not a real bus or courier location.'});
      return json(res,404,{error:'Demo vehicle ID not found. Try KG-BUS-DEMO, KG-VAN-DEMO or KG-COURIER-DEMO.'});
    }
    if(p === '/api/adventures/search' && req.method === 'GET'){
      const area=clean(url.searchParams.get('area'));
      if(area.length<2 || area.length>100) return json(res,400,{error:'Enter an area name between 2 and 100 characters.'});
      try { const latRaw=url.searchParams.get('lat'),lonRaw=url.searchParams.get('lon'),lat=Number(latRaw),lon=Number(lonRaw),hint=latRaw!==null&&lonRaw!==null&&latRaw!==''&&lonRaw!==''&&Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180?{lat,lon}:null;const data=await discoverAdventurePlaces(area,hint); return json(res,200,data); }
      catch(error){ console.error('Adventure search:',error.message); return json(res,200,{area,centre:null,radiusKm:25,count:0,items:[],source:'map-provider-fallback',live:false,notice:'Place search is temporarily limited. Try a nearby town or browse the featured adventure catalogue.'}); }
    }
    if(p === '/api/catalog' && req.method === 'GET'){
      const store=await readStore(); const category=clean(url.searchParams.get('category')).toLowerCase(); const q=clean(url.searchParams.get('q')).toLowerCase();
      const items=store.catalog.filter(item=>(!category||item.category===category)&&(!q||`${item.title} ${item.location} ${item.description}`.toLowerCase().includes(q)));
      return json(res,200,{items});
    }
    if(p === '/api/restaurants' && req.method === 'GET'){ const store=await readStore(); return json(res,200,{items:store.restaurants}); }
    const itemMatch=p.match(/^\/api\/catalog\/([^/]+)$/);
    if(itemMatch && req.method==='GET'){ const store=await readStore(); const item=store.catalog.find(row=>row.id===itemMatch[1]); return item?json(res,200,{item}):json(res,404,{error:'Experience not found'}); }
    if(p === '/api/delivery/quote' && req.method==='POST'){
      const data=await bodyJson(req); const type=clean(data.serviceType).toLowerCase();
      if(!['food','groceries','parcel','documents'].includes(type)) return json(res,400,{error:'Choose a valid delivery type.'});
      const km=Math.max(1,Math.min(100,Number(data.distanceKm)||6)); const base={food:29,groceries:35,parcel:49,documents:39}[type]; const size={small:0,medium:25,large:55}[data.packageSize]??0;
      const deliveryFee=Math.round(base+km*(type==='parcel'?8:5)+size+(data.scheduled?0:5)); const handlingFee=type==='food'||type==='groceries'?Math.round((Number(data.orderTotal)||0)*.02):0;
      return json(res,200,{distanceKm:Number(km.toFixed(1)),deliveryFee,handlingFee,total:money(data.orderTotal)+deliveryFee+handlingFee,eta:`${Math.max(18,Math.round(km*4+8))}–${Math.max(28,Math.round(km*5+18))} min`});
    }
    if(p === '/api/bookings' && req.method==='POST'){
      const data=await bodyJson(req); const required=['category','itemName','customerName','phone','email']; const missing=required.filter(key=>!clean(data[key]));
      if(missing.length) return json(res,400,{error:`Please complete: ${missing.join(', ')}.`});
      if(!/^[6-9]\d{9}$/.test(clean(data.phone).replace(/\s/g,''))) return json(res,400,{error:'Enter a valid 10-digit Indian mobile number.'});
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(data.email))) return json(res,400,{error:'Enter a valid email address.'});
      const store=await readStore(); const reference=`KG${Date.now().toString().slice(-7)}${crypto.randomBytes(2).toString('hex').toUpperCase()}`; const created=new Date().toISOString();
      const booking={id:crypto.randomUUID(),reference,ownerId:(await currentUser(req))?.id||null,category:clean(data.category),itemId:clean(data.itemId),itemName:clean(data.itemName),customerName:clean(data.customerName),phone:clean(data.phone),email:clean(data.email).toLowerCase(),bookingDate:clean(data.bookingDate),returnDate:clean(data.returnDate),guests:Math.max(1,Number(data.guests)||1),pickup:clean(data.pickup),drop:clean(data.drop),pickupTime:clean(data.pickupTime),address:clean(data.address),amount:money(data.amount),paymentMethod:clean(data.paymentMethod)||'Pay on arrival',details:data.details&&typeof data.details==='object'?data.details:{},status:'Request received',createdAt:created,timeline:[{label:'Request received',time:created,done:true},{label:'Partner confirmation',time:null,done:false},{label:clean(data.category)==='delivery'?'Pickup scheduled':'Trip / stay details confirmed',time:null,done:false},{label:clean(data.category)==='delivery'?'Picked up and in transit':'Experience / stay completed',time:null,done:false},{label:clean(data.category)==='delivery'?'Delivered':'Booking completed',time:null,done:false}]};
      store.bookings.unshift(booking); await writeStore(store); return json(res,201,{booking});
    }
    if(p === '/api/bookings/suggest' && req.method==='GET'){
      const user=await currentUser(req);if(!user)return json(res,401,{error:'Sign in to see your booking references.'});
      const q=clean(url.searchParams.get('q')).toLowerCase();if(q.length<3)return json(res,200,{items:[]});
      const store=await readStore();const items=store.bookings.filter(row=>(row.ownerId===user.id||row.email===user.email)&&row.reference.toLowerCase().includes(q)).slice(0,6).map(row=>({value:row.reference,label:row.reference,name:row.itemName,city:row.category,kind:'booking'}));
      return json(res,200,{items});
    }
    if(p === '/api/bookings' && req.method==='GET'){
      const user=await currentUser(req);if(!user)return json(res,401,{error:'Sign in to view your booking history.'});
      const store=await readStore();return json(res,200,{items:store.bookings.filter(row=>row.ownerId===user.id||row.email===user.email)});
    }
    const trackMatch=p.match(/^\/api\/bookings\/track\/([^/]+)$/);
    if(trackMatch&&req.method==='GET'){
      const store=await readStore(); const booking=store.bookings.find(row=>row.reference.toLowerCase()===trackMatch[1].toLowerCase());
      return booking?json(res,200,{booking}):json(res,404,{error:'We could not find that reference. Check the code and try again.'});
    }
    const cancelMatch=p.match(/^\/api\/bookings\/([^/]+)\/cancel$/);
    if(cancelMatch&&req.method==='PATCH'){
      const user=await currentUser(req);if(!user)return json(res,401,{error:'Sign in to manage this booking.'});const store=await readStore(); const booking=store.bookings.find(row=>row.reference===cancelMatch[1]&&(row.ownerId===user.id||row.email===user.email));
      if(!booking)return json(res,404,{error:'Booking not found.'}); if(booking.status!=='Request received')return json(res,409,{error:'This booking can no longer be cancelled online.'});
      booking.status='Cancellation requested'; booking.timeline.push({label:'Cancellation requested',time:new Date().toISOString(),done:true}); await writeStore(store); return json(res,200,{booking});
    }

    // Static frontend: the same server hosts the single-page website and API.
    const relative=p==='/'?'index.html':p.replace(/^\//,''); const file=path.resolve(FRONTEND,relative);
    if(!file.startsWith(FRONTEND+path.sep) && file!==path.join(FRONTEND,'index.html')) return json(res,403,{error:'Forbidden'});
    try { const stat=await fs.stat(file); if(!stat.isFile()) throw new Error('Not a file'); const data=await fs.readFile(file); res.writeHead(200,{'Content-Type':MIME[path.extname(file).toLowerCase()]||'application/octet-stream','Content-Length':data.length,'Cache-Control':path.extname(file)==='.html'?'no-cache':'public, max-age=3600'}); res.end(data); }
    catch { const index=await fs.readFile(path.join(FRONTEND,'index.html')); res.writeHead(200,{'Content-Type':MIME['.html']}); res.end(index); }
  } catch(error){ console.error(error); json(res,500,{error:error.message==='Unexpected end of JSON input'?'Invalid request body':'Something went wrong on the server. Please try again.'}); }
});
initializeStorage().then(async()=>{
  try{const store=await readStore();store.users||=[];store.sessions||=[];store.vehicles||=[];if(!databasePool)await writeLocalStore(store);}catch(error){console.warn('Local store defaults could not be initialized:',error.message);}
  server.listen(PORT,'0.0.0.0',()=>console.log(`Kenchain Groups is running on port ${PORT}${databasePool?' with Neon PostgreSQL':''}`));
}).catch(error=>{
  console.error('Failed to initialize application storage:',error);
  process.exit(1);
});
process.on('SIGTERM',async()=>{ if(databasePool) await databasePool.end(); process.exit(0); });
