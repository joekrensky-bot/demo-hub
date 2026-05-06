exports.handler = async (event) => {
  const H = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: 'Method Not Allowed' };

  const OK = process.env.OPENAI_API_KEY;
  const FK = process.env.FIRECRAWL_API_KEY;
  const JK = process.env.JASPER_API_KEY;
  if (!OK) return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'No OPENAI key' }) };

  const T = Date.now(), L = [], log = m => { const e = `[${Date.now()-T}ms] ${m}`; console.log(e); L.push(e); };

  let url='', articleUrl='', jasperUserId='hTcTOK3m6xUCKwznLDLXwem3Y9E2', manual=false;
  try {
    const p = JSON.parse(event.body||'{}');
    url = String(p.url||''); articleUrl = String(p.articleUrl||'');
    jasperUserId = String(p.jasperUserId||jasperUserId);
    manual = Boolean(p.manual);
  } catch(e) { return { statusCode:400, headers:H, body:JSON.stringify({error:'Bad JSON'}) }; }
  if (!url) return { statusCode:400, headers:H, body:JSON.stringify({error:'url required'}) };

  // ═══ MANUAL MODE: Jasper Command API generates content ═══
  if (manual) {
    log('MANUAL mode for: ' + url);

    const jasperCmd = async (command) => {
      if (!JK) return '';
      try {
        const r = await fetch('https://api.jasper.ai/v1/command', {
          method:'POST',
          headers:{'Content-Type':'application/json','x-api-key':JK},
          body:JSON.stringify({inputs:{command}}),
          signal:AbortSignal.timeout(8000),
        });
        if (!r.ok) { log('Jasper cmd fail: '+r.status); return ''; }
        const d = await r.json();
        return String(d.data?.[0]?.text||'').trim();
      } catch(e) { log('Jasper cmd err: '+e.message); return ''; }
    };

    try {
      // Generate articles and news in parallel via Jasper
      log('Jasper generating content...');
      const [articlesRaw, newsRaw, aboutRaw] = await Promise.all([
        jasperCmd('Write 6 blog article titles and 2-sentence summaries for a content hub demo for '+url+'. Format as JSON array: [{"title":"","summary":"","category":"one of Marketing,AI,Strategy,Growth,Content,Technology","slug":"lowercase-hyphen"}]. Return ONLY the JSON array.'),
        jasperCmd('Write 6 news headlines and 1-sentence summaries for '+url+'. Format as JSON array: [{"title":"","summary":"","slug":"lowercase-hyphen"}]. Return ONLY the JSON array.'),
        jasperCmd('Write a 2-paragraph about section for '+url+' content hub. Professional tone.'),
      ]);

      const parseArr = (raw) => { try { const m=raw.match(/\[[\s\S]*\]/); return m?JSON.parse(m[0]):[]; } catch(e){return [];} };
      let arts = parseArr(articlesRaw);
      let nws = parseArr(newsRaw);
      log('Jasper done: '+arts.length+' articles, '+nws.length+' news');

      // Fill gaps with placeholders
      const co = url.replace(/https?:\/\//,'').split('/')[0];
      const ph=(t,i)=>({title:t==='n'?'Company Update '+(i+1):'Article '+(i+1),summary:'Latest from '+co+'.',slug:t+'-'+i,category:t==='n'?'News':'Insights'});
      while(arts.length<6)arts.push(ph('a',arts.length));
      while(nws.length<6)nws.push(ph('n',nws.length));

      // Use GPT just for brand colors (tiny fast call)
      let brandPrimary='#0f172a', brandAccent='#6366f1', brandHeaderText='#fff';
      try {
        const gr = await fetch('https://api.openai.com/v1/chat/completions', {
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':'Bearer '+OK},
          body:JSON.stringify({model:'gpt-4o-mini',max_tokens:100,response_format:{type:'json_object'},
            messages:[{role:'system',content:'JSON only'},{role:'user',content:'Return brand colors for "'+co+'": {"brandPrimary":"#hex nav","brandAccent":"#hex cta","brandHeaderText":"#fff or #000","heroHeadline":"tagline","heroSubheading":"1 sentence"}'}]}),
          signal:AbortSignal.timeout(4000),
        });
        if (gr.ok) {
          const b=JSON.parse((await gr.json()).choices[0].message.content);
          brandPrimary=b.brandPrimary||brandPrimary; brandAccent=b.brandAccent||brandAccent;
          brandHeaderText=b.brandHeaderText||brandHeaderText;
          log('GPT brand colors done');
        }
      } catch(e) { log('GPT brand err: '+e.message); }

      const mi=(a,i,t)=>({id:t+'-'+i,title:String(a.title||t+' '+(i+1)),summary:String(a.summary||''),
        imageUrl:IMGS[i%IMGS.length],imageSource:'fallback',
        slug:String(a.slug||(a.title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||t+'-'+i),
        category:String(a.category||(t==='news'?'News':'Insights')),readTime:t==='news'?'2 min':'5 min read',
        date:'2025-05-05',body:'<p>'+(a.summary||'Coming soon.')+'</p>',
        source:'jasper',isNew:false,jasperDocId:null,jasperDocUrl:null});

      log('DONE '+((Date.now()-T)/1000).toFixed(1)+'s');
      return {statusCode:200,headers:H,body:JSON.stringify({
        _debug:L,companyName:co,
        brandPrimary,brandAccent,brandBg:'#f9f7f4',brandText:'#1a1a2e',brandHeaderText,
        logoUrl:'',heroHeadline:'Insights & Resources',heroSubheading:'Expert thinking to help your team move faster.',heroImageUrl:'',
        articles:arts.slice(0,6).map((a,i)=>mi(a,i,'article')),
        news:nws.slice(0,6).map((a,i)=>mi(a,i,'news')),
        aboutText:String(aboutRaw||'A modern content hub.'),products:[],featuredArticle:null,
      })};
    } catch(err) {
      return {statusCode:500,headers:H,body:JSON.stringify({error:String(err.message),_debug:L})};
    }
  }

  const clean = url.startsWith('http') ? url : 'https://'+url;
  const domain = clean.replace(/https?:\/\//,'').split('/')[0];
  log('START '+domain+' art='+(articleUrl||'none'));

  const IMGS = [
    'https://images.unsplash.com/photo-1563986768609-322da13575f3?w=800&q=80',
    'https://images.unsplash.com/photo-1555255707-c07966088b7b?w=800&q=80',
    'https://images.unsplash.com/photo-1432888498266-38ffec3eaf0a?w=800&q=80',
    'https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=800&q=80',
    'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&q=80',
    'https://images.unsplash.com/photo-1461749280684-dccba630e2f6?w=800&q=80',
    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&q=80',
    'https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=800&q=80',
    'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=800&q=80',
    'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=800&q=80',
    'https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=800&q=80',
    'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=800&q=80',
  ];

  // ── Helper: og scrape ──
  const ogScrape = async (u, ms=2500) => {
    try {
      const r = await fetch(u, {headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(ms),redirect:'follow'});
      if (!r.ok) return {};
      const h = await r.text();
      const g = ps => { for (const p of ps) { const m=h.match(p); if(m) return m[1].trim().replace(/&amp;/g,'&'); } return ''; };
      return {
        title: g([/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i,/<title[^>]*>([^<]+)<\/title>/i]),
        desc: g([/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i,/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i]),
        image: g([/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i,/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)/i]),
      };
    } catch(e) { return {}; }
  };

  // ═══ PHASE 1: og + map + article scrape — all parallel, 3s max ═══
  log('P1 start');

  const ogP = ogScrape(clean, 2500);

  const mapP = FK ? fetch('https://api.firecrawl.dev/v1/map', {
    method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+FK},
    body: JSON.stringify({url:clean, limit:30}),
    signal: AbortSignal.timeout(3000),
  }).then(r=>r.ok?r.json():null).catch(()=>null) : Promise.resolve(null);

  const artP = (articleUrl && FK) ? fetch('https://api.firecrawl.dev/v1/scrape', {
    method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+FK},
    body: JSON.stringify({url: articleUrl.startsWith('http')?articleUrl:'https://'+articleUrl, formats:['markdown']}),
    signal: AbortSignal.timeout(3000),
  }).then(r=>r.ok?r.json():null).catch(()=>null) : Promise.resolve(null);

  const [og, map, artData] = await Promise.all([ogP, mapP, artP]);

  // Extract blog URLs from map
  let blogUrls = [];
  if (map?.links) {
    blogUrls = map.links.filter(u =>
      /\/(blog|news|article|insight|resource|press|hello|post|update|story)\//i.test(u)
    ).slice(0, 6);
  }
  log('P1 done og='+(og.title?'yes':'no')+' map='+(map?.links?.length||0)+' blogs='+blogUrls.length);

  // ═══ PHASE 2: Scrape og from blog URLs — parallel, 2s max ═══
  let realArticles = [];
  if (blogUrls.length > 0) {
    log('P2 scraping '+blogUrls.length+' pages');
    const ogs = await Promise.all(blogUrls.map(u => ogScrape(u, 2000)));
    realArticles = blogUrls.map((u,i) => ({
      title: ogs[i].title || u.split('/').filter(Boolean).pop().replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase()),
      summary: ogs[i].desc || '',
      image: ogs[i].image || '',
      url: u,
    }));
    log('P2 done '+realArticles.filter(a=>a.image).length+' have images');
  } else {
    log('P2 skip — no blog URLs');
  }

  // ═══ PHASE 3: Featured article + Jasper doc (fire-and-forget) ═══
  let feat = null;
  let jasperP = Promise.resolve(null);
  if (articleUrl) {
    const ac = articleUrl.startsWith('http')?articleUrl:'https://'+articleUrl;
    let aT='',aD='',aI='',aC='';
    if (artData) {
      const m = artData.data?.metadata||{};
      aT=String(m.ogTitle||m['og:title']||m.title||'');
      aD=String(m.ogDescription||m['og:description']||m.description||'');
      aI=String(m.ogImage||m['og:image']||'').replace(/&amp;/g,'&');
      aC=String(artData.data?.markdown||'').slice(0,6000);
    }
    if (!aT) { const o=await ogScrape(ac,1500); aT=o.title||''; aD=o.desc||''; aI=o.image||''; }
    log('art: "'+aT.slice(0,40)+'" img='+(aI?'yes':'no')+' body='+aC.length);

    if (JK && (aC||aD||aT)) {
      jasperP = fetch('https://api.jasper.ai/v1/documents', {
        method:'POST',
        headers:{'Content-Type':'application/json','X-API-Key':JK.split(':')[0]},
        body:JSON.stringify({userId:jasperUserId,name:aT||'Featured',content:aC||aD||aT,status:'DRAFT'}),
        signal:AbortSignal.timeout(8000),
      }).then(async r=>{const t=await r.text();log('Jasper:'+r.status+' '+t.slice(0,60));if(r.ok){const d=JSON.parse(t);return d.data?.id||d.id||null;}return null;})
      .catch(e=>{log('Jasper err:'+e.message);return null;});
    }

    feat = {
      id:'featured-0', title:aT||'Featured Article', summary:aD||'Featured article.',
      imageUrl:aI||IMGS[0], imageSource:aI?'firecrawl':'fallback',
      slug:(aT||'featured').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),
      category:'Featured', readTime:'5 min read', date:new Date().toISOString().slice(0,10),
      body:aC?'<p>'+aC.slice(0,4000).replace(/\n\n+/g,'</p><p>').replace(/\n/g,' ')+'</p>':'<p>'+(aD||aT)+'</p>',
      source:'jasper-doc', isNew:true, jasperDocId:null, jasperDocUrl:null, articleSourceUrl:ac,
    };
  }

  // ═══ PHASE 4: GPT — short prompt, fast response ═══
  const artsForGPT = realArticles.length > 0
    ? 'REAL articles from '+domain+':\n'+realArticles.map((a,i)=>(i+1)+'. "'+a.title+'"'+(a.summary?' — '+a.summary.slice(0,80):'')).join('\n')
    : '';

  const prompt = 'Content hub JSON for '+domain+'.\n\n'+
    (artsForGPT||'Generate 6 articles for '+domain+'.')+'\n\n'+
    'og:title="'+(og.title||'')+'"\nog:desc="'+(og.desc||'')+'"\n\n'+
    'JSON only: {"companyName":"","brandPrimary":"#hex","brandAccent":"#hex","brandBg":"#f9f7f4","brandText":"#1a1a2e","brandHeaderText":"#fff",'+
    '"heroHeadline":"og:title exact","heroSubheading":"og:desc exact",'+
    '"articles":[{"title":"","summary":"1-2 sentences","slug":"","category":"","readTime":"5 min read","date":"2025-05","body":"<p>p</p><h2>h</h2><p>p</p><blockquote><p>q</p></blockquote><p>p</p>"}],'+
    '"news":[{"title":"","summary":"","slug":"","category":"News","readTime":"2 min","date":"2025-05","body":"<p>p</p>"}],'+
    '"aboutText":"","products":[{"name":"","description":"","cta":"Learn more"}]}'+
    '\n6 articles+6 news. Real titles first. Slugs lowercase-hyphen.';

  try {
    log('GPT start ('+prompt.length+' chars)');
    const gr = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+OK},
      body:JSON.stringify({model:'gpt-4o-mini',max_tokens:1500,response_format:{type:'json_object'},
        messages:[{role:'system',content:'JSON only. Be concise.'},{role:'user',content:prompt}]}),
      signal:AbortSignal.timeout(8000),
    });
    if (!gr.ok) {
      const e=await gr.text();
      return {statusCode:gr.status,headers:H,body:JSON.stringify({error:'GPT '+gr.status,detail:e.slice(0,200),_debug:L})};
    }
    const raw = await gr.json();
    const brand = JSON.parse(raw.choices[0].message.content);
    log('GPT done '+raw.usage?.total_tokens+'tok brand='+(brand.companyName||'?'));

    // Resolve Jasper
    if (feat) {
      const docId = await jasperP;
      if (docId) { feat.jasperDocId=docId; feat.jasperDocUrl='https://app.jasper.ai/documents/'+docId; log('Jasper doc:'+docId); }
    }

    const co = String(brand.companyName||domain);
    let arts = brand.articles||[], nws = brand.news||[];
    const ph = (t,i) => ({title:t==='n'?'Update '+(i+1):'Article '+(i+1),summary:'From '+co+'.',slug:t+'-'+i,category:t==='n'?'News':'Insights',readTime:t==='n'?'2 min':'5 min read',date:'2025-05-05',body:'<p>Coming soon.</p>'});
    while(arts.length<6)arts.push(ph('a',arts.length));
    while(nws.length<6)nws.push(ph('n',nws.length));
    if(feat)arts=[feat,...arts.slice(0,5)];

    const mi = (a,i,t) => ({
      id:t+'-'+i, title:String(a.title||t+' '+(i+1)), summary:String(a.summary||''),
      imageUrl: a.imageUrl || (realArticles[i]?.image) || IMGS[i%IMGS.length],
      imageSource: a.imageUrl?(a.imageSource||'firecrawl'):(realArticles[i]?.image?'firecrawl':'fallback'),
      slug:String(a.slug||(a.title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||t+'-'+i),
      category:String(a.category||(t==='news'?'News':'Insights')),
      readTime:String(a.readTime||'5 min read'), date:String(a.date||'2025-05-05'),
      body:String(a.body||''), source:a.source||'scraped', isNew:a.isNew||false,
      jasperDocId:a.jasperDocId||null, jasperDocUrl:a.jasperDocUrl||null,
    });

    log('DONE '+((Date.now()-T)/1000).toFixed(1)+'s');
    return {statusCode:200,headers:H,body:JSON.stringify({
      _debug:L, companyName:co,
      brandPrimary:String(brand.brandPrimary||'#0f172a'), brandAccent:String(brand.brandAccent||'#6366f1'),
      brandBg:'#f9f7f4', brandText:'#1a1a2e', brandHeaderText:String(brand.brandHeaderText||'#fff'),
      logoUrl:'https://logo.clearbit.com/'+domain,
      heroHeadline:String(brand.heroHeadline||og.title||'Insights & Resources'),
      heroSubheading:String(brand.heroSubheading||og.desc||''),
      heroImageUrl:String(og.image||''),
      articles:arts.slice(0,6).map((a,i)=>mi(a,i,'article')),
      news:nws.slice(0,6).map((a,i)=>mi(a,i,'news')),
      aboutText:String(brand.aboutText||''), products:brand.products||[],
      featuredArticle:feat?{jasperDocId:feat.jasperDocId,jasperDocUrl:feat.jasperDocUrl,title:feat.title}:null,
    })};
  } catch(err) {
    return {statusCode:500,headers:H,body:JSON.stringify({error:String(err.message),_debug:L})};
  }
};
