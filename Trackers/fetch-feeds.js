// fetch-feeds.js
// Runs in GitHub Actions. Fetches Federal Register API + JD Supra RSS,
// filters by contaminant keywords, deduplicates, sorts, writes feeds.json.

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');

// ── Output path ───────────────────────────────────────────────────────────────
const OUT_PATH = path.join(__dirname, 'emerging-contaminants-data.json');
const MAX_ITEMS = 20; // keep top 20; ticker shows 8 at a time

// ── Contaminant keyword filter (for JD Supra broad feeds) ────────────────────
const KEYWORDS = [
  'pfas', 'pfoa', 'pfos', 'perfluoro', 'forever chemical',
  'genx', 'pfbs',
  'microplastic', 'nanoplastic',
  '6ppd', '6ppd-q', '6ppd-quinone',
  'polychlorinated biphenyl', 'pcb',
  'dioxin', 'furan',
  'methylmercury', 'mercury',
  'arsenic',
  '1,4-dioxane',
  'chlorpyrifos',
  'atrazine',
  'glyphosate',
  'trichloroethylene', 'tce',
  'selenium',
  'emerging contaminant',
  'toxic substance', 'hazardous substance',
  'cercla', 'superfund',
  'tsca'
];

function matchesKeyword(text) {
  const lower = (text || '').toLowerCase();
  return KEYWORDS.some(k => lower.includes(k));
}

// ── Federal Register ──────────────────────────────────────────────────────────
const FR_TERMS = [
  { term: 'PFAS',                     tag: 'PFAS' },
  { term: 'PFOA PFOS',                tag: 'PFAS' },
  { term: 'perfluoro',                tag: 'PFAS' },
  { term: 'GenX PFBS',                tag: 'PFAS' },
  { term: 'microplastics',            tag: 'Microplastics' },
  { term: 'nanoplastics',             tag: 'Microplastics' },
  { term: '6PPD-quinone',             tag: '6PPD-Q' },
  { term: 'polychlorinated biphenyl', tag: 'PCB' },
  { term: 'dioxin furan',             tag: 'Dioxin/Furan' },
  { term: 'methylmercury',            tag: 'Mercury' },
  { term: 'arsenic',                  tag: 'Arsenic' },
  { term: '1,4-dioxane',              tag: '1,4-Dioxane' },
  { term: 'chlorpyrifos',             tag: 'Chlorpyrifos' },
  { term: 'atrazine',                 tag: 'Atrazine' },
  { term: 'glyphosate',               tag: 'Glyphosate' },
  { term: 'trichloroethylene',        tag: 'TCE' },
  { term: 'selenium',                 tag: 'Selenium' },
];

const FR_AGENCIES = [
  'environmental-protection-agency',
  'food-and-drug-administration',
  'geological-survey',
  'army-corps-of-engineers',
];

const FR_TYPES = ['RULE', 'PRORULE', 'NOTICE'];

function buildFRUrl(term) {
  const params = new URLSearchParams();
  params.append('conditions[term]', term);
  params.append('per_page', '4');
  params.append('order', 'newest');
  params.append('fields[]', 'title');
  params.append('fields[]', 'html_url');
  params.append('fields[]', 'publication_date');
  params.append('fields[]', 'type');
  params.append('fields[]', 'abstract');
  params.append('fields[]', 'agency_names');
  FR_AGENCIES.forEach(a => params.append('conditions[agencies][]', a));
  FR_TYPES.forEach(t => params.append('conditions[type][]', t));
  return `https://www.federalregister.gov/api/v1/documents.json?${params.toString()}`;
}

