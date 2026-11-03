import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  INDIA_SEARCH_BOUNDS,
  buildGooglePlaceSearchRequest,
  googleTouristQueries,
  googleAdventureQueries
} from '../frontend/google-places.js';
const placesModule = await readFile(new URL('../frontend/google-places.js', import.meta.url), 'utf8');

const app = await readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../backend/server.js', import.meta.url), 'utf8');

// A broad search is constrained to India instead of inheriting an IP or Bengaluru bias.
const indiaRequest = buildGooglePlaceSearchRequest('temples near Jaipur, Rajasthan, India', null, 20);
assert.deepEqual(indiaRequest.locationRestriction, INDIA_SEARCH_BOUNDS);
assert.equal(indiaRequest.locationBias, undefined);
assert.equal(indiaRequest.region, 'in');
assert.equal(indiaRequest.language, 'en-IN');
assert.equal(indiaRequest.maxResultCount, 20);

// Once the user chooses a place, bias locally while still keeping India as the region.
const localRequest = buildGooglePlaceSearchRequest('beaches near Puri, Odisha, India', { lat: 19.8135, lng: 85.8312 }, 50);
assert.deepEqual(localRequest.locationBias.center, { lat: 19.8135, lng: 85.8312 });
assert.equal(localRequest.locationRestriction, undefined);
assert.equal(localRequest.maxResultCount, 20);

const areas = [
  ['Jaipur, Rajasthan, India', 'Rajasthan'],
  ['Puri, Odisha, India', 'Odisha'],
  ['Varanasi, Uttar Pradesh, India', 'Uttar Pradesh'],
  ['Kochi, Kerala, India', 'Kerala'],
  ['Mumbai, Maharashtra, India', 'Maharashtra'],
  ['Shillong, Meghalaya, India', 'Meghalaya'],
  ['Chennai, Tamil Nadu, India', 'Tamil Nadu'],
  ['Gangtok, Sikkim, India', 'Sikkim'],
  ['Panaji, Goa, India', 'Goa'],
  ['Leh, Ladakh, India', 'Ladakh'],
  ['Port Blair, Andaman and Nicobar Islands, India', 'Andaman and Nicobar Islands'],
  ['Dispur, Assam, India', 'Assam']
];

for (const [area, stateName] of areas) {
  for (const category of ['temples', 'beaches', 'waterfalls', 'heritage', 'wildlife', 'hills', 'lakes']) {
    const queries = googleTouristQueries(category, area);
    assert.ok(queries.length >= 2, `${category} query variants exist for ${area}`);
    assert.ok(queries.every(query => query.includes(area)), `${category} queries retain the full Indian area ${area}`);
    assert.ok(queries.every(query => /India/i.test(query)), `${category} queries explicitly scope ${area} to India`);
    if (!/Udupi/i.test(area)) assert.ok(!queries.some(query => /Karnataka/i.test(query)), `No Karnataka bias for ${area}`);
  }
  assert.ok(googleAdventureQueries(area).every(query => query.includes(area) && /India/i.test(query)));
  assert.ok(googleAdventureQueries(area).length >= 3);
  assert.ok(area.includes(stateName));
}

const udupiBeachQueries = googleTouristQueries('beaches', 'Udupi, Karnataka, India');
for (const alias of ['Malpe Beach', 'Kaup Beach', 'Padubidri Blue Flag Beach', 'Mattu Beach', 'Delta Beach']) {
  assert.ok(udupiBeachQueries.some(query => query.includes(alias)), `Udupi alias ${alias} remains covered`);
}

// Autocomplete must explicitly scope all suggestions to India and avoid a fixed Bengaluru default.
assert.ok(app.includes("includedRegionCodes:['in']"));
assert.ok(app.includes('resolveGoogleAreaCentre'));
assert.ok(placesModule.includes('locationRestriction'));
assert.ok(placesModule.includes('INDIA_SEARCH_BOUNDS'));
assert.ok(!server.includes("lat:'12.9716',lon:'77.5946'"));
assert.ok(server.includes("countrycodes:'in'"));
assert.ok(server.includes("p.countrycode||p.countryCode||''"));
assert.ok(!server.includes("state:first.state||'Karnataka'"));

console.log(`India-wide search smoke passed: ${areas.length} test areas, 7 tourist categories, adventure search, India bounds and autocomplete country scoping.`);

// Every listing map must use actual coordinates or resolve the catalogue item
// through Google Places; it must never send unknown Indian places to Bengaluru.
assert.ok(app.includes('async function mapItemsWithCoordinates(items,libs)'));
assert.ok(app.includes('buildGooglePlaceSearchRequest(label,null,1)'));
assert.ok(app.includes('const INDIA_MAP_CENTRE=[22.5937,78.9629]'));
assert.ok(app.includes('return key?DEST_COORDS[key]:null'));
assert.ok(!app.includes("return key?DEST_COORDS[key]:[12.9716,77.5946]"));
assert.ok(!app.includes("Kenchain Groups · Bengaluru</b><br>Common pickup hub"));
assert.ok(app.includes('if(state.tourismCentre){bounds.extend'));
console.log('India-wide map coordinate and centre checks passed.');
