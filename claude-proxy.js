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
  const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY;
  const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY;

  if (!OPENAI_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'OPENAI_API_KEY not set' }) };

  let url = '', manual = false;
  try {
    const parsed = JSON.parse(event.body || '{}');
    url = String(parsed.url || '');
    manual = Boolean(parsed.manual);
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'url is required' }) };

  const clean = url.startsWith('http') ? url : 'https://' + url;
  const domain = clean.replace(/https?:\/\//, '').split('/')[0];

  // ── CURATED FALLBACK IMAGES ──────────────────────────────────
  const FALLBACK_IMAGES = {
    security:    'https://images.unsplash.com/photo-1563986768609-322da13575f3?w=800&q=80',
    ai:          'https://images.unsplash.com/photo-1555255707-c07966088b7b?w=800&q=80',
    marketing:   'https://images.unsplash.com/photo-1432888498266-38ffec3eaf0a?w=800&q=80',
    content:     'https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=800&q=80',
    growth:      'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=800&q=80',
    data:        'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&q=80',
    technology:  'https://images.unsplash.com/photo-1461749280684-dccba630e2f6?w=800&q=80',
    business:    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&q=80',
    health:      'https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=800&q=80',
    finance:     'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=800&q=80',
    gaming:      'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=800&q=80',
    cloud:       'https://images.unsplash.com/photo-1544197150-b99a580bb7a8?w=800&q=80',
    default:     'https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=800&q=80',
  };

  const getFallback = (category, title) => {
    const t = ((category||'') + ' ' + (title||'')).toLowerCase();
    if(t.includes('security')||t.includes('cyber')||t.includes('threat')) return FALLBACK_IMAGES.security;
    if(t.includes(' ai ')||t.includes('artificial')||t.includes('machine learning')||t.includes('agentic')) return FALLBACK_IMAGES.ai;
    if(t.includes('market')||t.includes('campaign')||t.includes('brand')) return FALLBACK_IMAGES.marketing;
    if(t.includes('content')||t.includes('writing')||t.includes('blog')) return FALLBACK_IMAGES.content;
    if(t.includes('growth')||t.includes('revenue')||t.includes('scale')) return FALLBACK_IMAGES.growth;
    if(t.includes('data')||t.includes('analytic')||t.includes('insight')) return FALLBACK_IMAGES.data;
    if(t.includes('cloud')||t.includes('platform')||t.includes('software')) return FALLBACK_IMAGES.technology;
    if(t.includes('health')||t.includes('medical')||t.includes('clinic')) return FALLBACK_IMAGES.health;
    if(t.includes('financ')||t.includes('invest')||t.includes('capital')) return FALLBACK_IMAGES.finance;
    if(t.includes('gaming')||t.includes('game')) return FALLBACK_IMAGES.gaming;
    if(t.includes('business')||t.includes('enterprise')||t.includes('team')) return FALLBACK_IMAGES.business;
    return FALLBACK_IMAGES.default;
  };

  const makePlaceholders = (companyName, count, type) => {
    const topics = type === 'news'
      ? ['Company announces new partnership','Product update brings new features','Industry recognition and awards','Expansion into new markets','Leadership team growth','Community and impact report']
      : ['Getting started with our platform','Best practices for modern teams','How to maximize your ROI','Customer success stories','The future of our industry','Expert tips and strategies'];
    return Array.from({length: count}, (_, i) => ({
      title: topics[i] || type + ' item ' + (i+1),
      summary: 'Stay tuned for the latest updates and insights from ' + companyName + '.',
      slug: (topics[i]||type+'-'+i).toLowerCase().replace(/[^a-z0-9]+/g,'-'),
      category: type === 'news' ? 'News' : 'Insights',
      readTime: type === 'news' ? '2 min read' : '5 min read',
      date: '2025-05-04',
      body: '<p>Content from ' + companyName + '. Check back soon for the full article.</p>',
    }));
  };

  // ── STEP 1: og scrape + Firecrawl map — in parallel ──────────
  let ogImage = '', ogTitle = '', ogDesc = '';
  let blogUrls = [];

  const ogPromise = fetch(clean, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(4000), redirect: 'follow',
  }).then(async r => {
    if (!r.ok) return;
    const h = await r.text();
    const mi = h.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
            || h.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    if (mi) ogImage = mi[1].trim().replace(/&amp;/g, '&');
    const mt = h.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
            || h.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (mt) ogTitle = mt[1].trim();
    else { const t = h.match(/<title[^>]*>([^<]+)<\/title>/i); if (t) ogTitle = t[1].trim(); }
    const md = h.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
            || h.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    if (md) ogDesc = md[1].trim();
  }).catch(() => {});

  // Firecrawl /map with search=blog to get article URLs from sitemap
  const mapPromise = FIRECRAWL_KEY ? fetch('https://api.firecrawl.dev/v1/map', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FIRECRAWL_KEY },
    body: JSON.stringify({ url: clean, search: 'blog OR news OR article OR insight', limit: 15 }),
    signal: AbortSignal.timeout(4000),
  }).then(r => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null);

  await ogPromise;
  const mapData = await mapPromise;

  // Extract blog/news URLs from map results
  if (mapData?.links) {
    blogUrls = mapData.links
      .filter(u => /\/(blog|news|article|insight|resource|press|story|update|post)\//i.test(u))
      .slice(0, 6);
    console.log('Blog URLs found via map:', blogUrls.length, blogUrls.slice(0,3));
  }

  // ── STEP 2: Scrape blog pages in parallel ────────────────────
  let scrapedArticles = [];
  let siteImages = [];

  if (FIRECRAWL_KEY && blogUrls.length > 0) {
    const scrapeResults = await Promise.all(
      blogUrls.slice(0, 4).map(blogUrl =>
        fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FIRECRAWL_KEY },
          body: JSON.stringify({ url: blogUrl, formats: ['extract'], extract: {
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                date: { type: 'string' },
                category: { type: 'string' },
                summary: { type: 'string' },
                heroImage: { type: 'string' },
              }
            }
          }}),
          signal: AbortSignal.timeout(3000),
        }).then(r => r.ok ? r.json() : null).catch(() => null)
      )
    );

    for (let i = 0; i < scrapeResults.length; i++) {
      const r = scrapeResults[i];
      if (!r) continue;
      const ex = r.data?.extract || {};
      const imgUrl = ex.heroImage || '';
      if (imgUrl && imgUrl.startsWith('http')) siteImages.push(imgUrl);
      if (ex.title) {
        scrapedArticles.push({
          title: ex.title,
          summary: ex.summary || '',
          slug: ex.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
          category: ex.category || 'Insights',
          readTime: '5 min read',
          date: ex.date || '2025-05-04',
          body: '<p>' + (ex.summary || ex.title) + '</p>',
          imageUrl: imgUrl,
          source: 'firecrawl',
        });
      }
    }
    console.log('Scraped articles:', scrapedArticles.length, '| Images:', siteImages.length);
  }

  // ── STEP 3: GPT for brand + fill remaining content ───────────
  const s = v => (v == null ? '' : String(v));

  const userPrompt = [
    'Build a content hub JSON for ' + s(clean) + ' (' + s(domain) + ').',
    '',
    'REAL CONTENT FOUND ON SITE:',
    scrapedArticles.length > 0
      ? 'Use these REAL articles found on their site as the first ' + scrapedArticles.length + ' articles:\n' +
        scrapedArticles.map((a,i) => (i+1)+'. "'+a.title+'" ('+a.category+', '+a.date+'): '+a.summary).join('\n')
      : 'No articles scraped — generate 6 articles specific to ' + domain + ' based on their real products/industry.',
    '',
    'HOMEPAGE META:',
    'og:title (USE EXACTLY as heroHeadline): ' + s(ogTitle),
    'og:description (USE EXACTLY as heroSubheading): ' + s(ogDesc),
    '',
    'Return ONLY valid JSON (no markdown):',
    '{"companyName":"","brandPrimary":"#hex real nav color","brandAccent":"#hex real CTA color","brandBg":"#f9f7f4","brandText":"#1a1a2e","brandHeaderText":"#hex","heroHeadline":"'+s(ogTitle).slice(0,80)+'","heroSubheading":"'+s(ogDesc).slice(0,200)+'","heroImageUrl":"'+s(ogImage)+'","articles":[{"title":"","summary":"2-3 sentences","slug":"","category":"","readTime":"5 min read","date":"2025-05-04","body":"<p>para</p><h2>heading</h2><p>para</p><p>para</p><blockquote><p>insight</p></blockquote><p>closing</p>"}],"news":[{"title":"","summary":"1-2 sentences","slug":"","category":"News","readTime":"2 min read","date":"2025-05-04","body":"<p>para</p><p>para</p>"}],"aboutText":"2-3 paragraphs","products":[{"name":"","description":"","cta":"Learn more"}]}',
    scrapedArticles.length > 0 ? 'IMPORTANT: Use the real article titles/categories from above as the first '+scrapedArticles.length+' entries in the articles array. Generate the remaining to total 6.' : '',
    'All slugs lowercase-hyphenated. Generate exactly 6 articles and 6 news items.',
  ].filter(Boolean).join('\n');

  try {
    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
      body: JSON.stringify({
        model: 'gpt-4o', max_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a content hub builder. Return valid JSON only, no markdown.' },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(7000),
    });

    if (!gptRes.ok) {
      const e = await gptRes.text();
      return { statusCode: gptRes.status, headers, body: JSON.stringify({ error: 'OpenAI ' + gptRes.status + ': ' + e }) };
    }

    const brand = JSON.parse((await gptRes.json()).choices[0].message.content);
    if (ogImage) brand.heroImageUrl = ogImage;

    const companyName = String(brand.companyName || domain);
    let articles = brand.articles || [];
    let news = brand.news || [];
    if (articles.length < 6) articles = [...articles, ...makePlaceholders(companyName, 6-articles.length, 'article')];
    if (news.length < 6) news = [...news, ...makePlaceholders(companyName, 6-news.length, 'news')];

    // Assign images: real scraped → site images → fallback
    const assignImage = (item, index) => {
      // Use scraped article's own image if it has one
      const scraped = scrapedArticles[index];
      if (scraped?.imageUrl) return { url: scraped.imageUrl, source: 'firecrawl' };
      // Use any site image from the pool
      if (siteImages[index % Math.max(siteImages.length, 1)] && siteImages.length > 0) {
        return { url: siteImages[index % siteImages.length], source: 'firecrawl' };
      }
      // Curated fallback
      return { url: getFallback(item.category, item.title), source: 'fallback' };
    };

    const buildItem = (a, i, type) => {
      const img = type === 'article' ? assignImage(a, i) : { url: getFallback(a.category, a.title), source: 'fallback' };
      return {
        id: type+'-'+i,
        title: String(a.title || type+' '+(i+1)),
        summary: String(a.summary || ''),
        imageUrl: img.url,
        imageSource: img.source,
        slug: String(a.slug || (a.title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || type+'-'+i),
        category: String(a.category || (type==='news'?'News':'Insights')),
        readTime: String(a.readTime || '5 min read'),
        date: String(a.date || '2025-05-04'),
        body: String(a.body || ''),
        source: 'scraped', isNew: false,
      };
    };

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        companyName,
        brandPrimary: String(brand.brandPrimary || '#0f172a'),
        brandAccent: String(brand.brandAccent || '#6366f1'),
        brandBg: '#f9f7f4', brandText: '#1a1a2e',
        brandHeaderText: String(brand.brandHeaderText || '#ffffff'),
        logoUrl: 'https://logo.clearbit.com/' + domain,
        heroHeadline: String(brand.heroHeadline || ogTitle || 'Insights & Resources'),
        heroSubheading: String(brand.heroSubheading || ogDesc || 'Stay ahead with the latest thinking.'),
        heroImageUrl: String(ogImage || ''),
        articles: articles.slice(0,6).map((a,i) => buildItem(a,i,'article')),
        news: news.slice(0,6).map((n,i) => buildItem(n,i,'news')),
        aboutText: String(brand.aboutText || ''),
        products: brand.products || [],
      }),
    };

  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message) }) };
  }
};
