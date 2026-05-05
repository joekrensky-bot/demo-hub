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
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body: ' + e.message }) }; }
  if (!url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'url is required' }) };

  const clean = url.startsWith('http') ? url : 'https://' + url;
  const domain = clean.replace(/https?:\/\//, '').split('/')[0];
  const log = []; // collect debug info

  // ── Jasper command helper ──
  const jasperCmd = async (label, body) => {
    log.push({ step: label, request: JSON.stringify(body).slice(0, 200) });
    const r = await fetch('https://api.jasper.ai/v1/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': JASPER_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    const txt = await r.text();
    if (!r.ok) {
      log.push({ step: label + '_error', status: r.status, response: txt.slice(0, 500) });
      throw new Error(`Jasper ${r.status} (${label}): ${txt.slice(0, 300)}`);
    }
    const result = (JSON.parse(txt).data?.[0]?.text || '').trim();
    log.push({ step: label + '_ok', chars: result.length });
    return result;
  };

  // ── 1. Scrape og tags ──
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
      log.push({ step: 'og_scrape', ogTitle, ogImage: ogImage.slice(0, 80) });
    }
  } catch(e) { log.push({ step: 'og_scrape_fail', error: e.message }); }

  // ── 2. Jasper: try blog paths with webScraper ──
  const blogPaths = ['/blog', '/news', '/articles', '/insights', '/resources',
                     '/press', '/en-us/news', '/en/blog', '/learn', '/stories',
                     '/updates', '/media', '/newsroom'];
  let scrapedContent = '';
  for (const path of blogPaths) {
    try {
      const pageUrl = `https://${domain}${path}`;
      scrapedContent = await jasperCmd(`scrape_blog${path}`, {
        inputs: {
          command: `List all article and blog post titles, dates, and summaries found at ${pageUrl}. For each use format: TITLE: [title] | DATE: [date] | SUMMARY: [2 sentences] | CATEGORY: [category]`,
          retrievalAddOn: 'webScraper',
        },
        options: { webScraper: { urls: [pageUrl] } },
      });
      if (scrapedContent.length > 200) break;
      scrapedContent = '';
    } catch(e) { continue; }
  }

  // ── 3. Parallel Jasper calls ──
  const [articleRes, newsRes, brandRes] = await Promise.allSettled([
    scrapedContent.length > 200
      ? Promise.resolve(scrapedContent)
      : jasperCmd('article_search', {
          inputs: {
            command: `Find the 6 most recent blog posts or articles published on ${domain}. For each: TITLE: [title] | DATE: [date] | SUMMARY: [2 sentences] | CATEGORY: [category]`,
            retrievalAddOn: 'webSearch',
          },
          options: { webSearch: { searchQuery: `site:${domain} blog OR articles OR insights`, maxResults: 8 } },
        }),

    jasperCmd('news_search', {
      inputs: {
        command: `Find 6 recent news items, announcements or press coverage about ${domain} from 2024-2025. For each: TITLE: [title] | DATE: [date] | SUMMARY: [1-2 sentences] | CATEGORY: News`,
        retrievalAddOn: 'webSearch',
      },
      options: { webSearch: { searchQuery: `"${domain}" news OR announcement 2025`, maxResults: 8 } },
    }),

    jasperCmd('brand_scrape', {
      inputs: {
        command: `Visit ${clean} and extract: HEADLINE: [main headline text] | SUBHEADLINE: [subheadline text] | ABOUT: [2-3 paragraphs about the company] | PRODUCTS: [product names] | NAV_COLOR: [hex of nav/header background] | CTA_COLOR: [hex of CTA button]`,
        retrievalAddOn: 'webScraper',
      },
      options: { webScraper: { urls: [clean] } },
    }),
  ]);

  const articleText = articleRes.status === 'fulfilled' ? articleRes.value : '';
  const newsText = newsRes.status === 'fulfilled' ? newsRes.value : '';
  const brandText = brandRes.status === 'fulfilled' ? brandRes.value : '';

  log.push({ step: 'jasper_results', articleChars: articleText.length, newsChars: newsText.length, brandChars: brandText.length });

  // ── 4. GPT structures into JSON ──
  const gptPrompt = `Build a content hub JSON for ${clean}.

BRAND CRAWL: ${brandText || `Use knowledge of ${domain}. Title: "${ogTitle}" Desc: "${ogDesc}"`}
ARTICLES: ${articleText || `Generate 6 specific articles for ${domain}'s industry`}
NEWS: ${newsText || `Generate 6 recent news items for ${domain}`}
og:image: "${ogImage}"

Return ONLY valid JSON:
{"companyName":"","brandPrimary":"#hex","brandAccent":"#hex","brandBg":"#f9f7f4","brandText":"#1a1a2e","brandHeaderText":"#fff","heroHeadline":"max 8 words","heroSubheading":"1 sentence","heroImageUrl":"${ogImage}","articles":[{"title":"","summary":"2-3 sentences","slug":"","category":"","readTime":"5 min read","date":"YYYY-MM-DD","body":"<p>paragraph</p><h2>heading</h2><p>paragraph</p><p>paragraph</p><blockquote><p>insight</p></blockquote><p>closing</p>"}],"news":[{"title":"","summary":"1-2 sentences","slug":"","category":"News","readTime":"2 min read","date":"YYYY-MM-DD","body":"<p>para</p><p>para</p>"}],"aboutText":"2-3 paragraphs","products":[{"name":"","description":"","cta":"Learn more"}]}
Exactly 6 articles and 6 news items. Slugs lowercase-hyphenated.`;

  try {
    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a content hub builder. Return valid JSON only.' },
          { role: 'user', content: gptPrompt },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!gptRes.ok) {
      const e = await gptRes.text();
      return { statusCode: gptRes.status, headers, body: JSON.stringify({ error: `OpenAI ${gptRes.status}: ${e}`, debug: log }) };
    }

    const brand = JSON.parse((await gptRes.json()).choices[0].message.content);
    if (ogImage) brand.heroImageUrl = ogImage;

    const mapItem = (a, i, type) => ({
      id: `${type}-${i}`, title: a.title || `${type} ${i+1}`, summary: a.summary || '',
      imageUrl: `https://picsum.photos/seed/${type}-${i}/800/450`,
      slug: a.slug || (a.title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || `${type}-${i}`,
      category: a.category||(type==='news'?'News':'Insights'),
      readTime: a.readTime||'5 min read', date: a.date||'2025-03-01',
      body: a.body||'', source:'scraped', isNew:false,
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        companyName: brand.companyName||domain, brandPrimary: brand.brandPrimary||'#0f172a',
        brandAccent: brand.brandAccent||'#6366f1', brandBg:'#f9f7f4', brandText:'#1a1a2e',
        brandHeaderText: brand.brandHeaderText||'#ffffff',
        logoUrl: `https://logo.clearbit.com/${domain}`,
        heroHeadline: brand.heroHeadline||ogTitle||'Insights & Resources',
        heroSubheading: brand.heroSubheading||ogDesc||'Stay ahead with the latest thinking.',
        heroImageUrl: ogImage||'',
        articles: (brand.articles||[]).slice(0,6).map((a,i)=>mapItem(a,i,'article')),
        news: (brand.news||[]).slice(0,6).map((n,i)=>mapItem(n,i,'news')),
        aboutText: brand.aboutText||'', products: brand.products||[],
      }),
    };
  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, debug: log }) };
  }
};
