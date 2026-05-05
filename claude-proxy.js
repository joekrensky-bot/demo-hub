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

  try {
    const { url } = JSON.parse(event.body);
    const clean = url.startsWith('http') ? url : 'https://' + url;
    const domain = clean.replace(/https?:\/\//, '').split('/')[0];

    // ── 1. Scrape homepage for og tags (fast, free) ──
    let ogImage = '', ogTitle = '', ogDescription = '';
    try {
      const pageRes = await fetch(clean, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html' },
        signal: AbortSignal.timeout(6000),
        redirect: 'follow',
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
          || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
        if (ogImg) ogImage = ogImg[1].trim().replace(/&amp;/g, '&');

        const ogT = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
        if (ogT) ogTitle = ogT[1].trim();
        else { const t = html.match(/<title[^>]*>([^<]+)<\/title>/i); if (t) ogTitle = t[1].trim(); }

        const ogD = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)
          || html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
        if (ogD) ogDescription = ogD[1].trim();
      }
    } catch(e) {}

    // ── 2. Responses API with web_search_preview ──
    const prompt = `You are building a branded content hub for ${clean}.

Your job: use web search to find REAL content from this site. Search for:
1. "${domain} blog articles" or "${domain} news" — find real recent articles with titles, dates, summaries
2. "${domain} brand colors" or visit the homepage — identify their real hex color palette  
3. "${domain} products" — find their real product/service names

${ogImage ? `Hero image (use this URL exactly): ${ogImage}` : ''}
${ogTitle ? `Page title: ${ogTitle}` : ''}
${ogDescription ? `Page description: ${ogDescription}` : ''}

Return ONLY valid JSON (no markdown, no code blocks):
{
  "companyName": "real company name",
  "brandPrimary": "#hex real dominant nav/header color",
  "brandAccent": "#hex real CTA button color",
  "brandBg": "#f9f7f4",
  "brandText": "#1a1a2e",
  "brandHeaderText": "#hex white if dark header",
  "heroHeadline": "real tagline or compelling headline from their site (max 8 words)",
  "heroSubheading": "real value proposition from their site (1 sentence)",
  "heroImageUrl": "${ogImage || ''}",
  "articles": [
    {
      "title": "REAL article title found on their blog/news page",
      "summary": "actual summary of that article content",
      "slug": "lowercase-hyphenated-slug",
      "category": "real category label used on the site",
      "readTime": "X min read",
      "date": "YYYY-MM-DD",
      "body": "<p>Substantive opening paragraph based on the real article.</p><h2>Key section heading</h2><p>Detailed paragraph expanding on the topic.</p><p>Another paragraph with specific insights.</p><blockquote><p>A relevant quote or key stat from the article.</p></blockquote><p>Closing paragraph with takeaways.</p>"
    }
  ],
  "news": [
    {
      "title": "REAL news headline from the site or recent press coverage",
      "summary": "actual news summary",
      "slug": "lowercase-hyphenated-slug",
      "category": "News",
      "readTime": "2 min read",
      "date": "YYYY-MM-DD",
      "body": "<p>News content paragraph.</p><p>Additional context and detail.</p>"
    }
  ],
  "aboutText": "Real company description based on what you find on their site. 2-3 paragraphs.",
  "products": [
    {"name": "real product name", "description": "real product description from their site", "cta": "Learn more"}
  ]
}

Find exactly 6 real articles and 6 real news items. Use actual content from the site — real titles, real dates, real categories. If some pages block access, use your best knowledge of this specific company's content. All slugs lowercase-hyphenated.`;

    const responsesRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        tools: [{ type: 'web_search_preview' }],
        input: prompt,
      }),
    });

    let brand;

    if (responsesRes.ok) {
      // ── Responses API path ──
      const responsesData = await responsesRes.json();
      const outputText = (responsesData.output || [])
        .filter(o => o.type === 'message')
        .flatMap(o => o.content || [])
        .filter(c => c.type === 'output_text')
        .map(c => c.text)
        .join('');

      const jsonMatch = outputText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response: ' + outputText.slice(0, 300));
      brand = JSON.parse(jsonMatch[0]);

    } else {
      // ── Fallback: chat/completions without search ──
      const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
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
            { role: 'system', content: 'You are a brand analyst. Return valid JSON only.' },
            { role: 'user', content: prompt },
          ],
        }),
      });
      if (!chatRes.ok) {
        const e = await chatRes.text();
        return { statusCode: chatRes.status, headers, body: JSON.stringify({ error: e }) };
      }
      const chatData = await chatRes.json();
      brand = JSON.parse(chatData.choices[0].message.content);
    }

    // Always use the og:image we scraped — never GPT's guessed image URL
    if (ogImage) brand.heroImageUrl = ogImage;

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
        heroImageUrl: ogImage || brand.heroImageUrl || '',
        articles: (brand.articles || []).slice(0, 6).map((a, i) => mapItem(a, i, 'article')),
        news: (brand.news || []).slice(0, 6).map((n, i) => mapItem(n, i, 'news')),
        aboutText: brand.aboutText || '',
        products: brand.products || [],
      }),
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
