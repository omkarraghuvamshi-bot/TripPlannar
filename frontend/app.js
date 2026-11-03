import { buildGooglePlaceSearchRequest, normalizeGooglePlace, googleTouristQueries, googleAdventureQueries } from './google-places.js';
const API = '/api';
let googleMapsApiKey = '';
let googleMapsMapId = 'DEMO_MAP_ID';
let googleMapsLoadPromise = null;
let googleMapFailureNotified = false;
const $ = (selector, root=document) => root.querySelector(selector);
const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
const money = value => `₹${Math.round(Number(value)||0).toLocaleString('en-IN')}`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateToday = () => new Date().toISOString().slice(0,10);
const icon = (symbol, cls='') => `<span class="simple-icon ${cls}" aria-hidden="true">${symbol}</span>`;
const FALLBACK_IMAGE='/assets/image-fallback.svg';
const fallbackForCategory = category => {
  const key=String(category||'').toLowerCase().replace(/[^a-z]/g,'');
  const map={temple:'temples',temples:'temples',beach:'beaches',beaches:'beaches',waterfall:'waterfalls',waterfalls:'waterfalls',wildlife:'wildlife',stay:'stays',stays:'stays',hospitality:'stays',tour:'heritage',heritage:'heritage',adventure:'hills',hills:'hills',lake:'lakes',lakes:'lakes'};
  return `/assets/place-fallbacks/${map[key]||'heritage'}.svg`;
};
const imageFor = item => item?.imageUrl || item?.image || fallbackForCategory(item?.category);
const imageAltFor = item => item?.imageAlt || `${item?.title || 'Kenchain destination'} · ${item?.location || 'India'}`;
const state = {
  view:'home', catalog:[], restaurants:[], loading:true, error:'', query:'', activeSearch:'', heroTab:'all', globalSearchLoading:false, globalSearchError:'', globalSearchResults:{experiences:[],restaurants:[],places:[],groceries:[]}, deliveryQuery:'',
  sort:'recommended', deliveryType:'food', restaurantId:null, cart:[], modal:null, booking:null,
  trackingRef:'', trackedBooking:null, trackingError:'', bookingItems:[], bookingLookupError:'', toastTimer:null, quote:null,
  adventureResults:[], adventureLookup:false, adventureLoading:false, adventureError:'', adventureArea:'', adventureCentre:null, adventureNotice:'', adventureLive:false,
  user:null,authMode:'login',authError:'',tourismCategory:'temples',tourismArea:'',tourismPlaces:[],tourismCentre:null,tourismLoading:false,tourismError:'',tourismNotice:'',tourismLive:false,tourismProvider:'Google Places API',
  vehicleId:'',vehicle:null,vehicleError:'',vehicleLoading:false,searchCenter:null,directions:null,mapProvider:'google',suggestionTimer:null,suggestionController:null,imageHydration:{tourism:0,adventure:0}
};

