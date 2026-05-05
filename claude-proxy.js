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

  // ── Jasper command helper with webSearch or webScraper ──
  const jasperSearch = async (command, searchQuery, context = '') => {
    const body = {
      inputs: {
        command,
        context: context || undefined,
        retrievalAddOn: 'webSearch',
      },
      options: {
        outputCount: 1,
        outputLanguage: 'English',
        inputLanguage: 'English',
        completionType: 'quality',
        webSearch: {
          searchQuery,
          maxResults: 8,
        },
      },
    };
    const r = await fetch('https://api.jasper.ai/v1/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': JASPER_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Jasper webSearch ${r.status}: ${text}`);
    const d = JSON.parse(text);
    return (d.data?.[0]?.text || '').trim();
  };

  const jasperScrape = async (command, urls, context = '') => {
    const body = {
      inputs: {
        command,
        context: context || undefined,
        retrievalAddOn: 'webScraper',
      },
      options: {
        outputCount: 1,
        outputLanguage: 'English',
        inputLanguage: 'English',
        completionType: 'quality',
        webScraper: { urls },
      },
    };
    const r = await fetch('https://api.jasper.ai/v1/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': JASPER_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Jasper webScraper ${r.status}: ${text}`);
    const d = JSON.parse(text);
    return (d.data?.[0]?.text || '').trim();
  };

  // ── 1. Scrape og tags from homepage ──
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

  // ── 2. Try scraping known blog/news pages directly ──
  const blogPaths = ['/blog', '/news', '/articles', '/insights', '/resources', '/press', '/en-us/news', '/en/blog', '/learn', '/stories', '/updates'];
  let scrapedBlogText = '';
  for (const path of blogPaths) {
    try {
      scrapedBlogText = await jasperScrape(
        `Find all article titles, dates, URLs, summaries, and categories on this page. List each article with TITLE: | DATE: | URL: | SUMMARY: | CATEGORY: format.`,
        [`https://${domain}${path}`],
        `This is the blog or news section of ${domain}. Extract all content listings.`
      );
      if (scrapedBlogText && scrapedBlogText.length > 200) break;
    } catch(e) { continue; }
  }

  // ── 3. Run parallel Jasper web searches ──
  const [articleSearch, newsSearch, brandSearch] = await Promise.allSettled([
    // Search for real articles if scraping failed
    scrapedBlogText.length > 200
      ? Promise.resolve(scrapedBlogText)
      : jasperSearch(
          `Find the 6 most recent blog posts or articles published on ${domain}. For each: TITLE: | DATE: | URL: | SUMMARY: | CATEGORY:`,
          `site:${domain} blog OR articles OR insights OR resources`,
          `Website: ${clean}. Find real published articles, not homepage content.`
        ),

    // Search for news & press
    jasperSearch(
      `Find the 6 most recent news items, press releases, or announcements about ${domain}. Include both site content and press coverage. For each: TITLE: | DATE: | SUMMARY: | CATEGORY:`,
      `${domain} news OR press release OR announcement 2025`,
      `Company: ${domain}. Find recent news from the last 6 months.`
    ),

    // Scrape brand identity from homepage
    jasperScrape(
      `Extract from this page: 1) The main headline/tagline text exactly as written, 2) The subheadline text exactly as written, 3) The header/nav background color (hex), 4) The primary CTA button color (hex), 5) What this company does in 3 paragraphs, 6) Product or service names. Format as: HEADLINE: | SUBHEADLINE: | NAV_COLOR: | CTA_COLOR: | ABOUT: | PRODUCTS:`,
      [clean],
      `This is the homepage of ${domain}. Extract brand identity elements.`
    ),
  ]);

  const articleText = articleSearch.status === 'fulfilled' ? articleSearch.value : '';
  const newsText = newsSearch.status === 'fulfilled' ? newsSearch.value : '';
  const brandText = brandSearch.status === 'fulfilled' ? brandSearch.value : '';

  // ── 4. GPT-4o structures everything into clean JSON ──
  const parsePrompt = `You are building a branded content hub. Parse the following crawled data into JSON.

BRAND DATA (from Jasper crawl of ${clean}):
${brandText || 'Not available'}

ARTICLES FOUND:
${articleText || 'Not available'}

NEWS FOUND:
${newsText || 'Not available'}

HOMEPAGE META:
- og:title: "${ogTitle}"
- og:description: "${ogDesc}"
- og:image: "${ogImage}"

Return ONLY valid JSON (no markdown, no code fences):
{
  "companyName": "real company name",
  "brandPrimary": "#hex - from NAV_COLOR in brand data, or best knowledge of ${domain}",
  "brandAccent": "#hex - from CTA_COLOR in brand data, or best knowledge",
  "brandBg": "#f9f7f4",
  "brandText": "#1a1a2e",
  "brandHeaderText": "#hex - white if dark nav, dark if light nav",
  "heroHeadline": "from HEADLINE in brand data or og:title, max 8 words",
  "heroSubheading": "from SUBHEADLINE in brand data or og:description, 1 sentence",
  "heroImageUrl": "${ogImage}",
  "articles": [
    {
      "title": "real article title from crawled data",
      "summary": "real 2-3 sentence summary",
      "slug": "lowercase-hyphenated",
      "category": "real category from site",
      "readTime": "5 min read",
      "date": "YYYY-MM-DD",
      "body": "<p>Expanded opening paragraph based on real article topic.</p><h2>Key section heading</h2><p>Detailed paragraph.</p><p>Another paragraph.</p><blockquote><p>Key insight or quote.</p></blockquote><p>Closing paragraph with takeaways.</p>"
    }
  ],
  "news": [
    {
      "title": "real news headline",
      "summary": "real 1-2 sentence summary",
      "slug": "lowercase-hyphenated",
      "category": "News",
      "readTime": "2 min read",
      "date": "YYYY-MM-DD",
      "body": "<p>News paragraph.</p><p>Context paragraph.</p>"
    }
  ],
  "aboutText": "from ABOUT in brand data, 2-3 paragraphs",
  "products": [{"name": "real product", "description": "real description", "cta": "Learn more"}]
}

Use crawled data wherever available. Fill gaps with accurate knowledge of ${domain}. Exactly 6 articles and 6 news items. All slugs lowercase-hyphenated.`;

  try {
    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a content hub builder. Parse crawled web data into clean JSON. Return valid JSON only.' },
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
        brandBg: '#f9f7f4',
        brandText: '#1a1a2e',
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
