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
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid body' }) }; }

  const clean = url.startsWith('http') ? url : 'https://' + url;
  const domain = clean.replace(/https?:\/\//, '').split('/')[0];

  // Helper: call Jasper /commands
  const jasper = async (command, context = '') => {
    const r = await fetch('https://api.jasper.ai/v1/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': JASPER_KEY },
      body: JSON.stringify({ command, context, inputLanguage: 'English', outputLanguage: 'English', outputCount: 1 }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) throw new Error(`Jasper ${r.status}: ${await r.text()}`);
    const d = await r.json();
    return (d.data?.[0]?.text || '').trim();
  };

  try {
    // ── STEP 1: Scrape og tags from homepage ──
    let ogImage = '', ogTitle = '', ogDesc = '';
    try {
      const p = await fetch(clean, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
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

    // ── STEP 2: Use Jasper to crawl the site's blog/news for real content ──
    const serpCommand = `Search the web and visit ${clean} and its blog or news section. Find the 6 most recent articles or blog posts published on this site. For each one return: title, publication date, URL, a 2-sentence summary of the actual content, and the category/topic tag used on the site. Format as a numbered list with these exact fields: TITLE: | DATE: | URL: | SUMMARY: | CATEGORY:`;
    const serpContext = `Website: ${clean}. Domain: ${domain}. Look for pages like ${clean}/blog, ${clean}/news, ${clean}/articles, ${clean}/insights, ${clean}/resources. Find real published content, not the homepage.`;

    // ── STEP 3: Use Jasper to crawl for news/press ──
    const newsCommand = `Search the web for the 6 most recent news articles, press releases, or announcements about ${domain} or ${ogTitle || domain}. Include both content published on their site and press coverage. For each: TITLE: | DATE: | SUMMARY: | CATEGORY:`;
    const newsContext = `Company website: ${clean}. Look for recent news, product launches, partnerships, or press coverage from the last 6 months.`;

    // ── STEP 4: Use Jasper to extract brand identity ──
    const brandCommand = `Visit ${clean} and identify: 1) The exact hex color of their navigation/header background, 2) The exact hex color of their primary CTA buttons, 3) Their main tagline or headline on the homepage, 4) Their value proposition subheadline, 5) A description of what this company does in 3 paragraphs, 6) Their main product or service names. Return as JSON with keys: brandPrimary, brandAccent, brandHeaderText, heroHeadline, heroSubheading, aboutText, products (array of {name, description}).`;
    const brandContext = `Website: ${clean}. Page title: "${ogTitle}". Description: "${ogDesc}".`;

    // Run all three Jasper calls in parallel
    const [serpResult, newsResult, brandResult] = await Promise.allSettled([
      jasper(serpCommand, serpContext),
      jasper(newsCommand, newsContext),
      jasper(brandCommand, brandContext),
    ]);

    const serpText = serpResult.status === 'fulfilled' ? serpResult.value : '';
    const newsText = newsResult.status === 'fulfilled' ? newsResult.value : '';
    const brandText = brandResult.status === 'fulfilled' ? brandResult.value : '';

    // ── STEP 5: Use GPT-4o to parse Jasper's results into structured JSON ──
    const parsePrompt = `You are parsing crawled web content into structured JSON for a content hub.

BRAND INFO FROM JASPER CRAWL:
${brandText || 'Not available - use your knowledge of ' + domain}

ARTICLES FOUND BY JASPER:
${serpText || 'Not available'}

NEWS FOUND BY JASPER:
${newsText || 'Not available'}

VERIFIED FROM HOMEPAGE:
- og:title: "${ogTitle}"
- og:description: "${ogDesc}"
- og:image: "${ogImage}"

Return ONLY valid JSON (no markdown):
{
  "companyName": "real company name",
  "brandPrimary": "#hex from brand crawl or your knowledge",
  "brandAccent": "#hex from brand crawl or your knowledge",
  "brandBg": "#f9f7f4",
  "brandText": "#1a1a2e",
  "brandHeaderText": "#hex - white if dark header",
  "heroHeadline": "real tagline from crawl or og:title, max 8 words",
  "heroSubheading": "real subheadline from crawl or og:description, 1 sentence",
  "heroImageUrl": "${ogImage}",
  "articles": [
    {
      "title": "real article title from crawl",
      "summary": "real 2-3 sentence summary from crawl",
      "slug": "lowercase-hyphenated",
      "category": "real category from site",
      "readTime": "5 min read",
      "date": "YYYY-MM-DD",
      "body": "<p>Expanded paragraph based on the real article topic.</p><h2>Key section</h2><p>Detail paragraph.</p><p>Another paragraph.</p><blockquote><p>Key insight.</p></blockquote><p>Closing paragraph.</p>"
    }
  ],
  "news": [
    {
      "title": "real news title",
      "summary": "real 1-2 sentence summary",
      "slug": "lowercase-hyphenated",
      "category": "News",
      "readTime": "2 min read",
      "date": "YYYY-MM-DD",
      "body": "<p>News paragraph.</p><p>Additional context.</p>"
    }
  ],
  "aboutText": "real company description from crawl",
  "products": [{"name": "real product", "description": "real description", "cta": "Learn more"}]
}

Use the crawled content wherever available. Fill gaps with accurate knowledge of this specific company. Generate exactly 6 articles and 6 news items. All slugs lowercase-hyphenated.`;

    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a content hub builder. Parse the provided crawled content into structured JSON. Return valid JSON only.' },
          { role: 'user', content: parsePrompt },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!gptRes.ok) {
      const e = await gptRes.text();
      return { statusCode: gptRes.status, headers, body: JSON.stringify({ error: `OpenAI ${gptRes.status}: ${e}` }) };
    }

    const gptData = await gptRes.json();
    const brand = JSON.parse(gptData.choices[0].message.content);

    // Always use the real scraped og:image
    if (ogImage) brand.heroImageUrl = ogImage;

    const mapItem = (a, i, type) => ({
      id: `${type}-${i}`,
      title: a.title || `${type} ${i + 1}`,
      summary: a.summary || '',
      imageUrl: `https://picsum.photos/seed/${type}-${i}/800/450`,
      slug: a.slug || (a.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `${type}-${i}`,
      category: a.category || (type === 'news' ? 'News' : 'Insights'),
      readTime: a.readTime || '5 min read',
      date: a.date || '2025-03-01',
      body: a.body || '',
      source: 'scraped',
      isNew: false,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        companyName: brand.companyName || domain,
        brandPrimary: brand.brandPrimary || '#0f172a',
        brandAccent: brand.brandAccent || '#6366f1',
        brandBg: brand.brandBg || '#f9f7f4',
        brandText: brand.brandText || '#1a1a2e',
        brandHeaderText: brand.brandHeaderText || '#ffffff',
        logoUrl: `https://logo.clearbit.com/${domain}`,
        heroHeadline: brand.heroHeadline || ogTitle || 'Insights & Resources',
        heroSubheading: brand.heroSubheading || ogDesc || 'Stay ahead with the latest thinking.',
        heroImageUrl: ogImage || '',
        articles: (brand.articles || []).slice(0, 6).map((a, i) => mapItem(a, i, 'article')),
        news: (brand.news || []).slice(0, 6).map((n, i) => mapItem(n, i, 'news')),
        aboutText: brand.aboutText || '',
        products: brand.products || [],
      }),
    };

  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