async function api(path, options={}) {
  const {headers = {}, signal: callerSignal, ...fetchOptions} = options;
  const timeoutController = new AbortController();
  const timeoutId = window.setTimeout(() => timeoutController.abort(new Error('The server request timed out. Please retry.')), 15000);
  const signal = callerSignal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([callerSignal, timeoutController.signal])
    : (callerSignal || timeoutController.signal);
  try {
    const response = await fetch(`${API}${path}`, {
      credentials: 'same-origin',
      ...fetchOptions,
      signal,
      headers: {Accept: 'application/json', ...(fetchOptions.body ? {'Content-Type': 'application/json'} : {}), ...headers}
    });
    const data = await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError' && timeoutController.signal.aborted && !callerSignal?.aborted) {
      throw new Error('The server took too long to respond. Check that Kenchain Groups is running and retry.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
async function loadData(){
  state.loading=true; state.error=''; render();
  try { const [catalog,restaurants,session,mapConfig]=await Promise.all([api('/catalog'),api('/restaurants'),api('/auth/me').catch(()=>({user:null})),api('/maps/config').catch(()=>({googleMapsApiKey:'',googleMapsMapId:'DEMO_MAP_ID'}))]); state.catalog=catalog.items||[]; state.restaurants=restaurants.items||[]; state.user=session.user||null; googleMapsApiKey=mapConfig.googleMapsApiKey||'';googleMapsMapId=mapConfig.googleMapsMapId||'DEMO_MAP_ID';state.mapProvider='google'; if(state.user){const mine=await api('/bookings');state.bookingItems=mine.items||[];} }
  catch(e){state.error=`${e.message} Make sure the Kenchain Groups server is running, then retry.`;}
  finally{state.loading=false;render();}
}
function navigate(view, keepSearch=false){ if(view!=='vehicles')clearInterval(vehiclePollTimer); state.view=view;state.menuOpen=false;state.modal=null;if(!keepSearch)state.activeSearch='';window.scrollTo({top:0,behavior:'smooth'});render(); }
function quickSearch(term,view){state.query=term;state.activeSearch=term;state.adventureLookup=false;state.adventureResults=[];state.view=view;window.scrollTo({top:0,behavior:'smooth'});if(view==='adventures'){searchAdventurePlaces(term);return;}render();}
async function searchEverything(term){const value=String(term||'').trim();state.query=value;state.activeSearch=value;state.view='search';state.globalSearchLoading=false;state.globalSearchError='';state.globalSearchResults={experiences:[],restaurants:[],places:[],groceries:[]};window.scrollTo({top:0,behavior:'smooth'});if(value.length<2){state.globalSearchError='Enter at least 2 characters to search across Kenchain Groups.';render();return;}state.globalSearchLoading=true;render();try{const data=await api(`/search?q=${encodeURIComponent(value)}`);let googlePlaces=[];if(googleMapsApiKey){try{const libs=await loadGoogleMapsLibraries();const response=await libs.places.Place.searchByText(buildGooglePlaceSearchRequest(`${value} in India`,null,8));googlePlaces=(response.places||[]).map(place=>normalizeGooglePlace(place,{area:'India',category:'heritage',categoryLabel:'Mapped place'})).filter(Boolean);}catch(error){console.info('Google Places general search fallback:',error.message);}}const merged=[...googlePlaces,...(data.places||[])];const seenPlaces=new Set();state.globalSearchResults={experiences:data.experiences||[],restaurants:data.restaurants||[],places:merged.filter(place=>{const key=place.googlePlaceId||place.id||place.title;if(seenPlaces.has(key))return false;seenPlaces.add(key);return true;}).slice(0,12),groceries:groceryItems.filter(x=>`${x.name} ${x.description||''}`.toLowerCase().includes(value.toLowerCase()))};if(!state.globalSearchResults.experiences.length&&!state.globalSearchResults.restaurants.length&&!state.globalSearchResults.places.length&&!state.globalSearchResults.groceries.length)state.globalSearchError=`No matches found for “${value}”. Try another destination, stay, activity or restaurant.`;}catch(error){state.globalSearchError=error.message||'Search is temporarily unavailable. Your local catalogue filters are still available in each service.';state.globalSearchResults.experiences=state.catalog.filter(item=>`${item.title||''} ${item.location||''} ${item.description||''}`.toLowerCase().includes(value.toLowerCase()));state.globalSearchResults.restaurants=state.restaurants.filter(item=>`${item.name||''} ${item.location||''} ${item.type||''}`.toLowerCase().includes(value.toLowerCase()));}finally{state.globalSearchLoading=false;render();}}
async function resolveGoogleAreaCentre(libs, area){
  const value=String(area||'').trim();
  if(!value)return null;
  const queries=[/\bindia\b/i.test(value)?value:`${value}, India`];
  for(const textQuery of queries){
    try{
      const request=buildGooglePlaceSearchRequest(textQuery,null,5);
      const response=await libs.places.Place.searchByText(request);
      const places=response.places||[];
      if(!places.length)continue;
      const priority=['locality','administrative_area_level_2','administrative_area_level_1','postal_town','sublocality','country'];
      const ranked=[...places].sort((a,b)=>{
        const aTypes=a.types||[],bTypes=b.types||[];
        const ai=priority.findIndex(type=>aTypes.includes(type));
        const bi=priority.findIndex(type=>bTypes.includes(type));
        return (ai<0?999:ai)-(bi<0?999:bi);
      });
      for(const place of ranked){
        const normalized=normalizeGooglePlace(place,{area:value,category:'heritage',categoryLabel:'Search area'});
        if(normalized)return {latitude:normalized.latitude,longitude:normalized.longitude,name:normalized.title||value};
      }
    }catch(error){console.info('Google area-centre lookup unavailable:',error.message);}
  }
  return null;
}
async function searchAdventurePlaces(area){
  const value=String(area||'').trim();
  if(value.length<2){state.adventureError='Enter a city, town or district to find mapped outdoor activities.';render();return;}
  state.adventureLookup=true;state.adventureLoading=true;state.adventureError='';state.adventureNotice='';state.adventureLive=false;state.adventureArea=value;state.adventureResults=[];state.adventureCentre=null;render();
  try{
    if(!googleMapsApiKey)throw new Error('Google Places is not configured. Add GOOGLE_MAPS_API_KEY and enable Places API (New).');
    const libs=await loadGoogleMapsLibraries();
    const selectedHint=state.searchCenter&&state.searchCenter.label===value?state.searchCenter:null;
    const areaCentre=selectedHint||knownSearchCentre(value)||await resolveGoogleAreaCentre(libs,value);
    const queries=googleAdventureQueries(value);
    const placesById=new Map();
    let lastError=null;
    for(const query of queries){
      try{
        const request=buildGooglePlaceSearchRequest(query,areaCentre?{lat:Number(areaCentre.latitude),lng:Number(areaCentre.longitude)}:null,20);
        const response=await libs.places.Place.searchByText(request);
        for(const place of response.places||[]){const item=normalizeGooglePlace(place,{area:value,category:'adventure',categoryLabel:'Outdoor activities'});if(item)placesById.set(item.googlePlaceId||item.id,item);}
        if(placesById.size>=8)break;
      }catch(error){lastError=error;console.warn('Google Places adventure search:',error.message);}
    }
    let items=[...placesById.values()];
    if(!items.length)throw lastError||new Error(`Google Places did not find mapped outdoor activity places near ${value}.`);
    const centre=areaCentre?{latitude:Number(areaCentre.latitude),longitude:Number(areaCentre.longitude),name:areaCentre.name||value}: {
      latitude:items.reduce((sum,item)=>sum+item.latitude,0)/items.length,
      longitude:items.reduce((sum,item)=>sum+item.longitude,0)/items.length,
      name:value
    };
    items=items.map(item=>{
      const context=`${item.title} ${item.placeType||''} ${item.description||''}`;
      const activityType=/kayak|raft|river|water|surf|dive|beach/i.test(context)?'Water adventure':/trek|hike|trail|climb|peak|mountain|nature walk/i.test(context)?'Trekking & hiking':/camp/i.test(context)?'Camping':/adventure park|zipline|rope course/i.test(context)?'Adventure park':'Outdoor activity place';
      const imageCategory=/water/i.test(activityType)?'waterfalls':/beach/i.test(context)?'beaches':/trekking/i.test(activityType)?'hills':'heritage';
      return {...item,category:'adventure',categoryLabel:'Outdoor activities',activityType,distanceKm:distanceBetweenKm(centre.latitude,centre.longitude,item.latitude,item.longitude),duration:'Check with local operator',price:0,rating:null,reviews:null,tag:'Google Places result',imageCategory,image:fallbackForCategory(imageCategory),imageAlt:`${item.title} · ${activityType} near ${value}`,activities:['Confirm operator and current availability','Check local permits and weather','Review equipment and safety requirements'],description:`${item.description||item.placeType||'Outdoor activity place'} near ${value}. Confirm current operations, permits and safety with the local provider before travelling.`};
    }).sort((a,b)=>(a.distanceKm??999)-(b.distanceKm??999)).slice(0,20);
    state.adventureResults=items;state.adventureArea=value;state.adventureCentre=centre;state.adventureLive=true;state.adventureNotice='Live place results from Google Places API. Listings identify mapped places, not verified activity operators or live availability.';
    render();hydratePlaceImages('adventure');
  }catch(error){
    console.warn('Google Places adventure discovery unavailable; trying OpenStreetMap fallback:',error.message);
    try{
      const params=new URLSearchParams({area:value});
      const hint=state.searchCenter&&state.searchCenter.label===value?state.searchCenter:null;
      const backupCentre=hint||knownSearchCentre(value);
      if(backupCentre){params.set('lat',backupCentre.latitude);params.set('lon',backupCentre.longitude);}
      const fallback=await api(`/adventures/search?${params}`);
      state.adventureResults=(fallback.items||[]).map(item=>({...item,imageCategory:/water|river|kayak|raft|waterfall/i.test(item.activityType||'')?'waterfalls':/beach|surf/i.test(item.activityType||'')?'beaches':/wildlife|nature reserve|bird/i.test(item.activityType||'')?'wildlife':/trek|climb|hiking|cycling/i.test(item.activityType||'')?'hills':'heritage'}));
      state.adventureArea=fallback.area||value;state.adventureCentre=fallback.centre||backupCentre||null;state.adventureLive=Boolean(fallback.live);state.adventureNotice=`Google Places is temporarily unavailable (${error.message}). ${fallback.notice||'Showing OpenStreetMap or curated backup results.'}`;
      if(state.adventureResults.length){render();hydratePlaceImages('adventure');}else state.adventureError=`No outdoor activity places were found around ${value}. ${state.adventureNotice}`;
    }catch(fallbackError){state.adventureError=`Google Places search failed: ${error.message}. ${fallbackError.message}`;}
  }finally{state.adventureLoading=false;render();}
}
function showToast(message){let el=$('.toast');if(el)el.remove();const node=document.createElement('div');node.className='toast';node.innerHTML=`${icon('✓')} ${esc(message)}`;document.body.appendChild(node);clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>node.remove(),2600);}
function footer(){return `<footer class="footer"><div class="footer-main section-width"><div class="footer-brand"><button class="brand" data-nav="home"><span class="brand-mark">↗</span><span>kenchain<span> groups</span><i>.</i></span></button><p>Go farther. Get it there.<br/>A better way to move through your plans.</p></div><div class="footer-links"><div><b>Explore</b><button data-nav="tours">Tours & trips</button><button data-nav="adventures">Adventure</button><button data-nav="stays">Hospitality</button></div><div><b>Move things</b><button data-delivery="food">Food & groceries</button><button data-delivery="parcel">Courier & parcels</button><button data-nav="track">Track a booking</button><button data-nav="vehicles">Bus & vehicle tracking</button><button data-nav="explore">Places by category</button></div><div><b>Your account</b><button data-nav="account">${state.user?'My account':'Sign in / Register'}</button><button data-nav="bookings">My bookings</button><span>Help centre: hello@kenchaingroups.example</span><span>Bengaluru, India</span></div></div></div><div class="footer-bottom section-width"><span>© 2026 Kenchain Groups. Built for the way you move.</span><span>Go well. Get there.</span></div></footer>`;}
function header(){return `<header class="topbar"><button class="brand" data-nav="home" aria-label="Kenchain Groups home"><span class="brand-mark">↗</span><span>kenchain<span> groups</span><i>.</i></span></button><nav class="nav-links ${state.menuOpen?'show':''}"><button class="${state.view==='tours'?'active':''}" data-nav="tours">Tours & trips</button><button class="${state.view==='adventures'?'active':''}" data-nav="adventures">Adventure</button><button class="${state.view==='stays'?'active':''}" data-nav="stays">Hospitality</button><button class="${state.view==='explore'?'active':''}" data-nav="explore">Explore places</button><button class="${state.view==='delivery'?'active':''}" data-delivery="food">Delivery</button><button class="${state.view==='vehicles'?'active':''}" data-nav="vehicles">Vehicle tracking</button></nav><div class="header-actions"><button class="track-link" data-nav="track">⌖ &nbsp;Track order</button><button class="account-action" data-nav="account" aria-label="${state.user?'Open account':'Sign in or create an account'}">${state.user?`<span class="account-action-avatar">${esc(state.user.name.slice(0,1).toUpperCase())}</span><span>My account</span>`:'<span aria-hidden="true">♙</span><span>Sign in</span>'}</button><button class="cart-action" data-delivery="food" aria-label="Shopping bag">▱ ${state.cart.length?`<b>${state.cart.reduce((s,i)=>s+i.qty,0)}</b>`:''}</button><button class="mobile-menu" data-action="menu" aria-label="Toggle menu" aria-expanded="${state.menuOpen?'true':'false'}">☰</button></div></header>${state.error?`<div class="server-alert">ⓘ <span>${esc(state.error)}</span><button data-action="retry">Retry</button></div>`:''}${state.loading?'<div class="loading-strip"><span></span></div>':''}`;}
function serviceCard(img,number,title,copy,action,nav,theme){
  const route=nav==='delivery'?'data-delivery="food"':`data-nav="${nav}"`;
  const imageAlt=({tours:'Scenic destination for guided tours',adventures:'Outdoor adventure landscape',stays:'Comfortable hotel and hospitality stay',delivery:'Food and parcel delivery service'})[nav]||title;
  const fallback=nav==='adventures'?fallbackForCategory('hills'):nav==='stays'?fallbackForCategory('stays'):nav==='delivery'?FALLBACK_IMAGE:fallbackForCategory('heritage');
  return `<button type="button" class="service-card ${theme}" ${route}><img src="${img}" data-fallback-src="${fallback}" alt="${imageAlt}" loading="lazy" decoding="async"/><div class="service-overlay"></div><div class="service-card-top"><span>${theme==='orange'?'✦':theme==='lime'?'⌁':theme==='purple'?'⌂':'⇢'}</span><small>${number}</small></div><div class="service-card-bottom"><h3>${title}</h3><p>${copy}</p><span class="service-action">${action} ↗</span></div></button>`;
}
function experienceCard(item){const live=['openstreetmap','google-places'].includes(item.source);const mapped=live||item.source==='kenchain-curated-fallback';const cat=item.category==='tour'?'TRIP':item.category==='stay'?'HOSPITALITY':live?'LIVE MAP PLACE':mapped?'CURATED MAP PLACE':'ADVENTURE';const per=item.category==='stay'?'night':'person';const price=mapped?'Ask local operator':money(item.price);const rating=live?`<span class="live-source">● ${item.source==='google-places'?'Google Places':'OpenStreetMap'}</span>`:mapped?`<span class="live-source curated-source">● Curated location</span>`:`<span class="rating">★ ${item.rating||'—'} <small>(${item.reviews||0})</small></span>`;return `<article class="experience-card ${live?'live-adventure-card':''}"><button class="experience-image" data-book="${esc(item.id)}" aria-label="View ${esc(item.title)}"><img src="${esc(imageFor(item))}" data-fallback-src="${esc(fallbackForCategory(item.imageCategory||item.category))}" alt="${esc(imageAltFor(item))}" loading="lazy" decoding="async"/><span class="image-label">${cat}</span>${item.tag?`<span class="tag-label">${esc(item.tag)}</span>`:''}<span class="image-arrow">↗</span></button><div class="experience-info"><div class="experience-location">⌖ ${esc(item.location)}${live&&item.distanceKm!=null?` · ${esc(item.distanceKm)} km from search area`:''}</div><h3>${esc(item.title)}</h3><div class="experience-meta"><span>◷ ${esc(item.duration)}</span>${rating}</div><div class="experience-foot"><div><small>${mapped?'VISIT INFO':'FROM'}</small><b>${price}${!mapped?`<i> / ${per}</i>`:''}</b></div><button data-book="${esc(item.id)}">${mapped?'Enquire →':'Book now →'}</button></div>${mapped?`<div class="osm-card-footer"><a href="${esc(item.mapUrl||item.osmUrl)}" target="_blank" rel="noopener">Open mapped place ↗</a>${item.sourceUrl?`<a href="${esc(item.sourceUrl)}" target="_blank" rel="noopener">Destination info ↗</a>`:''}<button type="button" class="direction-button" data-directions-id="${esc(item.id)}">Get directions ↗</button>${item.imagePageUrl?`<small>Photo: <a href="${esc(item.imagePageUrl)}" target="_blank" rel="noopener">${esc(item.imageCredit||'Wikimedia Commons')}</a> · ${esc(item.imageLicense||'See licence')}</small>`:''}</div>`:''}</div></article>`;}
const TOUR_CATEGORIES=[
{id:'temples',name:'Temples',sub:'Sacred places & architecture',img:'https://images.unsplash.com/photo-1548013146-72479768bada?auto=format&fit=crop&w=900&q=82',activities:['Temple trails','Heritage walks','Photography']},
{id:'beaches',name:'Beaches',sub:'Coastlines & water life',img:'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=900&q=82',activities:['Kayaking','Surf lessons','Coastal hikes']},
{id:'waterfalls',name:'Waterfalls',sub:'Nature escapes & cascades',img:'https://images.unsplash.com/photo-1432405972618-c60b47a9f7c8?auto=format&fit=crop&w=900&q=82',activities:['Nature hikes','Photography','Birdwatching']},
{id:'heritage',name:'Heritage',sub:'Forts, monuments & museums',img:'https://images.unsplash.com/photo-1564501049412-61c2a3083791?auto=format&fit=crop&w=900&q=82',activities:['Guided walks','Museums','Local crafts']},
{id:'wildlife',name:'Wildlife',sub:'Reserves & forest landscapes',img:'https://images.unsplash.com/photo-1549366021-9f761d450615?auto=format&fit=crop&w=900&q=82',activities:['Safaris','Birdwatching','Nature trails']},
{id:'hills',name:'Hill stations',sub:'Peaks, viewpoints & cool air',img:'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=900&q=82',activities:['Trekking','Camping','Cycling']},
{id:'lakes',name:'Lakes & rivers',sub:'Waterfront slow days',img:'https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=900&q=82',activities:['Boating','Kayaking','Birdwatching']}
];
function categorySection(){return `<section class="section-width category-discovery"><div class="section-heading"><div><span class="eyebrow">FIND YOUR KIND OF GETAWAY</span><h2>What are you in the mood <em>for?</em></h2></div><button class="text-link" data-nav="explore">Explore all places ↗</button></div><div class="tour-category-grid">${TOUR_CATEGORIES.map(c=>`<button type="button" class="tour-category-card" data-tour-category="${c.id}" aria-label="Explore ${c.name}: ${c.activities.join(', ')}"><img src="${c.img}" data-fallback-src="${fallbackForCategory(c.id)}" alt="${c.name} destination landscape" loading="lazy" decoding="async"/><span class="category-card-shade"></span><span class="category-card-text"><b>${c.name}</b><small>${c.sub}</small><i>${c.activities.join(' · ')}</i></span></button>`).join('')}</div></section>`;}
function home(){const trips=state.catalog.filter(i=>i.category==='tour').slice(0,3),stays=state.catalog.filter(i=>i.category==='stay').slice(0,3);return `<section class="hero-wrap"><div class="hero-copy"><div class="eyebrow"><span class="eyebrow-dot"></span> ONE APP. MORE OUT THERE.</div><h1>Make plans.<br/><em>Make memories.</em><br/>Move anything.</h1><p>Weekend escapes, wild experiences, welcoming hospitality and doorstep delivery. All your plans, one easy route.</p><div class="hero-trust"><span>◈ Local experiences, one easy plan</span><span>✧ Made for easy plans</span></div></div><div class="hero-art"><img class="hero-photo" src="https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=1600&q=90" data-fallback-src="${fallbackForCategory('lakes')}" alt="Mountain lake and dramatic travel landscape" loading="eager" decoding="async"/><div class="photo-shade"></div><div class="hero-stamp"><span>GO A LITTLE</span><strong>FURTHER</strong><i>↗</i></div><div class="floating-note"><span class="note-icon">⌖</span><div><b>Your next story</b><small>is one booking away</small></div>↗</div></div><div class="hero-bottom-line"><span>EXPLORE MORE, WORRY LESS</span><span>01 / 04</span></div></section><section class="quick-search section-width"><div class="quick-tabs">${[['all','✦','All services'],['tour','⌖','Tours & trips'],['adventure','⌁','Adventure'],['stay','⌂','Hospitality'],['delivery','⇢','Delivery']].map(([key,ic,label])=>`<button class="${state.heroTab===key?'selected':''}" data-hero-tab="${key}">${ic} ${label}</button>`).join('')}</div><form class="search-row" data-form="hero-search"><div class="search-field">⌖ <label><small>WHERE TO?</small><input name="query" value="${esc(state.query)}" placeholder="Try Coorg, Hampi, Gokarna..."/></label></div><div class="search-divider"></div><div class="search-prompt">▦ <span><small>WHEN</small><b>Pick your dates later</b></span></div><button class="search-button">⌕ ${state.heroTab==='all'?'Search everything':state.heroTab==='tour'?'Find trips':state.heroTab==='adventure'?'Find adventures':state.heroTab==='delivery'?'Find food & delivery':'Find hospitality'}</button></form><p class="search-hint">Popular: <button data-quick-search="Coorg" data-target="tours">Coorg</button><button data-quick-search="Gokarna" data-target="tours">Gokarna</button><button data-quick-search="Kudremukh" data-target="adventures">Kudremukh trek</button></p></section><section class="section-width service-section"><div class="section-heading"><div><span class="eyebrow">THE KENCHAIN GROUPS WAY</span><h2>Four ways to <em>get going.</em></h2></div><p>From the first mile of your trip to the last mile of a delivery, we've got the details covered.</p></div><div class="service-grid">${serviceCard('https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1000&q=85','01','Tours & trips','Curated escapes with pickup and drop built in.','Explore trips','tours','orange')}${serviceCard('https://images.unsplash.com/photo-1551632811-561732d1e306?auto=format&fit=crop&w=1000&q=85','02','Adventure','Find a trail, chase a rapid, try something new.','Get your thrill','adventures','lime')}${serviceCard('https://images.unsplash.com/photo-1445019980597-93fa8acb246c?auto=format&fit=crop&w=1000&q=85','03','Hospitality','Hotels, homestays and welcoming places to recharge.','Explore hospitality','stays','purple')}${serviceCard('https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?auto=format&fit=crop&w=1000&q=85','04','Send it. We’ll get it there.','Food, groceries, parcels and documents.','Book a delivery','delivery','blue')}</div></section>${categorySection()}${trackingWidget('Track any Kenchain service','Have a booking reference? Track a tour, adventure, hospitality request or delivery in one place.')}<section class="section-width feature-section"><div class="section-heading"><div><span class="eyebrow">THE WEEKEND EDIT</span><h2>Trips worth <em>the detour.</em></h2></div><button class="text-link" data-nav="tours">See all trips ↗</button></div><div class="card-grid three">${state.loading?'<div class="skeleton-card"><div></div><span></span></div>'.repeat(3):trips.map(experienceCard).join('')}</div></section><section class="adventure-band"><div class="adventure-band-image"><img src="https://images.unsplash.com/photo-1473448912268-2022ce9509d8?auto=format&fit=crop&w=1400&q=85" data-fallback-src="${fallbackForCategory('hills')}" alt="Sunlight falling through a forest trail" loading="lazy" decoding="async"/></div><div class="adventure-band-copy"><span class="eyebrow">A LITTLE OUT OF YOUR COMFORT ZONE</span><h2>Good stories<br/>start <em>outside.</em></h2><p>Guided trails, river days and fresh-air fixes. Find an experience that gets your heart going.</p><button class="button-primary" data-nav="adventures">Explore adventures →</button><button class="button-secondary" data-nav="vehicles">Track your bus / vehicle →</button></div><div class="band-tag">WILD<br/>LOOKS<br/>GOOD <span>↗</span></div></section><section class="section-width feature-section stay-feature"><div class="section-heading"><div><span class="eyebrow">HOSPITALITY / SLEEP WELL, WANDER FAR</span><h2>Hospitality with a <em>feeling.</em></h2></div><button class="text-link" data-nav="stays">Browse hospitality ↗</button></div><div class="card-grid three">${stays.map(experienceCard).join('')}</div></section><section class="delivery-promo section-width"><div class="delivery-promo-copy"><span class="eyebrow">THE OTHER KIND OF GETAWAY</span><h2>Your cravings.<br/><em>Our coordinates.</em></h2><p>Food, groceries, parcels or that important envelope. Set your pickup and drop, then let the good stuff move.</p><div class="delivery-icons"><span>♨ Food</span><span>❋ Groceries</span><span>▣ Parcels</span><span>▤ Documents</span></div><button class="button-primary" data-delivery="food">Explore delivery →</button></div><div class="delivery-promo-photo"><img src="https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?auto=format&fit=crop&w=1200&q=85" data-fallback-src="${FALLBACK_IMAGE}" alt="Freshly prepared pizza" loading="lazy" decoding="async"/><div class="delivery-floating">⇢ <span><b>Pickup to doorstep</b><small>One simple booking</small></span></div></div></section><section class="how-section section-width"><div class="section-heading"><div><span class="eyebrow">NO COMPLICATED PLANS</span><h2>Three steps. <em>You’re set.</em></h2></div></div><div class="steps-grid"><div class="step"><span>01</span><div><h3>Choose your thing</h3><p>Find a trip, experience, stay or delivery service.</p></div></div><div class="step"><span>02</span><div><h3>Add your details</h3><p>Pick dates, travellers and pickup or drop-off points.</p></div></div><div class="step"><span>03</span><div><h3>Get moving</h3><p>Receive a booking reference and track the next steps.</p></div></div></div></section>`;}
const INDIA_MAP_CENTRE=[22.5937,78.9629];
const DEST_COORDS = {
  'madikeri':[12.4244,75.7382], 'hampi':[15.3350,76.4600], 'gokarna':[14.5479,74.3188], 'mysuru':[12.2958,76.6394],
  'barapole':[12.20,75.75], 'kudremukh':[13.2297,75.1730], 'dandeli':[15.2470,74.6290], 'nandi hills':[13.3702,77.6835],
  'bengaluru':[12.9716,77.5946], 'coorg':[12.3375,75.8069], 'chikmagalur':[13.3161,75.7720], 'sakleshpur':[12.9416,75.7840],
  'jaipur':[26.9124,75.7873], 'puri':[19.8135,85.8312], 'varanasi':[25.3176,82.9739], 'kochi':[9.9312,76.2673],
  'mumbai':[19.0760,72.8777], 'shillong':[25.5788,91.8933], 'chennai':[13.0827,80.2707], 'gangtok':[27.3389,88.6065],
  'panaji':[15.4909,73.8278], 'leh':[34.1526,77.5771], 'port blair':[11.6234,92.7265], 'dispur':[26.1433,91.7898],
  'new delhi':[28.6139,77.2090], 'delhi':[28.6139,77.2090], 'agra':[27.1767,78.0081], 'amritsar':[31.6340,74.8723],
  'udaipur':[24.5854,73.7125], 'jaisalmer':[26.9157,70.9083], 'rishikesh':[30.0869,78.2676], 'manali':[32.2396,77.1887],
  'shimla':[31.1048,77.1734], 'hyderabad':[17.3850,78.4867], 'kolkata':[22.5726,88.3639], 'pune':[18.5204,73.8567],
  'ahmedabad':[23.0225,72.5714], 'bhopal':[23.2599,77.4126], 'lucknow':[26.8467,80.9462], 'patna':[25.5941,85.1376],
  'bhuvaneswar':[20.2961,85.8245], 'bhubaneswar':[20.2961,85.8245], 'visakhapatnam':[17.6868,83.2185], 'vijayawada':[16.5062,80.6480],
  'madurai':[9.9252,78.1198], 'tirupati':[13.6288,79.4192], 'ranchi':[23.3441,85.3096], 'kohima':[25.6751,94.1086]
};
function coordsFor(item){
  const lat=item?.latitude??item?.lat,lon=item?.longitude??item?.lng??item?.lon;
  const latitude=lat==null||lat===''?NaN:Number(lat),longitude=lon==null||lon===''?NaN:Number(lon);
  if(Number.isFinite(latitude)&&Number.isFinite(longitude)&&Math.abs(latitude)<=90&&Math.abs(longitude)<=180)return [latitude,longitude];
  const text=`${item?.location||''} ${item?.title||item?.name||''}`.toLowerCase();
  const key=Object.keys(DEST_COORDS).sort((a,b)=>b.length-a.length).find(k=>text.includes(k));
  return key?DEST_COORDS[key]:null;
}
const resolvedMapCoordinates=new Map();
async function mapItemsWithCoordinates(items,libs){
  const candidates=(items||[]).slice(0,18);
  const resolved=await Promise.all(candidates.map(async item=>{
    const known=coordsFor(item);if(known)return {...item,__mapCoordinates:known};
    const key=`${item.googlePlaceId||''}|${item.title||item.name||''}|${item.location||''}`.toLowerCase();
    if(resolvedMapCoordinates.has(key)){
      const cached=resolvedMapCoordinates.get(key);return cached?{...item,__mapCoordinates:cached}:null;
    }
    let coordinates=null;
    try{
      if(item.googlePlaceId&&libs?.places?.Place){
        const place=new libs.places.Place({id:item.googlePlaceId});
        await place.fetchFields({fields:['location']});
        const location=place.location;
        if(location)coordinates=[Number(typeof location.lat==='function'?location.lat():location.lat),Number(typeof location.lng==='function'?location.lng():location.lng)];
      }
      if(!coordinates&&libs?.places?.Place?.searchByText){
        const label=[item.title||item.name,item.location,'India'].filter(Boolean).join(', ');
        const response=await libs.places.Place.searchByText(buildGooglePlaceSearchRequest(label,null,1));
        const result=response.places?.[0];
        if(result?.location){const location=result.location;coordinates=[Number(typeof location.lat==='function'?location.lat():location.lat),Number(typeof location.lng==='function'?location.lng():location.lng)];}
      }
    }catch(error){console.info('Could not resolve map coordinates for catalogue item:',item.title||item.name,error.message);}
    if(!coordinates||!coordinates.every(Number.isFinite)||Math.abs(coordinates[0])>90||Math.abs(coordinates[1])>180)coordinates=null;
    resolvedMapCoordinates.set(key,coordinates);
    return coordinates?{...item,__mapCoordinates:coordinates}:null;
  }));
  return resolved.filter(Boolean);
}
function trackingWidget(title,copy){return `<section class="feature-tracking section-width"><div class="tracking-widget-copy"><span class="eyebrow">YOUR BOOKING, YOUR UPDATES</span><h3>${title}</h3><p>${copy}</p></div><form class="tracking-widget-form" data-form="tracking"><label for="quick-track-ref">Booking / delivery reference</label><div><input id="quick-track-ref" name="reference" required placeholder="e.g. KG1234567AB" value="${esc(state.trackingRef||'')}"/><button class="button-primary">Track now ↗</button></div></form></section>`;}
function listing(){
  const config={
    tours:{eyebrow:'TAKE THE SCENIC ROUTE',title:'Trips with a little more <em>story.</em>',desc:'Curated journeys, local guides and pickup-to-drop convenience. Pick a place, we’ll help with the rest.',category:'tour',art:'tours'},
    adventures:{eyebrow:'FIND YOUR OUTSIDE',title:'Real places. <em>Real outdoor plans.</em>',desc:'Search a city, town or region to discover outdoor activity places through Google Places. Check local operators, safety and availability before booking.',category:'adventure',art:'adventures'},
    stays:{eyebrow:'HOSPITALITY / CHECK IN WELL',title:'Hospitality with its own <em>story.</em>',desc:'Discover hotels, homestays and comfortable places to stay, with check-in dates and optional pickup or drop transfers.',category:'stay',art:'stays'}
  }[state.view];
  const liveAdventure=state.view==='adventures'&&state.adventureLookup;
  let items=liveAdventure?state.adventureResults:state.catalog.filter(i=>i.category===config.category&&(!state.activeSearch||`${i.title} ${i.location} ${i.description}`.toLowerCase().includes(state.activeSearch.toLowerCase())));
  items=[...items].sort((a,b)=>state.sort==='price-low'?a.price-b.price:state.sort==='price-high'?b.price-a.price:(b.rating||0)-(a.rating||0));
  const pageTitle=state.view==='stays'?'Hospitality':config.title;
  const resultLabel=liveAdventure?`${items.length} ${state.adventureLive?'live Google Places':'backup'} outdoor destinations near ${esc(state.adventureArea)}`:`${items.length} ${items.length===1?'experience':'experiences'} to explore`;
  return `<main class="listing-page section-width ${state.view==='stays'?'hospitality-page':''}">
    <div class="listing-hero"><div><span class="eyebrow">${config.eyebrow}</span><h1>${pageTitle}</h1><p>${config.desc}</p></div><div class="listing-hero-art ${config.art}"><span>${state.view==='tours'?'GO FURTHER':state.view==='adventures'?'FIND YOUR WILD':'HOSPITALITY'}</span></div></div>
    <div class="listing-controls"><form class="listing-search" data-form="listing-search">⌕ <input name="query" value="${esc(state.query)}" placeholder="${state.view==='adventures'?'Search a real area: Gokarna, Coorg, Dandeli…':'Search by destination or experience'}"/><button>${state.view==='adventures'?'Find places':'Search'}</button></form><label class="sort-control"><span>Sort by</span><select data-action="sort"><option value="recommended" ${state.sort==='recommended'?'selected':''}>Recommended</option><option value="price-low" ${state.sort==='price-low'?'selected':''}>Price: low to high</option><option value="price-high" ${state.sort==='price-high'?'selected':''}>Price: high to low</option></select>⌄</label></div>
    ${state.view==='adventures'?`<div class="adventure-live-note"><span class="live-pulse"></span><div><b>${state.adventureLookup?(state.adventureLive?'Google Places discovery':state.adventureResults.length?'Area discovery · curated backup':'Area lookup · no mapped matches'):'Area-based discovery'}</b><small>${state.adventureLookup?(state.adventureLive?'Results are fetched from Google Places. Activity operators, availability and prices are not implied.':esc(state.adventureNotice||'Live map data is temporarily unavailable. Curated destination results are used where available.')):'Search a city, town or region to discover mapped outdoor destinations.'}</small></div><span>${state.adventureLookup?(state.adventureLive?'GOOGLE PLACES':state.adventureResults.length?'BACKUP DATA':'NO MATCHES'):'SEARCH BY AREA'}</span></div>`:''}
    ${trackingWidget(state.view==='tours'?'Track your trip':state.view==='adventures'?'Track your adventure': 'Track your hospitality booking',`Already sent a ${state.view==='tours'?'tour request':state.view==='adventures'?'activity enquiry':'stay request'}? Enter its reference to follow the latest booking steps.`)}
    <section class="map-panel"><div class="map-panel-heading"><div><span class="eyebrow">EXPLORE THE REAL MAP</span><h2>${liveAdventure?'Outdoor places around':'Find your'} <em>${liveAdventure?esc(state.adventureArea):'way there.'}</em></h2><p>${liveAdventure?(state.adventureLive?'Pins show Google Places results around your selected area.':'Pins use curated backup coordinates while live place data recovers.'):`Google Maps basemap with destination markers and current-location directions.`}</p></div>${mapProviderControls()}</div><div id="explore-map" class="explore-map" role="application" aria-label="Interactive destination map"></div><div id="directions-result" class="directions-result" hidden aria-live="polite"></div></section>
    <div class="results-row"><span>${resultLabel}</span>${state.activeSearch?'<button data-action="clear-search">Clear search ×</button>':''}</div>
    ${state.adventureLoading?`<div class="live-search-state"><span class="spinner-dot"></span><b>Looking around ${esc(state.adventureArea)}…</b><small>Finding real mapped outdoor activity places.</small></div>`:''}
    ${state.adventureNotice&&state.view==='adventures'&&state.adventureLive?`<div class="live-search-state">${esc(state.adventureNotice)}</div>`:''}
    ${state.adventureError&&state.view==='adventures'?`<div class="live-search-error">${esc(state.adventureError)} <button class="button-secondary" data-action="clear-adventure-search">Show featured activities</button></div>`:''}
    ${items.length?`<div class="card-grid three listing-grid">${items.map(experienceCard).join('')}</div>`:!state.adventureLoading&&!state.adventureError?`<div class="empty-state">⌖<h3>No matching experiences yet</h3><p>Try another nearby destination or clear your search.</p><button class="button-secondary" data-action="clear-search">Clear filters</button></div>`:''}
    ${liveAdventure?`<p class="osm-disclaimer">Activity places and coordinates are sourced from OpenStreetMap, not live operator inventory. An enquiry is a request only. Confirm opening status, activity availability, prices, licences and safety arrangements directly with the operator. <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap attribution and licence ↗</a></p>`:`<div class="listing-note">◈ <span><b>Local partners, clearer plans.</b> Booking requests capture dates, travellers, pickup and drop-off points before you submit.</span></div>`}
  </main>`;
}
const TOUR_ACTIVITY_MAP={
  temples:['Temple architecture walks','Cultural & heritage tours','Photography','Local food trails'],beaches:['Kayaking with local operators','Surf lessons','Coastal hikes','Beach camping'],waterfalls:['Guided nature hikes','Landscape photography','Birdwatching','Canyoning with licensed operators'],heritage:['Guided heritage walks','Museum visits','Architecture tours','Local craft experiences'],wildlife:['Guided wildlife safaris','Birdwatching','Nature interpretation trails','Wildlife photography'],hills:['Guided trekking','Camping','Cycling','Sunrise viewpoints'],lakes:['Boating where officially permitted','Kayaking with operators','Birdwatching','Lakeside nature walks']
};
function globalSearchPage(){const r=state.globalSearchResults;return `<main class="global-search-page section-width"><section class="global-search-hero"><span class="eyebrow">SEARCH KENCHAIN GROUPS</span><h1>One search.<br/><em>All your plans.</em></h1><form class="global-search-form" data-form="global-search"><input type="search" name="query" value="${esc(state.query)}" placeholder="Search destinations, trips, stays, restaurants…" autocomplete="off" minlength="2" required/><button class="button-primary">Search ↗</button></form><p>Search across tours, adventures, Hospitality, restaurants and mapped places.</p></section>${state.globalSearchLoading?'<div class="live-search-state"><span class="spinner-dot"></span><b>Searching all services…</b></div>':''}${state.globalSearchError?`<div class="live-search-error">${esc(state.globalSearchError)}</div>`:''}${r.experiences.length?`<section class="global-result-section"><div class="section-heading"><div><span class="eyebrow">TRIPS, ACTIVITIES & HOSPITALITY</span><h2>Experiences <em>to explore.</em></h2></div></div><div class="card-grid three">${r.experiences.map(experienceCard).join('')}</div></section>`:''}${r.restaurants.length?`<section class="global-result-section"><div class="section-heading"><div><span class="eyebrow">FOOD & DELIVERY</span><h2>Local <em>favourites.</em></h2></div></div><div class="restaurant-strip">${r.restaurants.map(x=>`<button class="restaurant-card" data-global-restaurant="${esc(x.id)}"><img src="${esc(x.image||FALLBACK_IMAGE)}" data-fallback-src="${FALLBACK_IMAGE}" alt="${esc(x.name)}" loading="lazy"/><span class="restaurant-info"><b>${esc(x.name)}</b><small>${esc(x.type)} · ${esc(x.location)}</small><span>★ ${esc(x.rating||'—')} · ${esc(x.eta||'')}</span></span></button>`).join('')}</div></section>`:''}${r.groceries.length?`<section class="global-result-section"><div class="section-heading"><div><span class="eyebrow">GROCERIES</span><h2>Everyday <em>essentials.</em></h2></div></div><div class="food-grid">${r.groceries.map(item=>`<article class="food-item"><div class="food-item-image"><img src="${esc(item.image||FALLBACK_IMAGE)}" data-fallback-src="${FALLBACK_IMAGE}" alt="${esc(item.name)}" loading="lazy"/><button type="button" data-global-grocery="${esc(item.id)}">+</button></div><div class="food-item-info"><h4>${esc(item.name)}</h4><p>${esc(item.description)}</p><b>${money(item.price)}</b></div></article>`).join('')}</div></section>`:''}${r.places.length?`<section class="global-result-section"><div class="section-heading"><div><span class="eyebrow">MAPPED PLACES</span><h2>Places near <em>your search.</em></h2></div></div><div class="global-place-results">${r.places.map((x,i)=>`<button class="global-place-result" data-global-place="${i}"><span>⌖</span><span><b>${esc(x.name||x.label)}</b><small>${esc([x.city,x.state,x.country].filter(Boolean).join(' · '))}</small></span><i>Explore ↗</i></button>`).join('')}</div></section>`:''}<div class="global-search-footer"><button class="button-secondary" data-nav="home">← Back home</button><button class="button-secondary" data-nav="explore">Browse place categories</button></div></main>`;}

function touristPlacesPage(){
  const cat=TOUR_CATEGORIES.find(c=>c.id===state.tourismCategory)||TOUR_CATEGORIES[0];
  const hasArea=Boolean(state.tourismArea);
  const sourceLabel=!hasArea?'INTERACTIVE DESTINATION MAP':state.tourismLive?`LIVE ${String(state.tourismProvider||'GOOGLE PLACES API').toUpperCase()} PLACES`:state.tourismPlaces.length?'CURATED / OSM MAP BACKUP':'MAP CENTRE / NO MATCHES';
  const sourceCopy=!hasArea?'Search for a city, town or district to put destinations on the map.':state.tourismLive?`Place pins are returned from live ${state.tourismProvider||'Google Places API'} data.`:(state.tourismNotice||'The map is centred on your searched area. Search another category or nearby town to find pins.');
  return `<main class="tourism-page section-width">
    <section class="tourism-hero"><span class="eyebrow">KENCHAIN DESTINATION DISCOVERY</span><h1>Find the places<br/><em>you came for.</em></h1><p>Temples, beaches, waterfalls, heritage sites, wildlife, hill stations and lakes. Search an area to discover mapped destinations and ideas for exploring nearby.</p></section>
    <div class="tour-category-tabs">${TOUR_CATEGORIES.map(c=>`<button class="${c.id===state.tourismCategory?'active':''}" data-tour-category="${c.id}">${c.name}</button>`).join('')}</div>
    <form class="tourism-search" data-form="tourism-search"><label><small>DESTINATION / AREA</small><input name="area" value="${esc(state.tourismArea)}" placeholder="Search an area: Hampi, Gokarna, Coorg…" autocomplete="off"/><span class="search-helper">Live location suggestions</span></label><button class="button-primary">Explore ${esc(cat.name)} ↗</button></form>
    <div class="activity-ideas"><b>Ideas for this trip</b>${(TOUR_ACTIVITY_MAP[state.tourismCategory]||[]).map(x=>`<span>${esc(x)}</span>`).join('')}</div>
    <section class="map-panel tourism-map-panel"><div class="map-panel-heading"><div><span class="eyebrow">${sourceLabel}</span><h2>${state.tourismArea?`Around <em>${esc(state.tourismArea)}</em>`:`Explore ${esc(cat.name)}`}</h2><p>${sourceCopy}</p></div>${mapProviderControls()}</div><div id="tourism-map" class="explore-map" aria-label="Interactive tourist places map"></div><div id="directions-result" class="directions-result" hidden aria-live="polite"></div></section>
    <div class="results-row"><span>${state.tourismLoading?'Finding places…':state.tourismPlaces.length?`${state.tourismPlaces.length} ${state.tourismLive?'mapped':'curated'} ${cat.name.toLowerCase()} places`:state.tourismArea?'No matching places returned yet':'Enter an area to discover places'}</span></div>
    ${state.tourismLoading?'<div class="live-search-state"><span class="spinner-dot"></span><b>Searching the map…</b></div>':''}
    ${state.tourismNotice?`<div class="live-search-state">${esc(state.tourismNotice)}</div>`:''}
    ${state.tourismError?`<div class="live-search-error">${esc(state.tourismError)}</div>`:''}
    <div class="place-discovery-grid">${state.tourismPlaces.map(place=>`<article class="place-discovery-card"><img src="${esc(imageFor(place))}" data-fallback-src="${esc(fallbackForCategory(place.imageCategory||place.category))}" alt="${esc(imageAltFor(place))}" loading="lazy" decoding="async"/><div class="place-discovery-body"><span class="live-source">${place.source==='google-places'?'● GOOGLE PLACES LIVE':place.live?'● OPENSTREETMAP FALLBACK':'● CURATED MAP RESULT'}</span><h3>${esc(place.title)}</h3><p>⌖ ${esc(place.location)} · ${esc(place.distanceKm)} km away</p><div class="place-activities">${(place.activities||[]).slice(0,3).map(a=>`<span>${esc(a)}</span>`).join('')}</div><div class="place-actions"><a href="${esc(place.mapUrl||place.osmUrl)}" target="_blank" rel="noopener">Open map ↗</a><button type="button" class="direction-button" data-directions-id="${esc(place.id)}">Get directions ↗</button><button data-place-enquire="${esc(place.id)}">Plan around this ↗</button></div>${place.imagePageUrl?`<small class="image-credit">Photo: <a href="${esc(place.imagePageUrl)}" target="_blank" rel="noopener">${esc(place.imageCredit||'Wikimedia Commons')}</a> · ${esc(place.imageLicense||'See licence')}</small>`:''}</div></article>`).join('')}</div>
    <p class="osm-disclaimer">${state.tourismLive?`Mapped place data is from ${esc(state.tourismProvider||'Google Places API')}.`:'Backup place pins are curated by Kenchain Groups and should be verified locally.'} Activity ideas are suggestions, not confirmed operator availability or safety. Check local rules and licensed providers before booking. Google Maps and Places attributions are shown with the map.</p>
  </main>`;
}
function vehiclePage(){const v=state.vehicle;return `<main class="vehicle-page section-width"><section class="vehicle-hero"><span class="eyebrow">KENCHAIN FLEET PREVIEW</span><h1>Every journey,<br/><em>on the map.</em></h1><p>Try the interactive bus, travel van and courier demo routes. Vehicles move automatically on a simulated route so you can preview the tracking experience without GPS hardware.</p><div class="vehicle-demo-banner"><span class="demo-pulse"></span><div><b>DEMO TRACKING MODE</b><small>All positions, speed and route progress are simulated examples.</small></div></div></section><form class="vehicle-lookup" data-form="vehicle-track"><label><small>DEMO VEHICLE ID</small><input name="vehicleId" required value="${esc(state.vehicleId)}" placeholder="Try KG-BUS-DEMO or KG-VAN-DEMO" autocomplete="off"/></label><button class="button-primary" type="submit">Track demo vehicle ↗</button></form><div class="vehicle-examples"><span>Choose a demo route</span><button data-vehicle-demo="KG-BUS-DEMO">Tourist bus · Bengaluru → Mysuru</button><button data-vehicle-demo="KG-VAN-DEMO">Travel van · Mysuru → Coorg</button><button data-vehicle-demo="KG-COURIER-DEMO">Courier van · Bengaluru city</button></div>${state.vehicleError?`<div class="live-search-error">${esc(state.vehicleError)}</div>`:''}${state.vehicleLoading?'<div class="live-search-state"><span class="spinner-dot"></span><b>Loading simulated route…</b></div>':''}${v?`<section class="vehicle-live-panel"><div class="vehicle-status-head"><div><span class="eyebrow">SIMULATED ROUTE</span><h2>${esc(v.vehicleId)}</h2><p>${esc(v.routeName||`${v.origin} → ${v.destination}`)}</p></div><span class="status-pill is-demo">● DEMO ONLY</span></div><div class="vehicle-stats"><div><small>VEHICLE</small><b>${esc(v.vehicleType)}</b></div><div><small>REGISTRATION</small><b>${esc(v.registration||'Demo fleet')}</b></div><div><small>SIMULATED SPEED</small><b>${Math.round(v.speedKmh||0)} km/h</b></div><div class="vehicle-progress"><small>ROUTE PROGRESS</small><b>${Number(v.progressPercent||0)}%</b></div><div class="vehicle-refresh"><small>LAST SIMULATION TICK</small><b>${v.lastUpdated?new Date(v.lastUpdated).toLocaleTimeString('en-IN'):'Just now'}</b></div><div><small>ESTIMATED ARRIVAL</small><b>${Math.max(1,Number(v.etaMinutes)||1)} min</b></div></div><div class="vehicle-map-toolbar">${mapProviderControls()}</div><div id="vehicle-map" class="vehicle-map" aria-label="Simulated vehicle route map"></div><p class="vehicle-feed-note">This animated map uses a simulated sample route and does not show the location of a real bus, driver or courier. Refreshes every 5 seconds.</p></section>`:`<section class="vehicle-empty"><div class="vehicle-empty-icon">⌖</div><h2>Choose a demo vehicle</h2><p>Select one of the sample routes above to see a moving vehicle marker, route trail, estimated progress and arrival time.</p></section>`}<section class="vehicle-integration-note"><b>About this preview</b><p>Demo coordinates are generated by Kenchain Groups for interface testing only. They are not sourced from GPS, drivers or a transport operator. No real-time fleet location is implied.</p><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">Map data © OpenStreetMap</a></section></main>`;}
function deliveryTypes(){return [['food','♨','Food','Meals from local favourites'],['groceries','❋','Groceries','Everyday essentials'],['parcel','▣','Parcel','Boxes, gifts and packages'],['documents','▤','Documents','Fast document drop-offs']].map(([key,ic,label,caption])=>`<button class="delivery-type ${state.deliveryType===key?'active':''}" data-delivery="${key}"><span>${ic}</span><b>${label}</b><small>${caption}</small></button>`).join('');}
const groceryItems=[{id:'milk',name:'Fresh milk · 1 litre',description:'Daily dairy essential',price:68,image:'https://images.unsplash.com/photo-1563636619-e9143da7973b?auto=format&fit=crop&w=700&q=80'},{id:'fruit-box',name:'Seasonal fruit box',description:'A fresh mixed fruit selection',price:249,image:'https://images.unsplash.com/photo-1610832958506-aa56368176cf?auto=format&fit=crop&w=700&q=80'},{id:'veggie-box',name:'Everyday veggie box',description:'A mix of fresh seasonal vegetables',price:179,image:'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=700&q=80'},{id:'bread',name:'Sourdough loaf',description:'Freshly baked, 500 g',price:145,image:'https://images.unsplash.com/photo-1585478259715-876acc5be8eb?auto=format&fit=crop&w=700&q=80'}];
function addCartItem(item,restaurant){const key=`${restaurant?.id||'market'}:${item.id}`;const existing=state.cart.find(i=>i.key===key);if(existing)existing.qty++;else state.cart.push({...item,key,qty:1,restaurantName:restaurant?.name||'Kenchain Groups Market',restaurantLocation:restaurant?.location||'Bengaluru'});showToast(`${item.name} added to your bag`);render();}
function foodCard(item,restaurant){return `<article class="food-item"><div class="food-item-image"><img src="${esc(item.image||FALLBACK_IMAGE)}" data-fallback-src="${FALLBACK_IMAGE}" alt="${esc(item.name)}" loading="lazy" decoding="async"/><button data-add-item="${esc(item.id)}" data-restaurant="${esc(restaurant?.id||'market')}">+</button></div><div class="food-item-info"><h4>${esc(item.name)}</h4><p>${esc(item.description)}</p><b>${money(item.price)}</b></div></article>`;}
function delivery(){let restaurant=state.restaurants.find(r=>r.id===state.restaurantId)||state.restaurants[0];const deliveryTerm=state.deliveryQuery.trim().toLowerCase();const visibleRestaurants=state.restaurants.filter(r=>!deliveryTerm||`${r.name} ${r.type} ${r.location} ${(r.items||[]).map(i=>`${i.name} ${i.description||''}`).join(' ')}`.toLowerCase().includes(deliveryTerm));let items=state.deliveryType==='food'?(restaurant?.items||[]):state.deliveryType==='groceries'?groceryItems:[];if(deliveryTerm&&state.deliveryType==='food'){const matchingRestaurants=state.restaurants.filter(r=>`${r.name} ${r.type} ${r.location}`.toLowerCase().includes(deliveryTerm));if(matchingRestaurants.length){items=matchingRestaurants.flatMap(r=>(r.items||[]).map(i=>({...i,_restaurant:r})));}else{items=state.restaurants.flatMap(r=>(r.items||[]).map(i=>({...i,_restaurant:r}))).filter(i=>`${i.name} ${i.description||''}`.toLowerCase().includes(deliveryTerm));}}else if(deliveryTerm)items=items.filter(i=>`${i.name} ${i.description||''}`.toLowerCase().includes(deliveryTerm));const cartCount=state.cart.reduce((s,i)=>s+i.qty,0),cartTotal=state.cart.reduce((s,i)=>s+i.qty*i.price,0);let content='';if(state.deliveryType==='food'){content=`<section class="delivery-content"><div class="delivery-section-title"><div><span class="eyebrow">LOCAL PLATES, HEADING YOUR WAY</span><h2>What’s on your <em>menu?</em></h2></div><div class="delivery-mini-note">◷ Typical delivery: 20–40 min</div></div><div class="restaurant-strip">${visibleRestaurants.map(r=>`<button class="restaurant-card ${restaurant?.id===r.id?'active':''}" data-restaurant-select="${r.id}"><img src="${esc(r.image||FALLBACK_IMAGE)}" data-fallback-src="${FALLBACK_IMAGE}" alt="${esc(r.name)}" loading="lazy" decoding="async"/><span class="restaurant-info"><b>${esc(r.name)}</b><small>${esc(r.type)} · ${esc(r.location)}</small><span>★ ${r.rating} · ${esc(r.eta)}</span></span></button>`).join('')}</div><div class="menu-header"><div><span class="eyebrow">${esc(restaurant?.type||'FRESH PICKS')}</span><h3>${esc(restaurant?.name||'Local favourites')}</h3></div><span>${items.length} items</span></div><div class="food-grid">${items.length?items.map(i=>foodCard(i,i._restaurant||restaurant)).join(''):`<div class="empty-state"><h3>No menu matches</h3><p>Try a dish, ingredient or restaurant name.</p></div>`}</div></section>`;}else if(state.deliveryType==='groceries'){content=`<section class="delivery-content"><div class="delivery-section-title"><div><span class="eyebrow">THE EVERYDAY TOP-UP</span><h2>Fresh picks, <em>fast.</em></h2></div><div class="delivery-mini-note">◷ Usually 25–45 min</div></div><div class="food-grid">${items.length?items.map(i=>foodCard(i,null)).join(''):`<div class="empty-state"><h3>No grocery matches</h3><p>Try another item name.</p></div>`}</div></section>`;}else{const parcel=state.deliveryType==='parcel';content=`<section class="delivery-content courier-form-card"><div class="courier-form-intro"><span class="eyebrow">${parcel?'SEND SOMETHING WITH CARE':'IMPORTANT PAPERS, ON THE MOVE'}</span><h2>${parcel?'A package picked up.<br/><em>A package delivered.</em>':'Paperwork, meet<br/><em>peace of mind.</em>'}</h2><p>${parcel?'Gifts, boxes, forgotten essentials. Tell us what is moving and where it needs to go.':'Contracts, forms and important documents. Add your pickup and drop-off details below.'}</p><div class="courier-perks"><span>◈ Careful handling</span><span>⌖ Pickup & drop tracking</span></div></div><div class="courier-form-visual"><img src="${parcel?'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?auto=format&fit=crop&w=1000&q=85':'https://images.unsplash.com/photo-1455390582262-044c286a3033?auto=format&fit=crop&w=1000&q=85'}" data-fallback-src="${FALLBACK_IMAGE}" alt="Delivery service" loading="lazy" decoding="async"/><div class="visual-caption">⇢ <span><b>Door to door</b><small>Pickup at your address. Drop at theirs.</small></span></div></div></section><div class="direct-order-panel"><div class="direct-order-title">▣ <div><b>${parcel?'Parcel details':'Document details'}</b><small>We’ll collect it from the pickup address you provide.</small></div></div><div class="form-grid two"><label>Pickup address<input id="direct-pickup" placeholder="House, street, area, city"/></label><label>Drop-off address<input id="direct-drop" placeholder="Recipient’s full address"/></label></div><div class="form-grid three"><label>${parcel?'Package size':'Envelope size'}<select id="direct-size"><option value="small" ${state.deliveryDetails?.packageSize==='small'?'selected':''}>Small · up to 1 kg</option><option value="medium" ${state.deliveryDetails?.packageSize==='medium'?'selected':''}>Medium · up to 5 kg</option><option value="large" ${state.deliveryDetails?.packageSize==='large'?'selected':''}>Large · up to 10 kg</option></select></label><label>Approx. distance (km)<input type="number" id="direct-distance" min="1" max="100" value="6"/></label><label>Pickup preference<select id="direct-time"><option>ASAP</option><option>10:00 AM - 12:00 PM</option><option>12:00 PM - 2:00 PM</option><option>2:00 PM - 5:00 PM</option><option>5:00 PM - 8:00 PM</option></select></label></div><label>${parcel?'What’s inside?':'Document type'}<input id="direct-description" placeholder="${parcel?'E.g. books, gift box, clothes':'E.g. signed agreement, certificates'}"/></label><label>Handling instructions<textarea id="direct-instructions" rows="2" placeholder="Gate details, fragile item, recipient note..."></textarea></label><button class="button-primary" data-action="parcel-continue">Continue to contact details →</button></div>`;}
return `<main class="delivery-page section-width">${trackingWidget('Track your delivery','Enter the reference from your food, grocery, parcel or document order to follow its pickup-to-drop progress.')}<div class="delivery-heading"><div><span class="eyebrow">THE LAST-MILE CREW</span><h1>From here<br/><em>to your doorstep.</em></h1><p>Good things should get where they’re going. Pick a service, set your pickup and drop, and we’ll take it from there.</p></div><div class="delivery-heading-art"><img src="https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?auto=format&fit=crop&w=1000&q=85" data-fallback-src="${FALLBACK_IMAGE}" alt="Package ready for delivery" loading="lazy" decoding="async"/><span>⇢ PICKUP → DROP</span></div></div><div class="delivery-type-grid">${deliveryTypes()}</div>${['food','groceries'].includes(state.deliveryType)?`<form class="delivery-search" data-form="delivery-search"><label><small>FIND A RESTAURANT OR ITEM</small><input type="search" name="deliveryQuery" value="${esc(state.deliveryQuery)}" placeholder="Search restaurants, meals or groceries…" autocomplete="off"/></label><button class="button-primary">Search menu ↗</button>${state.deliveryQuery?`<button type="button" class="clear-delivery-search" data-action="clear-delivery-search">Clear</button>`:''}</form>`:''}${content}</main>${cartCount?`<div class="cart-dock"><div class="cart-dock-left"><span class="cart-dock-icon">▱<i>${cartCount}</i></span><div><b>${cartCount} ${cartCount===1?'item':'items'} in your bag</b><small>${money(cartTotal)} item subtotal</small></div></div><button data-action="checkout">Review & checkout <span>${money(cartTotal)}</span> →</button></div>`:''}`;}
function bookingModal(item){const stay=item.category==='stay';const live=['openstreetmap','google-places'].includes(item.source);const mappedProvider=item.source==='google-places'?'Google Places':'OpenStreetMap';const includes=(item.includes||[]).slice(0,3).map(x=>`<span>✓ ${esc(x)}</span>`).join('');return `<div class="modal-backdrop" data-action="backdrop-close"><div class="booking-modal modal-card"><button class="modal-close" data-action="close-modal">×</button><div class="modal-image"><img src="${esc(imageFor(item))}" data-fallback-src="${esc(fallbackForCategory(item.imageCategory||item.category))}" alt="${esc(imageAltFor(item))}"/><span>${stay?'HOSPITALITY BOOKING':item.category==='tour'?'TRIP BOOKING':live?'ACTIVITY ENQUIRY':'ADVENTURE BOOKING'}</span></div><div class="modal-content"><div class="modal-title"><span class="eyebrow">LET’S MAKE IT HAPPEN</span><h2>${esc(item.title)}</h2><p>⌖ ${esc(item.location)} · ◷ ${esc(item.duration)}</p></div><p class="modal-description">${esc(item.description)}</p><div class="includes-row">${includes}</div><form class="booking-form" data-form="booking"><input type="hidden" name="category" value="${esc(item.category)}"/><input type="hidden" name="itemId" value="${esc(item.id)}"/><input type="hidden" name="itemName" value="${esc(item.title)}"/><input type="hidden" name="price" value="${item.price}"/><div class="form-section-title"><span>01</span><b>${stay?'Your hospitality details':live?'Your activity enquiry details':'Your travel details'}</b></div><div class="form-grid two"><label>${stay?'Check-in':'Date'}<input required type="date" name="date" min="${dateToday()}"/></label>${stay?`<label>Check-out<input required type="date" name="returnDate" min="${dateToday()}"/></label>`:`<label>Pickup time<select name="pickupTime">${['05:00','06:00','07:00','08:00','09:00','10:00','12:00','14:00'].map(t=>`<option>${t}</option>`).join('')}</select></label>`}</div>${live?`<div class="osm-enquiry-note">This place was found in mapped place data from ${mappedProvider}. Kenchain Groups will record your enquiry, but does not verify current operator availability or price.</div>`:''}<div class="form-grid two"><label>${stay?'Guests':'Travellers'}<select name="guests">${Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1} ${i?'people':'person'}</option>`).join('')}</select></label>${stay?`<label class="check-field"><input type="checkbox" name="transfer" value="yes"/><span>Add pickup & drop transfer <small>₹350 flat add-on</small></span></label>`:`<label>Experience location<input value="${esc(item.location)}" readonly/></label>`}</div><div class="form-grid two"><label><span class="field-label-icon">⌖ Pickup point</span><input name="pickup" required value="${esc(item.pickup||'')}" placeholder="Your pickup address / landmark"/></label><label><span class="field-label-icon">⇢ Drop-off point</span><input name="drop" required value="${esc(item.drop||'')}" placeholder="Drop-off address / landmark"/></label></div><div class="form-section-title"><span>02</span><b>Contact details</b></div><div class="form-grid two"><label>Full name<input name="customerName" required value="${esc(state.user?.name||'')}" placeholder="Name on booking"/></label><label>Mobile number<input name="phone" required value="${esc(state.user?.phone||'')}" inputmode="numeric" maxlength="10" pattern="[6-9][0-9]{9}" placeholder="10-digit mobile"/></label></div><label>Email address<input name="email" required type="email" value="${esc(state.user?.email||'')}" placeholder="you@example.com"/></label><label>Special requests <span class="optional">OPTIONAL</span><textarea name="notes" rows="2" placeholder="Anything the partner should know?"></textarea></label><div class="form-grid two"><label>Payment preference<select name="paymentMethod"><option>Pay on arrival</option><option>UPI at partner</option><option>Card at partner</option></select></label><div class="price-total"><small>ESTIMATED TOTAL</small><b id="booking-price">${live?'Price on request':money(item.price)}</b><span id="booking-price-note">${live?'Confirm price with operator':`1 person${stay?' · 1 night':''}`}</span></div></div><div class="form-error" hidden></div><button class="button-primary submit-button">${live?'Send activity enquiry →':'Confirm booking →'}</button><p class="form-disclaimer">◈ ${live?'Your enquiry is saved with a tracking reference. Confirm activity details directly with the mapped operator.':'Your request is saved with a unique tracking reference. No online payment is collected here.'}</p></form></div></div></div>`;}
function checkoutModal(){const cartTotal=state.cart.reduce((s,i)=>s+i.qty*i.price,0),isDirect=['parcel','documents'].includes(state.deliveryType);return `<div class="modal-backdrop" data-action="backdrop-close"><div class="checkout-modal modal-card"><button class="modal-close" data-action="close-modal">×</button><div class="checkout-head"><span class="eyebrow">ALMOST THERE</span><h2>Where should we <em>meet?</em></h2><p>Set the addresses, share your contact details and confirm your delivery.</p></div><form class="booking-form" data-form="checkout">${state.cart.length?`<div class="checkout-items">${state.cart.map(i=>`<div><span>${esc(i.name)} <small>(${money(i.price)} each)</small></span><span class="checkout-qty"><button type="button" data-qty="${esc(i.key)}" data-diff="-1">−</button><b>${i.qty}</b><button type="button" data-qty="${esc(i.key)}" data-diff="1">+</button><strong>${money(i.qty*i.price)}</strong></span></div>`).join('')}</div>`:''}<div class="form-section-title"><span>01</span><b>Pickup & drop-off</b></div><label><span class="field-label-icon">⌖ Pickup address</span><input name="pickup" required value="${esc(state.deliveryDetails?.pickup || (state.deliveryType==='food'?state.cart[0]?.restaurantLocation||'':state.deliveryType==='groceries'?'Kenchain Groups Market · Bengaluru':''))}" placeholder="Pickup point, building, area, city"/></label><label><span class="field-label-icon">⇢ Drop-off address</span><input name="drop" required value="${esc(state.deliveryDetails?.drop||'')}" placeholder="Recipient’s full address"/></label><div class="form-grid two"><label>Approx. distance (km)<input name="distance" type="number" min="1" max="100" value="${esc(state.deliveryDetails?.distance||6)}"/></label><label>Pickup preference<select name="time"><option ${state.deliveryDetails?.time==='ASAP'?'selected':''}>ASAP</option><option ${state.deliveryDetails?.time==='10:00 AM - 12:00 PM'?'selected':''}>10:00 AM - 12:00 PM</option><option ${state.deliveryDetails?.time==='12:00 PM - 2:00 PM'?'selected':''}>12:00 PM - 2:00 PM</option><option ${state.deliveryDetails?.time==='2:00 PM - 5:00 PM'?'selected':''}>2:00 PM - 5:00 PM</option><option ${state.deliveryDetails?.time==='5:00 PM - 8:00 PM'?'selected':''}>5:00 PM - 8:00 PM</option></select></label></div>${isDirect?`<div class="form-grid two"><label>Package size<select name="packageSize"><option value="small" ${state.deliveryDetails?.packageSize==='small'?'selected':''}>Small · up to 1 kg</option><option value="medium" ${state.deliveryDetails?.packageSize==='medium'?'selected':''}>Medium · up to 5 kg</option><option value="large" ${state.deliveryDetails?.packageSize==='large'?'selected':''}>Large · up to 10 kg</option></select></label><label>Item description<input name="itemDescription" value="${esc(state.deliveryDetails?.itemDescription||'')}" placeholder="What are we carrying?"/></label></div>`:''}<div class="form-section-title"><span>02</span><b>Your contact details</b></div><div class="form-grid two"><label>Full name<input name="customerName" required value="${esc(state.user?.name||'')}" placeholder="Your name"/></label><label>Mobile number<input name="phone" required maxlength="10" inputmode="numeric" pattern="[6-9][0-9]{9}" placeholder="10-digit mobile"/></label></div><label>Email address<input name="email" required type="email" value="${esc(state.user?.email||'')}" placeholder="you@example.com"/></label><label>Delivery instructions <span class="optional">OPTIONAL</span><textarea name="instructions" rows="2" placeholder="Landmark, floor, call before arrival..."></textarea></label><label>Payment preference<select name="paymentMethod"><option>Pay on delivery</option><option>UPI at delivery</option><option>Card at delivery</option></select></label><div class="quote-box"><div><span>Estimated delivery</span><b id="quote-eta">Calculating…</b></div><div><span>Delivery & handling</span><b id="quote-fee">—</b></div><div class="quote-total"><span>Estimated total</span><b id="quote-total">${money(cartTotal)}</b></div><small id="quote-error" class="form-error" hidden></small></div><div class="form-error" hidden></div><button class="button-primary submit-button">Place delivery order →</button><p class="form-disclaimer">◈ You’ll receive a tracking reference after confirmation. No online payment is collected in this demo.</p></form></div></div>`;}
function bookingsPage(){if(!state.user)return `<main class="account-page section-width"><div class="account-hero"><span class="eyebrow">YOUR KENCHAIN GROUPS ACTIVITY</span><h1>Bookings need a<br/><em>secure sign in.</em></h1><p>Sign in to see bookings saved under your account.</p><button class="button-primary" data-nav="account">Sign in / Register →</button></div></main>`;return `<main class="account-page section-width"><div class="account-hero"><span class="eyebrow">YOUR KENCHAIN GROUPS ACTIVITY</span><h1>Your plans,<br/><em>all in one place.</em></h1><p>Bookings associated with ${esc(state.user.email)}.</p></div>${state.bookingLookupError?`<p class="lookup-message">${esc(state.bookingLookupError)}</p>`:''}${state.bookingItems.length?`<div class="booking-list"><div class="section-heading"><div><span class="eyebrow">BOOKING HISTORY</span><h2>Your recent <em>bookings.</em></h2></div><span>${state.bookingItems.length} found</span></div>${state.bookingItems.map(bookingRow).join('')}</div>`:'<p class="empty-state">No bookings found yet. Start exploring and your confirmed requests will appear here.</p>'}</main>`;}
function bookingRow(b){const symbol=b.category==='delivery'?'⇢':b.category==='stay'?'⌂':b.category==='adventure'?'⌁':'⌖';return `<div class="booking-row"><span class="booking-icon ${esc(b.category)}">${symbol}</span><div class="booking-row-main"><div><b>${esc(b.itemName)}</b><small>${esc(b.reference)} · ${new Date(b.createdAt).toLocaleDateString('en-IN')}</small></div><div class="booking-route"><span>${esc(b.pickup||'Not set')}</span> → <span>${esc(b.drop||'Not set')}</span></div></div><div class="booking-row-right"><b>${money(b.amount)}</b><span class="status-pill">${esc(b.status)}</span><button data-track="${esc(b.reference)}">Details ↗</button></div></div>`;}
function trackPage(){return `<main class="track-page section-width"><div class="track-intro"><span class="eyebrow">FOLLOW THE JOURNEY</span><h1>Know where it <em>stands.</em></h1><p>Track a tour, adventure, hospitality request, food order, grocery run, parcel or document delivery with its unique reference.</p><form class="track-form" data-form="tracking"><input name="reference" value="${esc(state.trackingRef)}" placeholder="Enter reference · e.g. KG1234567AB" required/><button class="button-primary">⌖ Track now</button></form>${state.trackingError?`<div class="form-error track-error">${esc(state.trackingError)}</div>`:''}</div>${state.trackedBooking?trackingResult(state.trackedBooking):''}</main>`;}
function trackingResult(b){return `<div class="tracking-result"><div class="tracking-result-head"><div><span class="eyebrow">TRACKING REFERENCE</span><h2>${esc(b.reference)}</h2></div><span class="status-pill">${esc(b.status)}</span></div><div class="tracking-summary"><div><small>ITEM / BOOKING</small><b>${esc(b.itemName)}</b></div><div><small>${['openstreetmap','google-places'].includes(b.details?.source)?'PRICE':'ESTIMATED VALUE'}</small><b>${['openstreetmap','google-places'].includes(b.details?.source)?'Price on request':money(b.amount)}</b></div><div><small>BOOKED ON</small><b>${new Date(b.createdAt).toLocaleDateString('en-IN')}</b></div></div><div class="tracking-route"><div><span class="route-dot start"></span><small>PICKUP</small><b>${esc(b.pickup||'Partner location')}</b></div><div class="route-track-line"></div><div><span class="route-dot end"></span><small>DROP-OFF</small><b>${esc(b.drop||b.itemName)}</b></div></div><div class="timeline">${(b.timeline||[]).map(step=>`<div class="timeline-step ${step.done?'done':''}"><span class="timeline-icon">${step.done?'✓':'○'}</span><div><b>${esc(step.label)}</b><small>${step.time?new Date(step.time).toLocaleString('en-IN'):'Pending'}</small></div></div>`).join('')}</div><p class="tracking-note">ⓘ This timeline shows the request and partner-confirmation steps recorded by Kenchain Groups. Vehicle routes elsewhere on this site are demonstration simulations and do not represent real driver or GPS locations.</p></div>`;}
function confirmation(){const b=state.booking;if(!b)return `<main class="confirmation-page section-width"><h1>You're all set.</h1><button class="button-primary" data-nav="home">Back home</button></main>`;return `<main class="confirmation-page section-width"><div class="success-icon">✓</div><span class="eyebrow">THAT’S A PLAN</span><h1>You’re <em>all set.</em></h1><p>Your ${b.category==='delivery'?'delivery order':'booking'} has been received. Keep this reference handy for your records.</p><div class="confirmation-ticket"><div class="ticket-top"><span>KENCHAIN GROUPS CONFIRMATION</span>◈</div><div class="ticket-ref"><small>YOUR REFERENCE</small><b>${esc(b.reference)}</b></div><div class="ticket-detail"><span>${esc(b.itemName)}</span><b>${money(b.amount)}</b></div><div class="ticket-route"><div><small>PICKUP</small><b>${esc(b.pickup||'Partner location')}</b></div>→<div><small>DROP-OFF</small><b>${esc(b.drop||'See booking details')}</b></div></div><div class="ticket-footer"><span>▦ ${esc(b.bookingDate||new Date(b.createdAt).toLocaleDateString('en-IN'))}</span><span class="status-pill">${esc(b.status)}</span></div></div><div class="confirmation-actions"><button class="button-primary" data-action="track-current">Track this booking →</button><button class="button-secondary" data-nav="home">Back to explore</button></div></main>`;}

function mapProviderControls(){
  return `<div class="mapProvider map-provider-control" role="group" aria-label="Map provider"><span class="google-provider-label"><span class="google-provider-dot"></span> Google Maps + Places</span></div>`;
}
async function loadGoogleMapsLibraries(){
  if(!googleMapsApiKey)throw new Error('Google Maps is not configured. Add GOOGLE_MAPS_API_KEY to your environment.');
  if(!googleMapsLoadPromise){
    googleMapsLoadPromise=new Promise((resolve,reject)=>{
      if(window.google?.maps?.importLibrary){resolve();return;}
      const callbackName='__kenchainGoogleMapsReady';
      const existing=document.querySelector('script[data-kenchain-google-maps]');
      if(existing){existing.addEventListener('error',()=>reject(new Error('Google Maps could not load. Check the key, billing and API restrictions.')),{once:true});window[callbackName]=resolve;return;}
      window[callbackName]=resolve;
      const script=document.createElement('script');
      script.dataset.kenchainGoogleMaps='true';script.async=true;script.defer=true;
      script.src=`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(googleMapsApiKey)}&v=weekly&loading=async&auth_referrer_policy=origin&language=en&region=IN&callback=${callbackName}`;
      script.onerror=()=>reject(new Error('Google Maps JavaScript API failed to load. Check billing, Maps JavaScript API enablement and HTTP-referrer restrictions.'));
      document.head.appendChild(script);
    }).then(async()=>{
      const [maps,places,routes,marker]=await Promise.all([
        google.maps.importLibrary('maps'),google.maps.importLibrary('places'),
        google.maps.importLibrary('routes'),google.maps.importLibrary('marker')
      ]);
      return {maps,places,routes,marker};
    }).catch(error=>{googleMapsLoadPromise=null;throw error;});
  }
  return googleMapsLoadPromise;
}
function makeGoogleMap(element,center,zoom,libs){
  return new libs.maps.Map(element,{center:{lat:Number(center[0]),lng:Number(center[1])},zoom,mapId:googleMapsMapId||'DEMO_MAP_ID',mapTypeControl:true,fullscreenControl:true,streetViewControl:false,gestureHandling:'greedy'});
}
function addGoogleMapMarker(map,libs,position,title,html=''){
  const marker=new libs.marker.AdvancedMarkerElement({map,position:{lat:Number(position[0]),lng:Number(position[1])},title,gmpClickable:Boolean(html)});
  if(html){const info=new google.maps.InfoWindow({content:html});marker.addListener('click',()=>info.open({map,anchor:marker}));}
  return marker;
}
function handleGoogleMapFallback(error){
  console.warn('Google Maps unavailable; using the OpenStreetMap/Leaflet fallback map:',error.message);
  if(!googleMapFailureNotified){showToast('Google Maps is unavailable. Switched to the OpenStreetMap fallback.');googleMapFailureNotified=true;}
}

function addResilientMapTiles(map){
  const providers=[];
  providers.push(
    {name:'OpenStreetMap',url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',options:{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}},
    {name:'CARTO',url:'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',options:{subdomains:'abcd',maxZoom:20,attribution:'&copy; OpenStreetMap contributors &copy; CARTO'}},
    {name:'OpenStreetMap HOT',url:'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',options:{subdomains:'abc',maxZoom:19,attribution:'&copy; OpenStreetMap contributors, HOT style'}}
  );
  const container=map.getContainer();
  const status=document.createElement('div');
  status.className='map-provider-status';
  status.hidden=true;
  status.textContent='Map tiles are temporarily unreachable. Your search pins and destination links are still available.';
  container.appendChild(status);
  let index=0,current=null,failed=false;
  const useProvider=()=>{
    if(index>=providers.length){
      failed=true;status.hidden=false;return;
    }
    const provider=providers[index];
    const layer=L.tileLayer(provider.url,provider.options);
    current=layer;
    let switched=false;
    const switchProvider=()=>{
      if(switched||current!==layer)return;
      switched=true;
      if(map.hasLayer(layer))map.removeLayer(layer);
      index+=1;
      useProvider();
    };
    layer.on('tileerror',switchProvider);
    layer.on('load',()=>{if(current===layer){status.hidden=true;failed=false;}});
    layer.addTo(map);
    // A provider may stall without emitting tileerror. Advance after a short wait
    // only when none of its tiles has loaded.
    setTimeout(()=>{if(current===layer&&!layer._tilesToLoad&& !layer._loading) return; if(current===layer&&Object.keys(layer._tiles||{}).length===0)switchProvider();},9000);
  };
  useProvider();
  return {get failed(){return failed;},get provider(){return providers[index]?.name||null;}};
}

let exploreMapInstance=null,exploreGoogleMap=null;
async function initExploreMap(){
  const el=$('#explore-map');if(!el)return;
  if(exploreMapInstance){exploreMapInstance.remove();exploreMapInstance=null;}exploreGoogleMap=null;
  const rawItems=state.view==='adventures'&&state.adventureLookup?state.adventureResults:state.catalog.filter(i=>i.category===({tours:'tour',adventures:'adventure',stays:'stay'}[state.view])&&(!state.activeSearch||`${i.title} ${i.location} ${i.description}`.toLowerCase().includes(state.activeSearch.toLowerCase())));
  let libs=null,mappedItems=[];
  if(state.mapProvider==='google'&&googleMapsApiKey){
    try{
      libs=await loadGoogleMapsLibraries();if(!document.body.contains(el))return;
      mappedItems=await mapItemsWithCoordinates(rawItems,libs);if(!document.body.contains(el))return;
    }catch(error){handleGoogleMapFallback(error);}
  }
  if(!mappedItems.length)mappedItems=rawItems.map(item=>{const coordinates=coordsFor(item);return coordinates?{...item,__mapCoordinates:coordinates}:null;}).filter(Boolean);
  const selectedCentre=state.view==='adventures'&&state.adventureCentre?[Number(state.adventureCentre.latitude),Number(state.adventureCentre.longitude)]:state.searchCenter?[Number(state.searchCenter.latitude),Number(state.searchCenter.longitude)]:null;
  const validSelected=selectedCentre&&selectedCentre.every(Number.isFinite)&&Math.abs(selectedCentre[0])<=90&&Math.abs(selectedCentre[1])<=180?selectedCentre:null;
  const mapCentre=validSelected||mappedItems[0]?.__mapCoordinates||INDIA_MAP_CENTRE;
  if(libs&&state.mapProvider==='google'&&googleMapsApiKey){
    try{
      const map=makeGoogleMap(el,mapCentre,mappedItems.length?7:validSelected?11:5,libs);exploreGoogleMap=map;
      const bounds=new google.maps.LatLngBounds();let hasBounds=false;
      if(validSelected){bounds.extend({lat:mapCentre[0],lng:mapCentre[1]});hasBounds=true;addGoogleMapMarker(map,libs,mapCentre,'Selected search area','<b>Selected search area</b>');}
      mappedItems.forEach(item=>{const c=item.__mapCoordinates;const popup=`<b>${esc(item.title||item.name)}</b><br>${esc(item.activityType||item.categoryLabel||'Destination')} · ${esc(item.location||'India')}<br><button type="button" class="map-book-link" data-directions-id="${esc(item.id)}">Get directions ↗</button>`;addGoogleMapMarker(map,libs,c,item.title||item.name,popup);bounds.extend({lat:Number(c[0]),lng:Number(c[1])});hasBounds=true;});
      if(hasBounds)map.fitBounds(bounds,48);
      return;
    }catch(error){handleGoogleMapFallback(error);}
  }
  if(!window.L){el.innerHTML='<div class="map-unavailable">Map tiles could not load. Search results remain available in the destination cards below.</div>';return;}
  const map=L.map(el,{scrollWheelZoom:false}).setView(mapCentre,mappedItems.length?7:validSelected?11:5);exploreMapInstance=map;addResilientMapTiles(map);
  const markers=[];const points=[];
  if(validSelected){L.circleMarker(mapCentre,{radius:7,color:'#fff',weight:2,fillColor:'#f29b48',fillOpacity:1}).addTo(map).bindPopup('Selected search area');points.push(mapCentre);}
  mappedItems.forEach(item=>{const c=item.__mapCoordinates;const popup=`<b>${esc(item.title||item.name)}</b><br>${esc(item.activityType||item.categoryLabel||'Destination')} · ${esc(item.location||'India')}<br><button type="button" class="map-book-link" data-directions-id="${esc(item.id)}">Get directions ↗</button>`;markers.push(L.marker(c).addTo(map).bindPopup(popup));points.push(c);});
  if(points.length>1)map.fitBounds(L.latLngBounds(points).pad(.18));else if(points.length===1)map.setView(points[0],12);setTimeout(()=>map.invalidateSize(),100);
}

let tourismMapInstance=null,tourismGoogleMap=null,vehicleMapInstance=null,vehicleGoogleMap=null,vehicleMapLayers=null;
let vehicleGoogleRouteLine=null,vehicleGoogleTrailLine=null,vehicleGoogleMarker=null;
let googleDirectionOverlays=[];
async function initTourismMap(){
  const el=$('#tourism-map');if(!el)return;if(tourismMapInstance){tourismMapInstance.remove();tourismMapInstance=null;}tourismGoogleMap=null;
  const center=state.tourismCentre?[state.tourismCentre.latitude,state.tourismCentre.longitude]:INDIA_MAP_CENTRE;
  if(state.mapProvider==='google'&&googleMapsApiKey){
    try{
      const libs=await loadGoogleMapsLibraries();if(!document.body.contains(el))return;
      const map=makeGoogleMap(el,center,state.tourismCentre?11:5,libs);tourismGoogleMap=map;const bounds=new google.maps.LatLngBounds();
      if(state.tourismCentre){bounds.extend({lat:Number(center[0]),lng:Number(center[1])});addGoogleMapMarker(map,libs,center,'Search area','<b>Search area</b>');}
      state.tourismPlaces.forEach(item=>{const c=[item.latitude,item.longitude];const popup=`<b>${esc(item.title)}</b><br>${esc(item.categoryLabel)} · ${esc(item.location)}<br><button type="button" class="map-book-link" data-directions-id="${esc(item.id)}">Get directions ↗</button>`;addGoogleMapMarker(map,libs,c,item.title,popup);bounds.extend({lat:Number(c[0]),lng:Number(c[1])});});
      if(state.tourismPlaces.length)map.fitBounds(bounds,48);return;
    }catch(error){handleGoogleMapFallback(error);}
  }
  if(!window.L){el.innerHTML='<div class="map-unavailable">Map tiles could not load. Open any destination using its map link below.</div>';return;}
  const map=L.map(el,{scrollWheelZoom:false}).setView(center,state.tourismCentre?11:5);tourismMapInstance=map;addResilientMapTiles(map);const points=[];
  if(state.tourismCentre){const c=[state.tourismCentre.latitude,state.tourismCentre.longitude];L.circleMarker(c,{radius:7,color:'#fff',weight:2,fillColor:'#f29b48',fillOpacity:1}).addTo(map).bindPopup('Search area');points.push(c);}
  state.tourismPlaces.forEach(item=>{const c=[item.latitude,item.longitude];points.push(c);L.marker(c).addTo(map).bindPopup(`<b>${esc(item.title)}</b><br>${esc(item.categoryLabel)} · ${esc(item.location)}<br><button type="button" class="map-book-link" data-directions-id="${esc(item.id)}">Get directions ↗</button>`);});
  if(points.length>1)map.fitBounds(L.latLngBounds(points).pad(.2));else if(points.length)map.setView(points[0],12);setTimeout(()=>map.invalidateSize(),100);
}
async function initVehicleMap(){
  const el=$('#vehicle-map'),v=state.vehicle;if(!el||!v||!Number.isFinite(Number(v.latitude))||!Number.isFinite(Number(v.longitude)))return;
  if(vehicleMapInstance){vehicleMapInstance.remove();vehicleMapInstance=null;}vehicleGoogleMap=null;vehicleGoogleRouteLine=null;vehicleGoogleTrailLine=null;vehicleGoogleMarker=null;vehicleMapLayers=null;
  if(state.mapProvider==='google'&&googleMapsApiKey){
    try{
      const libs=await loadGoogleMapsLibraries();if(!document.body.contains(el))return;
      const map=makeGoogleMap(el,[v.latitude,v.longitude],13,libs);vehicleGoogleMap=map;
      vehicleGoogleRouteLine=new libs.maps.Polyline({map,strokeColor:'#83dabb',strokeOpacity:.72,strokeWeight:5,geodesic:true});
      vehicleGoogleTrailLine=new libs.maps.Polyline({map,strokeColor:'#f7ad65',strokeOpacity:.95,strokeWeight:5,geodesic:true});
      const pin=document.createElement('div');pin.className='google-demo-vehicle-pin';pin.textContent=v.vehicleType.toLowerCase().includes('bus')?'🚌':v.vehicleType.toLowerCase().includes('courier')?'🚚':'🚐';
      vehicleGoogleMarker=new libs.marker.AdvancedMarkerElement({map,position:{lat:Number(v.latitude),lng:Number(v.longitude)},title:`${v.vehicleId} · DEMO`,content:pin});updateVehicleMap();return;
    }catch(error){handleGoogleMapFallback(error);}
  }
  if(!window.L){el.innerHTML='<div class="map-unavailable">Map tiles could not load. The simulated route details are still available above.</div>';return;}
  const map=L.map(el,{scrollWheelZoom:true}).setView([v.latitude,v.longitude],13);vehicleMapInstance=map;addResilientMapTiles(map);vehicleMapLayers=L.layerGroup().addTo(map);updateVehicleMap();
}
function updateVehicleMap(){
  const v=state.vehicle;if(!v)return;
  if(vehicleGoogleMap&&vehicleGoogleMarker){
    const route=Array.isArray(v.route)?v.route.map(p=>({lat:Number(p[0]),lng:Number(p[1])})):[];
    const trail=Array.isArray(v.trail)?v.trail.map(p=>({lat:Number(p[0]),lng:Number(p[1])})):[];
    vehicleGoogleRouteLine?.setPath(route);vehicleGoogleTrailLine?.setPath(trail);
    const pos={lat:Number(v.latitude),lng:Number(v.longitude)};vehicleGoogleMarker.position=pos;vehicleGoogleMap.panTo(pos);return;
  }
  if(!vehicleMapInstance||!vehicleMapLayers)return;vehicleMapLayers.clearLayers();
  if(Array.isArray(v.route)&&v.route.length>1)L.polyline(v.route,{color:'#8de3c4',weight:5,opacity:.7,dashArray:'9 7'}).addTo(vehicleMapLayers);
  if(Array.isArray(v.trail)&&v.trail.length>1)L.polyline(v.trail.map(p=>[p[0],p[1]]),{color:'#f8b86a',weight:5,opacity:.95}).addTo(vehicleMapLayers);
  const marker=L.circleMarker([v.latitude,v.longitude],{radius:10,color:'#fff',weight:3,fillColor:'#ff8e55',fillOpacity:1}).addTo(vehicleMapLayers);marker.bindPopup(`<b>${esc(v.vehicleId)}</b><br>${esc(v.vehicleType)} · ${esc(v.status)}<br><small>Simulated demonstration route only</small>`);vehicleMapInstance.panTo([v.latitude,v.longitude],{animate:true,duration:.7});
}

function requestCurrentPosition(){
  return new Promise((resolve,reject)=>{
    if(!navigator.geolocation){reject(new Error('This browser does not support location access.'));return;}
    navigator.geolocation.getCurrentPosition(
      position=>resolve({latitude:position.coords.latitude,longitude:position.coords.longitude,accuracy:position.coords.accuracy}),
      error=>reject(new Error(error.code===1?'Location permission was denied. Allow location access in your browser and try again.':error.code===2?'Your current location could not be determined. Check device location settings and try again.':'Location request timed out. Please try again.')),
      {enableHighAccuracy:true,timeout:15000,maximumAge:60000}
    );
  });
}
function directionsItem(id){return [...state.tourismPlaces,...state.adventureResults,...state.catalog].find(item=>String(item.id)===String(id));}
function validCoordinates(item){return item&&item.latitude!==undefined&&item.latitude!==null&&item.longitude!==undefined&&item.longitude!==null&&Number.isFinite(Number(item.latitude))&&Number.isFinite(Number(item.longitude))&&Math.abs(Number(item.latitude))<=90&&Math.abs(Number(item.longitude))<=180;}
function directionsMarkup(result){
  const steps=(result.route.steps||[]).slice(0,10).map((step,index)=>`<li><span>${index+1}</span><div><b>${esc(step.instruction)}</b><small>${step.distanceMeters>=1000?`${(step.distanceMeters/1000).toFixed(1)} km`:`${step.distanceMeters} m`}</small></div></li>`).join('');
  const provider=result.provider||'Google Maps Routes';
  return `<div class="directions-result-head"><div><span class="eyebrow">${esc(provider.toUpperCase())} · FROM YOUR LOCATION</span><h3>${esc(result.destination.title)}</h3><p>${result.route.distanceKm} km · about ${result.route.durationMinutes} min by car</p></div><button type="button" class="directions-close" data-action="close-directions" aria-label="Close directions">×</button></div>${steps?`<ol class="directions-steps">${steps}</ol>`:'<p class="directions-no-steps">The route is drawn on the map. Turn-by-turn steps were not returned for this route.</p>'}<small class="directions-attribution">Route calculated by ${esc(provider)}. Duration is an estimate and can change with road conditions.</small><a class="directions-external-link" href="https://www.google.com/maps/dir/?api=1&origin=${result.origin.latitude},${result.origin.longitude}&destination=${result.destination.latitude},${result.destination.longitude}&travelmode=driving" target="_blank" rel="noopener noreferrer">Open turn-by-turn navigation ↗</a>`;
}
async function getDirectionsTo(id){
  const item=directionsItem(id);if(!item){showToast('This destination is no longer available. Search again and retry.');return;}
  const host=$('#directions-result');if(host){host.hidden=false;host.innerHTML='<div class="directions-loading"><span class="spinner-dot"></span> Finding your current location and calculating a route…</div>';}
  showToast('Requesting your current location…');let origin=null,destination=null;
  try{
    origin=await requestCurrentPosition();
    if(validCoordinates(item))destination={latitude:Number(item.latitude),longitude:Number(item.longitude)};
    else{const q=[item.title,item.location].filter(Boolean).join(', ');const libs=await loadGoogleMapsLibraries();const geocoder=new libs.maps.Geocoder();const result=await geocoder.geocode({address:q,region:'IN'});const point=result.results?.[0]?.geometry?.location;if(!point)throw new Error('Google Maps could not locate this destination.');destination={latitude:typeof point.lat==='function'?point.lat():point.lat,longitude:typeof point.lng==='function'?point.lng():point.lng};}
    if(state.mapProvider==='google'&&googleMapsApiKey){
      const map=state.view==='explore'?tourismGoogleMap:exploreGoogleMap;if(!map)throw new Error('The Google map is not ready. Wait for the map to load and try again.');
      const {Route}=await loadGoogleMapsLibraries();
      const response=await Route.computeRoutes({origin:{lat:origin.latitude,lng:origin.longitude},destination:{lat:destination.latitude,lng:destination.longitude},travelMode:'DRIVING',routingPreference:'TRAFFIC_AWARE',languageCode:'en-IN',units:'METRIC',fields:['path','legs','distanceMeters','durationMillis','localizedValues']});
      const route=response.routes?.[0];if(!route)throw new Error('Google Maps did not return a driving route for this destination.');
      googleDirectionOverlays.forEach(layer=>layer.setMap(null));googleDirectionOverlays=[];
      const polylines=route.createPolylines({polylineOptions:{strokeColor:'#ff8b55',strokeOpacity:.94,strokeWeight:6}});polylines.forEach(layer=>{layer.setMap(map);googleDirectionOverlays.push(layer);});
      const waypoints=await route.createWaypointAdvancedMarkers();waypoints.forEach(marker=>{marker.map=map;googleDirectionOverlays.push({setMap:mapValue=>{marker.map=mapValue;}});});
      const bounds=new google.maps.LatLngBounds();(route.path||[]).forEach(point=>bounds.extend(point));if(route.path?.length)map.fitBounds(bounds,48);
      const steps=(route.legs||[]).flatMap(leg=>leg.steps||[]).map(step=>({instruction:step.instructions||step.localizedValues?.instruction||'Continue on the route',distanceMeters:Number(step.distanceMeters||0)}));
      const routeData={distanceKm:Number((Number(route.distanceMeters||0)/1000).toFixed(1)),durationMinutes:Math.max(1,Math.round(Number(route.durationMillis||0)/60000)),steps};
      state.directions={origin,destination,route:routeData,provider:'Google Maps Routes'};
      if(host){host.hidden=false;host.innerHTML=directionsMarkup({origin,destination:{...item,...destination,title:item.title},route:routeData,provider:'Google Maps Routes'});}
      showToast(`Google route ready · ${routeData.distanceKm} km`);return;
    }
    throw new Error('Google Maps Routes could not calculate this route. Use the Google Maps navigation link below or verify Routes API, billing and key restrictions.');
  }catch(error){
    const panel=$('#directions-result');if(panel){const fallbackLink=origin&&destination?`<a class="directions-external-link" href="https://www.google.com/maps/dir/?api=1&origin=${origin.latitude},${origin.longitude}&destination=${destination.latitude},${destination.longitude}&travelmode=driving" target="_blank" rel="noopener noreferrer">Open directions in Google Maps ↗</a>`:'';panel.hidden=false;panel.innerHTML=`<div class="directions-error"><b>Could not calculate directions</b><p>${esc(error.message)}</p><small>Allow browser location access on HTTPS and check that Maps JavaScript API, Places API (New), Routes API and billing are enabled for Google Maps.</small>${fallbackLink}</div>`;}
    showToast(error.message||'Directions could not be calculated.');
  }
}

function render(){document.body.dataset.page=state.view;const root=$('#root');let page=state.view==='home'?home():state.view==='search'?globalSearchPage():['tours','adventures','stays'].includes(state.view)?listing():state.view==='explore'?touristPlacesPage():state.view==='vehicles'?vehiclePage():state.view==='account'?accountPage():state.view==='delivery'?delivery():state.view==='bookings'?bookingsPage():state.view==='track'?trackPage():confirmation();root.innerHTML=header()+page+footer()+(state.modal==='booking'?bookingModal(state.modalItem):state.modal==='checkout'?checkoutModal():'');if(state.modal==='checkout')calculateQuote();if(['tours','adventures','stays'].includes(state.view))setTimeout(()=>initExploreMap(),80);if(state.view==='explore')setTimeout(()=>initTourismMap(),80);if(state.view==='vehicles'&&state.vehicle)setTimeout(()=>initVehicleMap(),80);attachImageFallbacks();}
function openBooking(id){const item=[...state.catalog,...state.adventureResults,...state.tourismPlaces].find(i=>i.id===id);if(!item)return;state.modal='booking';state.modalItem=item;render();}
function openCheckout(){if(['food','groceries'].includes(state.deliveryType)&&!state.cart.length){showToast('Add something to your bag first');return;}state.modal='checkout';state.quote=null;render();}
async function calculateQuote(){const form=$('[data-form="checkout"]');if(!form)return;const fd=new FormData(form);const data={serviceType:state.deliveryType,distanceKm:Number(fd.get('distance')||6),orderTotal:state.cart.reduce((s,i)=>s+i.qty*i.price,0),packageSize:fd.get('packageSize')||'small',scheduled:(fd.get('time')||'ASAP')!=='ASAP'};try{const q=await api('/delivery/quote',{method:'POST',body:JSON.stringify(data)});state.quote=q;const eta=$('#quote-eta'),fee=$('#quote-fee'),total=$('#quote-total');if(eta)eta.textContent=q.eta;if(fee)fee.textContent=money(q.deliveryFee+q.handlingFee);if(total)total.textContent=money(q.total);const err=$('#quote-error');if(err)err.hidden=true;}catch(e){const err=$('#quote-error');if(err){err.hidden=false;err.textContent=e.message;}}}
function readForm(form){return Object.fromEntries(new FormData(form).entries());}
function showFormError(form,message){const el=$('.form-error',form);if(el){el.hidden=false;el.textContent=message;}}
async function submitBooking(form){const f=readForm(form),item=state.modalItem,stay=item.category==='stay';const date=f.date,returnDate=f.returnDate;let guests=Math.max(1,Number(f.guests)||1),nights=1;if(!date)throw new Error(stay?'Choose your check-in date.':'Choose your experience date.');if(stay){nights=Math.max(1,Math.ceil((new Date(returnDate)-new Date(date))/86400000));if(!returnDate||returnDate<=date)throw new Error('Check-out must be after check-in.');}if(!f.pickup||!f.drop)throw new Error('Add both pickup and drop-off points.');const amount=['openstreetmap','google-places'].includes(item.source)?0:item.price*guests*(stay?nights:1)+(stay&&f.transfer==='yes'?350:0);const payload={category:item.category,itemId:item.id,itemName:item.title,customerName:f.customerName,phone:f.phone,email:f.email,bookingDate:date,returnDate,guests,pickup:f.pickup,drop:f.drop,pickupTime:f.pickupTime,amount,paymentMethod:f.paymentMethod,details:{notes:f.notes||'',transferIncluded:f.transfer==='yes',duration:item.duration,location:item.location,source:item.source||'kenchain-catalogue',osmId:item.osmId||'',osmUrl:item.osmUrl||'',activityType:item.activityType||''}};const d=await api('/bookings',{method:'POST',body:JSON.stringify(payload)});state.booking=d.booking;state.lastEmail=f.email;state.modal=null;navigate('confirmation');}
async function submitCheckout(form){const f=readForm(form),cartTotal=state.cart.reduce((s,i)=>s+i.qty*i.price,0);if(!f.pickup?.trim()||!f.drop?.trim())throw new Error('Pickup and drop-off addresses are both required.');const q=state.quote||await api('/delivery/quote',{method:'POST',body:JSON.stringify({serviceType:state.deliveryType,distanceKm:Number(f.distance)||6,orderTotal:cartTotal,packageSize:f.packageSize||'small',scheduled:f.time!=='ASAP'})});const contents=state.cart.map(i=>`${i.qty} × ${i.name}`).join(', ');const itemName=state.deliveryType==='parcel'?'Parcel pickup & delivery':state.deliveryType==='documents'?'Document express delivery':`${state.deliveryType==='food'?'Food order':'Grocery order'} · ${contents}`;const d=await api('/bookings',{method:'POST',body:JSON.stringify({category:'delivery',itemId:state.deliveryType,itemName,customerName:f.customerName,phone:f.phone,email:f.email,bookingDate:dateToday(),pickup:f.pickup,drop:f.drop,pickupTime:f.time,amount:q.total,paymentMethod:f.paymentMethod,details:{serviceType:state.deliveryType,contents:contents||f.itemDescription||'',packageSize:f.packageSize||'small',instructions:f.instructions||'',distanceKm:q.distanceKm,deliveryFee:q.deliveryFee,handlingFee:q.handlingFee,items:state.cart}})});state.booking=d.booking;state.lastEmail=f.email;state.cart=[];state.modal=null;navigate('confirmation');}
async function lookupBookings(form){const d=await api('/bookings');state.bookingItems=d.items||[];state.bookingLookupError=state.bookingItems.length?'':'No bookings found for this email yet.';render();}
const LOCAL_SEARCH_CENTRES = [
  {terms:['udupi'],latitude:13.3409,longitude:74.7421,name:'Udupi, Karnataka'},
  {terms:['malpe'],latitude:13.36197,longitude:74.69753,name:'Malpe, Udupi'},
  {terms:['kaup','kapu'],latitude:13.2238,longitude:74.7367,name:'Kaup, Udupi'},
  {terms:['padubidri'],latitude:13.13194,longitude:74.76222,name:'Padubidri, Udupi'},
  {terms:['mattu'],latitude:13.27348,longitude:74.72496,name:'Mattu, Udupi'},
  {terms:['hoode'],latitude:13.40754,longitude:74.69705,name:'Hoode, Udupi'},
  {terms:['kodi bengre','kodibengre','delta beach'],latitude:13.44596,longitude:74.69392,name:'Kodi Bengre, Udupi'}
];
function knownSearchCentre(area){
  const value=String(area||'').toLowerCase();
  const match=LOCAL_SEARCH_CENTRES.find(entry=>entry.terms.some(term=>value.includes(term)));
  return match?{latitude:match.latitude,longitude:match.longitude,name:match.name}:null;
}
function isUdupiCoastalSearch(area){
  return /\budupi\b|\bmalpe\b|\bkaup\b|\bkapu\b|\bpadubidri\b|\bmattu\b|\bhoode\b|\bkodi bengre\b|\bdelta beach\b/i.test(String(area||''));
}
function isBeachSearchResult(item){
  return /beach|shore|coast|seashore|lighthouse|sea walk|seawalk|island|malpe|kaup|kapu|padubidri|mattu|hoode|delta|kodi bengre|maravanthe|someshwara|paduvari/i.test(`${item.title||''} ${item.placeType||''} ${item.description||''}`);
}
async function searchGoogleTouristPlaces(area,category,centreHint=null){
  const def={
    temples:{label:'Temples & sacred places',activities:TOUR_ACTIVITY_MAP.temples},
    beaches:{label:'Beaches & coastlines',activities:TOUR_ACTIVITY_MAP.beaches},
    waterfalls:{label:'Waterfalls & nature',activities:TOUR_ACTIVITY_MAP.waterfalls},
    heritage:{label:'Heritage & monuments',activities:TOUR_ACTIVITY_MAP.heritage},
    wildlife:{label:'Wildlife & nature reserves',activities:TOUR_ACTIVITY_MAP.wildlife},
    hills:{label:'Hill stations & viewpoints',activities:TOUR_ACTIVITY_MAP.hills},
    lakes:{label:'Lakes & rivers',activities:TOUR_ACTIVITY_MAP.lakes}
  }[category];
  if(!def)throw new Error('Choose a valid destination category.');
  if(!googleMapsApiKey)throw new Error('Google Places is not configured. Add GOOGLE_MAPS_API_KEY and enable Places API (New).');
  const isUdupiBeaches=category==='beaches'&&isUdupiCoastalSearch(area);
  const libs=await loadGoogleMapsLibraries();
  const areaCentre=centreHint||knownSearchCentre(area)||await resolveGoogleAreaCentre(libs,area);
  const queryList=googleTouristQueries(category,area),byId=new Map();let lastError=null;
  for(const query of queryList){
    try{
      const request=buildGooglePlaceSearchRequest(query,areaCentre?{lat:Number(areaCentre.latitude),lng:Number(areaCentre.longitude)}:null,20);
      const response=await libs.places.Place.searchByText(request);
      for(const place of response.places||[]){
        const item=normalizeGooglePlace(place,{area,category,categoryLabel:def.label});
        if(!item)continue;
        if(category==='beaches'&&!isBeachSearchResult(item))continue;
        byId.set(item.googlePlaceId||item.id,item);
      }
      // A 20-result page is requested for each focused query. Continue with the
      // next phrase until enough distinct matches are collected for a useful map.
      if(byId.size>=18)break;
    }catch(error){lastError=error;console.warn(`Google Places ${category} search:`,error.message);}
  }
  const googleItems=[...byId.values()];
  let centre=areaCentre?{latitude:Number(areaCentre.latitude),longitude:Number(areaCentre.longitude),name:areaCentre.name||area}:null;
  if(!centre&&googleItems.length){
    centre={latitude:googleItems.reduce((sum,item)=>sum+item.latitude,0)/googleItems.length,longitude:googleItems.reduce((sum,item)=>sum+item.longitude,0)/googleItems.length,name:area};
  }

  // Udupi is supplemented with well-known coastal locations because some of its
  // local beaches are inconsistently represented in general POI indexes.
  let curatedItems=[];
  if(isUdupiBeaches){
    try{
      const backup=await api(`/places/curated?area=${encodeURIComponent(area)}&category=beaches`);
      curatedItems=backup.items||[];
      if(!centre&&backup.centre)centre={...backup.centre,name:backup.area||area};
    }catch(error){console.info('Udupi curated beach supplement unavailable:',error.message);}
  }

  if(!googleItems.length&&!curatedItems.length)throw lastError||new Error(`Google Places returned no ${def.label.toLowerCase()} near ${area}. Try a more specific city, district or nearby town.`);
  if(!centre&&curatedItems.length){
    centre={latitude:curatedItems.reduce((sum,item)=>sum+item.latitude,0)/curatedItems.length,longitude:curatedItems.reduce((sum,item)=>sum+item.longitude,0)/curatedItems.length,name:area};
  }
  if(!centre){
    const first=googleItems[0];
    centre={latitude:first.latitude,longitude:first.longitude,name:area};
  }
  const seen=new Set();
  const merged=[...googleItems,...curatedItems].filter(item=>{
    const key=String(item.googlePlaceId||item.title||item.id).toLowerCase().replace(/[^a-z0-9]+/g,'');
    if(seen.has(key))return false;seen.add(key);return true;
  });
  const items=merged.map(item=>({...item,category,categoryLabel:def.label,distanceKm:distanceBetweenKm(centre.latitude,centre.longitude,item.latitude,item.longitude),activities:item.activities||def.activities,imageCategory:category,image:item.image||fallbackForCategory(category),imageAlt:item.imageAlt||`${item.title} · ${def.label} near ${area}`})).sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,40);
  const hasGoogle=googleItems.length>0;
  const hasCurated=curatedItems.length>0;
  return {
    area,category,categoryLabel:def.label,centre,count:items.length,items,activities:def.activities,
    source:hasGoogle?'Google Places API':'Kenchain Groups curated destination backup',
    live:hasGoogle,
    provider:hasGoogle?(hasCurated?'Google Places + curated Udupi beach supplement':'Google Places API'):'Kenchain curated destination backup',
    notice:hasGoogle&&hasCurated?'Live Google Places results are supplemented with known Udupi district beaches. Curated entries are labelled separately; check access and activity operators before travel.':hasCurated?(lastError?`Google Places could not complete this search (${lastError.message}). Showing a curated Udupi district beach list with mapped coordinates.`:'Google Places returned no matching beach records. Showing a curated Udupi district beach list with mapped coordinates.'):'Live place results from Google Places in India. Activity ideas are suggestions; operator availability and access must be confirmed.',
    attribution:hasCurated?'Google Maps Platform · Places API; curated Udupi destination notes.':'Google Maps Platform · Places API'
  };
}
function distanceBetweenKm(lat1,lon1,lat2,lon2){
  const toRad=value=>value*Math.PI/180,deltaLat=toRad(lat2-lat1),deltaLon=toRad(lon2-lon1);
  const a=Math.sin(deltaLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(deltaLon/2)**2;
  return Number((6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))).toFixed(1));
}
async function searchTouristPlaces(area,category=state.tourismCategory){
  const value=String(area||'').trim();
  if(value.length<2){state.tourismError='Enter a city, town or district to explore mapped places.';render();return;}
  state.tourismArea=value;state.tourismCategory=category;state.tourismLoading=true;state.tourismError='';state.tourismNotice='';state.tourismLive=false;state.tourismPlaces=[];render();
  const centre=state.searchCenter&&state.searchCenter.label===value?state.searchCenter:null;
  try{
    const data=await searchGoogleTouristPlaces(value,category,centre);
    state.tourismPlaces=data.items.map(item=>({...item,imageCategory:category}));state.tourismCentre=data.centre;state.tourismArea=data.area||value;state.tourismLive=Boolean(data.live);state.tourismProvider=data.provider||'Google Places API';state.tourismNotice=data.notice||'Live place results from Google Places. Activity ideas are suggestions; operator availability and access must be confirmed.';
    render();hydratePlaceImages('tourism');
  }catch(error){
    console.warn('Google Places tourist discovery unavailable; trying OpenStreetMap fallback:',error.message);
    try{
      const query=new URLSearchParams({area:value,category});if(centre){query.set('lat',centre.latitude);query.set('lon',centre.longitude);}
      const fallback=await api(`/places/search?${query}`);
      state.tourismPlaces=(fallback.items||[]).map(item=>({...item,imageCategory:category}));state.tourismCentre=fallback.centre||null;state.tourismArea=fallback.area||value;state.tourismLive=Boolean(fallback.live);state.tourismProvider=fallback.provider||fallback.source||'OpenStreetMap';state.tourismNotice=`Google Places is temporarily unavailable (${error.message}). ${fallback.notice||'Showing OpenStreetMap or curated backup results.'}`;
      if(state.tourismPlaces.length){render();hydratePlaceImages('tourism');}else state.tourismError=`No ${category} places were returned for ${value}. ${state.tourismNotice}`;
    }catch(fallbackError){state.tourismError=`Google Places search failed: ${error.message}. ${fallbackError.message}`;}
  }finally{state.tourismLoading=false;render();}
}
async function hydratePlaceImages(scope){const target=scope==='tourism'?state.tourismPlaces:state.adventureResults,token=++state.imageHydration[scope];if(!target?.length)return;const entries=target.slice(0,24).map(item=>({id:item.id,title:item.title,location:item.location||state.tourismArea||state.adventureArea,category:item.imageCategory||item.category||state.tourismCategory}));try{const data=await api('/places/images',{method:'POST',body:JSON.stringify({items:entries})});if(token!==state.imageHydration[scope])return;const images=new Map((data.images||[]).map(row=>[row.id,row]));target.forEach(item=>{const match=images.get(item.id);if(match){item.image=match.imageUrl||item.image||fallbackForCategory(item.imageCategory||item.category);if(match.matched){item.imageUrl=match.imageUrl;item.imagePageUrl=match.pageUrl;item.imageCredit=match.credit;item.imageLicense=match.license;item.imageAlt=`${item.title} at ${item.location||'the selected area'}`;}else{item.imageUrl='';item.imagePageUrl='';item.imageCredit='';item.imageLicense='';}}});if((scope==='tourism'&&state.view==='explore')||(scope==='adventure'&&state.view==='adventures'))render();}catch(error){console.info('Destination photo matching unavailable; using category-specific fallback art.',error.message);}}
async function trackVehicle(id){const vehicleId=String(id||state.vehicleId).trim().toUpperCase();if(!vehicleId)throw new Error('Enter the vehicle tracking ID.');state.vehicleId=vehicleId;state.vehicleLoading=true;state.vehicleError='';state.vehicle=null;render();try{const d=await api(`/vehicles/${encodeURIComponent(vehicleId)}`);state.vehicle=d.vehicle;state.vehicleId=d.vehicle.vehicleId;state.vehicleError='';render();startVehiclePolling();}catch(error){state.vehicleError=error.message;state.vehicleLoading=false;render();}finally{state.vehicleLoading=false;}}
let vehiclePollTimer=null;
function startVehiclePolling(){clearInterval(vehiclePollTimer);if(!state.vehicle)return;vehiclePollTimer=setInterval(async()=>{if(state.view!=='vehicles'||!state.vehicle)return;try{const d=await api(`/vehicles/${encodeURIComponent(state.vehicleId)}`);state.vehicle=d.vehicle;updateVehicleMap();updateVehicleStats();}catch(error){console.warn('Demo vehicle refresh:',error.message);}},5000);}
function updateVehicleStats(){const v=state.vehicle;if(!v)return;const el=$('.vehicle-status-head .status-pill');if(el){el.className='status-pill is-demo';el.textContent='● DEMO ONLY';}const stamp=$('.vehicle-refresh b');if(stamp)stamp.textContent=v.lastUpdated?new Date(v.lastUpdated).toLocaleTimeString('en-IN'):'Just now';const speed=$('.vehicle-stats div:nth-child(3) b');if(speed)speed.textContent=`${Math.round(v.speedKmh||0)} km/h`;const progress=$('.vehicle-progress b');if(progress)progress.textContent=`${Number(v.progressPercent||0)}%`;const eta=$('.vehicle-stats div:last-child b');if(eta)eta.textContent=`${Math.max(1,Number(v.etaMinutes)||1)} min`;}
async function authenticate(form){const values=readForm(form),endpoint=state.authMode==='register'?'/auth/register':'/auth/login';state.authError='';try{const result=await api(endpoint,{method:'POST',body:JSON.stringify(values)});state.user=result.user;state.authError='';showToast(state.authMode==='register'?'Your account is ready':'You are signed in');const data=await api('/bookings');state.bookingItems=data.items||[];navigate('bookings');}catch(error){state.authError=error.message;render();}}
async function logout(){await api('/auth/logout',{method:'POST',body:'{}'});state.user=null;state.bookingItems=[];state.bookingLookupError='';navigate('home');showToast('You have signed out');}
async function track(ref){state.trackingRef=ref||state.trackingRef;state.trackingError='';state.trackedBooking=null;if(!state.trackingRef.trim())throw new Error('Enter your booking reference.');const d=await api(`/bookings/track/${encodeURIComponent(state.trackingRef.trim())}`);state.trackedBooking=d.booking;state.view='track';render();}