async function fetchFRTerm(termObj) {
  try {
    const res = await fetch(buildFRUrl(termObj.term), { timeout: 10000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.results || []).map(r => ({
      source: 'Federal Register',
      sourceType: 'regulatory',
      title: r.title,
      url: r.html_url,
      date: r.publication_date,
      type: r.type || 'Notice',
      agency: Array.isArray(r.agency_names) ? r.agency_names[0] || '' : '',
      tag: termObj.tag,
      abstract: (r.abstract || '').substring(0, 280),
    }));
  } catch (e) {
    console.warn(`FR fetch failed for "${termObj.term}":`, e.message);
    return [];
  }
}

// ── JD Supra RSS ──────────────────────────────────────────────────────────────
const JDS_FEEDS = [
  {
    url: 'https://www.jdsupra.com/resources/syndication/docsRSSfeed.aspx?ftype=EnvironmentalLaw&premium=1',
    label: 'JD Supra — Environmental Law',
  },
  {
    url: 'https://www.jdsupra.com/resources/syndication/docsRSSfeed.aspx?ftype=ToxicTorts&premium=1',
    label: 'JD Supra — Toxic Torts',
  },
  {
    url: 'https://www.jdsupra.com/resources/syndication/docsRSSfeed.aspx?ftype=PersonalInjuryProductsLiability&premium=1',
    label: 'JD Supra — Products Liability',
  },
];

async function fetchJDSupraFeed(feedDef) {
  try {
    const res = await fetch(feedDef.url, {
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FeedBot/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });
    const channel = parsed?.rss?.channel;
    if (!channel) return [];
    const rawItems = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];

    const out = [];
    for (const item of rawItems) {
      const title = item.title || '';
      const desc  = item.description || item.summary || '';
      if (!matchesKeyword(title) && !matchesKeyword(desc)) continue;

      const combined = (title + ' ' + desc).toLowerCase();
      let tag = 'Environmental';
      if (combined.includes('pfas') || combined.includes('pfoa') || combined.includes('pfos') || combined.includes('perfluoro')) tag = 'PFAS';
      else if (combined.includes('microplastic') || combined.includes('nanoplastic')) tag = 'Microplastics';
      else if (combined.includes('6ppd')) tag = '6PPD-Q';
      else if (combined.includes('pcb') || combined.includes('polychlorinated')) tag = 'PCB';
      else if (combined.includes('dioxin')) tag = 'Dioxin/Furan';
      else if (combined.includes('mercury')) tag = 'Mercury';
      else if (combined.includes('arsenic')) tag = 'Arsenic';
      else if (combined.includes('1,4-dioxane')) tag = '1,4-Dioxane';
      else if (combined.includes('chlorpyrifos')) tag = 'Chlorpyrifos';
      else if (combined.includes('atrazine')) tag = 'Atrazine';
      else if (combined.includes('glyphosate')) tag = 'Glyphosate';
      else if (combined.includes('trichloroethylene') || combined.includes(' tce')) tag = 'TCE';
      else if (combined.includes('selenium')) tag = 'Selenium';
      else if (combined.includes('cercla') || combined.includes('superfund')) tag = 'Superfund';

      const author = item['dc:creator'] || item.author || '';

      out.push({
        source: feedDef.label,
        sourceType: 'legal',
        title: title.trim(),
        url: (item.link || '').trim(),
        date: item.pubDate || item['dc:date'] || '',
        type: 'Analysis',
        agency: author.trim(),
        tag,
        abstract: desc.replace(/<[^>]+>/g, '').substring(0, 280).trim(),
      });

      if (out.length >= 15) break;
    }
    return out;
  } catch (e) {
    console.warn(`JD Supra fetch failed for "${feedDef.label}":`, e.message);
    return [];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching Federal Register...');
  const frResults = await Promise.all(FR_TERMS.map(fetchFRTerm));
  const frItems = frResults.flat();
  console.log(`  FR: ${frItems.length} raw items`);

  console.log('Fetching JD Supra feeds...');
  const jdsResults = await Promise.all(JDS_FEEDS.map(fetchJDSupraFeed));
  const jdsItems = jdsResults.flat();
  console.log(`  JD Supra: ${jdsItems.length} filtered items`);

  const all = [...frItems, ...jdsItems];
  const seen = new Set();
  const unique = all.filter(item => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });

  unique.sort((a, b) => {
    const da = new Date(a.date).getTime() || 0;
    const db = new Date(b.date).getTime() || 0;
    return db - da;
  });

  const final = unique.slice(0, MAX_ITEMS);

  const output = {
    generated: new Date().toISOString(),
    count: final.length,
    items: final,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nWrote ${final.length} items to ${OUT_PATH}`);
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
