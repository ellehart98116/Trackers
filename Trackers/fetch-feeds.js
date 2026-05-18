// fetch-feeds.js
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');

const OUT_PATH = path.resolve(__dirname, 'emerging-contaminants-data.json');
const MAX_ITEMS = 20;

const KEYWORDS = [
  'pfas', 'pfoa', 'pfos', 'perfluoro', 'forever chemical',
  'genx', 'pfbs', 'microplastic', 'nanoplastic',
  '6ppd', '6ppd-q', '6ppd-quinone',
  'polychlorinated biphenyl', 'pcb',
  'dioxin', 'furan', 'methylmercury', 'mercury',
  'arsenic', '1,4-dioxane', 'chlorpyrifos', 'atrazine',
  'glyphosate', 'trichloroethylene', 'tce', 'selenium',
  'emerging contaminant', 'toxic substance', 'hazardous substance',
  'cercla', 'superfund', 'tsca'
];

function matchesKeyword(text) {
  const lower = (text || '').toLowerCase();
  return KEYWORDS.some(k => lower.includes(k));
}

const JDS_FEEDS = [
  { url: 'https://www.jdsupra.com/resources/syndication/docsRSSfeed.aspx?ftype=EnvironmentalLaw&premium=1', label: 'JD Supra' },
  { url: 'https://www.jdsupra.com/resources/syndication/docsRSSfeed.aspx?ftype=ToxicTorts&premium=1', label: 'JD Supra' },
  { url: 'https://www.jdsupra.com/resources/syndication/docsRSSfeed.aspx?ftype=PersonalInjuryProductsLiability&premium=1', label: 'JD Supra' },
];

function extractText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val._) return val._;
  if (Array.isArray(val)) return extractText(val[0]);
  return String(val);
}

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
      const title = extractText(item.title);
      const desc  = extractText(item.description || item.summary || '');
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

      const author = extractText(item['dc:creator'] || item.author || '');

      out.push({
        source: feedDef.label,
        sourceType: 'legal',
        title: title.trim(),
        url: extractText(item.link || '').trim(),
        date: extractText(item.pubDate || item['dc:date'] || ''),
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

async function main() {
  console.log('Output path:', OUT_PATH);

  console.log('Fetching JD Supra feeds...');
  const jdsResults = await Promise.all(JDS_FEEDS.map(fetchJDSupraFeed));
  const jdsItems = jdsResults.flat();
  console.log(`  JD Supra: ${jdsItems.length} filtered items`);

  const seen = new Set();
  const unique = jdsItems.filter(item => {
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
  const output = { generated: new Date().toISOString(), count: final.length, items: final };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`Wrote ${final.length} items to ${OUT_PATH}`);
  console.log('Done.');
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
