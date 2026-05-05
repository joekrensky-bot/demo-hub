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
  if (!OPENAI_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'OPENAI_API_KEY not set' }) };

  let url = '';
  try {
    const body = JSON.parse(event.body);
    url = body.url || '';
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const clean = url.startsWith('http') ? url : 'https://' + url;
  const domain = clean.replace(/https?:\/\//, '').split('/')[0];

  // ── 1. Scrape og tags from homepage ──
  let ogImage = '', ogTitle = '', ogDescription = '';
  try {
    const pageRes = await fetch(clean, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
    });
    if (pageRes.ok) {
      const html = await pageRes.text();
      const m1 = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
               || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
               || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
      if (m1) ogImage = m1[1].trim().replace(/&amp;/g, '&');

      const m2 = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
               || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
      if (m2) ogTitle = m2[1].trim();
      else { const t = html.match(/<title[^>]*>([^<]+)<\/title>/i); if (t) ogTitle = t[1].trim(); }

      const m3 = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
               || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)
               || html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
      if (m3) ogDescription = m3[1].trim();
    }
  } catch(e) { /* silent */ }

  // ── 2. Call GPT-4o with chat/completions (known working) ──
  const prompt = `You are building a branded content hub for ${clean} (domain: ${domain}).

${ogTitle ? `Real page title: "${ogTitle}"` : ''}
${ogDescription ? `Real page description: "${ogDescription}"` : ''}

Use your knowledge of this company to generate accurate, on-brand content. Return ONLY valid JSON:
{
  "companyName": "real company name",
  "brandPrimary": "#hex their real dominant nav/header color",
  "brandAccent": "#hex their real CTA button color",
  "brandBg": "#f9f7f4",
  "brandText": "#1a1a2e",
  "brandHeaderText": "#hex - white if dark header, dark if light header",
  "heroHeadline": "${ogTitle ? `rephrase this for a content hub (max 8 words): ${ogTitle}` : 'compelling headline based on their real brand positioning, max 8 words'}",
  "heroSubheading": "${ogDescription ? `rephrase: ${ogDescription}` : 'their real value proposition in one sentence'}",
  "heroImageUrl": "",
  "articles": [
    {
      "title": "specific article title that could realistically appear on this company's blog",
      "summary": "2-3 sentence summary grounded in this company's actual products and industry",
      "slug": "lowercase-hyphenated",
      "category": "real category this company would use",
      "readTime": "5 min read",
      "date": "2025-04-15",
      "body": "<p>Substantive opening paragraph specific to this company.</p><h2>Relevant section heading</h2><p>Detailed paragraph with specific insights about their industry.</p><p>Another paragraph expanding on practical applications.</p><blockquote><p>A relevant insight or quote.</p></blockquote><p>Closing paragraph with actionable takeaways.</p>"
    }
  ],
  "news": [
    {
      "title": "plausible recent news headline for this company",
      "summary": "1-2 sentences",
      "slug": "lowercase-hyphenated",
      "category": "News",
      "readTime": "2 min read",
      "date": "2025-04-20",
      "body": "<p>News detail paragraph.</p><p>Additional context.</p>"
    }
  ],
  "aboutText": "Accurate 2-3 paragraph company description based on what you know about them.",
  "products": [
    {"name": "real product/service name", "description": "accurate description", "cta": "Learn more"}
  ]
}
Generate exactly 6 articles and 6 news items. Be specific to this company — not generic.`;

  try {
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
          { role: 'system', content: 'You are a brand content expert. Return valid JSON only, no markdown, no code blocks.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!gptRes.ok) {
      const errText = await gptRes.text();
      return { statusCode: gptRes.status, headers, body: JSON.stringify({ error: `OpenAI ${gptRes.status}: ${errText}` }) };
    }

    const gptData = await gptRes.json();
    const brand = JSON.parse(gptData.choices[0].message.content);

    const mapItem = (a, i, type) => ({
      id: `${type}-${i}`,
      title: a.title || `${type} ${i + 1}`,
      summary: a.summary || '',
      imageUrl: `https://picsum.photos/seed/${type}-${i}/800/450`,
      slug: a.slug || (a.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `${type}-${i}`,
      category: a.category || (type === 'news' ? 'News' : 'Insights'),
      readTime: a.readTime || '5 min read',
      date: a.date || '2025-03-01',
      body: a.body || '',
      source: 'scraped',
      isNew: false,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        companyName: brand.companyName || domain,
        brandPrimary: brand.brandPrimary || '#0f172a',
        brandAccent: brand.brandAccent || '#6366f1',
        brandBg: brand.brandBg || '#f9f7f4',
        brandText: brand.brandText || '#1a1a2e',
        brandHeaderText: brand.brandHeaderText || '#ffffff',
        logoUrl: `https://logo.clearbit.com/${domain}`,
        heroHeadline: brand.heroHeadline || ogTitle || 'Insights & Resources',
        heroSubheading: brand.heroSubheading || ogDescription || 'Stay ahead with the latest thinking.',
        heroImageUrl: ogImage || '',
        articles: (brand.articles || []).slice(0, 6).map((a, i) => mapItem(a, i, 'article')),
        news: (brand.news || []).slice(0, 6).map((n, i) => mapItem(n, i, 'news')),
        aboutText: brand.aboutText || '',
        products: brand.products || [],
      }),
    };

  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
