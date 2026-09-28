import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const meta = { name: 'trip-planner' };

const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
const WIKIPEDIA_PY = path.join(toolsDir, 'wikipedia-summary', 'wikipedia_summary.py');
const PLACES_PY = path.join(toolsDir, 'places-of-interest', 'places_of_interest.py');
const WEATHER_PY = path.join(toolsDir, 'weather', 'weather.py');
const FORECAST_PY = path.join(toolsDir, 'forecast', 'forecast.py');
const PUBLIC_HOLIDAYS_PY = path.join(toolsDir, 'public-holidays', 'public_holidays.py');
const TRAVEL_ADVISORY_PY = path.join(toolsDir, 'travel-advisory', 'travel_advisory.py');
const CURRENCY_PY = path.join(toolsDir, 'currency', 'currency.py');
const COUNTRY_INFO_PY = path.join(toolsDir, 'country-info', 'country_info.py');
const ROUTE_DISTANCE_PY = path.join(toolsDir, 'route-distance', 'route_distance.py');

const COUNTRY_LOOKUP = {
  japan: { iso2: 'JP', currency: 'JPY' },
  india: { iso2: 'IN', currency: 'INR' },
  'united states': { iso2: 'US', currency: 'USD' },
  usa: { iso2: 'US', currency: 'USD' },
  france: { iso2: 'FR', currency: 'EUR' },
  germany: { iso2: 'DE', currency: 'EUR' },
  'united kingdom': { iso2: 'GB', currency: 'GBP' },
  uk: { iso2: 'GB', currency: 'GBP' },
  canada: { iso2: 'CA', currency: 'CAD' },
  australia: { iso2: 'AU', currency: 'AUD' },
  china: { iso2: 'CN', currency: 'CNY' },
  italy: { iso2: 'IT', currency: 'EUR' },
  spain: { iso2: 'ES', currency: 'EUR' },
  brazil: { iso2: 'BR', currency: 'BRL' },
  mexico: { iso2: 'MX', currency: 'MXN' },
  'south korea': { iso2: 'KR', currency: 'KRW' },
  korea: { iso2: 'KR', currency: 'KRW' },
  thailand: { iso2: 'TH', currency: 'THB' },
  singapore: { iso2: 'SG', currency: 'SGD' },
  vietnam: { iso2: 'VN', currency: 'VND' },
  indonesia: { iso2: 'ID', currency: 'IDR' },
  malaysia: { iso2: 'MY', currency: 'MYR' },
  'sri lanka': { iso2: 'LK', currency: 'LKR' },
  nepal: { iso2: 'NP', currency: 'NPR' },
  maldives: { iso2: 'MV', currency: 'MVR' },
  turkey: { iso2: 'TR', currency: 'TRY' },
  'united arab emirates': { iso2: 'AE', currency: 'AED' },
  uae: { iso2: 'AE', currency: 'AED' },
  dubai: { iso2: 'AE', currency: 'AED' },
};

function shellEscape(value) {
  return String(value ?? '').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function resolveCountryMeta(country) {
  const trimmed = String(country ?? '').trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const iso2 = trimmed.toUpperCase();
    const byIso = Object.values(COUNTRY_LOOKUP).find((c) => c.iso2 === iso2);
    return { iso2, currency: byIso?.currency ?? 'USD' };
  }
  return COUNTRY_LOOKUP[trimmed.toLowerCase()] ?? { iso2: trimmed, currency: trimmed };
}

function safeJson(text) {
  let raw = typeof text === 'string' ? text : text?.content?.[0]?.text ?? text?.output ?? '';
  raw = String(raw).trim();
  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/;
  const m = raw.match(fenceRe);
  if (m) raw = m[1].trim();
  try { return JSON.parse(raw); }
  catch { return { ok: false, error: 'parse failed', raw }; }
}

