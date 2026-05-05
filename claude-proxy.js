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

    // Step 1: fetch the homepage to get real og tags
    let ogImage = '', ogTitle = '', ogDescription = '';
    try {
      const pageRes = await fetch(clean, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html',
        },
        redirect: 'follow',
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
          || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
        if (ogImg) ogImage = ogImg[1].trim();

        const ogT = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
        if (ogT) ogTitle = ogT[1].trim();

        const ogD = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)
          || html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
        if (ogD) ogDescription = ogD[1].trim();
      }
    } catch(e) {}

    // Step 2: use GPT with web_search_preview to find real articles and brand info
    const prompt = `You are building a branded content hub for ${clean}.

VERIFIED DATA FROM THE SITE (use these exactly, do not modify):
- heroImageUrl: "${ogImage || ''}"
- heroHeadline: "${ogTitle || ''}" (use this or improve it slightly for a content hub)  
- heroSubheading: "${ogDescription || ''}" (use this or improve it slightly)

YOUR TASK: Search the web for:
1. Recent blog posts or articles published on ${domain} — search "site:${domain} blog" or "site:${domain} articles" or "site:${domain} news"
2. The brand's color scheme, logo, and visual identity

Return ONLY valid JSON, no markdown:
{
  "companyName": "string",
  "brandPrimary": "#hex - the dominant header/nav color",
  "brandAccent": "#hex - the CTA button color", 
  "brandBg": "#hex - page background, usually white or near-white",
  "brandText": "#hex - body text color",
  "brandHeaderText": "#hex - text color in the header (white if dark header)",
  "logoUrl": "https://logo.clearbit.com/${domain}",
  "heroHeadline": "from verified data above or slightly improved version",
  "heroSubheading": "from verified data above or slightly improved version",
  "heroImageUrl": "${ogImage || ''}",
  "articles": [
    {
      "title": "REAL article title found on the site",
      "summary": "actual summary of that article",
      "slug": "url-slug",
      "category": "category from the site",
      "readTime": "X min read",
      "date": "YYYY-MM-DD",
      "body": "<p>expanded content about this article topic</p><h2>Key points</h2><p>more detail</p>"
    }
  ],
  "news": [
    {
      "title": "REAL news item from the site or recent press",
      "summary": "actual summary",
      "slug": "url-slug",
      "category": "News",
      "readTime": "2 min read", 
      "date": "YYYY-MM-DD",
      "body": "<p>news content</p>"
    }
  ],
  "aboutText": "accurate description of what this company does based on their site",
  "products": [{"name": "actual product name", "description": "real description", "cta": "Learn more"}]
}

Generate exactly 6 articles and 6 news items using REAL content found on the site. If you can't find enough real articles, generate plausible ones based on the company's actual products and industry. All slugs lowercase-hyphenated.`;

    const response = await fetch('https://api.openai.com/v1/responses', {
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

    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: response.status, headers, body: JSON.stringify({ error: errText }) };
    }

    const data = await response.json();

    // Extract the text output from the responses API format
    const outputText = data.output
      ?.filter(o => o.type === 'message')
      ?.flatMap(o => o.content)
      ?.filter(c => c.type === 'output_text')
      ?.map(c => c.text)
      ?.join('') || '';

    // Parse JSON from the response
    const jsonMatch = outputText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'No JSON in response', raw: outputText.slice(0, 500) }) };
    }

    const brand = JSON.parse(jsonMatch[0]);

    // Always override heroImageUrl with the real og:image we fetched
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
        brandBg: brand.brandBg || '#ffffff',
        brandText: brand.brandText || '#0f172a',
        brandHeaderText: brand.brandHeaderText || '#ffffff',
        logoUrl: brand.logoUrl || `https://logo.clearbit.com/${domain}`,
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
