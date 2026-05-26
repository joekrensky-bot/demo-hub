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
  const UK = process.env.UNSPLASH_ACCESS_KEY;
  // Note: OPENAI key only required for scrape/manual modes, NOT for Jasper/Workato pushes

  const T = Date.now(), L = [], log = m => { const e = `[${Date.now()-T}ms] ${m}`; console.log(e); L.push(e); };

  let url='', articleUrl='', jasperUserId='hTcTOK3m6xUCKwznLDLXwem3Y9E2', manual=false;
  let _jasperPush=false, _action='', _jasperApiKey='', _projectId='', _docTitle='', _docContent='', _projectName='';
  let _workatoPush=false, _workatoUrl='', _wCompany='', _wTitle='', _wContent='', _wUserId='';
  try {
    const p = JSON.parse(event.body||'{}');
    url = String(p.url||''); articleUrl = String(p.articleUrl||'');
    jasperUserId = String(p.jasperUserId||jasperUserId);
    manual = Boolean(p.manual);
    _jasperPush = Boolean(p._jasperPush);
    _workatoPush = Boolean(p._workatoPush);
    _workatoUrl = String(p.workatoWebhookUrl||'');
    _wCompany = String(p.companyName||'');
    _wTitle = String(p.articleTitle||'');
    _wContent = String(p.articleContent||'');
    _wUserId = String(p.userId||'');
    _action = String(p.action||'');
    _jasperApiKey = String(p.jasperApiKey||'');
    _projectId = String(p.projectId||'');
    _docTitle = String(p.title||'');
    _docContent = String(p.content||'');
    _projectName = String(p.projectName||'');
    // Override jasperUserId if explicitly passed in push payload
    if (p.jasperUserId) jasperUserId = String(p.jasperUserId);
    if (p.userId) jasperUserId = String(p.userId);
  } catch(e) { return { statusCode:400, headers:H, body:JSON.stringify({error:'Bad JSON'}) }; }

  // ═══ WORKATO WEBHOOK FORWARD ═══
  if (_workatoPush) {
    if (!_workatoUrl) return { statusCode:400, headers:H, body:JSON.stringify({error:'workatoWebhookUrl required'}) };
    log('Forwarding to Workato: ' + _workatoUrl.slice(0,60));
    try {
      const wRes = await fetch(_workatoUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName:    _wCompany,
          articleTitle:   _wTitle,
          articleContent: _wContent,
          userId:         _wUserId,
        }),
        signal: AbortSignal.timeout(12000),
      });
      const wText = await wRes.text();
      log('Workato response: ' + wRes.status + ' ' + wText.slice(0,120));
      // Try to parse JSON response (contains appUrl if recipe returns it)
      let wData = {};
      try { wData = JSON.parse(wText); } catch(_) {}
      return {
        statusCode: wRes.ok ? 200 : wRes.status,
        headers: H,
        body: JSON.stringify({
          success: wRes.ok,
          appUrl:  wData.appUrl || '',
          docId:   wData.docId  || '',
          projectId: wData.projectId || '',
          _debug: L,
          _workatoStatus: wRes.status,
          _workatoBody: wText.slice(0, 300),
        }),
      };
    } catch(err) {
      log('Workato forward error: ' + err.message);
      return { statusCode:500, headers:H, body:JSON.stringify({error:'Workato forward failed: '+err.message, _debug:L}) };
    }
  }

  // ═══ JASPER WORKSPACE PUSH ═══
  if (_jasperPush) {
    if (!_jasperApiKey) return { statusCode:400, headers:H, body:JSON.stringify({error:'jasperApiKey required'}) };
    const jH = { 'Content-Type':'application/json', 'X-API-Key': _jasperApiKey };
    log('Jasper push: action=' + _action + ' userId=' + jasperUserId + ' key=' + _jasperApiKey.slice(0,12) + '…');
    try {
      // ── Single action: create project + document in one function call ──
      if (_action === 'pushHeroArticle') {
        // Step 1: create Canvas project
        log('Creating project: "' + _projectName + '" for userId=' + jasperUserId);
        const pRes = await fetch('https://api.jasper.ai/v1/projects', {
          method:'POST', headers:jH,
          body:JSON.stringify({ userId:jasperUserId, name:_projectName }),
          signal:AbortSignal.timeout(8000),
        });
        const pText = await pRes.text();
        log('Project response: ' + pRes.status + ' ' + pText.slice(0,120));
        if (!pRes.ok) return { statusCode:pRes.status, headers:H, body:JSON.stringify({error:'Project: '+pText.slice(0,200), _debug:L}) };
        const pData = JSON.parse(pText);
        // data is an array per the spec: { data: [{ id, name, userId }] }
        const projArr = pData.data || pData;
        const proj = Array.isArray(projArr) ? projArr[0] : projArr;
        const projectId = proj.id || proj.projectId || '';
        log('Project id: ' + projectId);

        // Step 2: create document inside the project
        log('Creating document: ' + _docTitle);
        const docBody = { userId:jasperUserId, name:_docTitle||'Hero Article', content:_docContent, status:'DRAFT' };
        if (projectId) docBody.projectId = projectId;
        const dRes = await fetch('https://api.jasper.ai/v1/documents', {
          method:'POST', headers:jH,
          body:JSON.stringify(docBody),
          signal:AbortSignal.timeout(8000),
        });
        const dText = await dRes.text();
        log('Document response: ' + dRes.status + ' ' + dText.slice(0,120));
        if (!dRes.ok) return { statusCode:dRes.status, headers:H, body:JSON.stringify({error:'Document: '+dText.slice(0,200), _debug:L}) };
        const dData = JSON.parse(dText);
        const doc = dData.data || dData;
        const docId = doc.id || '';
        const appUrl = doc.appUrl || proj.appUrl || (docId ? `https://app.jasper.ai/canvas/edit/${docId}` : '');
        log('Done: docId=' + docId + ' appUrl=' + appUrl);
        return { statusCode:200, headers:H, body:JSON.stringify({ projectId, docId, appUrl, _debug:L }) };
      }
      if (_action === 'listUsers') {
        log('Listing Jasper users (paginated)');
        let allUsers = [];
        let page = 1;
        const PER_PAGE = 100;
        const MAX_PAGES = 10; // safety cap = 1000 users max
        while (page <= MAX_PAGES) {
          const r = await fetch('https://api.jasper.ai/v1/users?limit=' + PER_PAGE + '&page=' + page, {
            method:'GET', headers:jH,
            signal:AbortSignal.timeout(6000),
          });
          const t = await r.text();
          log('Users page ' + page + ': ' + r.status + ' (' + t.length + ' chars)');
          if (!r.ok) {
            if (page === 1) return { statusCode:r.status, headers:H, body:JSON.stringify({error:'Users: '+t.slice(0,200), _debug:L}) };
            log('Stopping pagination on page ' + page + ' error');
            break;
          }
          let d; try { d = JSON.parse(t); } catch(e) { log('Parse err page '+page); break; }
          const arr = Array.isArray(d.data) ? d.data : (Array.isArray(d.users) ? d.users : Array.isArray(d) ? d : []);
          if (arr.length === 0) { log('Empty page ' + page + ', stopping'); break; }
          allUsers = allUsers.concat(arr);
          log('Got ' + arr.length + ' users on page ' + page + ' (total: ' + allUsers.length + ')');
          if (arr.length < PER_PAGE) { log('Last page reached'); break; }
          page++;
        }
        const users = allUsers.map(u=>({ id:u.id||u.userId||'', email:u.email||'', name:((u.firstName||'')+' '+(u.lastName||'')).trim() }))
          .sort((a,b) => (a.email||'').localeCompare(b.email||''));
        log('Total users returned: ' + users.length);
        return { statusCode:200, headers:H, body:JSON.stringify({ users, _debug:L }) };
      }
      return { statusCode:400, headers:H, body:JSON.stringify({error:'unknown action: '+_action, _debug:L}) };
    } catch(err) {
      log('Jasper push error: ' + err.message);
      return { statusCode:500, headers:H, body:JSON.stringify({error:'Jasper push failed: '+err.message, _debug:L}) };
    }
  }

  if (!url) return { statusCode:400, headers:H, body:JSON.stringify({error:'url required'}) };

  // ═══ MANUAL MODE: Jasper Command API generates content ═══
  // ── Unsplash: fetch one photo per category keyword, picsum fallback ──
  const CAT_KEYWORDS = {
    Marketing:'marketing creative campaign',AI:'artificial intelligence technology',
    Strategy:'business strategy planning',Growth:'growth success chart',
    Content:'content writing media',Technology:'technology innovation',
    Insights:'data analytics insight',News:'news media journalism',
    Featured:'hero abstract professional',health:'healthcare medical science',
    finserv:'finance banking corporate',ecommerce:'retail shopping lifestyle',
    default:'office professional team',
  };
  const picsumFallback = (slug, category, idx) => {
    const offsets = {Marketing:1000,AI:2000,Strategy:3000,Growth:4000,Content:5000,
      Technology:6000,Insights:7000,News:8000,Featured:9000};
    const offset = offsets[category]||0;
    const hash = String(slug||idx).split('').reduce((a,ch)=>((a<<5)-a+ch.charCodeAt(0))|0,0);
    return `https://picsum.photos/seed/${Math.abs(hash)+offset+(idx*97)}/800/450`;
  };
  // Fetch a pool of Unsplash photos per keyword — one call per category, 6 photos each
  const unsplashPool = {}; // category → [url, url, ...]
  const fetchUnsplashCategory = async (category) => {
    if (!UK || unsplashPool[category]) return;
    const kw = encodeURIComponent(CAT_KEYWORDS[category] || CAT_KEYWORDS.default);
    try {
      const r = await fetch(
        `https://api.unsplash.com/photos/random?query=${kw}&count=6&orientation=landscape&client_id=${UK}`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (!r.ok) { log('Unsplash ' + category + ' ' + r.status); return; }
      const photos = await r.json();
      unsplashPool[category] = (Array.isArray(photos) ? photos : [photos])
        .map(p => p.urls?.regular || p.urls?.small || '').filter(Boolean);
      log('Unsplash ' + category + ': ' + unsplashPool[category].length + ' photos');
    } catch(e) { log('Unsplash err ' + category + ': ' + e.message); }
  };
  const getUnsplashImg = (slug, category, idx) => {
    const pool = unsplashPool[category] || unsplashPool.default || [];
    if (pool.length) return pool[idx % pool.length] + '&w=800&q=80';
    return picsumFallback(slug, category, idx);
  };

  if (manual) {
    if (!OK) return { statusCode:500, headers:H, body:JSON.stringify({error:'OPENAI_API_KEY required for manual mode'}) };
    log('MANUAL mode for: ' + url);
    try {
      const co = url.replace(/https?:\/\//, '').split('/')[0].replace(/\..+/, '');
      log('GPT+images start for: ' + co);

      // ── GPT content + ALL Unsplash calls run in parallel ──
      const allCats = ['Marketing','AI','Strategy','Growth','Content','Technology','News','Featured'];
      const unsplashP = Promise.all(allCats.map(cat => fetchUnsplashCategory(cat))).catch(() => {});
      const heroP = UK ? fetch(
        `https://api.unsplash.com/photos/random?query=${encodeURIComponent(co + ' business professional')}&orientation=landscape&client_id=${UK}`,
        { signal: AbortSignal.timeout(3000) }
      ).then(r => r.ok ? r.json() : null).then(p => p ? (p.urls?.regular || '') + '&w=1600&q=85' : '').catch(() => '')
      : Promise.resolve('');

      const gptP = fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OK },
        body: JSON.stringify({
          model: 'gpt-4o-mini', max_tokens: 1200,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Return only valid JSON. No markdown.' },
            { role: 'user', content: `Generate a content hub for "${co}". JSON only:
{"articles":[{"title":"","summary":"2 sentences","category":"Marketing|AI|Strategy|Growth|Content|Technology","slug":"lowercase-hyphen"}],"news":[{"title":"","summary":"1 sentence","slug":""}],"aboutText":"2 paragraphs"}
6 articles + 6 news. Authentic to ${co}'s industry.` },
          ],
        }),
        signal: AbortSignal.timeout(8000),
      }).then(async r => {
        if (!r.ok) throw new Error('GPT ' + r.status);
        const d = await r.json();
        return JSON.parse(d.choices[0].message.content);
      }).catch(e => {
        log('GPT err: ' + e.message + ' — using placeholders');
        const cats = ['Marketing','AI','Strategy','Growth','Content','Technology'];
        return {
          articles: cats.map((cat, i) => ({
            title: co + ': ' + cat + ' Insights', summary: 'How ' + co + ' approaches ' + cat.toLowerCase() + '.',
            category: cat, slug: cat.toLowerCase() + '-insights-' + i,
          })),
          news: ['Product Updates','Industry Leader','New Partnerships','Customer Success','State of Industry','Virtual Summit'].map((t,i) => ({
            title: co + ' ' + t, summary: 'The latest from ' + co + '.', slug: t.toLowerCase().replace(/\s+/g,'-'),
          })),
          aboutText: co + ' helps teams create, collaborate, and grow.',
        };
      });

      // Wait for ALL in parallel — total ~3-5s
      const [parsed, _img, heroImageUrl] = await Promise.all([gptP, unsplashP, heroP]);
      log('GPT+images done: ' + (parsed.articles?.length||0) + ' articles, hero=' + (heroImageUrl?'yes':'no'));

      // Fill gaps
      const ph = (t, i) => ({ title: t==='news'?'Update '+(i+1):'Article '+(i+1), summary:'From '+co+'.', slug:t+'-'+i, category:t==='news'?'News':'Insights' });
      const arts = parsed.articles || []; const nws = parsed.news || [];
      while (arts.length < 6) arts.push(ph('article', arts.length));
      while (nws.length < 6) nws.push(ph('news', nws.length));

      const mkItem = (a, i, t) => ({
        id: t+'-'+i, title: String(a.title||t+' '+(i+1)), summary: String(a.summary||''),
        imageUrl: getUnsplashImg(a.slug||(a.title||t+'-'+i), a.category||(t==='news'?'News':'Insights'), i),
        imageSource: UK ? 'unsplash' : 'picsum',
        slug: String(a.slug||(a.title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||t+'-'+i),
        category: String(a.category||(t==='news'?'News':'Insights')),
        readTime: t==='news'?'2 min read':'5 min read',
        date: new Date(Date.now()-i*86400000*3).toISOString().slice(0,10),
        body: '<p>'+(a.summary||'Coming soon.')+'</p>',
        source:'manual', isNew:false, jasperDocId:null, jasperDocUrl:null,
      });

      log('DONE manual '+((Date.now()-T)/1000).toFixed(1)+'s');
      return { statusCode:200, headers:H, body:JSON.stringify({
        _debug:L, companyName:co,
        brandPrimary:'#0f172a', brandAccent:'#6366f1',
        brandBg:'#f9f7f4', brandText:'#1a1a2e', brandHeaderText:'#ffffff',
        logoUrl:'', heroHeadline:'Insights & Resources',
        heroSubheading:'Expert thinking to help your team move faster.',
        heroImageUrl: heroImageUrl || '',
        articles: arts.slice(0,6).map((a,i) => mkItem(a,i,'article')),
        news: nws.slice(0,6).map((a,i) => mkItem(a,i,'news')),
        aboutText: String(parsed.aboutText||'A modern content hub.'),
        products:[], featuredArticle:null,
      })};
    } catch (err) {
      log('MANUAL ERROR: ' + err.message);
      return { statusCode:500, headers:H, body:JSON.stringify({error:String(err.message), _debug:L}) };
    }
  }

  const clean = url.startsWith('http') ? url : 'https://'+url;
  const domain = clean.replace(/https?:\/\//,'').split('/')[0];
  log('START '+domain+' art='+(articleUrl||'none'));

  const getItemImage = (slug, category, idx) => {
    const CAT_OFFSET = {Marketing:1000,AI:2000,Strategy:3000,Growth:4000,Content:5000,
      Technology:6000,Insights:7000,News:8000,Featured:9000};
    const offset = CAT_OFFSET[category] || 0;
    const hash = String(slug||idx).split('').reduce((a,ch)=>((a<<5)-a+ch.charCodeAt(0))|0, 0);
    const seed = Math.abs(hash) + offset + (idx * 97);
    return `https://picsum.photos/seed/${seed}/800/450`;
  };

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

  // ── Prefetch Unsplash image pools for scrape branch ──
  // Fire-and-forget in parallel with GPT so they arrive together
  const scrapeUnsplashFetch = UK ? Promise.all(
    Object.keys(CAT_KEYWORDS).map(cat => fetchUnsplashCategory(cat))
  ) : Promise.resolve();

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
    if (!OK) return { statusCode:500, headers:H, body:JSON.stringify({error:'OPENAI_API_KEY required for scrape mode', _debug:L}) };
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
    await scrapeUnsplashFetch; // ensure image pools ready
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
      imageUrl: a.imageUrl || (realArticles[i]?.image) || getUnsplashImg(a.slug||(a.title||t+'-'+i), a.category||(t==='news'?'News':'Insights'), i),
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
