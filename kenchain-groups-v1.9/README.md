# Kenchain Groups

A responsive travel, hospitality, adventure and delivery marketplace with a Node.js API, account sign-in, booking references, OpenStreetMap place discovery and **simulated-only** fleet tracking.

## Run locally

**Requirements:** Node.js 20 or newer.

```bash
npm install
npm start
```

Open <http://localhost:4000>.

For development with automatic restart:

```bash
npm run dev
```

Run the built-in source and UI audit:

```bash
npm run lint
```

With the server running in another terminal, run the API smoke tests for search, Hospitality filtering and demo vehicle lookup:

```bash
npm run test:search
```

To verify the map/search fallback when public place providers return errors (uses a local mock 502 server, so it does not depend on external map availability):

```bash
npm run test:map-resilience
```

## Included experiences

- Unified search across tours, adventure catalogue, Hospitality, restaurants, groceries and mapped destinations. The homepage has an “All services” search mode as well as dedicated service tabs.
- Live typeahead suggestions on destination/area, pickup/drop-off, restaurant/menu, booking-reference and demo-vehicle search fields, with mouse and keyboard selection.
- Food and grocery menus support filtering by restaurant, dish, ingredient or item. Search suggestions can jump directly to the matching restaurant or menu category.

- Tours and travel with date, traveller, pickup and drop-off details.
- Hospitality bookings for hotels and homestays, including check-in/out and optional transfers.
- Adventure discovery by area using mapped OpenStreetMap features.
- Explore categories: temples, beaches, waterfalls, heritage, wildlife, hills, and lakes/rivers.
- Place-matched Wikimedia Commons photos where a relevant image can be verified. The image resolver checks that the place name appears in the file name; it does not substitute a random unrelated image. When no suitable photo can be verified or the service is unavailable, the UI displays a locally stored category illustration instead.
- Interactive Leaflet maps with OpenStreetMap tiles and attribution.
- Food, groceries, parcel and document delivery with pickup/drop-off and estimated pricing.
- Booking reference lookup and customer booking history.
- Account registration and sign-in with salted scrypt password hashes, opaque server-side sessions, HttpOnly cookies and rate-limited sign-in attempts.
- Vehicle tracking preview for a tourist bus, travel van and courier van. Vehicle location, speed, progress, breadcrumb trail and ETA are **simulated demo data** that moves along sample routes. It is not sourced from GPS hardware, driver devices, fleet partners or live transport systems.

## Demo vehicle IDs

| Demo ID | Example route |
|---|---|
| `KG-BUS-DEMO` | Bengaluru → Mysuru |
| `KG-VAN-DEMO` | Mysuru → Madikeri / Coorg |
| `KG-COURIER-DEMO` | Bengaluru city loop |

The vehicle page refreshes the simulation on a five-second interval and labels the map and stats as demo-only. It has no GPS-ingest endpoint and does not accept real vehicle location updates.

## Search and map reliability

All service search inputs share the same live-suggestion handler: place and pickup/drop-off fields use geocoding; food/grocery search uses local restaurant and item suggestions; vehicle search uses the simulated fleet catalogue; and booking-reference suggestions are scoped to the signed-in customer. If a provider is unavailable, the user can still submit the typed value. The map tries OpenStreetMap tiles, then CARTO, then the OSM HOT style. If all tile sources fail, markers and destination links remain available with an explanatory overlay.

## API routes

- `GET /api/health`
- `GET /api/search?q=...` for cross-service results
- `GET /api/search/suggest?q=...` for unified typeahead suggestions
- `GET /api/catalog` and `GET /api/catalog/:id`
- `GET /api/restaurants`
- `GET /api/places/suggest?q=...`
- `GET /api/places/search?area=...&category=...`
- `POST /api/places/images` for place-specific image matching
- `GET /api/adventures/search?area=...`
- `GET /api/vehicles?q=...` and `GET /api/vehicles/:vehicleId` for demo-only fleet data
- `POST /api/delivery/quote`
- `POST /api/bookings`, `GET /api/bookings`, `GET /api/bookings/track/:reference`
- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`

## Storage

If `DATABASE_URL` is set, the application stores bookings, users and sessions in PostgreSQL. The app uses the `pg` driver already declared in `package.json`. For production, use a pooled Neon connection string for application requests. If `DATABASE_URL` is not set, a JSON file under `backend/data/store.json` is used for local development.

Set `DATABASE_URL` in Render's environment settings. Never commit a real database connection string, password or other secret to Git.

## Provider notes and limitations

- Location suggestions use Photon with Nominatim fallback. Live mapped-place discovery tries multiple Overpass mirrors. If the public providers return errors such as HTTP 502, the API now returns a handled JSON response and uses cached or clearly labelled curated map pins for supported areas. For other areas it keeps the map centred on the geocoded search location and explains that no live pins could be loaded instead of returning an upstream 502. Public endpoints have fair-use and availability limits; for sustained commercial traffic, use an appropriate contracted or self-hosted provider.
- Destination photos are looked up against Wikimedia Commons. Each matched image carries its source/credit/license information in the result. A local category illustration is used when a relevant file cannot be verified.
- Leaflet and OpenStreetMap tiles require an internet connection. Respect the OpenStreetMap tile usage policy and use a commercial tile service for high-volume production traffic.
- Demo tour, hospitality, restaurant and delivery catalogue entries are seed examples. They are not live partner inventory.
- Booking references and statuses are persisted by Kenchain Groups. Real hotel/tour confirmations, actual courier dispatch, driver GPS, live payments, customer email verification, password reset, MFA and operator/admin roles require their respective production integrations. No online payment is taken by this starter.

## Deployment on Render

This is a Node web service from the repository root:

- Build command: `npm install`
- Start command: `npm start`
- Environment: set `DATABASE_URL` to the Neon pooled connection string.

Render supplies `PORT`; the server binds to `0.0.0.0`.

## Image handling

All rendered `<img>` elements are assigned descriptive alt text and a local fallback. Destination result images are correlated to their own place IDs so a Commons image cannot drift onto another card after an asynchronous search completes. If a relevant image is not found, the corresponding category SVG is used.