export async function main(context) {
  const { phase, command, agent, log, args } = context;
  const destination = shellEscape(args.destination || 'London');
  const from = shellEscape(args.from || '');
  const country = args.country || args.destination || 'UK';
  const { iso2, currency } = resolveCountryMeta(country);
  const iso2Arg = shellEscape(iso2);
  const currencyArg = shellEscape(currency);
  const days = args.days ?? 7;
  const signal = args.signal;
  const reportPhase = args.reportPhase ?? (() => {});
  const cancelled = () => signal?.aborted === true;

  const data = {};

  phase('wikipedia');
  await reportPhase(`wikipedia-summary for ${destination}`);
  const wikiRaw = await command(`python3 "${WIKIPEDIA_PY}" "${destination}"`, { member_name: 'doer', failSoft: true });
  data.wikipedia = safeJson(wikiRaw);
  log(`wikipedia: ${JSON.stringify(data.wikipedia).slice(0, 200)}`);
  if (cancelled()) return { cancelled: true, ...data };

  phase('weather');
  await reportPhase(`weather for ${destination}`);
  const weatherRaw = await command(`python3 "${WEATHER_PY}" "${destination}"`, { member_name: 'doer', failSoft: true });
  data.weather = safeJson(weatherRaw);
  log(`weather: ${JSON.stringify(data.weather).slice(0, 200)}`);
  if (cancelled()) return { cancelled: true, ...data };

  phase('forecast');
  await reportPhase(`forecast for ${destination}`);
  const forecastRaw = await command(`python3 "${FORECAST_PY}" "${destination}" ${days}`, { member_name: 'doer', failSoft: true });
  data.forecast = safeJson(forecastRaw);
  log(`forecast: ${JSON.stringify(data.forecast).slice(0, 200)}`);
  if (cancelled()) return { cancelled: true, ...data };

  phase('places');
  await reportPhase(`places-of-interest for ${destination}`);
  const placesRaw = await command(`python3 "${PLACES_PY}" "${destination}" 10`, { member_name: 'doer', failSoft: true });
  data.places = safeJson(placesRaw);
  log(`places: ${JSON.stringify(data.places).slice(0, 200)}`);
  if (cancelled()) return { cancelled: true, ...data };

  phase('public-holidays');
  await reportPhase(`public-holidays for ${iso2Arg}`);
  const holidaysRaw = await command(`python3 "${PUBLIC_HOLIDAYS_PY}" "${iso2Arg}"`, { member_name: 'doer', failSoft: true });
  data.holidays = safeJson(holidaysRaw);
  log(`holidays: ${JSON.stringify(data.holidays).slice(0, 200)}`);
  if (cancelled()) return { cancelled: true, ...data };

  phase('travel-advisory');
  await reportPhase(`travel-advisory for ${iso2Arg}`);
  const advisoryRaw = await command(`python3 "${TRAVEL_ADVISORY_PY}" "${iso2Arg}"`, { member_name: 'doer', failSoft: true });
  data.advisory = safeJson(advisoryRaw);
  log(`advisory: ${JSON.stringify(data.advisory).slice(0, 200)}`);
  if (cancelled()) return { cancelled: true, ...data };

  phase('currency');
  await reportPhase(`currency INR to ${currencyArg}`);
  const currencyRaw = await command(`python3 "${CURRENCY_PY}" "INR" "${currencyArg}"`, { member_name: 'doer', failSoft: true });
  data.currency = safeJson(currencyRaw);
  log(`currency: ${JSON.stringify(data.currency)}`);
  if (cancelled()) return { cancelled: true, ...data };

  phase('country-info');
  await reportPhase(`country-info for ${country}`);
  const countryRaw = await command(`python3 "${COUNTRY_INFO_PY}" "${shellEscape(country)}"`, { member_name: 'doer', failSoft: true });
  data.countryInfo = safeJson(countryRaw);
  log(`country-info: ${JSON.stringify(data.countryInfo).slice(0, 200)}`);
  if (cancelled()) return { cancelled: true, ...data };

  if (from) {
    phase('route-distance');
    await reportPhase(`route-distance ${from} to ${destination}`);
    const routeRaw = await command(`python3 "${ROUTE_DISTANCE_PY}" "${from}" "${destination}"`, { member_name: 'doer', failSoft: true });
    data.route = safeJson(routeRaw);
    log(`route: ${JSON.stringify(data.route).slice(0, 200)}`);
    if (cancelled()) return { cancelled: true, ...data };
  }

  phase('compose');
  await reportPhase(`composing trip plan for ${destination}`);
  const memLines = (args.memories ?? []).map(m => `- [${m.kind}] ${m.text}`).join('\n');
  const prompt = [
    `You are a knowledgeable travel planning specialist. Given the tool data below, compose a complete trip plan for ${destination}${from ? ` from ${from}` : ''}.`,
    '',
    'Include:',
    '1. Trip overview (destination highlights, best time to visit)',
    '2. Day-by-day itinerary with morning/afternoon/evening activities, estimated costs in local currency with INR equivalent',
    '3. Budget summary table',
    '4. Practical tips (packing, visa, safety, connectivity, customs)',
    '5. Caveats (what is tool-verified vs estimated, any data gaps)',
    '',
    `Wikipedia: ${JSON.stringify(data.wikipedia)}`,
    `Weather: ${JSON.stringify(data.weather)}`,
    `Forecast: ${JSON.stringify(data.forecast)}`,
    `Places: ${JSON.stringify(data.places)}`,
    `Holidays: ${JSON.stringify(data.holidays)}`,
    `Advisory: ${JSON.stringify(data.advisory)}`,
    `Currency: ${JSON.stringify(data.currency)}`,
    `Country info: ${JSON.stringify(data.countryInfo)}`,
    data.route ? `Route: ${JSON.stringify(data.route)}` : '',
    memLines ? `\nRecalled memories (use these to inform your response):\n${memLines}` : '',
    '',
    'Reply with ONLY the trip plan, no preamble.',
  ].join('\n');
  const answer = await agent(prompt, { member_name: 'doer' });

  return { destination, from: from || null, country, iso2, currency, ...data, answer };
}
