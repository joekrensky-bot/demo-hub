exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY;
  const JASPER_KEY = process.env.JASPER_API_KEY;
  if (!OPENAI_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'OPENAI_API_KEY not set' }) };

  const T = Date.now();
  const logs = [];
  const log = (msg) => { const e = '[' + (Date.now()-T) + 'ms] ' + msg; console.log(e); logs.push(e); };

  let url = '', articleUrl = '', jasperUserId = 'hTcTOK3m6xUCKwznLDLXwem3Y9E2';
  try {
    const p = JSON.parse(event.body || '{}');
    url = String(p.url || '');
    articleUrl = String(p.articleUrl || '');
    jasperUserId = String(p.jasperUserId || jasperUserId);
  } catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad JSON' }) }; }

  if (!url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'url required' }) };

  const clean = url.startsWith('http') ? url : 'https://' + url;
  const domain = clean.replace(/https?:\/\//, '').split('/')[0];
  log('START url=' + domain + ' articleUrl=' + (articleUrl||'none'));

  // ── Fallback images ──
  const IMGS = [
    'https://images.unsplash.com/photo-1563986768609-322da13575f3?w=800&q=80',
    'https://images.unsplash.com/photo-1555255707-c07966088b7b?w=800&q=80',
    'https://images.unsplash.com/photo-1432888498266-38ffec3eaf0a?w=800&q=80',
    'https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=800&q=80',
    'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&q=80',
    'https://images.unsplash.com/photo-1461749280684-dccba630e2f6?w=800&q=80',
    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&q=80',
    'https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=800&q=80',
    'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=800&q=80',
    'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=800&q=80',
    'https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=800&q=80',
    'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=800&q=80',
  ];

  // ── Helper: scrape og tags from a URL ──
  const scrapeOg = async (u, timeout=3000) => {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
      if (!r.ok) return {};
      const h = await r.text();
      const g = (pats) => { for (const p of pats) { const m = h.match(p); if (m) return m[1].trim().replace(/&amp;/g,'&'); } return ''; };
      return {
        title: g([/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i, /<title[^>]*>([^<]+)<\/title>/i]),
        desc: g([/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i]),
        image: g([/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i, /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)/i]),
      };
    } catch(e) { return {}; }
  };

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: All parallel — og, site map, article scrape (max 4s)
  // ═══════════════════════════════════════════════════════════════
  log('phase1 start');

  // 1a. Homepage og tags
  const ogP = scrapeOg(clean, 3000);

  // 1b. Firecrawl /map — get all blog/news URLs from the site
  const mapP = FIRECRAWL_KEY ? fetch('https://api.firecrawl.dev/v1/map', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FIRECRAWL_KEY },
    body: JSON.stringify({ url: clean, limit: 50 }),
    signal: AbortSignal.timeout(4000),
  }).then(r => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null);

  // 1c. Article URL scrape (if provided)
  const articleScrapeP = (articleUrl && FIRECRAWL_KEY) ? fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FIRECRAWL_KEY },
    body: JSON.stringify({ url: articleUrl.startsWith('http') ? articleUrl : 'https://'+articleUrl, formats: ['markdown'] }),
    signal: AbortSignal.timeout(4000),
  }).then(r => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null);

  const [og, mapData, artScrape] = await Promise.all([ogP, mapP, articleScrapeP]);

  // Extract blog/news URLs from map
  let blogUrls = [];
  if (mapData && mapData.links) {
    blogUrls = mapData.links.filter(u =>
      /\/(blog|news|article|insight|resource|press|story|hello|post|update)\//i.test(u)
    );
    log('map found ' + mapData.links.length + ' total, ' + blogUrls.length + ' blog/news');
  } else {
    log('map returned nothing');
  }

  // Build real article list from URLs — extract titles from URL slugs
  const realArticles = blogUrls.slice(0, 8).map(u => {
    const slug = u.split('/').filter(Boolean).pop() || '';
    const title = slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return { title, summary: '', slug, url: u, date: '2025-05-05' };
  });

  log('phase1 done | ogTitle=' + (og.title||'none').slice(0,30) + ' ogImage=' + (og.image?'yes':'no') + ' realArticles=' + realArticles.length);

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: Scrape og tags from top 6 blog URLs for real titles+images (parallel, 3s)
  // ═══════════════════════════════════════════════════════════════
  log('phase2 start — scraping ' + Math.min(realArticles.length, 6) + ' article pages');
  const articleOgs = await Promise.all(
    realArticles.slice(0, 6).map(a => scrapeOg(a.url, 3000))
  );
  for (let i = 0; i < Math.min(articleOgs.length, realArticles.length); i++) {
    if (articleOgs[i].title) realArticles[i].title = articleOgs[i].title;
    if (articleOgs[i].desc) realArticles[i].summary = articleOgs[i].desc;
    if (articleOgs[i].image) realArticles[i].image = articleOgs[i].image;
  }
  const withImages = realArticles.filter(a => a.image).length;
  log('phase2 done | titles scraped, ' + withImages + ' have real images');

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3: Process featured article (from article URL)
  // ═══════════════════════════════════════════════════════════════
  let featuredArticle = null;
  if (articleUrl) {
    const articleClean = articleUrl.startsWith('http') ? articleUrl : 'https://'+articleUrl;
    let aTitle='', aDesc='', aImage='', aContent='';

    if (artScrape) {
      const meta = artScrape.data?.metadata || {};
      aTitle = String(meta.ogTitle||meta['og:title']||meta.title||'');
      aDesc = String(meta.ogDescription||meta['og:description']||meta.description||'');
      aImage = String(meta.ogImage||meta['og:image']||'').replace(/&amp;/g,'&');
      aContent = String(artScrape.data?.markdown||'').slice(0,6000);
    }
    if (!aTitle) {
      const aOg = await scrapeOg(articleClean, 2000);
      aTitle = aOg.title || ''; aDesc = aOg.desc || ''; aImage = aOg.image || '';
    }
    log('article: title="' + aTitle.slice(0,50) + '" image=' + (aImage?'yes':'no') + ' content=' + aContent.length + 'ch');

    // Jasper doc creation (fire and forget — don't block GPT)
    let jasperDocId = null, jasperDocUrl = null;
    const jasperP = (JASPER_KEY && (aContent||aDesc||aTitle)) ?
      fetch('https://api.jasper.ai/v1/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': JASPER_KEY.split(':')[0] },
        body: JSON.stringify({ userId: jasperUserId, name: aTitle||'Featured Article', content: aContent||aDesc||aTitle, status: 'DRAFT' }),
        signal: AbortSignal.timeout(8000),
      }).then(async r => {
        const t = await r.text(); log('Jasper: ' + r.status + ' ' + t.slice(0,80));
        if (r.ok) { const d = JSON.parse(t); return d.data?.id || d.id || null; }
        return null;
      }).catch(e => { log('Jasper err: '+e.message); return null; })
    : Promise.resolve(null);

    featuredArticle = {
      id: 'featured-0', title: aTitle||'Featured Article',
      summary: aDesc||'Featured article for Jasper optimization.',
      imageUrl: aImage || IMGS[0],
      imageSource: aImage ? 'firecrawl' : 'fallback',
      slug: (aTitle||'featured').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),
      category: 'Featured', readTime: '5 min read', date: new Date().toISOString().slice(0,10),
      body: aContent ? '<p>'+aContent.slice(0,4000).replace(/\n\n+/g,'</p><p>').replace(/\n/g,' ')+'</p>' : '<p>'+(aDesc||aTitle)+'</p>',
      source: 'jasper-doc', isNew: true, jasperDocId: null, jasperDocUrl: null, articleSourceUrl: articleClean,
      _jasperP: jasperP, // resolve after GPT
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 4: GPT — brand colors + expand article summaries
  // ═══════════════════════════════════════════════════════════════
  const realArtsText = realArticles.length > 0
    ? 'REAL CONTENT FROM ' + domain.toUpperCase() + ' (use these exact titles as articles):\n' +
      realArticles.slice(0,6).map((a,i) => (i+1)+'. "'+a.title+'"' + (a.summary ? ' — '+a.summary.slice(0,120) : '')).join('\n')
    : 'No real articles found. Generate 6 articles specific to ' + domain + ' and their products.';

  const prompt = 'Build content hub JSON for ' + domain + '.\n\n' + realArtsText + '\n\n' +
    'Homepage: title="' + (og.title||'') + '" desc="' + (og.desc||'') + '"\n\n' +
    'Return ONLY JSON:\n' +
    '{"companyName":"","brandPrimary":"#hex nav bg","brandAccent":"#hex CTA","brandBg":"#f9f7f4","brandText":"#1a1a2e","brandHeaderText":"#fff",' +
    '"heroHeadline":"use og:title exactly","heroSubheading":"use og:desc exactly",' +
    '"articles":[{"title":"REAL title","summary":"2 sentences","slug":"","category":"","readTime":"5 min read","date":"2025-05","body":"<p>para</p><h2>h</h2><p>para</p><blockquote><p>insight</p></blockquote><p>close</p>"}],' +
    '"news":[{"title":"","summary":"1 sentence","slug":"","category":"News","readTime":"2 min","date":"2025-05","body":"<p>para</p>"}],' +
    '"aboutText":"2 paragraphs","products":[{"name":"","description":"","cta":"Learn more"}]}' +
    '\n6 articles + 6 news. Real titles first, fill rest. Slugs lowercase-hyphenated.';

  try {
    log('GPT start');
    const gr = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
      body: JSON.stringify({
        model: 'gpt-4o-mini', max_tokens: 2000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Return valid JSON only.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!gr.ok) {
      const e = await gr.text();
      return { statusCode: gr.status, headers, body: JSON.stringify({ error: 'GPT ' + gr.status, detail: e, _debug: logs }) };
    }

    const brand = JSON.parse((await gr.json()).choices[0].message.content);
    log('GPT done brand=' + (brand.companyName||'?'));

    // Resolve Jasper doc if we started one
    if (featuredArticle && featuredArticle._jasperP) {
      const docId = await featuredArticle._jasperP;
      if (docId) {
        featuredArticle.jasperDocId = docId;
        featuredArticle.jasperDocUrl = 'https://app.jasper.ai/documents/' + docId;
        log('Jasper doc ready: ' + docId);
      }
      delete featuredArticle._jasperP;
    }

    // Merge
    const company = String(brand.companyName || domain);
    let articles = brand.articles || [];
    let news = brand.news || [];

    // Fill gaps
    const ph = (type, i) => ({ title: type==='news' ? 'Company Update '+(i+1) : 'Article '+(i+1),
      summary: 'Latest from '+company+'.', slug: type+'-'+i, category: type==='news'?'News':'Insights',
      readTime: type==='news'?'2 min':'5 min read', date: '2025-05-05', body: '<p>Coming soon.</p>' });
    while (articles.length < 6) articles.push(ph('article', articles.length));
    while (news.length < 6) news.push(ph('news', news.length));

    // Insert featured at position 0
    if (featuredArticle) articles = [featuredArticle, ...articles.slice(0,5)];

    // Assign images: real scraped image → fallback rotation
    const mapItem = (a, i, type) => ({
      id: type+'-'+i,
      title: String(a.title||type+' '+(i+1)),
      summary: String(a.summary||''),
      imageUrl: a.imageUrl || (realArticles[i] && realArticles[i].image) || IMGS[i % IMGS.length],
      imageSource: a.imageUrl ? (a.imageSource||'firecrawl') : (realArticles[i]?.image ? 'firecrawl' : 'fallback'),
      slug: String(a.slug||(a.title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||type+'-'+i),
      category: String(a.category||(type==='news'?'News':'Insights')),
      readTime: String(a.readTime||'5 min read'),
      date: String(a.date||'2025-05-05'),
      body: String(a.body||''),
      source: a.source||'scraped', isNew: a.isNew||false,
      jasperDocId: a.jasperDocId||null, jasperDocUrl: a.jasperDocUrl||null,
    });

    log('DONE total=' + (Date.now()-T) + 'ms');
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        _debug: logs, companyName: company,
        brandPrimary: String(brand.brandPrimary||'#0f172a'),
        brandAccent: String(brand.brandAccent||'#6366f1'),
        brandBg: '#f9f7f4', brandText: '#1a1a2e',
        brandHeaderText: String(brand.brandHeaderText||'#fff'),
        logoUrl: 'https://logo.clearbit.com/' + domain,
        heroHeadline: String(brand.heroHeadline || og.title || 'Insights & Resources'),
        heroSubheading: String(brand.heroSubheading || og.desc || ''),
        heroImageUrl: String(og.image || ''),
        articles: articles.slice(0,6).map((a,i) => mapItem(a,i,'article')),
        news: news.slice(0,6).map((a,i) => mapItem(a,i,'news')),
        aboutText: String(brand.aboutText||''),
        products: brand.products||[],
        featuredArticle: featuredArticle ? { jasperDocId: featuredArticle.jasperDocId, jasperDocUrl: featuredArticle.jasperDocUrl, title: featuredArticle.title } : null,
      }),
    };
  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message), _debug: logs }) };
  }
};
