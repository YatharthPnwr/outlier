// Outlier — sort an Instagram profile's posts/reels by views, likes, comments,
// outlier score, or age. Runs as a content script; all API calls are same-origin
// and ride on the logged-in session's cookies.

(() => {
  'use strict';

  const IG_APP_ID = '936619743392459070';
  const ASBD_ID = '129477';
  const PAGE_SIZE = 12; // clips endpoint caps around 12 per page
  const FEED_PAGE_SIZE = 33;
  // Relay doc id for PolarisProfileReelsTabContentQuery_connection — the query
  // Instagram's own web app fires when the reels grid paginates (sniffed live).
  const REELS_DOC_ID = '28237651492507044';
  const REELS_FRIENDLY = 'PolarisProfileReelsTabContentQuery_connection';
  // Instagram media pk encodes creation time: ms = (pk >> 23) + IG_EPOCH_MS
  const IG_EPOCH_MS = 1314220021721n;
  const RESERVED_PATHS = new Set([
    'explore', 'reels', 'stories', 'direct', 'accounts', 'p', 'tv',
    'challenge', 'about', 'developer', 'legal', 'session', 'graphql', 'api',
  ]);

  const POST_LIMITS = [
    { label: 'Latest 25 Posts', value: 25 },
    { label: 'Latest 50 Posts', value: 50 },
    { label: 'Latest 100 Posts', value: 100 },
    { label: 'Latest 200 Posts', value: 200 },
    { label: 'Latest 1K Posts', value: 1000 },
    { label: 'All Posts', value: Infinity },
    { label: 'Custom Posts…', value: 'custom' },
  ];

  const DATE_RANGES = [
    { label: 'Posts from 1 Week Back', days: 7 },
    { label: 'Posts from 1 Month Back', days: 30 },
    { label: 'Posts from 3 Months Back', days: 91 },
    { label: 'Posts from 6 Months Back', days: 182 },
    { label: 'Posts from 1 Year Back', days: 365 },
    { label: 'All Posts', days: Infinity },
    { label: 'Custom Date…', days: 'custom' },
  ];

  const SORTS = [
    { id: 'likes', label: 'Likes', icon: '♥' },
    { id: 'views', label: 'Views', icon: '▶' },
    { id: 'outlier', label: 'Outlier score', icon: '⚡' },
    { id: 'comments', label: 'Comments', icon: '💬' },
    { id: 'oldest', label: 'Oldest', icon: '🕓' },
  ];

  const state = {
    filterMode: 'posts',          // 'posts' | 'date'
    postLimit: 25,
    dateDays: 7,
    sortId: 'views',              // selected criterion; fetch starts only on Sort click
    fetching: false,
    abort: false,
    username: null,
    cache: new Map(),             // `${userId}` -> { items, fetchedAll }
    hiddenGrid: null,
  };

  // ---------------------------------------------------------------- utils

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const getCookie = (name) =>
    document.cookie.split('; ').find((c) => c.startsWith(name + '='))?.split('=')[1] ?? '';

  const fmt = (n) => {
    if (n == null) return '–';
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'K';
    if (n < 1e9) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  };

  const fmtDate = (ts) =>
    new Date(ts * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });

  function profileUsername() {
    const m = location.pathname.match(/^\/([A-Za-z0-9._]+)\/?(reels\/?)?$/);
    if (!m) return null;
    const name = m[1].toLowerCase();
    return RESERVED_PATHS.has(name) ? null : m[1];
  }

  const onReelsTab = () => /\/reels\/?$/.test(location.pathname);

  // ---------------------------------------------------------------- API

  async function apiGet(url) {
    const res = await fetch(url, {
      headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest' },
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`Instagram returned ${res.status}`);
    return res.json();
  }

  // The user id is embedded in the profile page's inline JSON payloads —
  // no API call needed. Fallbacks: web_profile_info, then raw profile HTML.
  function userIdFromScripts(username, root) {
    const esc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const res = [
      new RegExp(`"username":"${esc}"[^{}]{0,400}?"(?:pk|pk_id|id|profile_id)":"(\\d{3,})"`, 'i'),
      new RegExp(`"(?:pk|pk_id|id|profile_id)":"(\\d{3,})"[^{}]{0,400}?"username":"${esc}"`, 'i'),
      new RegExp(`profilePage_(\\d{3,})`),
    ];
    // Regex-major order: username-paired matches beat the generic profilePage_
    // marker, which can be stale after SPA navigation between profiles.
    const scripts = [...root.querySelectorAll('script')]
      .map((s) => s.textContent || '')
      .filter((t) => t.toLowerCase().includes(username.toLowerCase()) || t.includes('profilePage_'));
    for (const re of res) {
      for (const t of scripts) {
        const m = t.match(re);
        if (m) return m[1];
      }
    }
    return null;
  }

  async function getUserId(username) {
    let id = userIdFromScripts(username, document);
    if (id) return id;

    try {
      const json = await apiGet(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`
      );
      id = json?.data?.user?.id;
      if (id) return id;
    } catch { /* endpoint 404s on some sessions — fall through */ }

    const res = await fetch(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
      credentials: 'include',
    });
    if (res.ok) {
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      id = userIdFromScripts(username, doc);
      if (id) return id;
    }
    throw new Error('Could not resolve user id — make sure you are logged in to Instagram.');
  }

  // lsd + fb_dtsg tokens live in the page's inline scripts; required by /api/graphql.
  let pageTokens = null;
  function getPageTokens() {
    if (pageTokens?.lsd) return pageTokens;
    let lsd = null, dtsg = null;
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent || '';
      if (!lsd) lsd = t.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1] ?? null;
      if (!dtsg) dtsg = t.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/)?.[1] ?? null;
      if (lsd && dtsg) break;
    }
    pageTokens = { lsd, dtsg };
    return pageTokens;
  }

  async function fetchClipsPage(userId, cursor) {
    const { lsd, dtsg } = getPageTokens();
    if (!lsd) throw new Error('page token missing — reload the page');
    const variables = JSON.stringify({
      after: cursor ?? null,
      first: PAGE_SIZE,
      data: { include_feed_video: true, page_size: PAGE_SIZE, target_user_id: userId },
      id: userId,
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true,
    });
    const body = new URLSearchParams({
      fb_api_req_friendly_name: REELS_FRIENDLY,
      doc_id: REELS_DOC_ID,
      variables,
      server_timestamps: 'true',
      lsd,
    });
    if (dtsg) body.set('fb_dtsg', dtsg);
    const res = await fetch('https://www.instagram.com/api/graphql', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-csrftoken': decodeURIComponent(getCookie('csrftoken')),
        'x-ig-app-id': IG_APP_ID,
        'x-fb-friendly-name': REELS_FRIENDLY,
        'x-fb-lsd': lsd,
        'x-asbd-id': ASBD_ID,
      },
      body,
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`reels endpoint returned ${res.status} — try reloading the page`);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text.replace(/^for \(;;\);/, '')); } catch {
      throw new Error('reels endpoint returned non-JSON — reload the page and make sure you are logged in');
    }
    const conn = json?.data?.fetch__XDTUserDict?.clips_connection
      ?? json?.data?.xdt_api__v1__clips__user__connection_v2;
    if (!conn) {
      const msg = json?.errors?.[0]?.message || 'unexpected response shape';
      throw new Error(`reels endpoint: ${msg}`);
    }
    return {
      medias: (conn.edges || []).map((e) => e?.node?.media).filter(Boolean),
      maxId: conn.page_info?.end_cursor ?? null,
      more: Boolean(conn.page_info?.has_next_page),
    };
  }

  async function fetchFeedPage(userId, maxId) {
    // Primary: feed by user id. Fallback: feed by username (id variant 404s on some sessions).
    const urls = [
      `https://www.instagram.com/api/v1/feed/user/${userId}/?count=${FEED_PAGE_SIZE}`,
      state.username
        ? `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(state.username)}/username/?count=${FEED_PAGE_SIZE}`
        : null,
    ].filter(Boolean);

    let lastErr;
    for (let url of urls) {
      if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;
      try {
        const json = await apiGet(url);
        return {
          medias: json.items || [],
          maxId: json.next_max_id ?? null,
          more: Boolean(json.more_available),
        };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`posts endpoint failed (${lastErr?.message}) — try the Reels tab`);
  }

  function takenAtFromPk(pk) {
    try { return Number((BigInt(pk) >> 23n) + IG_EPOCH_MS) / 1000; } catch { return 0; }
  }

  function normalize(media) {
    const views = media.play_count ?? media.view_count ?? media.ig_play_count ?? null;
    const thumb =
      media.image_versions2?.candidates?.[0]?.url ??
      media.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ?? '';
    const code = media.code;
    const isClip = media.product_type === 'clips' || media.media_type === 2;
    return {
      code,
      href: isClip ? `/reel/${code}/` : `/p/${code}/`,
      thumb,
      takenAt: media.taken_at ?? (media.pk ? takenAtFromPk(media.pk) : 0),
      likes: media.like_count ?? 0,
      comments: media.comment_count ?? 0,
      views,
      isVideo: media.media_type === 2,
      isCarousel: media.media_type === 8,
    };
  }

  // Fetch until we hit the post limit / date cutoff / end of profile.
  async function collect(userId, { limit, sinceTs }, onProgress) {
    const useClips = onReelsTab();
    const cacheKey = `${userId}:${useClips ? 'clips' : 'feed'}`;
    const cached = state.cache.get(cacheKey);
    const items = cached ? [...cached.items] : [];
    let fetchedAll = cached?.fetchedAll ?? false;
    let maxId = cached?.maxId ?? null;

    const enough = () => {
      if (fetchedAll) return true;
      if (sinceTs != null) {
        const oldest = items[items.length - 1];
        return oldest ? oldest.takenAt < sinceTs : false;
      }
      return items.length >= limit;
    };

    while (!enough()) {
      if (state.abort) throw new Error('Cancelled');
      onProgress(items.length);
      const page = useClips
        ? await fetchClipsPage(userId, maxId)
        : await fetchFeedPage(userId, maxId);
      items.push(...page.medias.map(normalize));
      maxId = page.maxId;
      if (!page.more || !maxId) { fetchedAll = true; break; }
      await sleep(350 + Math.random() * 400); // be gentle, avoid rate limiting
    }

    state.cache.set(cacheKey, { items, fetchedAll, maxId });

    let out = items;
    if (sinceTs != null) out = out.filter((it) => it.takenAt >= sinceTs);
    else if (Number.isFinite(limit)) out = out.slice(0, limit);
    return out;
  }

  // ---------------------------------------------------------------- sorting

  function sortItems(items, sortId) {
    const arr = [...items];
    switch (sortId) {
      case 'likes':
        return arr.sort((a, b) => b.likes - a.likes);
      case 'comments':
        return arr.sort((a, b) => b.comments - a.comments);
      case 'views':
        return arr.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
      case 'oldest':
        return arr.sort((a, b) => a.takenAt - b.takenAt);
      case 'outlier': {
        // Outlier score: metric vs. the profile's average over the fetched set.
        const hasViews = arr.some((it) => it.views != null);
        const metric = (it) => (hasViews ? it.views ?? 0 : it.likes);
        const avg = arr.reduce((s, it) => s + metric(it), 0) / (arr.length || 1);
        arr.forEach((it) => { it.outlier = avg ? metric(it) / avg : 0; });
        return arr.sort((a, b) => b.outlier - a.outlier);
      }
      default:
        return arr;
    }
  }

  // ---------------------------------------------------------------- grid

  function findGridContainer() {
    const anchors = document.querySelectorAll('main a[href*="/reel/"], main a[href*="/p/"]');
    if (!anchors.length) return null;
    const total = anchors.length;
    let el = anchors[0];
    while (el.parentElement && el.parentElement.tagName !== 'MAIN' && el.parentElement !== document.body) {
      el = el.parentElement;
      const count = el.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]').length;
      if (count >= total) break;
    }
    return el;
  }

  function renderGrid(items, sortId) {
    removeGrid();
    const grid = findGridContainer();
    if (grid) {
      grid.classList.add('sf-hidden-grid');
      state.hiddenGrid = grid;
    }

    const wrap = document.createElement('div');
    wrap.id = 'sf-results';
    items.forEach((it, i) => {
      const a = document.createElement('a');
      a.className = 'sf-tile';
      a.href = it.href;
      a.target = '_blank';
      a.rel = 'noopener';

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = it.thumb;
      img.alt = '';
      a.appendChild(img);

      const rank = document.createElement('span');
      rank.className = 'sf-rank';
      rank.textContent = `#${i + 1}`;
      a.appendChild(rank);

      const meta = document.createElement('span');
      meta.className = 'sf-meta';
      if (sortId === 'oldest') {
        meta.textContent = fmtDate(it.takenAt);
      } else if (sortId === 'outlier') {
        meta.textContent = `⚡ ${it.outlier.toFixed(1)}x · ${it.views != null ? '▶ ' + fmt(it.views) : '♥ ' + fmt(it.likes)}`;
      } else if (sortId === 'comments') {
        meta.textContent = `💬 ${fmt(it.comments)} · ♥ ${fmt(it.likes)}`;
      } else if (sortId === 'likes') {
        meta.textContent = `♥ ${fmt(it.likes)}${it.views != null ? ' · ▶ ' + fmt(it.views) : ''}`;
      } else {
        meta.textContent = `${it.views != null ? '▶ ' + fmt(it.views) + ' · ' : ''}♥ ${fmt(it.likes)}`;
      }
      a.appendChild(meta);
      wrap.appendChild(a);
    });

    const anchor = state.hiddenGrid ?? document.querySelector('main');
    if (!anchor) return;
    if (state.hiddenGrid) anchor.parentElement.insertBefore(wrap, anchor);
    else anchor.appendChild(wrap);
  }

  function removeGrid() {
    document.getElementById('sf-results')?.remove();
    if (state.hiddenGrid) {
      state.hiddenGrid.classList.remove('sf-hidden-grid');
      state.hiddenGrid = null;
    }
  }

  // ---------------------------------------------------------------- panel

  function buildPanel() {
    if (document.getElementById('sf-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'sf-panel';
    panel.innerHTML = `
      <div class="sf-header">
        <span class="sf-logo"><svg viewBox="0 0 128 128" width="18" height="18" xmlns="http://www.w3.org/2000/svg"><rect x="18" y="77" width="18" height="28" rx="6" fill="#5a5c62"/><rect x="45" y="62" width="18" height="43" rx="6" fill="#5a5c62"/><rect x="72" y="31" width="18" height="74" rx="6" fill="#bef23c"/><rect x="99" y="69" width="18" height="36" rx="6" fill="#5a5c62"/><g stroke="#bef23c" stroke-width="4" stroke-linecap="round"><line x1="71" y1="16" x2="91" y2="16"/><line x1="81" y1="6" x2="81" y2="26"/><line x1="74" y1="9" x2="88" y2="23"/><line x1="74" y1="23" x2="88" y2="9"/></g></svg></span>
        <span class="sf-title">Outlier</span>
        <span class="sf-badge">Free</span>
        <button class="sf-min" title="Minimize">–</button>
      </div>
      <div class="sf-body">
        <div class="sf-label">Filters</div>
        <div class="sf-tabs">
          <button class="sf-tab sf-active" data-mode="posts">▦ Posts</button>
          <button class="sf-tab" data-mode="date">🗓 Date</button>
        </div>
        <div class="sf-select-wrap">
          <select id="sf-posts-select"></select>
          <select id="sf-date-select" class="sf-hidden"></select>
        </div>
        <div class="sf-label">Sort by</div>
        <div class="sf-sorts"></div>
        <button id="sf-go" class="sf-go">Sort</button>
        <div class="sf-status" id="sf-status"></div>
        <button id="sf-reset" class="sf-reset sf-hidden">Restore original feed</button>
      </div>
    `;
    document.body.appendChild(panel);

    const postsSel = panel.querySelector('#sf-posts-select');
    POST_LIMITS.forEach((o, i) => postsSel.add(new Option(o.label, i)));
    const dateSel = panel.querySelector('#sf-date-select');
    DATE_RANGES.forEach((o, i) => dateSel.add(new Option(o.label, i)));

    panel.querySelector('.sf-header').addEventListener('click', () => {
      panel.classList.toggle('sf-collapsed');
    });

    panel.querySelectorAll('.sf-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        panel.querySelectorAll('.sf-tab').forEach((t) => t.classList.remove('sf-active'));
        tab.classList.add('sf-active');
        state.filterMode = tab.dataset.mode;
        postsSel.classList.toggle('sf-hidden', state.filterMode !== 'posts');
        dateSel.classList.toggle('sf-hidden', state.filterMode !== 'date');
      });
    });

    postsSel.addEventListener('change', () => {
      const opt = POST_LIMITS[Number(postsSel.value)];
      if (opt.value === 'custom') {
        const n = parseInt(prompt('How many latest posts?', '300') ?? '', 10);
        if (n > 0) state.postLimit = n;
        else postsSel.value = '0';
      } else {
        state.postLimit = opt.value;
      }
    });

    dateSel.addEventListener('change', () => {
      const opt = DATE_RANGES[Number(dateSel.value)];
      if (opt.days === 'custom') {
        const d = prompt('Posts since date (YYYY-MM-DD)?', '');
        const ts = d ? Date.parse(d) : NaN;
        if (!Number.isNaN(ts)) state.dateDays = (Date.now() - ts) / 86400000;
        else dateSel.value = '0';
      } else {
        state.dateDays = opt.days;
      }
    });

    // Clicking a criterion only selects it; fetching starts on the Sort button.
    const sorts = panel.querySelector('.sf-sorts');
    SORTS.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'sf-sort' + (s.id === state.sortId ? ' sf-active' : '');
      b.dataset.sortId = s.id;
      b.innerHTML = `<span class="sf-sort-icon">${s.icon}</span>${s.label}`;
      b.addEventListener('click', () => {
        state.sortId = s.id;
        panel.querySelectorAll('.sf-sort').forEach((x) => x.classList.remove('sf-active'));
        b.classList.add('sf-active');
      });
      sorts.appendChild(b);
    });

    panel.querySelector('#sf-go').addEventListener('click', () => runSort(state.sortId));

    panel.querySelector('#sf-reset').addEventListener('click', () => {
      removeGrid();
      setStatus('');
      panel.querySelector('#sf-reset').classList.add('sf-hidden');
      panel.querySelectorAll('.sf-sort').forEach((b) => b.classList.remove('sf-active'));
    });
  }

  function setStatus(msg, isError = false) {
    const el = document.getElementById('sf-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('sf-error', isError);
  }

  async function runSort(sortId) {
    if (state.fetching) { state.abort = true; return; }
    const username = profileUsername();
    if (!username) { setStatus('Open a profile page first.', true); return; }

    const panel = document.getElementById('sf-panel');
    const goBtn = panel.querySelector('#sf-go');
    goBtn.textContent = 'Cancel';

    state.fetching = true;
    state.abort = false;
    try {
      setStatus('Resolving profile…');
      const userId = await getUserId(username);

      const opts = state.filterMode === 'date'
        ? { sinceTs: Number.isFinite(state.dateDays) ? Date.now() / 1000 - state.dateDays * 86400 : null, limit: Infinity }
        : { limit: state.postLimit, sinceTs: null };
      if (state.filterMode === 'date' && opts.sinceTs == null) opts.limit = Infinity;

      const items = await collect(userId, opts, (n) => setStatus(`Fetching posts… ${n} so far`));
      if (!items.length) { setStatus('No posts found for this filter.', true); return; }

      const sorted = sortItems(items, sortId);
      renderGrid(sorted, sortId);
      setStatus(`Sorted ${sorted.length} posts by ${SORTS.find((s) => s.id === sortId).label.toLowerCase()}.`);
      panel.querySelector('#sf-reset').classList.remove('sf-hidden');
    } catch (err) {
      setStatus(err.message === 'Cancelled' ? 'Cancelled.' : `Error: ${err.message}`, true);
    } finally {
      state.fetching = false;
      state.abort = false;
      goBtn.textContent = 'Sort';
    }
  }

  // ---------------------------------------------------------------- SPA nav

  function onNavigate() {
    const username = profileUsername();
    const panel = document.getElementById('sf-panel');
    if (username) {
      buildPanel();
      if (state.username && state.username !== username) {
        removeGrid();
        setStatus('');
        document.getElementById('sf-reset')?.classList.add('sf-hidden');
      }
      state.username = username;
      document.getElementById('sf-panel').classList.remove('sf-hidden');
    } else if (panel) {
      panel.classList.add('sf-hidden');
      removeGrid();
    }
  }

  let lastHref = '';
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onNavigate();
    }
  }, 500);

  onNavigate();
})();