// Delegated interactions keep the page lightweight and dependency-free.
document.addEventListener('click',async e=>{
  const directions=e.target.closest('[data-directions-id]');if(directions){await getDirectionsTo(directions.dataset.directionsId);return;}
  const nav=e.target.closest('[data-nav]');if(nav){navigate(nav.dataset.nav);return;}
  const del=e.target.closest('[data-delivery]');if(del){const next=del.dataset.delivery;if(state.deliveryType!==next&&state.cart.length){state.cart=[];showToast('Bag cleared for the new delivery service');}state.deliveryType=next;state.restaurantId=null;state.deliveryDetails={};navigate('delivery');return;}
  const hero=e.target.closest('[data-hero-tab]');if(hero){state.heroTab=hero.dataset.heroTab;if(state.heroTab==='delivery')state.deliveryType='food';render();return;}
  const qs=e.target.closest('[data-quick-search]');if(qs){quickSearch(qs.dataset.quickSearch,qs.dataset.target);return;}
  const book=e.target.closest('[data-book]');if(book){openBooking(book.dataset.book);return;}
  const tourCat=e.target.closest('[data-tour-category]');if(tourCat){state.tourismCategory=tourCat.dataset.tourCategory;state.tourismPlaces=[];state.tourismError='';state.tourismNotice='';state.tourismLive=false;if(state.view==='explore'&&state.tourismArea){searchTouristPlaces(state.tourismArea,state.tourismCategory);return;}state.view='explore';state.menuOpen=false;render();return;}
  const placeEnquire=e.target.closest('[data-place-enquire]');if(placeEnquire){const item=state.tourismPlaces.find(x=>x.id===placeEnquire.dataset.placeEnquire);if(item){state.modalItem={...item,category:'adventure',duration:'Plan with local operators',price:0,includes:item.activities};state.modal='booking';render();}return;}
  const demoVehicle=e.target.closest('[data-vehicle-demo]');if(demoVehicle){trackVehicle(demoVehicle.dataset.vehicleDemo);return;}
  const globalRestaurant=e.target.closest('[data-global-restaurant]');if(globalRestaurant){state.deliveryType='food';state.restaurantId=globalRestaurant.dataset.globalRestaurant;state.deliveryQuery='';navigate('delivery');return;}
  const globalGrocery=e.target.closest('[data-global-grocery]');if(globalGrocery){const item=groceryItems.find(x=>x.id===globalGrocery.dataset.globalGrocery);if(item){state.deliveryType='groceries';addCartItem(item,null);navigate('delivery');}return;}
  const globalPlace=e.target.closest('[data-global-place]');if(globalPlace){const item=state.globalSearchResults.places[Number(globalPlace.dataset.globalPlace)];if(item){state.tourismArea=item.label||item.name;state.searchCenter=item.latitude!=null?{latitude:item.latitude,longitude:item.longitude,label:state.tourismArea}:null;state.tourismCategory='temples';state.view='explore';searchTouristPlaces(state.tourismArea,state.tourismCategory);return;}}
  const authMode=e.target.closest('[data-auth-mode]');if(authMode){state.authMode=authMode.dataset.authMode;state.authError='';render();return;}
  const add=e.target.closest('[data-add-item]');if(add){const restaurant=state.restaurants.find(r=>r.id===add.dataset.restaurant)||null;const source=state.deliveryType==='food'?(restaurant?.items||[]):groceryItems;const item=source.find(i=>i.id===add.dataset.addItem);if(item)addCartItem(item,restaurant);return;}
  const rest=e.target.closest('[data-restaurant-select]');if(rest){const next=state.restaurants.find(r=>r.id===rest.dataset.restaurantSelect);if(state.cart.length&&state.cart.some(i=>i.restaurantName!==next.name)){state.cart=[];showToast('Bag cleared because the restaurant changed');}state.restaurantId=next.id;render();return;}
  const trackBtn=e.target.closest('[data-track]');if(trackBtn){try{await track(trackBtn.dataset.track);}catch(err){state.trackingError=err.message;navigate('track');render();}return;}
  const action=e.target.closest('[data-action]');if(action){const type=action.dataset.action;if(type==='menu'){state.menuOpen=!state.menuOpen;render();}else if(type==='logout'){try{await logout();}catch(error){showToast(error.message);}}else if(type==='retry')loadData();else if(type==='clear-delivery-search'){state.deliveryQuery='';render();}else if(type==='close-directions'){const panel=$('#directions-result');if(panel){panel.hidden=true;panel.innerHTML='';}if(state.directions){state.directions=null;const map=state.view==='explore'?tourismMapInstance:exploreMapInstance;if(map?._kgDirectionsLayer){map.removeLayer(map._kgDirectionsLayer);delete map._kgDirectionsLayer;}googleDirectionOverlays.forEach(layer=>layer.setMap(null));googleDirectionOverlays=[];}}else if(type==='clear-search'){state.activeSearch='';state.query='';if(state.view==='adventures'){state.adventureLookup=false;state.adventureResults=[];state.adventureError='';state.adventureArea='';state.adventureCentre=null;state.adventureNotice='';state.adventureLive=false;}render();}else if(type==='clear-adventure-search'){state.adventureLookup=false;state.adventureResults=[];state.adventureError='';state.adventureArea='';state.adventureCentre=null;state.adventureNotice='';state.adventureLive=false;state.query='';state.activeSearch='';render();}else if(type==='close-modal'){state.modal=null;render();}else if(type==='backdrop-close'&&e.target===action){state.modal=null;render();}else if(type==='checkout')openCheckout();else if(type==='track-current'){if(state.booking)try{await track(state.booking.reference);}catch(err){showToast(err.message);}}else if(type==='parcel-continue'){state.deliveryDetails={pickup:$('#direct-pickup')?.value||'',drop:$('#direct-drop')?.value||'',distance:$('#direct-distance')?.value||6,packageSize:$('#direct-size')?.value||'small',itemDescription:$('#direct-description')?.value||'',instructions:$('#direct-instructions')?.value||''};if(!state.deliveryDetails.pickup||!state.deliveryDetails.drop){showToast('Add both pickup and drop-off addresses');return;}openCheckout();}return;}
  const qty=e.target.closest('[data-qty]');if(qty){const item=state.cart.find(i=>i.key===qty.dataset.qty);if(item){item.qty+=Number(qty.dataset.diff);if(item.qty<=0)state.cart=state.cart.filter(i=>i!==item);render();}return;}
});
document.addEventListener('change',e=>{
  if(e.target.matches('[data-action="sort"]')){state.sort=e.target.value;render();return;}
  if(e.target.closest('[data-form="booking"]')&&(e.target.name==='date'||e.target.name==='returnDate'||e.target.name==='guests'||e.target.name==='transfer')){updateBookingPrice(e.target.form);}
  if(e.target.closest('[data-form="checkout"]')&&['distance','packageSize','time'].includes(e.target.name))calculateQuote();
});
const suggestionControllers=new WeakMap(),suggestionTimers=new WeakMap(),suggestionSessions=new WeakMap(),googleSuggestionSessions=new WeakMap();
function suggestionSessionFor(input){let token=suggestionSessions.get(input);if(!token){token=globalThis.crypto?.randomUUID?.()||`kg-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;suggestionSessions.set(input,token);}return token;}
async function googlePlaceSuggestions(input,term){
  const libs=await loadGoogleMapsLibraries();let token=googleSuggestionSessions.get(input);
  if(!token){token=new libs.places.AutocompleteSessionToken();googleSuggestionSessions.set(input,token);}
  const request={input:term,sessionToken:token,includedRegionCodes:['in'],language:'en-IN',region:'in'};
  if(state.searchCenter)request.origin={lat:Number(state.searchCenter.latitude),lng:Number(state.searchCenter.longitude)};
  const response=await libs.places.AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
  return (response.suggestions||[]).map(suggestion=>{
    const prediction=suggestion.placePrediction;if(!prediction)return null;
    const text=prediction.text?.toString?.()||String(prediction.text||'');
    const main=prediction.mainText?.toString?.()||text,secondary=prediction.secondaryText?.toString?.()||'Google Maps place';
    return {value:text,label:text,name:main,city:secondary,kind:'place',source:'google',googlePrediction:prediction};
  }).filter(Boolean);
}
function suggestionScope(input){
  const name=(input.name||'').toLowerCase(),id=(input.id||'').toLowerCase(),ph=(input.placeholder||'').toLowerCase();
  const form=input.closest('form[data-form]')?.dataset.form||'';
  const context=`${name} ${id} ${ph} ${form}`;
  if(name==='vehicleid'||/vehicle|registration|bus[-_ ]?id/.test(context))return'vehicle';
  if(name==='reference'||/tracking|booking[-_ ]?reference/.test(context))return'reference';
  if(name==='deliveryquery'||/restaurant|food|grocery|menu|dish|meal/.test(context))return'menu';
  if(['area','pickup','drop','destination','location','address','from','to','origin'].includes(name)||['direct-pickup','direct-drop'].includes(id)||/\b(destination|location|address|pickup|drop(?:-off)?|city|town|district|area|from|to|origin)\b/i.test(context))return'place';
  if(name==='query'||input.type==='search'||/search/.test(ph)||['hero-search','listing-search','global-search'].includes(form))return'global';
  return'';
}
function isPlaceSearchInput(input){return Boolean(suggestionScope(input));}
function attachSuggestions(input){const label=input.closest('label');let host;if(label){if(!label.parentElement?.classList.contains('suggestion-field')){const wrapper=document.createElement('div');wrapper.className='suggestion-field suggestion-host';label.parentElement.insertBefore(wrapper,label);wrapper.appendChild(label);}host=label.parentElement;}else{host=input.parentElement;}if(!host)return;host.classList.add('suggestion-host');let box=$('.live-suggestions',host);if(!box){box=document.createElement('div');box.className='live-suggestions';box.hidden=true;host.appendChild(box);}box._input=input;return box;}
function menuSuggestions(term){const q=term.toLowerCase(),rows=[];for(const r of state.restaurants){if(`${r.name} ${r.type} ${r.location}`.toLowerCase().includes(q))rows.push({value:r.name,label:r.name,name:r.name,city:`${r.type} · ${r.location}`,kind:'restaurant',id:r.id});for(const item of r.items||[]){if(`${item.name} ${item.description||''}`.toLowerCase().includes(q))rows.push({value:item.name,label:item.name,name:item.name,city:`${r.name} · ${r.location}`,kind:'menu-item',id:item.id,restaurantId:r.id});}}for(const item of groceryItems){if(`${item.name} ${item.description||''}`.toLowerCase().includes(q))rows.push({value:item.name,label:item.name,name:item.name,city:'Grocery item',kind:'grocery',id:item.id});}return rows.slice(0,8);}
function localSearchSuggestions(term){const q=term.toLowerCase(),items=[];for(const item of state.catalog){if(`${item.title||''} ${item.location||''} ${item.description||''}`.toLowerCase().includes(q))items.push({value:item.title,label:item.title,name:item.title,city:item.location,kind:'experience',category:item.category,id:item.id});}for(const restaurant of state.restaurants){if(`${restaurant.name||''} ${restaurant.location||''} ${restaurant.type||''}`.toLowerCase().includes(q))items.push({value:restaurant.name,label:restaurant.name,name:restaurant.name,city:restaurant.location,kind:'restaurant',id:restaurant.id});}for(const item of groceryItems){if(`${item.name||''} ${item.description||''}`.toLowerCase().includes(q))items.push({value:item.name,label:item.name,name:item.name,city:'Grocery item',kind:'grocery',id:item.id});}return items.slice(0,8);}
async function fetchSuggestions(input){
  const term=input.value.trim(),scope=suggestionScope(input),box=attachSuggestions(input);if(!box)return;
  suggestionControllers.get(input)?.abort();
  if(term.length<2){box.hidden=true;box.innerHTML='';input.setAttribute('aria-expanded','false');return;}
  const controller=new AbortController();suggestionControllers.set(input,controller);box.hidden=false;input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','true');box.setAttribute('role','listbox');box.innerHTML='<div class="suggestion-loading">Finding live suggestions…</div>';
  try{
    let items=[];
    if(scope==='vehicle'){
      const data=await api(`/vehicles?q=${encodeURIComponent(term)}`,{signal:controller.signal});items=(data.items||[]).map(v=>({value:v.vehicleId,label:v.vehicleId,name:v.vehicleId,city:`${v.routeName||v.vehicleType} · DEMO`,kind:'vehicle'}));
    }else if(scope==='reference'){
      try{const data=await api(`/bookings/suggest?q=${encodeURIComponent(term)}`,{signal:controller.signal});items=data.items||[];}catch(error){if(!state.user)items=[];else throw error;}
    }else if(scope==='menu'){
      items=menuSuggestions(term);
    }else{
      let mapped=[];
      if(googleMapsApiKey&&state.mapProvider==='google'){
        try{mapped=await googlePlaceSuggestions(input,term);}catch(error){console.info('Google Places autocomplete fallback:',error.message);}
      }
      if(!mapped.length){
        try{const data=await api(`/places/suggest?q=${encodeURIComponent(term)}`,{signal:controller.signal});mapped=data.items||[];}catch(error){console.info('Google Places and local place suggestions unavailable:',error.message);}
      }
      if(scope==='global'){
        let local=[];try{const data=await api(`/search/suggest?q=${encodeURIComponent(term)}`,{signal:controller.signal});local=data.items||[];}catch(error){local=localSearchSuggestions(term);}
        items=[...mapped,...local.filter(item=>item.kind!=='place')];
      }else{
        items=mapped;
        if(!items.length){try{const data=await api(`/places/suggest?q=${encodeURIComponent(term)}`,{signal:controller.signal});items=data.items||[];}catch(error){items=localSearchSuggestions(term).filter(item=>item.kind!=='restaurant');}}
      }
      const seen=new Set();items=items.filter(item=>{const key=String(item.value||item.name||item.label).toLowerCase();if(seen.has(key))return false;seen.add(key);return true;}).slice(0,10);
    }
    if(controller.signal.aborted||!document.body.contains(input))return;
    box._items=items;
    box.innerHTML=items.length?items.map((item,i)=>`<button type="button" role="option" aria-selected="false" data-place-suggestion="${i}"><span>${item.kind==='booking'?'▣':item.kind==='vehicle'?'↗':item.kind==='restaurant'?'♨':item.kind==='menu-item'||item.kind==='grocery'?'✦':item.kind==='experience'?'⌂':'⌖'}</span><span><b>${esc(item.name||item.label)}</b><small>${esc(item.city||item.sub||item.category||item.featureType||item.kind||'')}</small></span></button>`).join(''):'<div class="suggestion-loading">No suggestions. You can still enter your search.</div>';
    box.hidden=false;input.setAttribute('aria-expanded','true');
  }catch(error){if(error.name!=='AbortError'&&!controller.signal.aborted){box.innerHTML='<div class="suggestion-loading">Suggestions are unavailable. You can still submit your search.</div>';box.hidden=false;input.setAttribute('aria-expanded','true');}}
}
document.addEventListener('input',e=>{const input=e.target;if(!(input instanceof HTMLInputElement)||!isPlaceSearchInput(input))return;if(['query','area'].includes(input.name)&&state.searchCenter&&input.value!==state.searchCenter.label)state.searchCenter=null;clearTimeout(suggestionTimers.get(input));suggestionTimers.set(input,setTimeout(()=>fetchSuggestions(input),260));});
document.addEventListener('click',async e=>{
  const suggestion=e.target.closest('[data-place-suggestion]');
  if(suggestion){
    const host=suggestion.closest('.suggestion-host'),box=$('.live-suggestions',host),input=box?._input;let item=box?._items?.[Number(suggestion.dataset.placeSuggestion)];
    if(input&&item){
      if(item.googlePrediction){
        try{
          const place=item.googlePrediction.toPlace();await place.fetchFields({fields:['displayName','formattedAddress','location','types','id']});
          const loc=place.location;const lat=loc?(typeof loc.lat==='function'?loc.lat():loc.lat):null;const lng=loc?(typeof loc.lng==='function'?loc.lng():loc.lng):null;
          item={...item,name:place.displayName||item.name,value:place.formattedAddress||item.value,label:place.formattedAddress||item.label,latitude:lat,longitude:lng,googlePlaceId:place.id||''};
          googleSuggestionSessions.delete(input);
        }catch(error){showToast(error.message||'Google Maps could not load that place.');}
      }
      input.value=item.value||item.name||item.label||'';input.dispatchEvent(new Event('change',{bubbles:true}));
      if(item.latitude!=null&&item.longitude!=null){input.dataset.latitude=item.latitude;input.dataset.longitude=item.longitude;if(['query','area'].includes(input.name)){state.query=input.value;state.searchCenter={latitude:Number(item.latitude),longitude:Number(item.longitude),label:input.value};}}
      if(input.name==='area')state.tourismArea=input.value;
      if(item.kind==='booking'){track(item.value||item.name).catch(error=>showToast(error.message));}
      else if(item.kind==='vehicle'){state.vehicleId=item.value||item.name;state.view='vehicles';window.scrollTo({top:0,behavior:'smooth'});trackVehicle(state.vehicleId);}
      else if(item.kind==='restaurant'){state.deliveryType='food';state.restaurantId=item.id;state.deliveryQuery='';if(state.view==='delivery')render();else navigate('delivery');}
      else if(item.kind==='menu-item'){state.deliveryType='food';state.restaurantId=item.restaurantId||state.restaurantId;state.deliveryQuery=item.value||item.name;if(state.view==='delivery')render();else navigate('delivery');}
      else if(item.kind==='grocery'){state.deliveryType='groceries';state.deliveryQuery=item.value||item.name;if(state.view==='delivery')render();else navigate('delivery');}
      else if(item.kind==='experience'){state.query=item.value||item.name;}
    }
    if(box){box.hidden=true;box.innerHTML='';input?.setAttribute('aria-expanded','false');}return;
  }
  if(!e.target.closest('.suggestion-host'))$$('.live-suggestions').forEach(box=>{box.hidden=true;box._input?.setAttribute('aria-expanded','false');});
});
document.addEventListener('keydown',e=>{const input=e.target;if(input instanceof HTMLInputElement&&isPlaceSearchInput(input)){const host=input.closest('label')?.parentElement||input.parentElement;const box=$('.live-suggestions',host);if(box&&!box.hidden){const options=$$('button[data-place-suggestion]',box),index=options.findIndex(x=>x.getAttribute('aria-selected')==='true');if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const next=e.key==='ArrowDown'?Math.min(index+1,options.length-1):Math.max(index-1,0);options.forEach((x,i)=>x.setAttribute('aria-selected',String(i===next)));options[next]?.scrollIntoView({block:'nearest'});return;}if(e.key==='Enter'&&index>=0){e.preventDefault();options[index].click();return;}}}if(e.key==='Escape')$$('.live-suggestions').forEach(box=>{box.hidden=true;box._input?.setAttribute('aria-expanded','false');});});
function applyImageFallback(img){
  if(!(img instanceof HTMLImageElement)||img.dataset.fallbackApplied==='1')return;
  const fallback=img.dataset.fallbackSrc||FALLBACK_IMAGE;
  let currentPath='';try{currentPath=new URL(img.currentSrc||img.src,location.href).pathname;}catch{}
  let decodedPath=currentPath;try{decodedPath=decodeURIComponent(currentPath);}catch{}
  if(decodedPath===fallback)return;
  img.dataset.fallbackApplied='1';img.classList.add('image-fallback-active');img.src=fallback;
}
function attachImageFallbacks(){
  $$('img').forEach(img=>{
    if(!img.hasAttribute('alt'))img.alt='Kenchain Groups destination or service image';
    if(!img.dataset.fallbackSrc)img.dataset.fallbackSrc=FALLBACK_IMAGE;
    if(!img.dataset.fallbackReady){img.dataset.fallbackReady='1';img.addEventListener('error',()=>applyImageFallback(img));}
    if(img.complete&&img.naturalWidth===0)applyImageFallback(img);
  });
}
document.addEventListener('error',e=>{if(e.target instanceof HTMLImageElement)applyImageFallback(e.target);},true);
function updateBookingPrice(form){const f=readForm(form),item=state.modalItem;if(!item||['openstreetmap','google-places'].includes(item.source))return;const stay=item.category==='stay';const guests=Math.max(1,Number(f.guests)||1);const nights=stay&&f.date&&f.returnDate?Math.max(1,Math.ceil((new Date(f.returnDate)-new Date(f.date))/86400000)):1;const amount=['openstreetmap','google-places'].includes(item.source)?0:item.price*guests*(stay?nights:1)+(stay&&f.transfer==='yes'?350:0);const price=$('#booking-price'),note=$('#booking-price-note');if(price)price.textContent=money(amount);if(note)note.textContent=`${guests} ${guests===1?'person':'people'}${stay?` · ${nights} night${nights>1?'s':''}`:''}`;}
document.addEventListener('submit',async e=>{
  const form=e.target.closest('form[data-form]');if(!form)return;e.preventDefault();const type=form.dataset.form;
  if(type==='hero-search'||type==='listing-search'){const f=readForm(form);state.query=f.query||'';state.activeSearch=state.query;if(type==='hero-search'){if(state.heroTab==='all'){await searchEverything(state.query);return;}state.view=({tour:'tours',adventure:'adventures',stay:'stays',delivery:'delivery'})[state.heroTab]||'tours';if(state.heroTab==='delivery'){state.deliveryQuery=state.query;render();return;}}window.scrollTo({top:0,behavior:'smooth'});if(state.view==='adventures'&&state.query.trim()){await searchAdventurePlaces(state.query);return;}if(state.view==='adventures'&&!state.query.trim()){state.adventureLookup=false;state.adventureResults=[];state.adventureError='';}render();return;}
  if(type==='global-search'){const f=readForm(form);await searchEverything(f.query);return;}if(type==='delivery-search'){state.deliveryQuery=readForm(form).deliveryQuery||'';render();return;}if(type==='auth'){await authenticate(form);return;}if(type==='tourism-search'){const f=readForm(form);state.tourismArea=f.area||'';await searchTouristPlaces(state.tourismArea,state.tourismCategory);return;}if(type==='vehicle-track'){const f=readForm(form);await trackVehicle(f.vehicleId);return;}
  try{const button=$('button[type="submit"],button:not([type])',form);if(button){button.disabled=true;button.dataset.original=button.textContent;button.textContent='Please wait…';}if(type==='booking')await submitBooking(form);else if(type==='checkout')await submitCheckout(form);else if(type==='lookup')await lookupBookings(form);else if(type==='tracking'){const f=readForm(form);await track(f.reference);} }
  catch(err){if(type==='tracking'){state.trackingError=err.message;state.view='track';render();}else if(type==='lookup'){state.bookingLookupError=err.message;render();}else showFormError(form,err.message);const button=$('button',form);if(button){button.disabled=false;button.textContent=button.dataset.original||'Try again';}}
});

loadData();
