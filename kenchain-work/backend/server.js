import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const DATA_FILE = path.join(__dirname, 'data', 'store.json');
let databasePool = null;
const PORT = Number(process.env.PORT || 4000);
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
async function discoverTouristPlaces(area,category,coordinateHint=null){
  const def=touristCategories[category];if(!def)throw new Error('Choose a valid place category.');
  const cacheKey=`${area.toLowerCase().trim()}|${category}|${coordinateHint?.lat||''},${coordinateHint?.lon||''}`,cached=placeSearchCache.get(cacheKey);if(cached&&Date.now()-cached.at<15*60*1000)return cached.data;
  const location=coordinateHint&&Number.isFinite(Number(coordinateHint.lat))&&Number.isFinite(Number(coordinateHint.lon))?{lat:String(coordinateHint.lat),lon:String(coordinateHint.lon),name:area,display_name:area}:await geocodeArea(area),lat=Number(location.lat),lon=Number(location.lon),radius=35000;
  const query=def.tags.replaceAll('R',String(radius)).replaceAll('LAT',String(lat)).replaceAll('LON',String(lon));
  const overpass=`[out:json][timeout:25];(${query});out center tags 80;`;
  const response=await fetch(process.env.OVERPASS_API_URL||'https://overpass-api.de/api/interpreter',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','User-Agent':'KenchainGroups/1.4 (+https://kenchain-groups-updo.onrender.com)'},body:new URLSearchParams({data:overpass}),signal:AbortSignal.timeout(35000)});
  if(!response.ok)throw new Error(`The live place map is temporarily unavailable (${response.status}).`);
  const raw=await response.json(),seen=new Set();
  const items=(raw.elements||[]).map(el=>{const tags=el.tags||{},pLat=Number(el.lat??el.center?.lat),pLon=Number(el.lon??el.center?.lon);if(!tags.name||!Number.isFinite(pLat)||!Number.isFinite(pLon))return null;const osmId=`${el.type}/${el.id}`;if(seen.has(osmId))return null;seen.add(osmId);return{id:`place-${el.type}-${el.id}`,title:tags.name,category,categoryLabel:def.label,location:tags['addr:city']||tags['addr:town']||tags['addr:district']||location.name||area,latitude:pLat,longitude:pLon,distanceKm:Number(haversineKm(lat,lon,pLat,pLon).toFixed(1)),description:tags.description||def.label,activities:def.activities,image:categoryFallback(category),imageAlt:`${tags.name} · ${def.label} near ${area}`,osmId,osmUrl:`https://www.openstreetmap.org/${osmId}`,source:'openstreetmap'};}).filter(Boolean).sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,50);
  const data={area:location.display_name||area,category,categoryLabel:def.label,centre:{latitude:lat,longitude:lon},count:items.length,items,activities:def.activities,source:'OpenStreetMap',attribution:'© OpenStreetMap contributors'};placeSearchCache.set(cacheKey,{at:Date.now(),data});return data;
}
const suggestionCache=new Map(),suggestionLastRequest=new Map();
async function placeSuggestions(q,ip='unknown'){
  const key=q.toLowerCase().trim(),cached=suggestionCache.get(key);if(cached&&Date.now()-cached.at<5*60*1000)return cached.items;
  const last=suggestionLastRequest.get(ip)||0;if(Date.now()-last<250)return[];suggestionLastRequest.set(ip,Date.now());
  const endpoint=(process.env.PHOTON_URL||'https://photon.komoot.io/api/');const params=new URLSearchParams({q,limit:'7',lang:'en',lat:'12.9716',lon:'77.5946',location_bias_scale:'0.2'});
  const response=await fetch(`${endpoint}?${params}`,{headers:{'User-Agent':'KenchainGroups/1.4 (+https://kenchain-groups-updo.onrender.com)'},signal:AbortSignal.timeout(9000)});if(!response.ok)throw new Error('Location suggestions are unavailable. You can still enter the full address.');
  const json=await response.json();const items=(json.features||[]).map(feature=>{const p=feature.properties||{},coords=feature.geometry?.coordinates||[];const name=p.name||p.street||p.city||p.county;if(!name||coords.length<2)return null;const context=[p.city,p.state,p.country].filter(Boolean).filter((v,i,a)=>v!==name&&a.indexOf(v)===i);return{label:[name,...context].join(', '),name,city:p.city||p.county||'',state:p.state||'',country:p.country||'',latitude:Number(coords[1]),longitude:Number(coords[0])};}).filter(Boolean);
  suggestionCache.set(key,{at:Date.now(),items});return items;
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
let geocoderQueue = Promise.resolve();
let lastGeocoderRequest = 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function geocodeArea(area){
  const task = geocoderQueue.then(async () => {
    const pause = Math.max(0, 1100 - (Date.now() - lastGeocoderRequest));
    if (pause) await wait(pause);
    lastGeocoderRequest = Date.now();
    const query = new URLSearchParams({ q: area, format:'jsonv2', limit:'1', countrycodes:'in', addressdetails:'1' });
    const response = await fetch(`${process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org'}/search?${query}`, {
      headers: {
        'User-Agent': `KenchainGroups/1.2 (${process.env.CONTACT_EMAIL || 'website-operator'})`,
        'Referer': process.env.APP_URL || 'https://kenchain-groups-updo.onrender.com'
      },
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error(`Location lookup is temporarily unavailable (${response.status}).`);
    const results = await response.json();
    if (!results.length) throw new Error('We could not find that area. Try a city, town or district name.');
    return results[0];
  });
  geocoderQueue = task.catch(() => {});
  return task;
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
async function discoverAdventurePlaces(area, coordinateHint=null){
  const key=`${area.toLowerCase().replace(/\s+/g,' ').trim()}|${coordinateHint?.lat||''},${coordinateHint?.lon||''}`;
  const cached=adventureCache.get(key);
  if(cached && Date.now()-cached.at<ADVENTURE_CACHE_MS) return cached.data;
  const location=coordinateHint&&Number.isFinite(Number(coordinateHint.lat))&&Number.isFinite(Number(coordinateHint.lon))?{lat:String(coordinateHint.lat),lon:String(coordinateHint.lon),name:area,display_name:area}:await geocodeArea(area);
  const lat=Number(location.lat), lon=Number(location.lon);
  const radius=25000;
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
  const response=await fetch((process.env.OVERPASS_API_URL || 'https://overpass-api.de/api/interpreter'),{
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','User-Agent':'KenchainGroups/1.2 adventure-discovery'},
    body:new URLSearchParams({data:q}),
    signal:AbortSignal.timeout(35000)
  });
  if(!response.ok) throw new Error(`Adventure places are temporarily unavailable (${response.status}). Try again shortly.`);
  const raw=await response.json();
  const seen=new Set();
  const items=(raw.elements||[]).map(el=>{
    const tags=el.tags||{};
    const itemLat=Number(el.lat ?? el.center?.lat), itemLon=Number(el.lon ?? el.center?.lon);
    if(!tags.name || !Number.isFinite(itemLat) || !Number.isFinite(itemLon)) return null;
    const osmKey=`${el.type}/${el.id}`;
    if(seen.has(osmKey)) return null;
    seen.add(osmKey);
    const local=tags['addr:city']||tags['addr:town']||tags['addr:village']||tags['addr:district']||location.name||area;
    const kind=activityKind(tags);
    return {
      id:`osm-${el.type}-${el.id}`, category:'adventure', source:'openstreetmap', osmId:osmKey,
      title:tags.name, location:local, duration:'Check with local operator', price:0, rating:null, reviews:null,
      tag:'Mapped local place', image:categoryFallback(/water|river|kayak|raft|waterfall/i.test(kind)?'waterfalls':/beach|surf/i.test(kind)?'beaches':/wildlife|nature reserve|bird/i.test(kind)?'wildlife':/trek|climb|hiking|cycling/i.test(kind)?'hills':'heritage'), imageAlt:`${tags.name} · ${kind}`,
      description:`${kind}. ${tags.description || 'This is a real place mapped in OpenStreetMap. Confirm current activity operations, access, safety arrangements and availability with the local operator before travelling.'}`,
      activityType:kind, latitude:itemLat, longitude:itemLon, distanceKm:Number(haversineKm(lat,lon,itemLat,itemLon).toFixed(1)),
      osmUrl:`https://www.openstreetmap.org/${el.type}/${el.id}`,
      website:tags.website||tags['contact:website']||'', phone:tags.phone||tags['contact:phone']||'',
      includes:['OpenStreetMap place record','Confirm operator and current availability','Check safety requirements before booking']
    };
  }).filter(Boolean).sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,60);
  const data={area:location.display_name||area, centre:{latitude:lat,longitude:lon}, radiusKm:25, count:items.length, items, source:'OpenStreetMap', osmDataTimestamp:raw.osm3s?.timestamp_osm_base||null, attribution:'© OpenStreetMap contributors'};
  adventureCache.set(key,{at:Date.now(),data});
  return data;
}

const server = http.createServer(async (req,res) => {
  try {
    if(req.method === 'OPTIONS'){ res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type' }); return res.end(); }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = decodeURIComponent(url.pathname);

    if(p === '/api/health' && req.method === 'GET') return json(res,200,{status:'ok',service:'Kenchain Groups API'});
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
    if(p === '/api/places/suggest' && req.method==='GET'){
      const q=clean(url.searchParams.get('q'));if(q.length<2||q.length>100)return json(res,200,{items:[]});
      try{return json(res,200,{items:await placeSuggestions(q,req.socket.remoteAddress||'unknown')});}catch(error){return json(res,502,{error:error.message,items:[]});}
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
    if(p === '/api/places/search' && req.method==='GET'){
      const area=clean(url.searchParams.get('area')),category=clean(url.searchParams.get('category')).toLowerCase();if(area.length<2||area.length>100)return json(res,400,{error:'Enter a city, town or district.'});
      try{const lat=Number(url.searchParams.get('lat')),lon=Number(url.searchParams.get('lon')),hint=Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon}:null;return json(res,200,await discoverTouristPlaces(area,category,hint));}catch(error){console.error('Tourist places search:',error.message);return json(res,502,{error:error.message||'Live map search failed.'});}
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
      try { const lat=Number(url.searchParams.get('lat')),lon=Number(url.searchParams.get('lon')),hint=Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon}:null;const data=await discoverAdventurePlaces(area,hint); return json(res,200,data); }
      catch(error){ console.error('Adventure search:',error.message); return json(res,502,{error:error.message||'Live adventure search failed. Please try again.'}); }
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
