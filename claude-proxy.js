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
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'OPENAI_API_KEY not set in Netlify environment variables' }) };
  }

  try {
    const { prompt, url } = JSON.parse(event.body);

    // Step 1: Actually fetch the page and extract real data
    let pageContext = '';
    let realOgImage = '';
    let realOgTitle = '';
    let realOgDescription = '';

    if (url) {
      try {
        const clean = url.startsWith('http') ? url : 'https://' + url;
        const pageRes = await fetch(clean, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            'Accept': 'text/html',
          },
          redirect: 'follow',
        });

        if (pageRes.ok) {
          const html = await pageRes.text();

          // Extract og:image
          const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
          if (ogImageMatch) realOgImage = ogImageMatch[1];

          // Extract og:title
          const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
          if (ogTitleMatch) realOgTitle = ogTitleMatch[1];

          // Extract og:description
          const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
          if (ogDescMatch) realOgDescription = ogDescMatch[1];

          // Extract page title as fallback
          if (!realOgTitle) {
            const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
            if (titleMatch) realOgTitle = titleMatch[1].trim();
          }

          // Extract meta description as fallback
          if (!realOgDescription) {
            const metaDescMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
              || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
            if (metaDescMatch) realOgDescription = metaDescMatch[1];
          }

          // Grab visible text for context (strip tags, limit to 3000 chars)
          const text = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 3000);

          pageContext = `
REAL DATA EXTRACTED FROM THE PAGE (use this, do not guess):
- og:title: ${realOgTitle || 'not found'}
- og:description: ${realOgDescription || 'not found'}  
- og:image URL (USE THIS EXACTLY as heroImageUrl): ${realOgImage || 'not found'}
- Page text excerpt: ${text}
`;
        }
      } catch (fetchErr) {
        pageContext = `Could not fetch page directly: ${fetchErr.message}`;
      }
    }

    // Step 2: Send to GPT with the real page data injected
    const fullPrompt = pageContext ? `${pageContext}\n\n${prompt}` : prompt;

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
          {
            role: 'system',
            content: 'You are a brand analyst. Always respond with valid JSON only, no markdown. When real page data is provided, use it exactly — especially heroImageUrl which must be copied verbatim from the og:image value.',
          },
          { role: 'user', content: fullPrompt },
        ],
      }),
    });

    const data = await response.json();
    return { statusCode: response.status, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
