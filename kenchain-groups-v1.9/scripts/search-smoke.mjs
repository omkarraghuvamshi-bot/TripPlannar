const base = (process.env.APP_URL || `http://127.0.0.1:${process.env.PORT || 4000}`).replace(/\/$/, '');
const checks = [];

async function get(path) {
  const response = await fetch(`${base}/api${path}`, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${data.error || 'request failed'}`);
  return data;
}

function check(name, condition) {
  checks.push({ name, pass: Boolean(condition) });
}

try {
  const health = await get('/health');
  check('API is reachable', health.status === 'ok');

  const results = await get('/search?q=Coorg');
  check('All-services search returns Coorg experiences', (results.experiences || []).some(item => /coorg|madikeri/i.test(`${item.title} ${item.location}`)));
  check('All-services response includes all result groups', Array.isArray(results.experiences) && Array.isArray(results.restaurants) && Array.isArray(results.places));

  const suggestions = await get('/search/suggest?q=coorg');
  check('Unified typeahead returns a list', Array.isArray(suggestions.items));

  const stays = await get('/catalog?category=stay&q=Coorg');
  check('Hospitality search filters stays by area', (stays.items || []).every(item => item.category === 'stay' && /coorg|madikeri/i.test(`${item.title} ${item.location} ${item.description}`)));

  const vehicles = await get('/vehicles?q=KG-BUS');
  check('Vehicle search returns the matching demo bus', (vehicles.items || []).some(item => item.vehicleId === 'KG-BUS-DEMO'));
} catch (error) {
  console.error(`Search smoke test could not complete: ${error.message}`);
  process.exit(1);
}

for (const result of checks) console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.name}`);
if (checks.some(result => !result.pass)) process.exit(1);
console.log(`\n${checks.length} search checks passed.`);
