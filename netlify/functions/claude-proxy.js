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
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'url required' }) };

  const clean = url.startsWith('http') ? url : 'https://' + url;
  const domain = clean.replace(/https?:\/\//, '').split('/')[0];
  log('START url=' + domain + ' articleUrl=' + (articleUrl || 'none'));

  const FALLBACKS = {
    security: 'https://images.unsplash.com/photo-1563986768609-322da13575f3?w=800&q=80',
    ai: 'https://images.unsplash.com/photo-1555255707-c07966088b7b?w=800&q=80',
    marketing: 'https://images.unsplash.com/photo-1432888498266-38ffec3eaf0a?w=800&q=80',
    content: 'https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=800&q=80',
    data: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&q=80',
    technology: 'https://images.unsplash.com/photo-1461749280684-dccba630e2f6?w=800&q=80',
    business: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&q=80',
    default: 'https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=800&q=80',
  };
  const fallback = (cat, title) => {
    const t = ((cat||'')+(title||'')).toLowerCase();
    if (t.includes('security')||t.includes('cyber')) return FALLBACKS.security;
    if (t.includes('ai ')||t.includes('artificial')||t.includes('machine')) return FALLBACKS.ai;
    if (t.includes('market')||t.includes('brand')) return FALLBACKS.marketing;
    if (t.includes('content')||t.includes('writ')) return FALLBACKS.content;
    if (t.includes('data')||t.includes('analyt')) return FALLBACKS.data;
    if (t.includes('tech')||t.includes('software')||t.includes('cloud')) return FALLBACKS.technology;
    if (t.includes('business')||t.includes('enterprise')) return FALLBACKS.business;
    return FALLBACKS.default;
  };

  // ── All parallel: og + 2 SERP + article scrape ──
  const ogP = fetch(clean, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(2500), redirect: 'follow',
  }).then(async r => {
    if (!r.ok) return {};
    const h = await r.text();
    const get = (patterns) => { for (const p of patterns) { const m = h.match(p); if (m) return m[1].trim().replace(/&amp;/g,'&'); } return ''; };
    return {
      ogImage: get([/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i, /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)/i]),
      ogTitle: get([/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i, /<title[^>]*>([^<]+)<\/title>/i]),
      ogDesc: get([/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i]),
    };
  }).catch(() => ({}));

  const serpP = (q) => !FIRECRAWL_KEY ? Promise.resolve([]) :
    fetch('https://api.firecrawl.dev/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FIRECRAWL_KEY },
      body: JSON.stringify({ query: q, limit: 6 }),
      signal: AbortSignal.timeout(2500),
    }).then(r => r.ok ? r.json() : { data: [] })
    .then(d => (d.data||[]).map(i => ({
      title: String(i.title||'').replace(/\s*[-|].*$/, '').trim(),
      summary: String(i.description || ''),
      date: String(i.publishedDate || '2025-05-05'),
      url: String(i.url || ''),
    })).filter(i => i.title.length > 5))
    .catch(() => []);

  const articleP = (articleUrl && FIRECRAWL_KEY) ?
    fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FIRECRAWL_KEY },
      body: JSON.stringify({ url: articleUrl.startsWith('http') ? articleUrl : 'https://' + articleUrl, formats: ['markdown'] }),
      signal: AbortSignal.timeout(2500),
    }).then(r => r.ok ? r.json() : null).catch(() => null)
    : Promise.resolve(null);

  log('parallel start');
  const [og, arts, news, artData] = await Promise.all([
    ogP,
    serpP(domain + ' blog articles 2025'),
    serpP(domain + ' news 2025'),
    articleP,
  ]);
  log('parallel done | arts=' + arts.length + ' news=' + news.length + ' ogImage=' + (og.ogImage?'yes':'no'));

  // ── Process article ──
  let featuredArticle = null;
  if (articleUrl) {
    const articleClean = articleUrl.startsWith('http') ? articleUrl : 'https://' + articleUrl;
    let aTitle = '', aDesc = '', aImage = '', aContent = '';
    if (artData) {
      const meta = artData.data?.metadata || {};
      aTitle = String(meta.ogTitle || meta['og:title'] || meta.title || '');
      aDesc = String(meta.ogDescription || meta['og:description'] || meta.description || '');
      aImage = String(meta.ogImage || meta['og:image'] || '').replace(/&amp;/g,'&');
      aContent = String(artData.data?.markdown || '').slice(0, 6000);
    }
    // og fallback
    if (!aTitle) {
      try {
        const r = await fetch(articleClean, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(1500), redirect: 'follow' });
        if (r.ok) {
          const h = await r.text();
          const mt = h.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || h.match(/<title[^>]*>([^<]+)<\/title>/i);
          if (mt) aTitle = mt[1].trim();
          const mi = h.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i);
          if (mi) aImage = mi[1].trim().replace(/&amp;/g,'&');
          const md = h.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i);
          if (md) aDesc = md[1].trim();
        }
      } catch(e) {}
    }
    log('article: title=' + aTitle.slice(0,40) + ' image=' + (aImage?'yes':'no'));

    // Create Jasper doc
    let jasperDocId = null, jasperDocUrl = null;
    if (JASPER_KEY && (aContent || aDesc || aTitle)) {
      try {
        const jr = await fetch('https://api.jasper.ai/v1/documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': JASPER_KEY.split(':')[0] },
          body: JSON.stringify({ userId: jasperUserId, name: aTitle || 'Featured Article', content: aContent || aDesc || aTitle, status: 'DRAFT' }),
          signal: AbortSignal.timeout(5000),
        });
        const jt = await jr.text();
        log('Jasper: ' + jr.status + ' ' + jt.slice(0,80));
        if (jr.ok) {
          const jd = JSON.parse(jt);
          jasperDocId = jd.data?.id || jd.id || null;
          if (jasperDocId) jasperDocUrl = 'https://app.jasper.ai/documents/' + jasperDocId;
        }
      } catch(e) { log('Jasper err: ' + e.message); }
    }

    featuredArticle = {
      id: 'featured-0', title: aTitle || 'Featured Article',
      summary: aDesc || 'Featured article for Jasper optimization.',
      imageUrl: aImage || fallback('technology', aTitle),
      imageSource: aImage ? 'firecrawl' : 'fallback',
      slug: (aTitle||'featured').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),
      category: 'Featured', readTime: '5 min read',
      date: new Date().toISOString().slice(0,10),
      body: aContent ? '<p>' + aContent.slice(0,4000).replace(/\n\n+/g,'</p><p>') + '</p>' : '<p>' + (aDesc||aTitle) + '</p>',
      source: 'jasper-doc', isNew: true, jasperDocId, jasperDocUrl, articleSourceUrl: articleClean,
    };
    log('featuredArticle ready docId=' + jasperDocId);
  }

  // ── GPT ──
  const serpText = arts.length ? 'REAL ARTICLES FROM ' + domain.toUpperCase() + ':\n' + arts.map((a,i)=>(i+1)+'. "'+a.title+'" — '+a.summary.slice(0,100)+' ('+a.date+')').join('\n') : '';
  const newsText = news.length ? 'REAL NEWS FROM ' + domain.toUpperCase() + ':\n' + news.map((a,i)=>(i+1)+'. "'+a.title+'" — '+a.summary.slice(0,100)+' ('+a.date+')').join('\n') : '';

  const prompt = 'Build content hub JSON for ' + domain + '.\n' +
    (serpText||'Generate 6 articles specific to '+domain+' products/industry.') + '\n\n' +
    (newsText||'Generate 6 news items for '+domain+'.') + '\n\n' +
    'og:title="' + (og.ogTitle||'') + '" og:desc="' + (og.ogDesc||'') + '"\n\n' +
    'Return ONLY valid JSON:\n' +
    '{"companyName":"","brandPrimary":"#hex","brandAccent":"#hex","brandBg":"#f9f7f4","brandText":"#1a1a2e","brandHeaderText":"#hex",' +
    '"heroHeadline":"' + (og.ogTitle||'').slice(0,60) + '","heroSubheading":"' + (og.ogDesc||'').slice(0,150) + '",' +
    '"heroImageUrl":"' + (og.ogImage||'') + '",' +
    '"articles":[{"title":"use REAL title above","summary":"2 sentences","slug":"","category":"","readTime":"5 min read","date":"2025-05-05","body":"<p>para</p><h2>h</h2><p>para</p><blockquote><p>insight</p></blockquote><p>closing</p>"}],' +
    '"news":[{"title":"use REAL title above","summary":"1-2 sentences","slug":"","category":"News","readTime":"2 min read","date":"2025-05-05","body":"<p>para</p>"}],' +
    '"aboutText":"2 paragraphs","products":[{"name":"","description":"","cta":"Learn more"}]}' +
    '\nExactly 6 articles + 6 news. Use real titles first. Slugs lowercase-hyphenated.';

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
      signal: AbortSignal.timeout(9000),
    });

    if (!gr.ok) {
      const e = await gr.text();
      return { statusCode: gr.status, headers, body: JSON.stringify({ error: 'GPT ' + gr.status + ': ' + e, _debug: logs }) };
    }

    const brand = JSON.parse((await gr.json()).choices[0].message.content);
    log('GPT done brand=' + (brand.companyName||'?'));
    if (og.ogImage) brand.heroImageUrl = og.ogImage;

    const company = String(brand.companyName || domain);
    let articles = (brand.articles || []);
    let newsList = (brand.news || []);

    const placeholder = (type, i) => ({
      title: type==='news' ? ['New partnership','Product update','Award received','Expansion news','Leadership update','Community report'][i]||'News '+(i+1)
                           : ['Getting started','Best practices','ROI guide','Customer story','Industry trends','Expert tips'][i]||'Article '+(i+1),
      summary: 'Latest from ' + company + '.', slug: type+'-'+i,
      category: type==='news'?'News':'Insights', readTime: type==='news'?'2 min read':'5 min read',
      date: '2025-05-05', body: '<p>Coming soon.</p>',
    });

    while (articles.length < 6) articles.push(placeholder('article', articles.length));
    while (newsList.length < 6) newsList.push(placeholder('news', newsList.length));

    if (featuredArticle) articles = [featuredArticle, ...articles.slice(0,5)];

    const pool = Object.values(FALLBACKS);
    const mapItem = (a, i, type) => ({
      id: type+'-'+i, title: String(a.title||type+' '+(i+1)), summary: String(a.summary||''),
      imageUrl: a.imageUrl || pool[i % pool.length],
      imageSource: a.imageSource || 'fallback',
      slug: String(a.slug||(a.title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||type+'-'+i),
      category: String(a.category||(type==='news'?'News':'Insights')),
      readTime: String(a.readTime||'5 min read'), date: String(a.date||'2025-05-05'),
      body: String(a.body||''), source: a.source||'scraped', isNew: a.isNew||false,
      jasperDocId: a.jasperDocId||null, jasperDocUrl: a.jasperDocUrl||null,
    });

    log('DONE');
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        _debug: logs, companyName: company,
        brandPrimary: String(brand.brandPrimary||'#0f172a'),
        brandAccent: String(brand.brandAccent||'#6366f1'),
        brandBg: '#f9f7f4', brandText: '#1a1a2e',
        brandHeaderText: String(brand.brandHeaderText||'#ffffff'),
        logoUrl: 'https://logo.clearbit.com/' + domain,
        heroHeadline: String(brand.heroHeadline || og.ogTitle || 'Insights & Resources'),
        heroSubheading: String(brand.heroSubheading || og.ogDesc || ''),
        heroImageUrl: String(og.ogImage || ''),
        articles: articles.slice(0,6).map((a,i) => mapItem(a,i,'article')),
        news: newsList.slice(0,6).map((a,i) => mapItem(a,i,'news')),
        aboutText: String(brand.aboutText||''),
        products: brand.products||[],
        featuredArticle: featuredArticle ? { jasperDocId: featuredArticle.jasperDocId, jasperDocUrl: featuredArticle.jasperDocUrl, title: featuredArticle.title } : null,
      }),
    };
  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message), _debug: logs }) };
  }
};
