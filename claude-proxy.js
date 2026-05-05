exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  const JASPER_KEY = process.env.JASPER_API_KEY;
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!JASPER_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'JASPER_API_KEY not set' }) };
  if (!OPENAI_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'OPENAI_API_KEY not set' }) };

  let url = '';
  try { url = JSON.parse(event.body).url || ''; }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }
  if (!url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'url is required' }) };

  const clean = url.startsWith('http') ? url : 'https://' + url;
  const domain = clean.replace(/https?:\/\//, '').split('/')[0];

  // Jasper /v1/command with webSearch — exact API shape from docs
  const jasperWebSearch = async (command, searchQuery) => {
    const body = {
      inputs: { command, retrievalAddOn: 'webSearch' },
      options: { webSearch: { searchQuery, maxResults: 8 } },
    };
    const r = await fetch('https://api.jasper.ai/v1/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': JASPER_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`Jasper webSearch ${r.status}: ${txt}`);
    return (JSON.parse(txt).data?.[0]?.text || '').trim();
  };

  // Jasper /v1/command with webScraper — URL embedded in command text per docs
  const jasperWebScrape = async (command) => {
    const body = {
      inputs: { command, retrievalAddOn: 'webScraper' },
    };
    const r = await fetch('https://api.jasper.ai/v1/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': JASPER_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`Jasper webScraper ${r.status}: ${txt}`);
    return (JSON.parse(txt).data?.[0]?.text || '').trim();
  };

  // ── 1. Scrape og tags directly ──
  let ogImage = '', ogTitle = '', ogDesc = '';
  try {
    const p = await fetch(clean, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(6000), redirect: 'follow',
    });
    if (p.ok) {
      const h = await p.text();
      const mi = h.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
              || h.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
              || h.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
      if (mi) ogImage = mi[1].trim().replace(/&amp;/g, '&');
      const mt = h.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
              || h.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
      if (mt) ogTitle = mt[1].trim();
      else { const t = h.match(/<title[^>]*>([^<]+)<\/title>/i); if (t) ogTitle = t[1].trim(); }
      const md = h.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
              || h.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
      if (md) ogDesc = md[1].trim();
    }
  } catch(e) {}

  // ── 2. Try scraping blog/news pages with webScraper ──
  const blogPaths = ['/blog', '/news', '/articles', '/insights', '/resources', '/press',
                     '/en-us/news', '/en/blog', '/learn', '/stories', '/updates', '/media'];
  let scrapedArticles = '';
  for (const path of blogPaths) {
    try {
      const pageUrl = `https://${domain}${path}`;
      const result = await jasperWebScrape(
        `Visit ${pageUrl} and list all article or post titles, dates, and summaries you find. For each item format as: TITLE: [title] | DATE: [date] | SUMMARY: [1-2 sentence summary] | CATEGORY: [category]`
      );
      if (result && result.length > 150) { scrapedArticles = result; break; }
    } catch(e) { continue; }
  }

  // ── 3. Parallel Jasper searches ──
  const [articleResult, newsResult, brandResult] = await Promise.allSettled([
    // Articles — use scrape result or fall back to webSearch
    scrapedArticles.length > 150
      ? Promise.resolve(scrapedArticles)
      : jasperWebSearch(
          `List the 6 most recent blog posts or articles from ${domain}. For each: TITLE: | DATE: | SUMMARY: (2 sentences) | CATEGORY:`,
          `site:${domain} (blog OR articles OR insights OR news OR resources)`
        ),

    // News & press
    jasperWebSearch(
      `List the 6 most recent news items, announcements, or press releases about ${domain} from 2024-2025. For each: TITLE: | DATE: | SUMMARY: (1-2 sentences) | CATEGORY: News`,
      `"${domain}" news OR "press release" OR announcement 2025`
    ),

    // Brand identity — scrape homepage
    jasperWebScrape(
      `Visit ${clean} and extract: 1) The exact main headline text on the page, 2) The exact subheadline or description text, 3) The company's main value proposition, 4) What products or services they offer, 5) A description of who this company is and what they do. Format: HEADLINE: | SUBHEADLINE: | PRODUCTS: | ABOUT:`
    ),
  ]);

  const articleText = articleResult.status === 'fulfilled' ? articleResult.value : '';
  const newsText = newsResult.status === 'fulfilled' ? newsResult.value : '';
  const brandText = brandResult.status === 'fulfilled' ? brandResult.value : '';

  // ── 4. GPT structures into JSON ──
  const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a content hub builder. Parse crawled web data into clean JSON. Return valid JSON only, no markdown.' },
        { role: 'user', content: `Build a content hub JSON for ${clean}.

BRAND DATA FROM CRAWL:
${brandText || 'Use your knowledge of ' + domain}

ARTICLES FROM CRAWL:
${articleText || 'Use your knowledge of ' + domain + ' content'}

NEWS FROM CRAWL:
${newsText || 'Use your knowledge of ' + domain + ' news'}

HOMEPAGE META:
og:title: "${ogTitle}"
og:description: "${ogDesc}"
og:image: "${ogImage}"

Return ONLY this JSON structure (no markdown):
{
  "companyName": "real name",
  "brandPrimary": "#hex real nav color",
  "brandAccent": "#hex real CTA color",
  "brandBg": "#f9f7f4",
  "brandText": "#1a1a2e",
  "brandHeaderText": "#ffffff or dark hex",
  "heroHeadline": "from HEADLINE field or og:title, max 8 words",
  "heroSubheading": "from SUBHEADLINE field or og:description",
  "heroImageUrl": "${ogImage}",
  "articles": [{"title":"","summary":"2-3 sentences","slug":"","category":"","readTime":"5 min read","date":"YYYY-MM-DD","body":"<p>paragraph</p><h2>heading</h2><p>paragraph</p><p>paragraph</p><blockquote><p>insight</p></blockquote><p>closing</p>"}],
  "news": [{"title":"","summary":"1-2 sentences","slug":"","category":"News","readTime":"2 min read","date":"YYYY-MM-DD","body":"<p>paragraph</p><p>paragraph</p>"}],
  "aboutText": "2-3 paragraphs from ABOUT field",
  "products": [{"name":"","description":"","cta":"Learn more"}]
}
Exactly 6 articles and 6 news items. Use crawled data first, fill gaps with accurate brand knowledge. Slugs lowercase-hyphenated.` },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!gptRes.ok) {
    const e = await gptRes.text();
    return { statusCode: gptRes.status, headers, body: JSON.stringify({ error: `OpenAI ${gptRes.status}: ${e}` }) };
  }

  const brand = JSON.parse((await gptRes.json()).choices[0].message.content);
  if (ogImage) brand.heroImageUrl = ogImage;

  const mapItem = (a, i, type) => ({
    id: `${type}-${i}`, title: a.title || `${type} ${i+1}`, summary: a.summary || '',
    imageUrl: `https://picsum.photos/seed/${type}-${i}/800/450`,
    slug: a.slug || (a.title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || `${type}-${i}`,
    category: a.category || (type==='news'?'News':'Insights'),
    readTime: a.readTime || '5 min read', date: a.date || '2025-03-01',
    body: a.body || '', source: 'scraped', isNew: false,
  });

  return {
    statusCode: 200, headers,
    body: JSON.stringify({
      companyName: brand.companyName || domain,
      brandPrimary: brand.brandPrimary || '#0f172a',
      brandAccent: brand.brandAccent || '#6366f1',
      brandBg: '#f9f7f4', brandText: '#1a1a2e',
      brandHeaderText: brand.brandHeaderText || '#ffffff',
      logoUrl: `https://logo.clearbit.com/${domain}`,
      heroHeadline: brand.heroHeadline || ogTitle || 'Insights & Resources',
      heroSubheading: brand.heroSubheading || ogDesc || 'Stay ahead with the latest thinking.',
      heroImageUrl: ogImage || '',
      articles: (brand.articles||[]).slice(0,6).map((a,i)=>mapItem(a,i,'article')),
      news: (brand.news||[]).slice(0,6).map((n,i)=>mapItem(n,i,'news')),
      aboutText: brand.aboutText || '',
      products: brand.products || [],
    }),
  };
};
