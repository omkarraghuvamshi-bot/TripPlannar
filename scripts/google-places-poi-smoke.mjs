import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { buildGooglePlaceSearchRequest, googleTouristQueries, googleAdventureQueries, normalizeGooglePlace, GOOGLE_PLACE_FIELDS } from '../frontend/google-places.js';

const app = await readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
const request = buildGooglePlaceSearchRequest('temples near Gokarna, India', { lat: 14.55, lng: 74.32 }, 10);
assert.equal(request.textQuery, 'temples near Gokarna, India');
assert.equal(request.maxResultCount, 10);
assert.ok(request.fields.includes('location') && request.fields.includes('displayName'));
assert.deepEqual(request.locationBias.center, { lat: 14.55, lng: 74.32 });
assert.ok(request.locationBias.radius > 0);
assert.equal(buildGooglePlaceSearchRequest('test', null, 999).maxResultCount, 20);

for (const category of ['temples','beaches','waterfalls','heritage','wildlife','hills','lakes']) {
  const queries = googleTouristQueries(category, 'Gokarna');
  assert.ok(queries.length >= 1 && queries.every(q => q.includes('Gokarna')));
}
assert.ok(googleAdventureQueries('Coorg').some(q => /trekking|kayaking|rafting/i.test(q)));
const udupiBeachQueries=googleTouristQueries('beaches','Udupi, Karnataka, India');
assert.ok(udupiBeachQueries.some(q=>/Malpe Beach/i.test(q)));
assert.ok(udupiBeachQueries.some(q=>/Kaup Beach/i.test(q)));
assert.ok(udupiBeachQueries.some(q=>/Padubidri/i.test(q)));
assert.ok(udupiBeachQueries.some(q=>/Mattu Beach/i.test(q)));
assert.ok(udupiBeachQueries.some(q=>/Delta Beach/i.test(q)));

const place = normalizeGooglePlace({
  id: 'test-place-123', displayName: 'Om Beach', formattedAddress: 'Gokarna, Karnataka, India',
  location: { lat: () => 14.5095, lng: () => 74.3185 }, types: ['beach'], primaryType: 'tourist_attraction'
}, { area: 'Gokarna', category: 'beaches', categoryLabel: 'Beaches & coastlines' });
assert.equal(place.title, 'Om Beach');
assert.equal(place.source, 'google-places');
assert.equal(place.live, true);
assert.equal(place.latitude, 14.5095);
assert.match(place.mapUrl, /google\.com\/maps\/search/);
assert.equal(normalizeGooglePlace({ id: 'bad', displayName: 'No geometry' }, { area: 'Gokarna' }), null);

assert.ok(app.includes('libs.places.Place.searchByText'));
assert.ok(app.includes('searchGoogleTouristPlaces'));
assert.ok(app.includes('googleAdventureQueries'));
assert.ok(!app.includes('api(`/maps/discover?'));
assert.ok(!app.includes('api(`/maps/adventures?'));
assert.ok(app.includes('Google Places API'));
console.log(`Google Places smoke test passed: ${GOOGLE_PLACE_FIELDS.length} fields, 7 destination categories, adventure discovery, result normalization and frontend integration.`);
