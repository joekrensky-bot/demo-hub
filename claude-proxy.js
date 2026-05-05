exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY;

  if (!OPENAI_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'OPENAI_API_KEY not set' }) };

  try {
    const { url } = JSON.parse(event.body);
    const clean = url.startsWith('http') ? url : 'https://' + url;
    const domain = clean.replace(/https?:\/\//, '').split('/')[0];
    const companySlug = domain.replace('www.', '').split('.')[0];

    // ── 1. Clearbit company enrichment (free, no auth needed) ──
    let clearbitData = {};
    try {
      const cb = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${companySlug}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (cb.ok) {
        const companies = await cb.json();
        if (companies && companies[0]) clearbitData = companies[0];
      }
    } catch(e) {}

    // ── 2. Wikipedia summary ──
    let wikiSummary = '', wikiTitle = '';
    try {
      const wikiRes = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(clearbitData.name || companySlug)}`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (wikiRes.ok) {
        const wiki = await wikiRes.json();
        wikiSummary = wiki.extract || '';
        wikiTitle = wiki.title || '';
      }
    } catch(e) {}

    // ── 3. Unsplash hero image based on company industry/name ──
    let heroImageUrl = '';
    const imageQuery = clearbitData.name || companySlug;
    if (UNSPLASH_KEY) {
      try {
        const uRes = await fetch(
          `https://api.unsplash.com/photos/random?query=${encodeURIComponent(imageQuery)}&orientation=landscape&client_id=${UNSPLASH_KEY}`,
          { signal: AbortSignal.timeout(4000) }
        );
        if (uRes.ok) {
          const uData = await uRes.json();
          heroImageUrl = uData?.urls?.regular || '';
        }
      } catch(e) {}
    }

    // ── 4. Homepage og:image as hero fallback ──
    if (!heroImageUrl) {
      try {
        const pageRes = await fetch(clean, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot/1.0)', 'Accept': 'text/html' },
          signal: AbortSignal.timeout(6000),
          redirect: 'follow',
        });
        if (pageRes.ok) {
          const html = await pageRes.text();
          const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
            || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
          if (m) heroImageUrl = m[1].trim().replace(/&amp;/g, '&');
        }
      } catch(e) {}
    }

    // ── 5. GPT generates brand content using real company context ──
    const context = [
      clearbitData.name ? `Company name: ${clearbitData.name}` : '',
      clearbitData.domain ? `Domain: ${clearbitData.domain}` : '',
      wikiSummary ? `Wikipedia: ${wikiSummary.slice(0, 1000)}` : '',
    ].filter(Boolean).join('\n');

    const prompt = `You are building a content hub for ${clearbitData.name || companySlug} (${domain}).

REAL COMPANY DATA:
${context || `Company: ${companySlug} at ${domain}`}

Using this real data, return ONLY valid JSON:
{
  "companyName": "${clearbitData.name || companySlug}",
  "brandPrimary": "#hex - their real dominant brand color (from your knowledge of their visual identity)",
  "brandAccent": "#hex - their real CTA/button color",
  "brandBg": "#f9f7f4",
  "brandText": "#1a1a2e",
  "brandHeaderText": "#hex - white if dark header, dark if light",
  "heroHeadline": "compelling headline for their content hub (8 words max, based on their real tagline/positioning)",
  "heroSubheading": "one sentence subheadline based on their real value proposition",
  "articles": [
    {
      "title": "specific article title relevant to this company's real products/industry",
      "summary": "2-3 sentences specific to this brand",
      "slug": "url-slug",
      "category": "real category for this industry",
      "readTime": "5 min read",
      "date": "2025-04-${String(Math.floor(Math.random()*28)+1).padStart(2,'0')}",
      "body": "<p>opening paragraph</p><h2>Section heading</h2><p>detailed paragraph</p><p>another paragraph</p><blockquote><p>relevant insight or quote</p></blockquote><p>closing paragraph</p>"
    }
  ],
  "news": [
    {
      "title": "recent news headline specific to this company or industry",
      "summary": "1-2 sentences",
      "slug": "url-slug",
      "category": "News",
      "readTime": "2 min read",
      "date": "2025-04-${String(Math.floor(Math.random()*28)+1).padStart(2,'0')}",
      "body": "<p>news content paragraph</p><p>additional context</p>"
    }
  ],
  "aboutText": "accurate 2-3 paragraph description based on real Wikipedia/company data",
  "products": [
    {"name": "real product or service name", "description": "real description", "cta": "Learn more"}
  ]
}

Generate exactly 6 articles and 6 news items deeply specific to ${clearbitData.name || companySlug}'s real products, services and industry. All slugs lowercase-hyphenated.`;

    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a brand content expert. Return valid JSON only.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!gptRes.ok) {
      const e = await gptRes.text();
      return { statusCode: gptRes.status, headers, body: JSON.stringify({ error: e }) };
    }

    const gptData = await gptRes.json();
    const brand = JSON.parse(gptData.choices[0].message.content);

    // ── 6. Unsplash images per article category ──
    const getUnsplashImg = async (query, seed) => {
      if (!UNSPLASH_KEY) return `https://picsum.photos/seed/${seed}/800/450`;
      try {
        const r = await fetch(
          `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)}&orientation=landscape&client_id=${UNSPLASH_KEY}`,
          { signal: AbortSignal.timeout(3000) }
        );
        if (r.ok) {
          const d = await r.json();
          return d?.urls?.regular || `https://picsum.photos/seed/${seed}/800/450`;
        }
      } catch(e) {}
      return `https://picsum.photos/seed/${seed}/800/450`;
    };

    const mapItem = async (a, i, type) => {
      const imgQuery = `${clearbitData.name || companySlug} ${a.category || type}`;
      const imageUrl = await getUnsplashImg(imgQuery, `${type}-${i}`);
      return {
        id: `${type}-${i}`,
        title: a.title || `${type} ${i + 1}`,
        summary: a.summary || '',
        imageUrl,
        slug: a.slug || (a.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `${type}-${i}`,
        category: a.category || (type === 'news' ? 'News' : 'Insights'),
        readTime: a.readTime || '5 min read',
        date: a.date || '2025-03-01',
        body: a.body || '',
        source: 'scraped',
        isNew: false,
      };
    };

    const articles = await Promise.all((brand.articles || []).slice(0, 6).map((a, i) => mapItem(a, i, 'article')));
    const news = await Promise.all((brand.news || []).slice(0, 6).map((n, i) => mapItem(n, i, 'news')));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        companyName: brand.companyName || clearbitData.name || companySlug,
        brandPrimary: brand.brandPrimary || '#0f172a',
        brandAccent: brand.brandAccent || '#6366f1',
        brandBg: brand.brandBg || '#f9f7f4',
        brandText: brand.brandText || '#1a1a2e',
        brandHeaderText: brand.brandHeaderText || '#ffffff',
        logoUrl: clearbitData.logo || `https://logo.clearbit.com/${domain}`,
        heroHeadline: brand.heroHeadline || 'Insights & Resources',
        heroSubheading: brand.heroSubheading || 'Stay ahead with the latest thinking.',
        heroImageUrl,
        articles,
        news,
        aboutText: brand.aboutText || wikiSummary || '',
        products: brand.products || [],
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
