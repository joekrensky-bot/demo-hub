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

  if (!OPENAI_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'OPENAI_API_KEY not set' }) };

  let url = '';
  try {
    const parsed = JSON.parse(event.body || '{}');
    url = String(parsed.url || '');
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'url is required' }) };

  const clean = url.startsWith('http') ? url : 'https://' + url;
  const domain = clean.replace(/https?:\/\//, '').split('/')[0];

  const FALLBACK_IMAGES = {
    security:   'https://images.unsplash.com/photo-1563986768609-322da13575f3?w=800&q=80',
    ai:         'https://images.unsplash.com/photo-1555255707-c07966088b7b?w=800&q=80',
    marketing:  'https://images.unsplash.com/photo-1432888498266-38ffec3eaf0a?w=800&q=80',
    content:    'https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=800&q=80',
    growth:     'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=800&q=80',
    data:       'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&q=80',
    technology: 'https://images.unsplash.com/photo-1461749280684-dccba630e2f6?w=800&q=80',
    business:   'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&q=80',
    health:     'https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=800&q=80',
    finance:    'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=800&q=80',
    default:    'https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=800&q=80',
  };

  const getFallback = (category, title) => {
    const t = ((category||'') + ' ' + (title||'')).toLowerCase();
    if(t.includes('security')||t.includes('cyber')) return FALLBACK_IMAGES.security;
    if(t.includes('ai ')||t.includes('artificial')||t.includes('agentic')) return FALLBACK_IMAGES.ai;
    if(t.includes('market')||t.includes('campaign')) return FALLBACK_IMAGES.marketing;
    if(t.includes('content')||t.includes('writing')) return FALLBACK_IMAGES.content;
    if(t.includes('growth')||t.includes('revenue')) return FALLBACK_IMAGES.growth;
    if(t.includes('data')||t.includes('analytic')) return FALLBACK_IMAGES.data;
    if(t.includes('cloud')||t.includes('platform')||t.includes('software')) return FALLBACK_IMAGES.technology;
    if(t.includes('health')||t.includes('medical')) return FALLBACK_IMAGES.health;
    if(t.includes('financ')||t.includes('invest')) return FALLBACK_IMAGES.finance;
    if(t.includes('business')||t.includes('enterprise')) return FALLBACK_IMAGES.business;
    return FALLBACK_IMAGES.default;
  };

  const makePlaceholders = (companyName, count, type) => {
    const topics = type === 'news'
      ? ['New partnership announced','Product update released','Industry award received','Market expansion update','Leadership milestone','Community initiative']
      : ['Getting started guide','Best practices overview','ROI maximization tips','Customer success story','Industry trends report','Expert strategies'];
    return Array.from({length: count}, (_, i) => ({
      title: topics[i] || type+' '+(i+1),
      summary: 'The latest from ' + companyName + '.',
      slug: (topics[i]||type+'-'+i).toLowerCase().replace(/[^a-z0-9]+/g,'-'),
      category: type==='news'?'News':'Insights',
      readTime: type==='news'?'2 min read':'5 min read',
      date:'2025-05-04', body:'<p>Coming soon.</p>',
    }));
  };

  // ── STEP 1: og tags + SERP search — fully parallel ───────────
  let ogImage='', ogTitle='', ogDesc='';
  let serpArticles=[], serpNews=[];

  const ogPromise = fetch(clean, {
    headers: {'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'},
    signal: AbortSignal.timeout(3000), redirect:'follow',
  }).then(async r => {
    if(!r.ok) return;
    const h = await r.text();
    const mi = h.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
            || h.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    if(mi) ogImage = mi[1].trim().replace(/&amp;/g,'&');
    const mt = h.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
            || h.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if(mt) ogTitle = mt[1].trim();
    else { const t=h.match(/<title[^>]*>([^<]+)<\/title>/i); if(t) ogTitle=t[1].trim(); }
    const md = h.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
            || h.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    if(md) ogDesc = md[1].trim();
  }).catch(()=>{});

  // Firecrawl search — SERP snippets only, no scraping
  const serpSearch = async (query) => {
    if(!FIRECRAWL_KEY) return [];
    try {
      const r = await fetch('https://api.firecrawl.dev/v1/search', {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+FIRECRAWL_KEY},
        body: JSON.stringify({ query, limit: 8 }),
        signal: AbortSignal.timeout(3000),
      });
      if(!r.ok){ console.log('SERP fail:',r.status,await r.text()); return []; }
      const d = await r.json();
      // Accept any result from this domain OR closely related
      return (d.data||[]).map(item => ({
        title: String(item.title||'').replace(/\s*[-|].*$/,'').trim(), // strip site name suffix
        summary: item.description || item.markdown?.slice(0,200) || '',
        url: item.url || '',
        date: item.publishedDate || item.metadata?.publishedDate || '2025-05-04',
      })).filter(item => item.title.length > 5);
    } catch(e){ console.log('SERP error:',e.message); return []; }
  };

  // Run og scrape + 2 SERP searches all in parallel
  log('og+SERP start');
  const [_, articleResults, newsResults] = await Promise.all([
    ogPromise,
    serpSearch('site:' + domain + ' (blog OR article OR insight OR guide OR resource)'),
    serpSearch(domain + ' news announcement 2025'),
  ]);

  serpArticles = articleResults.slice(0,6);
  serpNews = newsResults.slice(0,6);
  log('og+SERP done | articles=' + serpArticles.length + ' news=' + serpNews.length + ' ogImage=' + (ogImage?'yes':'no'));

  // ── DEEP MODE: scrape actual pages for real images ────────────
  let siteImages = [];
  if (mode === 'deep' && FIRECRAWL_KEY && serpArticles.length > 0) {
    const pageUrls = serpArticles.slice(0,3).map(a => a.url).filter(Boolean);
    const scrapes = await Promise.all(pageUrls.map(pageUrl =>
      fetch('https://api.firecrawl.dev/v1/scrape', {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+FIRECRAWL_KEY},
        body: JSON.stringify({ url: pageUrl, formats: ['markdown'] }),
        signal: AbortSignal.timeout(3000),
      }).then(r => r.ok ? r.json() : null).catch(() => null)
    ));
    for(const r of scrapes) {
      if(!r) continue;
      const md = String(r.data?.markdown||'');
      const imgs = [...md.matchAll(/!\[.*?\]\((https?:\/\/[^)]+\.(?:jpg|jpeg|png|webp)[^)]*)\)/gi)]
        .map(m => m[1]).filter(u => !u.includes('logo') && !u.includes('icon'));
      siteImages.push(...imgs.slice(0,2));
    }
    console.log('Deep mode site images:', siteImages.length);
  }

  // ── STEP 2: GPT structures brand + fills gaps ─────────────────
  const s = v => v == null ? '' : String(v);

  const formatSerp = (items, label) => items.length > 0
    ? label + ':\n' + items.map((a,i) => `${i+1}. "${a.title}" — ${a.summary.slice(0,120)} (${a.date})`).join('\n')
    : '';

  const userPrompt = [
    'Build a branded content hub JSON for ' + s(domain) + '.',
    '',
    formatSerp(serpArticles, 'REAL ARTICLES FROM ' + domain.toUpperCase() + ' (use these as the first articles, keep titles exact)'),
    formatSerp(serpNews, 'REAL NEWS FROM ' + domain.toUpperCase() + ' (use these as the first news items, keep titles exact)'),
    '',
    'og:title (heroHeadline — use exactly): ' + s(ogTitle),
    'og:description (heroSubheading — use exactly): ' + s(ogDesc),
    '',
    'Return ONLY valid JSON (no markdown):',
    '{"companyName":"","brandPrimary":"#hex","brandAccent":"#hex","brandBg":"#f9f7f4","brandText":"#1a1a2e","brandHeaderText":"#hex","heroHeadline":"'+s(ogTitle.slice(0,60)||domain)+'","heroSubheading":"'+s(ogDesc.slice(0,150))+'","heroImageUrl":"'+s(ogImage)+'","articles":[{"title":"","summary":"2 sentences","slug":"","category":"","readTime":"5 min read","date":"2025-05-04","body":"<p>para</p><h2>heading</h2><p>para</p><blockquote><p>insight</p></blockquote><p>closing</p>"}],"news":[{"title":"","summary":"1-2 sentences","slug":"","category":"News","readTime":"2 min read","date":"2025-05-04","body":"<p>para</p>"}],"aboutText":"2 paragraphs","products":[{"name":"","description":"","cta":"Learn more"}]}',
    'Use real SERP titles first. Fill to 6 articles + 6 news. Slugs lowercase-hyphenated. Dates 2025-04 or 2025-05.',
  ].filter(Boolean).join('\n');

  try {
    log('GPT start');
    log('GPT start');
    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+OPENAI_KEY},
      body: JSON.stringify({
        model:'gpt-4o', max_tokens:2500,
        response_format:{type:'json_object'},
        messages:[
          {role:'system', content:'You are a content hub builder. Return valid JSON only, no markdown.'},
          {role:'user', content:userPrompt},
        ],
      }),
      signal: AbortSignal.timeout(5500),
    });

    if(!gptRes.ok) {
      const e = await gptRes.text();
      return {statusCode:gptRes.status, headers, body:JSON.stringify({error:'OpenAI '+gptRes.status+': '+e})};
    }

    const brand = JSON.parse((await gptRes.json()).choices[0].message.content);
    log('GPT done brand=' + (brand.companyName||'?'));
    log('GPT done');
    if(ogImage) brand.heroImageUrl = ogImage;

    const companyName = String(brand.companyName || domain);
    let articles = brand.articles || [];
    let news = brand.news || [];
    if(articles.length < 6) articles = [...articles, ...makePlaceholders(companyName, 6-articles.length, 'article')];
    if(news.length < 6) news = [...news, ...makePlaceholders(companyName, 6-news.length, 'news')];

    // Insert featured article as position-1 if we have one
    if (featuredArticle) {
      articles = [featuredArticle, ...articles.slice(0, 5)];
    }

    const fallbackPool = Object.values(FALLBACK_IMAGES);
    const buildItem = (a, i, type) => {
      let imageUrl, imageSource;
      if(siteImages[i]) {
        imageUrl = siteImages[i]; imageSource = 'firecrawl';
      } else {
        imageUrl = fallbackPool[i % fallbackPool.length] || getFallback(a.category, a.title);
        imageSource = 'fallback';
      }
      return {
      id: type+'-'+i,
      title: String(a.title || type+' '+(i+1)),
      summary: String(a.summary || ''),
      imageUrl, imageSource,
      slug: String(a.slug||(a.title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||type+'-'+i),
      category: String(a.category||(type==='news'?'News':'Insights')),
      readTime: String(a.readTime||'5 min read'),
      date: String(a.date||'2025-05-04'),
      body: String(a.body||''),
      source:'scraped', isNew:false,
      };
    };

    log('DONE — sending response');
    return {
      statusCode:200, headers,
      body: JSON.stringify({
        companyName,
        brandPrimary: String(brand.brandPrimary||'#0f172a'),
        brandAccent: String(brand.brandAccent||'#6366f1'),
        brandBg:'#f9f7f4', brandText:'#1a1a2e',
        brandHeaderText: String(brand.brandHeaderText||'#ffffff'),
        logoUrl:'https://logo.clearbit.com/'+domain,
        heroHeadline: String(brand.heroHeadline||ogTitle||'Insights & Resources'),
        heroSubheading: String(brand.heroSubheading||ogDesc||'Stay ahead with the latest thinking.'),
        heroImageUrl: String(ogImage||''),
        featuredArticle: featuredArticle ? {
          jasperDocId: featuredArticle.jasperDocId,
          jasperDocUrl: featuredArticle.jasperDocUrl,
          title: featuredArticle.title,
        } : null,
        articles: articles.slice(0,6).map((a,i)=>i===0&&featuredArticle ? featuredArticle : buildItem(a,i,'article')),
        news: news.slice(0,6).map((n,i)=>buildItem(n,i,'news')),
        aboutText: String(brand.aboutText||''),
        products: brand.products||[],
      }),
    };
  } catch(err) {
    return {statusCode:500, headers, body:JSON.stringify({error:String(err.message)})};
  }
};
