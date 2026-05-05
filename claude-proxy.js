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

  // ── IMAGE HELPERS ──────────────────────────────────────────────

  // Scenario 1: Unsplash search — sorted by relevance, pick by index for variety
  const unsplashImage = async (query, seed) => {
    if (!UNSPLASH_KEY) return null;
    try {
      // Search returns top results sorted by relevance — much better than random
      const r = await fetch(
        'https://api.unsplash.com/search/photos?query=' + encodeURIComponent(query) +
        '&orientation=landscape&content_filter=high&per_page=10&client_id=' + UNSPLASH_KEY,
        { signal: AbortSignal.timeout(3000) }
      );
      if (r.ok) {
        const d = await r.json();
        const results = d?.results || [];
        if (results.length === 0) return null;
        // Pick deterministically by seed so same article = same image
        const pick = results[seed % results.length];
        return pick?.urls?.regular || null;
      }
    } catch(e) {}
    return null;
  };

  // Scenario 2: Extract images from Firecrawl markdown (real site images)
  const extractImagesFromMarkdown = (markdown) => {
    if (!markdown) return [];
    const imgRegex = /!\[.*?\]\((https?:\/\/[^)]+\.(?:jpg|jpeg|png|webp)[^)]*)\)/gi;
    const srcRegex = /src=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)/gi;
    const imgs = [];
    let m;
    while ((m = imgRegex.exec(markdown)) !== null) {
      if (!m[1].includes('logo') && !m[1].includes('icon') && !m[1].includes('avatar')) {
        imgs.push(m[1]);
      }
    }
    while ((m = srcRegex.exec(markdown)) !== null) {
      if (!m[1].includes('logo') && !m[1].includes('icon') && !m[1].includes('avatar')) {
        imgs.push(m[1]);
      }
    }
    return [...new Set(imgs)].slice(0, 12);
  };

  // Scenario 3: Curated Unsplash fallbacks by topic (no key needed, direct URLs)
  // Curated high-quality fallbacks — verified to be professional and relevant
  const FALLBACK_IMAGES = {
    technology:  'https://images.unsplash.com/photo-1461749280684-dccba630e2f6?w=800&q=80',  // code on monitor
    business:    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&q=80',  // business meeting
    marketing:   'https://images.unsplash.com/photo-1432888498266-38ffec3eaf0a?w=800&q=80',  // marketing strategy
    ai:          'https://images.unsplash.com/photo-1555255707-c07966088b7b?w=800&q=80',  // AI/tech abstract
    health:      'https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=800&q=80',  // medical professional
    finance:     'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=800&q=80',  // finance charts
    gaming:      'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=800&q=80',  // gaming setup
    ecommerce:   'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=800&q=80',  // shopping/retail
    security:    'https://images.unsplash.com/photo-1563986768609-322da13575f3?w=800&q=80',  // security/lock
    cloud:       'https://images.unsplash.com/photo-1544197150-b99a580bb7a8?w=800&q=80',  // cloud servers
    data:        'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&q=80',  // data dashboard
    strategy:    'https://images.unsplash.com/photo-1512758017271-d7b84c2113f1?w=800&q=80',  // strategy whiteboard
    content:     'https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=800&q=80',  // content/laptop writing
    growth:      'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=800&q=80',  // growth charts
    default:     'https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=800&q=80',  // modern office
  };

  const getFallbackByCategory = (category, title) => {
    const text = ((category || '') + ' ' + (title || '')).toLowerCase();
    if(text.includes('security') || text.includes('cyber') || text.includes('threat')) return FALLBACK_IMAGES.security;
    if(text.includes('ai') || text.includes('artificial') || text.includes('machine learning')) return FALLBACK_IMAGES.ai;
    if(text.includes('market') || text.includes('campaign') || text.includes('brand')) return FALLBACK_IMAGES.marketing;
    if(text.includes('content') || text.includes('writing') || text.includes('blog')) return FALLBACK_IMAGES.content;
    if(text.includes('growth') || text.includes('revenue') || text.includes('scale')) return FALLBACK_IMAGES.growth;
    if(text.includes('data') || text.includes('analytic') || text.includes('insight')) return FALLBACK_IMAGES.data;
    if(text.includes('cloud') || text.includes('server') || text.includes('infra')) return FALLBACK_IMAGES.cloud;
    if(text.includes('health') || text.includes('medical') || text.includes('clinic')) return FALLBACK_IMAGES.health;
    if(text.includes('financ') || text.includes('invest') || text.includes('capital')) return FALLBACK_IMAGES.finance;
    if(text.includes('gaming') || text.includes('game')) return FALLBACK_IMAGES.gaming;
    if(text.includes('ecomm') || text.includes('retail') || text.includes('shop')) return FALLBACK_IMAGES.ecommerce;
    if(text.includes('strateg') || text.includes('plan') || text.includes('roadmap')) return FALLBACK_IMAGES.strategy;
    if(text.includes('tech') || text.includes('platform') || text.includes('software')) return FALLBACK_IMAGES.technology;
    if(text.includes('business') || text.includes('enterprise') || text.includes('team')) return FALLBACK_IMAGES.business;
    return FALLBACK_IMAGES.default;
  };

  // Pick best image for an article: site image → unsplash API → curated fallback
  const getArticleImage = async (siteImages, index, category, companyName) => {
    // Scenario 1: real image from the site
    if (siteImages[index]) return siteImages[index];
    // Scenario 2: Unsplash API with category + company context
    if (UNSPLASH_KEY) {
      const query = (category || companyName || 'business technology').slice(0, 50);
      const img = await unsplashImage(query, index);
      if (img) return img;
    }
    // Scenario 3: curated fallback by category
    return getFallbackByCategory(category);
  };

  // ── DEFAULT ARTICLE PLACEHOLDERS ──────────────────────────────
  const makePlaceholderArticles = (companyName, count, type) => {
    const topics = type === 'news'
      ? ['Company announces new partnership', 'Product update brings new features', 'Industry recognition and awards', 'Expansion into new markets', 'Leadership team growth', 'Community and impact report']
      : ['Getting started with our platform', 'Best practices for modern teams', 'How to maximize your ROI', 'Customer success stories', 'The future of our industry', 'Expert tips and strategies'];
    return Array.from({length: count}, (_, i) => ({
      title: topics[i] || (type + ' item ' + (i+1)),
      summary: 'Stay tuned for the latest updates and insights from ' + companyName + '.',
      slug: topics[i] ? topics[i].toLowerCase().replace(/[^a-z0-9]+/g,'-') : type + '-' + i,
      category: type === 'news' ? 'News' : 'Insights',
      readTime: type === 'news' ? '2 min read' : '5 min read',
      date: '2025-05-0' + (i+1),
      body: '<p>This is a placeholder article for ' + companyName + '. Replace with real content after generation.</p>',
    }));
  };

  // ══════════════════════════════════════════════════════════════
  // PATH A: MANUAL — Jasper generates content
  // ══════════════════════════════════════════════════════════════
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
          signal: AbortSignal.timeout(25000),
        });
        if (!r.ok) return '';
        const d = await r.json();
        return String(d.data?.[0]?.text || '').trim();
      } catch(e) { return ''; }
    };

    const parseArray = (raw) => {
      try { const m = raw.match(/\[[\s\S]*\]/); return m ? JSON.parse(m[0]) : []; }
      catch(e) { return []; }
    };

    const [articlesRaw, newsRaw] = await Promise.all([
      jasperCmd('Generate 6 marketing blog articles for a content hub demo for ' + companyName + '. Return as JSON array only, no markdown: [{"title":"","summary":"2-3 sentence teaser","slug":"lowercase-hyphen","category":"one of: Marketing, AI, Strategy, Growth, Content, Technology","readTime":"5 min read","date":"2025-05-04","body":"<p>opening para</p><h2>section</h2><p>detail para</p><p>another para</p><blockquote><p>key insight</p></blockquote><p>closing</p>"}]'),
      jasperCmd('Generate 6 news items for a content hub demo for ' + companyName + '. Return as JSON array only, no markdown: [{"title":"","summary":"1-2 sentences","slug":"lowercase-hyphen","category":"News","readTime":"2 min read","date":"2025-05-04","body":"<p>news para</p><p>context para</p>"}]'),
    ]);

    let articles = parseArray(articlesRaw);
    let news = parseArray(newsRaw);

    // Fallback: fill any missing items with placeholders
    if (articles.length < 6) {
      articles = [...articles, ...makePlaceholderArticles(companyName, 6 - articles.length, 'article')];
    }
    if (news.length < 6) {
      news = [...news, ...makePlaceholderArticles(companyName, 6 - news.length, 'news')];
    }

    // Assign images
    const mapManual = async (a, i, type) => {
      const img = await getArticleImage([], i, a.category, companyName, a.title);
      return {
        id: type + '-' + i,
        title: String(a.title || type + ' ' + (i+1)),
        summary: String(a.summary || ''),
        imageUrl: String(img||'').split('|')[0],
        imageSource: String(img||'').includes('|source:') ? String(img).split('|source:')[1].split('|')[0] : 'fallback',
        imageQuery: String(img||'').includes('|query:') ? String(img).split('|query:')[1] : '',
        slug: String(a.slug || (a.title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-') || type+'-'+i),
        category: String(a.category || (type==='news'?'News':'Insights')),
        readTime: String(a.readTime || '5 min read'),
        date: String(a.date || '2025-05-04'),
        body: String(a.body || ''),
        source: 'jasper', isNew: false,
      };
    };

    // Synchronous image assignment
    const allManual = [
      ...articles.slice(0,6).map((a,i) => ({...a,_idx:i,_type:'article'})),
      ...news.slice(0,6).map((n,i) => ({...n,_idx:i,_type:'news'})),
    ];
    const manualImgs = allManual.map(item => getArticleImage([], item._idx, item.category, companyName, item.title));
    const mapManualSync = (a, i, type, img) => ({
      id: type+'-'+i,
      title: String(a.title || type+' '+(i+1)),
      summary: String(a.summary || ''),
      imageUrl: String(img||'').split('|')[0],
      imageSource: String(img||'').includes('|source:') ? String(img).split('|source:')[1].split('|')[0] : 'fallback',
      imageQuery: String(img||'').includes('|query:') ? String(img).split('|query:')[1] : '',
      slug: String(a.slug || (a.title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-') || type+'-'+i),
      category: String(a.category || (type==='news'?'News':'Insights')),
      readTime: String(a.readTime || '5 min read'),
      date: String(a.date || '2025-05-04'),
      body: String(a.body || ''),
      source: 'jasper', isNew: false,
    });
    const mappedArticles = articles.slice(0,6).map((a,i) => mapManualSync(a,i,'article',manualImgs[i]));
    const mappedNews = news.slice(0,6).map((n,i) => mapManualSync(n,i,'news',manualImgs[6+i]));

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        companyName, brandPrimary: '#0f172a', brandAccent: '#6366f1',
        brandBg: '#f9f7f4', brandText: '#1a1a2e', brandHeaderText: '#ffffff',
        logoUrl: '', heroHeadline: 'Insights & Resources',
        heroSubheading: 'Expert thinking to help your team move faster.',
        heroImageUrl: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1600&q=80',
        articles: mappedArticles, news: mappedNews,
        aboutText: 'A modern content hub powered by Jasper AI.',
        products: [],
      }),
    };
  }

  // ══════════════════════════════════════════════════════════════
  // PATH B: URL — Firecrawl + GPT
  // ══════════════════════════════════════════════════════════════
  const clean = url.startsWith('http') ? url : 'https://' + url;
  const domain = clean.replace(/https?:\/\//, '').split('/')[0];

  // ── og scrape ──
  let ogImage = '', ogTitle = '', ogDesc = '', homeMarkdown = '';
  try {
    const p = await fetch(clean, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(4000), redirect: 'follow',
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

  // ── Firecrawl: run concurrently with og scrape, 3s max ──
  let siteImages = [];
  const firecrawlPromise = FIRECRAWL_KEY ? fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FIRECRAWL_KEY },
    body: JSON.stringify({ url: clean, formats: ['markdown'] }),
    signal: AbortSignal.timeout(3000),
  }).then(r => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null);

  // ── Await Firecrawl result ──
  const fcData = await firecrawlPromise;
  if (fcData) {
    const meta = fcData.data?.metadata || fcData.metadata || {};
    homeMarkdown = String(fcData.data?.markdown || fcData.data?.content || '').slice(0, 4000);
    if (!ogImage) ogImage = String(meta.ogImage || meta['og:image'] || '').replace(/&amp;/g, '&');
    if (!ogTitle) ogTitle = String(meta.ogTitle || meta['og:title'] || meta.title || '');
    if (!ogDesc) ogDesc = String(meta.ogDescription || meta['og:description'] || meta.description || '');
    // Extract images from markdown AND from Firecrawl's screenshot/images array
    siteImages = extractImagesFromMarkdown(homeMarkdown);
    // Also check Firecrawl's dedicated images array if present
    const fcImages = fcData.data?.images || fcData.images || [];
    const extraImgs = fcImages
      .filter(u => u && typeof u === 'string' && u.startsWith('http') && !u.includes('logo') && !u.includes('icon') && !u.includes('favicon'))
      .slice(0, 10);
    siteImages = [...new Set([...siteImages, ...extraImgs])];
    console.log('Firecrawl images found:', siteImages.length, siteImages.slice(0,3));
  }

  // ── GPT structures content ──
  const s = (v) => (v == null ? '' : String(v));
  const toneRef = homeMarkdown.length > 100
    ? 'Use this homepage content as tone/voice reference:\n\n' + homeMarkdown.slice(0, 3000)
    : 'Use your knowledge of ' + domain + ' to write in their brand voice.';

  const userPrompt = [
    'Build a content hub JSON for ' + s(clean) + ' (' + s(domain) + ').',
    '',
    s(toneRef),
    '',
    'HOMEPAGE META:',
    'og:title (USE THIS EXACTLY as heroHeadline, do not rephrase): ' + s(ogTitle),
    'og:description (USE THIS EXACTLY as heroSubheading, do not rephrase): ' + s(ogDesc),
    'og:image: ' + s(ogImage),
    '',
    'Return exactly this JSON (6 articles, 6 news, no markdown):',
    '{"companyName":"","brandPrimary":"#hex real nav color","brandAccent":"#hex real CTA color","brandBg":"#f9f7f4","brandText":"#1a1a2e","brandHeaderText":"#hex","heroHeadline":"real headline max 8 words","heroSubheading":"real subheadline 1 sentence","heroImageUrl":"' + s(ogImage) + '","articles":[{"title":"","summary":"2-3 sentences","slug":"","category":"","readTime":"5 min read","date":"2025-05-04","body":"<p>para</p><h2>heading</h2><p>para</p><p>para</p><blockquote><p>insight</p></blockquote><p>closing</p>"}],"news":[{"title":"","summary":"1-2 sentences","slug":"","category":"News","readTime":"2 min read","date":"2025-05-04","body":"<p>para</p><p>para</p>"}],"aboutText":"2-3 paragraphs","products":[{"name":"","description":"","cta":"Learn more"}]}',
    'All dates 2025-04 or 2025-05. Slugs lowercase-hyphenated. Use real content from tone reference. Fill gaps with brand knowledge.',
  ].join('\n');

  try {
    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
      body: JSON.stringify({
        model: 'gpt-4o', max_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a content hub builder. Return valid JSON only.' },
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

    // Fallback: fill missing articles/news with placeholders
    const companyName = String(brand.companyName || domain);
    let articles = brand.articles || [];
    let news = brand.news || [];
    if (articles.length < 6) articles = [...articles, ...makePlaceholderArticles(companyName, 6-articles.length, 'article')];
    if (news.length < 6) news = [...news, ...makePlaceholderArticles(companyName, 6-news.length, 'news')];

    // Synchronous image assignment — no API calls, instant
    const allItems = [
      ...articles.slice(0,6).map((a,i) => ({a,i,type:'article'})),
      ...news.slice(0,6).map((n,i) => ({a:n,i,type:'news'})),
    ];
    const imageResults = allItems.map(({a,i}) => getArticleImage(siteImages, i, a.category, companyName, a.title));
    console.log('Firecrawl images:', siteImages.length, '| Sources:', imageResults.map(r => String(r).split('|source:')[1]?.split('|')[0]));

    const buildItem = (a, i, type, img) => ({
      id: type+'-'+i,
      title: String(a.title || type+' '+(i+1)),
      summary: String(a.summary || ''),
      imageUrl: String(img||'').split('|')[0],
      imageSource: String(img||'').includes('|source:') ? String(img).split('|source:')[1].split('|')[0] : 'fallback',
      imageQuery: String(img||'').includes('|query:') ? String(img).split('|query:')[1] : '',
      slug: String(a.slug || (a.title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || type+'-'+i),
      category: String(a.category || (type==='news'?'News':'Insights')),
      readTime: String(a.readTime || '5 min read'),
      date: String(a.date || '2025-05-04'),
      body: String(a.body || ''),
      source: 'scraped', isNew: false,
    });

    const mappedArticles = articles.slice(0,6).map((a,i) => buildItem(a,i,'article',imageResults[i]));
    const mappedNews = news.slice(0,6).map((n,i) => buildItem(n,i,'news',imageResults[6+i]));

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
        articles: mappedArticles,
        news: mappedNews,
        aboutText: String(brand.aboutText || ''),
        products: brand.products || [],
      }),
    };
  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message) }) };
  }
};
