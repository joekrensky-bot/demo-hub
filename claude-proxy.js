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

  // Scenario 1: Unsplash API (best quality, needs key)
  const unsplashImage = async (query, seed) => {
    if (!UNSPLASH_KEY) return null;
    try {
      const r = await fetch(
        'https://api.unsplash.com/photos/random?query=' + encodeURIComponent(query) + '&orientation=landscape&client_id=' + UNSPLASH_KEY,
        { signal: AbortSignal.timeout(3000) }
      );
      if (r.ok) {
        const d = await r.json();
        return d?.urls?.regular || null;
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
  const FALLBACK_IMAGES = {
    technology:  'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&q=80',
    business:    'https://images.unsplash.com/photo-1553877522-43269d4ea984?w=800&q=80',
    marketing:   'https://images.unsplash.com/photo-1533750349088-cd871a92f312?w=800&q=80',
    ai:          'https://images.unsplash.com/photo-1677442135703-1787eea5ce01?w=800&q=80',
    health:      'https://images.unsplash.com/photo-1559757148-5c350d0d3c56?w=800&q=80',
    finance:     'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800&q=80',
    gaming:      'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=800&q=80',
    ecommerce:   'https://images.unsplash.com/photo-1472851294608-062f824d29cc?w=800&q=80',
    security:    'https://images.unsplash.com/photo-1614064641938-3bbee52942c7?w=800&q=80',
    cloud:       'https://images.unsplash.com/photo-1544197150-b99a580bb7a8?w=800&q=80',
    data:        'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&q=80',
    default:     'https://images.unsplash.com/photo-1497366216548-37526070297c?w=800&q=80',
  };

  const getFallbackByCategory = (category) => {
    const cat = (category || '').toLowerCase();
    for (const [key, url] of Object.entries(FALLBACK_IMAGES)) {
      if (cat.includes(key)) return url;
    }
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

    const mappedArticles = await Promise.all(articles.slice(0,6).map((a,i) => mapManual(a,i,'article')));
    const mappedNews = await Promise.all(news.slice(0,6).map((n,i) => mapManual(n,i,'news')));

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

  // ── Firecrawl homepage ──
  let siteImages = [];
  if (FIRECRAWL_KEY) {
    try {
      const fcRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FIRECRAWL_KEY },
        body: JSON.stringify({ url: clean, formats: ['markdown'] }),
        signal: AbortSignal.timeout(4000),
      });
      if (fcRes.ok) {
        const fcData = await fcRes.json();
        const meta = fcData.data?.metadata || fcData.metadata || {};
        homeMarkdown = String(fcData.data?.markdown || fcData.data?.content || '').slice(0, 5000);
        if (!ogImage) ogImage = String(meta.ogImage || meta['og:image'] || '').replace(/&amp;/g, '&');
        if (!ogTitle) ogTitle = String(meta.ogTitle || meta['og:title'] || meta.title || '');
        if (!ogDesc) ogDesc = String(meta.ogDescription || meta['og:description'] || meta.description || '');
        // Extract real images from the scraped page
        siteImages = extractImagesFromMarkdown(homeMarkdown);
      }
    } catch(e) {}
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
    'og:title: ' + s(ogTitle),
    'og:description: ' + s(ogDesc),
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
      signal: AbortSignal.timeout(8000),
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

    // Map items with smart image selection
    const mapItem = async (a, i, type) => {
      const img = await getArticleImage(siteImages, i, a.category, companyName, a.title);
      return {
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
      };
    };

    const mappedArticles = await Promise.all(articles.slice(0,6).map((a,i) => mapItem(a,i,'article')));
    const mappedNews = await Promise.all(news.slice(0,6).map((n,i) => mapItem(n,i,'news')));

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
