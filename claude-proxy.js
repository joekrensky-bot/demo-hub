exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const JASPER_KEY = process.env.JASPER_API_KEY;
  const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY;

  if (!OPENAI_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'OPENAI_API_KEY not set' }) };

  let url = '';
  let manual = false;
  try {
    const parsed = JSON.parse(event.body || '{}');
    url = String(parsed.url || '');
    manual = Boolean(parsed.manual);
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // ════════════════════════════════════════════
  // PATH A: MANUAL — Jasper generates content
  // ════════════════════════════════════════════
  if (manual || !url) {
    const companyName = String(url || 'Content Hub');

    if (!JASPER_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'JASPER_API_KEY not set for manual path' }) };
    }

    const jasperCmd = async (command) => {
      try {
        const r = await fetch('https://api.jasper.ai/v1/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': JASPER_KEY },
          body: JSON.stringify({ inputs: { command } }),
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return '';
        const d = await r.json();
        return String(d.data?.[0]?.text || '').trim();
      } catch(e) { return ''; }
    };

    // Generate all content in parallel via Jasper
    const [articlesRaw, newsRaw] = await Promise.all([
      jasperCmd(
        'Generate 6 marketing blog articles for a content hub demo for ' + companyName + '. ' +
        'Write in a professional, helpful, modern marketing tone. ' +
        'Return as a JSON array (no markdown) with this structure for each: ' +
        '[{"title":"","summary":"2-3 sentence teaser","slug":"lowercase-hyphen","category":"one of: Marketing, AI, Strategy, Growth, Content, News","readTime":"5 min read","date":"2025-04-15","body":"<p>opening para</p><h2>section</h2><p>detail para</p><p>another para</p><blockquote><p>key insight</p></blockquote><p>closing</p>"}]'
      ),
      jasperCmd(
        'Generate 6 news items and announcements for a content hub demo for ' + companyName + '. ' +
        'Make them feel like real product updates, partnerships, awards, or industry news. ' +
        'Return as a JSON array (no markdown): ' +
        '[{"title":"","summary":"1-2 sentences","slug":"lowercase-hyphen","category":"News","readTime":"2 min read","date":"2025-04-20","body":"<p>news para</p><p>context para</p>"}]'
      ),
    ]);

    // Parse Jasper JSON arrays safely
    const parseArray = (raw) => {
      try {
        const m = raw.match(/\[[\s\S]*\]/);
        return m ? JSON.parse(m[0]) : [];
      } catch(e) { return []; }
    };

    const articles = parseArray(articlesRaw);
    const news = parseArray(newsRaw);

    const mapItem = (a, i, type) => ({
      id: type + '-' + i,
      title: String(a.title || type + ' ' + (i + 1)),
      summary: String(a.summary || ''),
      imageUrl: 'https://picsum.photos/seed/' + type + '-' + i + '/800/450',
      slug: String(a.slug || (a.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-') || type + '-' + i),
      category: String(a.category || (type === 'news' ? 'News' : 'Insights')),
      readTime: String(a.readTime || '5 min read'),
      date: String(a.date || '2025-03-01'),
      body: String(a.body || ''),
      source: 'jasper',
      isNew: false,
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        companyName: companyName,
        brandPrimary: '#0f172a', brandAccent: '#6366f1',
        brandBg: '#f9f7f4', brandText: '#1a1a2e', brandHeaderText: '#ffffff',
        logoUrl: '', heroHeadline: 'Insights & Resources',
        heroSubheading: 'Expert thinking to help your team move faster.',
        heroImageUrl: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1600&q=80',
        articles: articles.slice(0, 6).map((a, i) => mapItem(a, i, 'article')),
        news: news.slice(0, 6).map((n, i) => mapItem(n, i, 'news')),
        aboutText: 'A modern content hub powered by Jasper AI.',
        products: [],
      }),
    };
  }

  // ════════════════════════════════════════════
  // PATH B: URL — Firecrawl scrapes real content
  // ════════════════════════════════════════════
  const clean = url.startsWith('http') ? url : 'https://' + url;
  const domain = clean.replace(/https?:\/\//, '').split('/')[0];

  // ── Step 1: Firecrawl homepage ──
  let homeMarkdown = '';
  let ogImage = '';
  let ogTitle = '';
  let ogDesc = '';

  const fcFetch = (fcUrl) => FIRECRAWL_KEY
    ? fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FIRECRAWL_KEY },
        body: JSON.stringify({ url: fcUrl, formats: ['markdown'] }),
        signal: AbortSignal.timeout(5000),
      }).then(r => r.ok ? r.json() : null).catch(() => null)
    : Promise.resolve(null);

  // Run homepage + 3 most likely blog paths in parallel (fast)
  const blogPaths = ['/blog', '/news', '/newsroom'];
  const [homeData, ...blogResults] = await Promise.all([
    fcFetch(clean),
    ...blogPaths.map(p => fcFetch('https://' + domain + p)),
  ]);

  if (homeData) {
    const meta = homeData.data?.metadata || homeData.metadata || {};
    homeMarkdown = String(homeData.data?.markdown || homeData.data?.content || '').slice(0, 5000);
    ogImage = String(meta.ogImage || meta['og:image'] || '').replace(/&amp;/g, '&');
    ogTitle = String(meta.ogTitle || meta['og:title'] || meta.title || '');
    ogDesc = String(meta.ogDescription || meta['og:description'] || meta.description || '');
  }

  // Pick first blog result with real content
  let blogMarkdown = '';
  for (const bd of blogResults) {
    if (!bd) continue;
    const md = String(bd.data?.markdown || bd.data?.content || '').trim();
    if (md.length > 300) { blogMarkdown = md.slice(0, 4000); break; }
  }

  // Og tag fallback if Firecrawl wasn't available
  if (!ogTitle || !ogImage) {
    try {
      const p = await fetch(clean, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(6000), redirect: 'follow',
      });
      if (p.ok) {
        const h = await p.text();
        if (!ogImage) {
          const mi = h.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                  || h.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
          if (mi) ogImage = mi[1].trim().replace(/&amp;/g, '&');
        }
        if (!ogTitle) {
          const mt = h.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
          if (mt) ogTitle = mt[1].trim();
          else { const t = h.match(/<title[^>]*>([^<]+)<\/title>/i); if (t) ogTitle = t[1].trim(); }
        }
        if (!ogDesc) {
          const md = h.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
                  || h.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
          if (md) ogDesc = md[1].trim();
        }
      }
    } catch(e) {}
  }

  // ── Step 3: GPT structures into JSON using real scraped content ──
  // Use homepage markdown as tone reference for content generation
  const safeHome = String(homeMarkdown || '');
  const safeBlog = String(blogMarkdown || '');
  const safeDomain = String(domain || '');
  const toneRef = safeHome.length > 100
    ? 'Use the following homepage content as tone/voice reference — write articles that sound like this brand:\n\n' + safeHome.slice(0, 3000)
    : 'Use your knowledge of ' + safeDomain + ' to write in their brand voice.';

  const blogRef = safeBlog.length > 100
    ? 'Real blog/news content found on site (use these actual article titles and topics where possible):\n\n' + safeBlog.slice(0, 5000)
    : 'No blog page scraped — generate 6 plausible articles deeply specific to ' + safeDomain + ' products and industry.';

  const systemPrompt = 'You are a content hub builder. Return valid JSON only, no markdown, no code fences.';

  // Ensure every value is a plain string - no nulls/undefined can touch the prompt
  const s = (v) => (v == null ? '' : String(v));
  const userPrompt = [
    'Build a content hub JSON for ' + s(clean) + ' (' + s(domain) + ').',
    '',
    s(toneRef),
    '',
    s(blogRef),
    '',
    'HOMEPAGE META:',
    'og:title: ' + s(ogTitle),
    'og:description: ' + s(ogDesc),
    'og:image: ' + s(ogImage),
    '',
    'Return exactly this JSON shape with 6 articles and 6 news items (no markdown, no code fences):',
    '{',
    '  "companyName": "real company name",',
    '  "brandPrimary": "#hex real nav/header color",',
    '  "brandAccent": "#hex real CTA button color",',
    '  "brandBg": "#f9f7f4",',
    '  "brandText": "#1a1a2e",',
    '  "brandHeaderText": "#ffffff or dark hex",',
    '  "heroHeadline": "real headline from site max 8 words",',
    '  "heroSubheading": "real subheadline from site 1 sentence",',
    '  "heroImageUrl": "' + s(ogImage) + '",',
    '  "articles": [{"title":"","summary":"2-3 sentences","slug":"","category":"","readTime":"5 min read","date":"2025-04 or 2025-05 (recent dates only)","body":"<p>para</p><h2>heading</h2><p>para</p><p>para</p><blockquote><p>insight</p></blockquote><p>closing</p>"}],',
    '  "news": [{"title":"","summary":"1-2 sentences","slug":"","category":"News","readTime":"2 min read","date":"2025-04 or 2025-05 (recent dates only)","body":"<p>para</p><p>para</p>"}],',
    '  "aboutText": "2-3 paragraphs",',
    '  "products": [{"name":"","description":"","cta":"Learn more"}]',
    '}',
    'All slugs lowercase-hyphenated. All dates must be in 2025 (April or May preferred). Use real scraped content first, fill gaps with brand knowledge.',
  ].join('\n');

  try {
    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_KEY,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!gptRes.ok) {
      const errText = await gptRes.text();
      return { statusCode: gptRes.status, headers, body: JSON.stringify({ error: 'OpenAI ' + gptRes.status + ': ' + errText }) };
    }

    const brand = JSON.parse((await gptRes.json()).choices[0].message.content);
    if (ogImage) brand.heroImageUrl = ogImage;

    const mapItem = (a, i, type) => ({
      id: type + '-' + i,
      title: String(a.title || type + ' ' + (i + 1)),
      summary: String(a.summary || ''),
      imageUrl: 'https://picsum.photos/seed/' + type + '-' + i + '/800/450',
      slug: String(a.slug || (a.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || type + '-' + i),
      category: String(a.category || (type === 'news' ? 'News' : 'Insights')),
      readTime: String(a.readTime || '5 min read'),
      date: String(a.date || '2025-03-01'),
      body: String(a.body || ''),
      source: 'scraped',
      isNew: false,
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        companyName: String(brand.companyName || domain),
        brandPrimary: String(brand.brandPrimary || '#0f172a'),
        brandAccent: String(brand.brandAccent || '#6366f1'),
        brandBg: '#f9f7f4', brandText: '#1a1a2e',
        brandHeaderText: String(brand.brandHeaderText || '#ffffff'),
        logoUrl: 'https://logo.clearbit.com/' + domain,
        heroHeadline: String(brand.heroHeadline || ogTitle || 'Insights & Resources'),
        heroSubheading: String(brand.heroSubheading || ogDesc || 'Stay ahead with the latest thinking.'),
        heroImageUrl: String(ogImage || ''),
        articles: (brand.articles || []).slice(0, 6).map((a, i) => mapItem(a, i, 'article')),
        news: (brand.news || []).slice(0, 6).map((n, i) => mapItem(n, i, 'news')),
        aboutText: String(brand.aboutText || ''),
        products: brand.products || [],
      }),
    };

  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message) }) };
  }
};
