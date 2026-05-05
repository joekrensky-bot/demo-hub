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

  // ── Core Jasper command helper ──
  // Per docs: inputs.command is required. context is optional string. retrievalAddOn optional.
  const jasperCmd = async ({ command, context, retrievalAddOn, searchQuery, scrapeUrls }) => {
    const inputs = { command };
    if (context && typeof context === 'string' && context.trim()) inputs.context = context.trim();
    if (retrievalAddOn) inputs.retrievalAddOn = retrievalAddOn;

    const options = {};
    if (searchQuery) options.webSearch = { searchQuery, maxResults: 8 };
    if (scrapeUrls && scrapeUrls.length) options.webScraper = { urls: scrapeUrls };

    const body = { inputs };
    if (Object.keys(options).length) body.options = options;

    const r = await fetch('https://api.jasper.ai/v1/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': JASPER_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`Jasper ${r.status}: ${txt}`);
    const d = JSON.parse(txt);
    return (d.data?.[0]?.text || '').trim();
  };

  // ── 1. Fetch og tags ──
  let ogImage = '', ogTitle = '', ogDesc = '', pageHtml = '';
  try {
    const p = await fetch(clean, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(6000), redirect: 'follow',
    });
    if (p.ok) {
      pageHtml = await p.text();
      const mi = pageHtml.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
              || pageHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
              || pageHtml.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
      if (mi) ogImage = mi[1].trim().replace(/&amp;/g, '&');
      const mt = pageHtml.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
              || pageHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
      if (mt) ogTitle = mt[1].trim();
      else { const t = pageHtml.match(/<title[^>]*>([^<]+)<\/title>/i); if (t) ogTitle = t[1].trim(); }
      const md = pageHtml.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
              || pageHtml.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
      if (md) ogDesc = md[1].trim();
    }
  } catch(e) {}

  // ── 2. Get existing Jasper tone IDs for this workspace ──
  let toneId = null;
  try {
    const tonesRes = await fetch('https://api.jasper.ai/v1/tones?limit=1', {
      headers: { 'x-api-key': JASPER_KEY },
      signal: AbortSignal.timeout(5000),
    });
    if (tonesRes.ok) {
      const tonesData = await tonesRes.json();
      toneId = tonesData.data?.[0]?.id || null;
    }
  } catch(e) {}

  // ── 3. Try blog/news pages with webScraper ──
  const blogPaths = ['/blog', '/news', '/articles', '/insights', '/resources',
                     '/press', '/en-us/news', '/en/blog', '/learn', '/stories',
                     '/updates', '/media', '/newsroom', '/content', '/thinking'];
  let scrapedContent = '';

  for (const path of blogPaths) {
    try {
      const result = await jasperCmd({
        command: `List every article, blog post, or news item you find on this page. For each one include: TITLE: [exact title] | DATE: [publication date] | SUMMARY: [2 sentence summary of the actual content] | CATEGORY: [topic category]. List at least 6 items if available.`,
        retrievalAddOn: 'webScraper',
        scrapeUrls: [`https://${domain}${path}`],
      });
      if (result && result.length > 200) {
        scrapedContent = result;
        break;
      }
    } catch(e) { continue; }
  }

  // ── 4. Parallel: article search + news search + brand scrape ──
  const [articleRes, newsRes, brandRes] = await Promise.allSettled([

    // Articles — use scraped content or fall back to webSearch
    scrapedContent.length > 200
      ? Promise.resolve(scrapedContent)
      : jasperCmd({
          command: `Find and list the 6 most recent blog posts or articles published on ${domain}. For each: TITLE: [title] | DATE: [date] | SUMMARY: [2 sentence summary] | CATEGORY: [category]`,
          retrievalAddOn: 'webSearch',
          searchQuery: `site:${domain} blog OR article OR insight OR resource`,
        }),

    // News
    jasperCmd({
      command: `Find the 6 most recent news items, press releases, product announcements, or media coverage about ${domain} from 2024-2025. For each: TITLE: [title] | DATE: [date] | SUMMARY: [1-2 sentences] | CATEGORY: News`,
      retrievalAddOn: 'webSearch',
      searchQuery: `"${domain}" OR "${ogTitle || domain}" news announcement 2025`,
    }),

    // Brand identity from homepage
    jasperCmd({
      command: `Visit ${clean} and extract these exact details: HEADLINE: [main hero headline text exactly as written] | SUBHEADLINE: [subheadline or description text exactly as written] | ABOUT: [2-3 paragraph description of what this company does] | PRODUCTS: [list of main product or service names] | NAV_COLOR: [best guess hex for header/nav background] | CTA_COLOR: [best guess hex for primary button color]`,
      retrievalAddOn: 'webScraper',
      scrapeUrls: [clean],
    }),

  ]);

  const articleText = articleRes.status === 'fulfilled' ? articleRes.value : '';
  const newsText = newsRes.status === 'fulfilled' ? newsRes.value : '';
  const brandText = brandRes.status === 'fulfilled' ? brandRes.value : '';

  // ── 5. Fallback: if Jasper failed entirely, use webSearch for content ──
  let fallbackArticles = '', fallbackBrand = '';
  if (!articleText && !brandText) {
    try {
      [fallbackArticles, fallbackBrand] = await Promise.all([
        jasperCmd({
          command: `Search for recent articles and content from ${domain}. List 6 articles with TITLE: | DATE: | SUMMARY: | CATEGORY: for each.`,
          retrievalAddOn: 'webSearch',
          searchQuery: `${domain} blog articles news 2024 2025`,
        }),
        jasperCmd({
          command: `What does ${domain} do? What are their main products, brand colors, and target audience? Describe their headline and value proposition.`,
          context: `Website: ${clean}. Page title: ${ogTitle}. Description: ${ogDesc}.`,
        }),
      ]);
    } catch(e) {}
  }

  // ── 6. Build single JSON via GPT-4o ──
  const finalArticles = articleText || fallbackArticles;
  const finalBrand = brandText || fallbackBrand;

  const gptPrompt = `Build a content hub JSON for ${clean} (${domain}).

BRAND DATA FROM JASPER CRAWL:
${finalBrand || `Use your knowledge of ${domain}. og:title="${ogTitle}" og:description="${ogDesc}"`}

ARTICLES FROM JASPER:
${finalArticles || `Generate 6 plausible articles deeply specific to ${domain}'s actual products and industry.`}

