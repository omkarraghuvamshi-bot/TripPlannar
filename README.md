# Kenchain Groups v2.7.2

Kenchain Groups combines Hospitality stays, tours, mapped tourist destinations, outdoor adventures, food and grocery delivery, courier bookings, simulated fleet tracking, customer authentication and booking references.

## Google Maps and Places are the only live map/search provider

The project no longer uses Mapbox. Google Maps JavaScript API powers the map, Google Places API (New) powers India-scoped place autocomplete and live tourist/adventure POI discovery, and Google Routes API powers directions. OpenStreetMap/curated records remain a clearly labelled fallback when Google Places is temporarily unavailable.

The frontend uses `google.maps.places.Place.searchByText()` with the Places API field mask. All Explore, category, adventure, Hospitality and directions maps share the same India-wide location context. Missing catalogue coordinates are resolved from the Google Place ID or a focused Google Places lookup; unknown coordinates are not silently pinned to Bengaluru. Unresolved maps open on a neutral India overview instead of an unrelated city. Category searches are India-wide: if no locality is selected, Text Search is restricted to an India-wide map viewport; after a visitor selects or resolves a city/town, searches are biased to that locality. Queries dynamically include the entered city, district, state and India rather than assuming Karnataka. The same Places Autocomplete flow is restricted to India for homepage, Explore, adventure and pickup/drop address inputs. No Google Places REST request is made from the backend using the browser key. The API key is delivered to the browser by `/api/maps/config` because it is a public Maps JavaScript key. Restrict it to your website's HTTP referrers and only the required APIs in Google Cloud Console.

## Google Cloud setup

Enable billing and these APIs in the same Google Cloud project:

1. Maps JavaScript API
2. Places API (New)
3. Routes API

Set `GOOGLE_MAPS_API_KEY` and `GOOGLE_MAPS_MAP_ID` in `.env` locally, and set the same variables in Render's environment settings. A key with HTTP-referrer restrictions is suitable for this browser-side integration. Do not use a server-restricted key in the Maps JavaScript loader.

Place suggestions use Google Autocomplete with India-only region filtering. If Google autocomplete is unavailable, Photon is queried without a fixed Bengaluru coordinate bias and its results are filtered to India; Nominatim is a secondary fallback with `countrycodes=in`. The backend geocoder therefore works with locations across Indian states and union territories rather than defaulting to Karnataka.

Live Places search can incur billable Google Maps Platform usage. The Text Search field mask requests ID, display name, formatted address, location, types and primary type fields. Configure quota limits and billing alerts in Google Cloud.

### Udupi beaches

Beach discovery for Udupi district uses targeted Google Places Text Search queries for the Udupi coast, Malpe, Kaup/Kapu, Padubidri, Mattu, Hoode and Delta Beach/Kodi Bengre. When Google returns sparse or empty beach results, the app supplements them with six clearly labelled curated map pins with coordinates and place-specific activity ideas. The curated entries are informational backups, not live operator inventory or a guarantee of beach access. Destination descriptions are cross-checked against Karnataka Tourism pages; local conditions, access and activities must be reconfirmed before visiting.

## Startup fix in v2.7.2

The frontend entrypoint uses ES-module imports and is loaded with `type="module"`. The previous build loaded it as a classic script, which caused the browser to reject the first `import` statement and remain on the static boot screen. A startup watchdog now displays a Retry message if the frontend module cannot load, and API requests time out with a visible error instead of leaving the UI in a permanent loading state.

## Run locally

Requires Node.js 20 or newer.

```bash
cp .env.example .env
# Set GOOGLE_MAPS_API_KEY and optional DATABASE_URL in .env
npm install
npm start
```

Open `http://localhost:4000`.

## Tests

```bash
npm run lint
npm run test:startup
npm run test:search
npm run test:map-resilience
npm run test:google-maps
npm run test:google-places
npm run test:udupi-beaches
npm run test:india-search
npm run test:india-search-api
npm run test:all
```

Google integration tests validate configuration and request construction without making live billable Google requests. Map resilience tests verify that a curated/OSM fallback still renders when public data services fail, including Udupi beach searches with all external place providers returning HTTP 502. India-wide tests cover Jaipur/Rajasthan, Puri/Odisha, Varanasi/Uttar Pradesh, Kochi/Kerala, Mumbai/Maharashtra, Shillong/Meghalaya, Chennai/Tamil Nadu, Gangtok/Sikkim, Panaji/Goa, Leh/Ladakh, Port Blair/Andaman and Nicobar Islands and Dispur/Assam. The map smoke tests also ensure unknown coordinates are never replaced with Bengaluru coordinates and that neutral map extents are used when no local search centre is available.

## Real data limitations

Google Places returns mapped points of interest, not confirmation that an adventure operator is active, accepts bookings, or is safe/open. Verify all operator details, prices, permits and activity availability before booking. Vehicle tracking in this build is explicitly simulated and does not show live bus or courier GPS.

## Deployment

Render Web Service runtime: Node. Build command: `npm install`. Start command: `npm start`. Add `DATABASE_URL`, `GOOGLE_MAPS_API_KEY`, and `GOOGLE_MAPS_MAP_ID` in Render environment settings. `DATABASE_URL` should use a pooled Postgres connection for application traffic.
