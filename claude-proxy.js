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
  if (!OPENAI_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'OPENAI_API_KEY not set' }) };
  }

  try {
    const { url } = JSON.parse(event.body);
    const clean = url.startsWith('http') ? url : 'https://' + url;
    const domain = clean.replace(/https?:\/\//, '').split('/')[0];

    // Step 1: Fetch the homepage for real og tags
    let ogImage = '', ogTitle = '', ogDescription = '', pageText = '';
    try {
      const pageRes = await fetch(clean, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
      if (pageRes.ok) {
        const html = await pageRes.text();

        const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
          || html.match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
        if (ogImg) ogImage = ogImg[1].trim().replace(/&amp;/g, '&');

        const ogT = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
        if (ogT) ogTitle = ogT[1].trim();

        const ogD = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)
          || html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
        if (ogD) ogDescription = ogD[1].trim();

        if (!ogTitle) {
          const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          if (t) ogTitle = t[1].trim();
        }

        // Grab visible text for GPT context
        pageText = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 4000);
      }
    } catch(e) {
      // Couldn't fetch page — GPT will work from its training knowledge
    }

    // Step 2: Try to fetch the blog/news page for real articles
    let articlePageText = '';
    const blogPaths = ['/blog', '/news', '/articles', '/insights', '/resources', '/en-us/news', '/press'];
    for (const path of blogPaths) {
      try {
        const blogRes = await fetch(`https://${domain}${path}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(5000),
        });
        if (blogRes.ok) {
          const html = await blogRes.text();
          articlePageText = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 3000);
          if (articlePageText.length > 200) break;
        }
      } catch(e) {}
    }

    const prompt = `You are building a branded content hub for ${clean}.

${ogTitle || ogDescription || pageText ? `REAL DATA SCRAPED FROM THE SITE:
- Page title / og:title: "${ogTitle}"
- og:description: "${ogDescription}"
- heroImageUrl (use EXACTLY, do not change): "${ogImage}"
- Homepage text: "${pageText.slice(0, 1500)}"
${articlePageText ? `- Blog/news page text: "${articlePageText.slice(0, 1500)}"` : ''}
` : `No page data could be fetched. Use your training knowledge about ${domain}.`}

Using the above real data AND your knowledge of ${domain}, return ONLY valid JSON:
{
  "companyName": "real company name",
  "brandPrimary": "#hex - real dominant nav/header color",
  "brandAccent": "#hex - real CTA button color",
  "brandBg": "#hex - page background",
  "brandText": "#hex - body text color",
  "brandHeaderText": "#hex - header text color (white if dark header)",
  "logoUrl": "https://logo.clearbit.com/${domain}",
  "heroHeadline": "${ogTitle ? 'use og:title above or rephrase for content hub' : 'compelling content hub headline'}",
  "heroSubheading": "${ogDescription ? 'use og:description above or rephrase' : 'one sentence value proposition'}",
  "heroImageUrl": "${ogImage || ''}",
  "articles": [{"title":"real or plausible article title for this brand","summary":"2-3 sentences","slug":"url-slug","category":"real category","readTime":"5 min read","date":"2025-03-15","body":"<p>paragraph</p><h2>heading</h2><p>paragraph</p><p>paragraph</p>"}],
  "news": [{"title":"real or recent news item","summary":"1-2 sentences","slug":"url-slug","category":"News","readTime":"2 min read","date":"2025-04-01","body":"<p>paragraph</p>"}],
  "aboutText": "accurate 2-3 paragraph description of the company",
  "products": [{"name":"real product name","description":"real description","cta":"Learn more"}]
}

Generate exactly 6 articles and 6 news items. Use real content from the scraped text where possible, otherwise generate plausible content deeply specific to this brand's actual products and industry. All slugs lowercase-hyphenated.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
          { role: 'system', content: 'You are a brand analyst. Always respond with valid JSON only, no markdown.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: response.status, headers, body: JSON.stringify({ error: errText }) };
    }

    const data = await response.json();
    const brand = JSON.parse(data.choices[0].message.content);

    // Always use the real og:image we scraped — never trust GPT's image URLs
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
        brandText: brand.brandText || '#0f172a',
        brandHeaderText: brand.brandHeaderText || '#ffffff',
        logoUrl: brand.logoUrl || `https://logo.clearbit.com/${domain}`,
        heroHeadline: brand.heroHeadline || ogTitle || 'Insights & Resources',
        heroSubheading: brand.heroSubheading || ogDescription || 'Stay ahead with the latest thinking.',
        heroImageUrl: ogImage || '',
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