NEWS FROM JASPER:
${newsText || `Generate 6 plausible recent news items for ${domain}.`}

VERIFIED HOMEPAGE META:
- og:title: "${ogTitle}"
- og:description: "${ogDesc}"
- og:image: "${ogImage}"

Return ONLY valid JSON, no markdown, no code fences:
{
  "companyName": "real company name",
  "brandPrimary": "#hex from NAV_COLOR in brand data or your knowledge of ${domain}",
  "brandAccent": "#hex from CTA_COLOR in brand data or your knowledge",
  "brandBg": "#f9f7f4",
  "brandText": "#1a1a2e",
  "brandHeaderText": "#ffffff or dark if light header",
  "heroHeadline": "from HEADLINE field - exact text from site, max 8 words",
  "heroSubheading": "from SUBHEADLINE field - exact text from site",
  "heroImageUrl": "${ogImage}",
  "articles": [
    {
      "title": "real or highly plausible article title",
      "summary": "real 2-3 sentence summary",
      "slug": "lowercase-hyphenated",
      "category": "real category",
      "readTime": "5 min read",
      "date": "YYYY-MM-DD",
      "body": "<p>Opening paragraph specific to this company and topic.</p><h2>Key section heading</h2><p>Detailed paragraph with specifics.</p><p>Another paragraph.</p><blockquote><p>Key insight or stat.</p></blockquote><p>Closing with takeaways.</p>"
    }
  ],
  "news": [
    {
      "title": "real or plausible news headline",
      "summary": "1-2 sentence summary",
      "slug": "lowercase-hyphenated",
      "category": "News",
      "readTime": "2 min read",
      "date": "YYYY-MM-DD",
      "body": "<p>News paragraph.</p><p>Context paragraph.</p>"
    }
  ],
  "aboutText": "from ABOUT field, 2-3 accurate paragraphs",
  "products": [{"name": "real product name", "description": "real description", "cta": "Learn more"}]
}
Exactly 6 articles, exactly 6 news items. Use crawled data wherever present. Fill gaps with deep brand knowledge of ${domain}. Slugs lowercase-hyphenated.`;

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
          { role: 'user', content: gptPrompt },
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
      readTime: a.readTime||'5 min read', date: a.date||'2025-03-01',
      body: a.body||'', source:'scraped', isNew:false,
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
  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
