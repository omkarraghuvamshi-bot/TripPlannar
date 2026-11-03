export const GOOGLE_PLACE_FIELDS = Object.freeze([
  'id', 'displayName', 'formattedAddress', 'location', 'types', 'primaryType', 'primaryTypeDisplayName'
]);

// A broad India viewport keeps un-biased searches on the Indian map while still
// allowing a selected city/town to narrow results through a local location bias.
// Google Places accepts a LatLngBoundsLiteral for locationRestriction.
export const INDIA_SEARCH_BOUNDS = Object.freeze({
  north: 37.4,
  south: 6.3,
  east: 97.8,
  west: 68.0
});

function withIndiaContext(area) {
  const value = String(area || '').trim().replace(/\s+/g, ' ');
  if (!value) return 'India';
  return /\bindia\b/i.test(value) ? value : `${value}, India`;
}

export function buildGooglePlaceSearchRequest(textQuery, center = null, maxResultCount = 10) {
  const request = {
    textQuery: String(textQuery || '').trim(),
    fields: [...GOOGLE_PLACE_FIELDS],
    maxResultCount: Math.max(1, Math.min(20, Number(maxResultCount) || 10)),
    language: 'en-IN',
    region: 'in',
    rankPreference: 'RELEVANCE'
  };

  const lat = Number(center?.lat);
  const lng = Number(center?.lng);
  if (center && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    request.locationBias = {
      center: { lat, lng },
      radius: 50000
    };
  } else {
    // This is used for broad/general searches and prevents an IP-biased search
    // from silently favouring one city when the user has not picked a location.
    request.locationRestriction = { ...INDIA_SEARCH_BOUNDS };
  }
  return request;
}

export function googleTouristQueries(category, area) {
  const place = withIndiaContext(area);
  const areaKey = String(area || '').toLowerCase();
  const isUdupiCoast = /\budupi\b|\bmalpe\b|\bkaup\b|\bkapu\b|\bpadubidri\b|\bmattu\b|\bhoode\b|\bkodi bengre\b|\bdelta beach\b/.test(areaKey);
  const variants = {
    temples: [
      `temples near ${place}`,
      `famous temples, mandirs and pilgrimage places in ${place}`,
      `sacred sites, shrines and religious attractions around ${place}`
    ],
    beaches: [
      `beaches near ${place}`,
      `famous beaches and coastal attractions around ${place}`,
      `sea shores, beach destinations and waterfront places in ${place}`
    ],
    waterfalls: [
      `waterfalls near ${place}`,
      `famous waterfalls and cascade viewpoints around ${place}`,
      `waterfall nature spots and scenic falls in ${place}`
    ],
    heritage: [
      `historic places, forts and monuments near ${place}`,
      `heritage sites, palaces and archaeological attractions around ${place}`,
      `museums, historic buildings and cultural landmarks in ${place}`
    ],
    wildlife: [
      `wildlife sanctuaries and national parks near ${place}`,
      `bird sanctuaries, nature reserves and tiger reserves around ${place}`,
      `wildlife parks and biodiversity attractions in ${place}`
    ],
    hills: [
      `hill stations and mountain viewpoints near ${place}`,
      `hiking trails, peaks and scenic viewpoints around ${place}`,
      `mountain destinations and nature trails in ${place}`
    ],
    lakes: [
      `lakes, rivers and reservoirs near ${place}`,
      `waterfront attractions and boating places around ${place}`,
      `famous lakes, dams and river viewpoints in ${place}`
    ]
  };
  if (category === 'beaches' && isUdupiCoast) {
    return [
      ...(variants.beaches || []),
      `Malpe Beach near ${place}`,
      `Kaup Beach and Kapu Lighthouse near ${place}`,
      `Padubidri Blue Flag Beach near ${place}`,
      `Mattu Beach and Hoode Beach near ${place}`,
      `Delta Beach Kodi Bengre near ${place}`
    ];
  }
  return variants[category] || [`${String(category || 'tourist')} attractions near ${place}`, `best places to visit around ${place}`];
}

export function googleAdventureQueries(area) {
  const place = withIndiaContext(area);
  return [
    `outdoor adventure activities and adventure parks near ${place}`,
    `trekking, hiking, camping and climbing destinations around ${place}`,
    `rafting, kayaking, surfing, paragliding and water sports near ${place}`
  ];
}

function readCoordinate(value, method) {
  if (value == null) return NaN;
  return Number(typeof value[method] === 'function' ? value[method]() : value[method] ?? value);
}

export function normalizeGooglePlace(place, { area = '', category = 'heritage', categoryLabel = 'Mapped place' } = {}) {
  if (!place) return null;
  const location = place.location;
  const latitude = readCoordinate(location, 'lat');
  const longitude = readCoordinate(location, 'lng');
  const displayName = typeof place.displayName === 'string'
    ? place.displayName
    : place.displayName?.text || place.name || '';
  const title = String(displayName || '').trim();
  if (!title || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const id = String(place.id || `${title}-${latitude}-${longitude}`);
  const address = String(place.formattedAddress || area || 'India');
  const placeType = String(place.primaryTypeDisplayName || place.primaryType || place.types?.[0] || categoryLabel);
  const query = encodeURIComponent(`${title}, ${address}`);
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${query}&query_place_id=${encodeURIComponent(id)}`;
  return {
    id: `google-${id}`,
    googlePlaceId: id,
    title,
    category,
    categoryLabel,
    location: address,
    latitude,
    longitude,
    description: placeType,
    placeType,
    distanceKm: null,
    image: `/assets/place-fallbacks/${category === 'adventure' ? 'hills' : category}.svg`,
    imageAlt: `${title} · ${categoryLabel} near ${area || 'India'}`,
    mapUrl: mapsUrl,
    source: 'google-places',
    live: true,
    activities: []
  };
}
