(() => {
  'use strict';

  const API = '/api/tmdb';   // serverless proxy that holds the TMDB key (api/tmdb.js)
  const IMG = 'https://image.tmdb.org/t/p/';

  // Search tuning
  const MAX_DEGREES = 6;          // films in the chain
  const MAX_CALLS = 2500;         // hard budget per search
  const LAYER_CAP = 160;          // nodes expanded per layer, most prominent first
  const MIN_VOTES = 25;           // ignore obscure films
  const MAX_BILLING = 25;         // only the top-billed cast of a film
  const CONCURRENCY = 10;
  const SELF_ROLE = /\b(self|himself|herself|themselves|archive|uncredited)\b/i;
  const DOCUMENTARY = 99;

  const DEFAULT_PAIR = [
    { id: 4724, name: 'Kevin Bacon', profile_path: null },
    { id: 505710, name: 'Zendaya', profile_path: null },
  ];

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- API
  const cache = new Map();
  let calls = 0;

  async function tmdb(path, params = {}, signal) {
    const qs = new URLSearchParams({ path, ...params });
    const url = `${API}?${qs}`;
    if (cache.has(url)) return cache.get(url);
    const p = (async () => {
      for (let attempt = 0; ; attempt++) {
        calls++;
        const res = await fetch(url, { signal });
        if (res.status === 429 && attempt < 4) {
          const wait = Number(res.headers.get('Retry-After')) * 1000 || 500 * 2 ** attempt;
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const err = new Error(body.error || `TMDB answered ${res.status} for ${path}`);
          err.fatal = res.status >= 500 && /TMDB_API_KEY/.test(err.message);
          throw err;
        }
        return res.json();
      }
    })();
    cache.set(url, p);
    p.catch(() => cache.delete(url));
    return p;
  }

  // Run fn over items with a fixed number of requests in flight.
  async function pool(items, fn, stop) {
    let i = 0;
    const worker = async () => {
      while (i < items.length && !stop()) {
        const item = items[i++];
        await fn(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  }

  const img = (path, size) => (path ? `${IMG}${size}${path}` : null);
  const year = (d) => (d ? d.slice(0, 4) : '');

  // ---------------------------------------------------------------- Graph
  // Bipartite graph: people (p:ID) and films (m:ID). An edge means the person
  // has an on-screen role in the film. Bidirectional BFS from both actors.
  const info = new Map();   // key -> { kind, id, name, image, year, weight }
  const roles = new Map();  // "p:ID|m:ID" -> character

  const roleKey = (a, b) => (a[0] === 'p' ? `${a}|${b}` : `${b}|${a}`);

  function remember(key, data) {
    const prev = info.get(key);
    if (!prev || (data.weight || 0) > (prev.weight || 0)) info.set(key, { ...prev, ...data });
  }

  async function neighbors(key, signal) {
    const [kind, id] = key.split(':');
    if (kind === 'p') {
      const data = await tmdb(`/person/${id}/movie_credits`, {}, signal);
      const out = [];
      const seen = new Set();
      for (const c of data.cast || []) {
        if (seen.has(c.id)) continue;
        if ((c.genre_ids || []).includes(DOCUMENTARY)) continue;
        if ((c.vote_count || 0) < MIN_VOTES) continue;
        if (!c.release_date || SELF_ROLE.test(c.character || '')) continue;
        seen.add(c.id);
        const m = `m:${c.id}`;
        remember(m, { kind: 'm', id: c.id, name: c.title, image: c.poster_path, year: year(c.release_date), weight: c.vote_count });
        roles.set(roleKey(key, m), c.character || '');
        out.push(m);
      }
      return out;
    }
    const data = await tmdb(`/movie/${id}/credits`, {}, signal);
    const out = [];
    for (const c of data.cast || []) {
      if ((c.order ?? 0) >= MAX_BILLING) continue;
      if (SELF_ROLE.test(c.character || '')) continue;
      const p = `p:${c.id}`;
      remember(p, { kind: 'p', id: c.id, name: c.name, image: c.profile_path, weight: c.popularity || 0 });
      roles.set(roleKey(p, key), c.character || '');
      out.push(p);
    }
    return out;
  }

  async function findChain(a, b, { signal, onProgress }) {
    const src = `p:${a.id}`, dst = `p:${b.id}`;
    remember(src, { kind: 'p', id: a.id, name: a.name, image: a.profile_path, weight: 1e9 });
    remember(dst, { kind: 'p', id: b.id, name: b.name, image: b.profile_path, weight: 1e9 });
    if (src === dst) return [src];

    const sides = [
      { parent: new Map([[src, null]]), frontier: [src], depth: 0 },
      { parent: new Map([[dst, null]]), frontier: [dst], depth: 0 },
    ];
    const stats = { films: new Set(), people: new Set([src, dst]) };
    calls = 0;

    const maxEdges = MAX_DEGREES * 2;
    while (sides[0].frontier.length && sides[1].frontier.length) {
      if (sides[0].depth + sides[1].depth >= maxEdges) return null;
      if (calls >= MAX_CALLS) throw new Error('budget');

      // Grow the smaller search; it's the cheaper one to extend.
      const s = sides[0].frontier.length <= sides[1].frontier.length ? 0 : 1;
      const me = sides[s], other = sides[1 - s];

      const layer = [...me.frontier]
        .sort((x, y) => (info.get(y)?.weight || 0) - (info.get(x)?.weight || 0))
        .slice(0, LAYER_CAP);
      const next = [];
      let meet = null;

      await pool(layer, async (node) => {
        let ns;
        try { ns = await neighbors(node, signal); }
        catch (e) { if (e.name === 'AbortError' || e.fatal) throw e; return; }
        onProgress({ node, stats });
        for (const n of ns) {
          (n[0] === 'm' ? stats.films : stats.people).add(n);
          if (me.parent.has(n)) continue;
          me.parent.set(n, node);
          next.push(n);
          if (!meet && other.parent.has(n)) meet = n;
        }
      }, () => meet !== null || signal.aborted);

      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      me.depth++;
      me.frontier = next;
      if (meet) return stitch(meet, sides[0].parent, sides[1].parent);
    }
    return null;
  }

  function stitch(meet, pa, pb) {
    const left = [];
    for (let n = meet; n; n = pa.get(n)) left.unshift(n);
    const right = [];
    for (let n = pb.get(meet); n; n = pb.get(n)) right.push(n);
    return [...left, ...right];
  }

  // ---------------------------------------------------------------- Pickers
  const picked = { a: null, b: null };

  function setPick(side, person) {
    picked[side] = person;
    const input = $(`input-${side}`);
    const face = $(`face-${side}`);
    input.value = person ? person.name : '';
    const src = person && img(person.profile_path, 'w185');
    face.hidden = !src;
    if (src) face.src = src;
    input.closest('.picker').classList.toggle('has-face', !!src);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function wirePicker(side) {
    const input = $(`input-${side}`);
    const list = $(`list-${side}`);
    let results = [];
    let active = -1;
    let seq = 0;

    const close = () => { list.hidden = true; active = -1; };
    const choose = (i) => { if (results[i]) { setPick(side, results[i]); close(); } };
    const highlight = () => {
      [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    };

    const search = debounce(async (q) => {
      const mine = ++seq;
      if (q.trim().length < 2) { close(); return; }
      try {
        const data = await tmdb('/search/person', { query: q.trim(), include_adult: 'false' });
        if (mine !== seq) return;
        results = (data.results || [])
          .filter((p) => p.known_for_department === 'Acting' || (p.known_for || []).length)
          .slice(0, 7);
        list.innerHTML = '';
        if (!results.length) {
          list.innerHTML = '<li class="empty">No actors match that name.</li>';
        }
        results.forEach((p, i) => {
          const li = document.createElement('li');
          li.setAttribute('role', 'option');
          const face = img(p.profile_path, 'w92');
          const known = (p.known_for || []).map((k) => k.title || k.name).filter(Boolean).slice(0, 3).join(', ');
          li.innerHTML = `${face ? `<img alt="" src="${face}">` : '<span class="noface"></span>'}
            <span><span class="nm"></span><span class="kf"></span></span>`;
          li.querySelector('.nm').textContent = p.name;
          li.querySelector('.kf').textContent = known || p.known_for_department || '';
          li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
          list.appendChild(li);
        });
        active = results.length ? 0 : -1;
        highlight();
        list.hidden = false;
      } catch (e) {
        showMessage(e.message);
      }
    }, 220);

    input.addEventListener('input', () => {
      picked[side] = null;
      $(`face-${side}`).hidden = true;
      input.closest('.picker').classList.remove('has-face');
      search(input.value);
    });
    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { active = Math.min(active + 1, results.length - 1); highlight(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); highlight(); e.preventDefault(); }
      else if (e.key === 'Enter' && active >= 0) { choose(active); e.preventDefault(); }
      else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => setTimeout(close, 120));
  }

  // ---------------------------------------------------------------- Run
  let controller = null;
  let timer = null;

  function showMessage(text) {
    const m = $('message');
    m.textContent = text;
    m.hidden = !text;
  }

  function setCounters(stats, started) {
    $('c-films').textContent = stats.films.size.toLocaleString();
    $('c-people').textContent = stats.people.size.toLocaleString();
    $('c-calls').textContent = calls.toLocaleString();
    $('c-time').textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`;
  }

  async function run() {
    if (!picked.a || !picked.b) {
      showMessage('Pick an actor from the suggestions in both boxes, then search again.');
      return;
    }
    if (controller) controller.abort();
    controller = new AbortController();
    const { signal } = controller;

    location.hash = `from=${picked.a.id}&to=${picked.b.id}`;
    showMessage('');
    $('result').hidden = true;
    $('stage').classList.add('searching');
    $('go').disabled = true;
    $('cancel').hidden = false;
    $('ticker').innerHTML = '&nbsp;';

    const started = performance.now();
    let lastStats = { films: new Set(), people: new Set() };
    timer = setInterval(() => setCounters(lastStats, started), 100);

    try {
      const chain = await findChain(picked.a, picked.b, {
        signal,
        onProgress: ({ node, stats }) => {
          lastStats = stats;
          const n = info.get(node);
          if (n) {
            const what = n.kind === 'm' ? `the cast of <b></b>` : `the films of <b></b>`;
            $('ticker').innerHTML = `Reading ${what}`;
            $('ticker').querySelector('b').textContent = n.kind === 'm' ? `${n.name} (${n.year})` : n.name;
          }
        },
      });
      setCounters(lastStats, started);
      if (!chain) {
        showMessage(`No chain within ${MAX_DEGREES} films. One of them may only have documentary or self credits, or be too obscure for the search to reach.`);
      } else {
        render(chain);
      }
    } catch (e) {
      if (e.name === 'AbortError') showMessage('Search stopped.');
      else if (e.message === 'budget') showMessage(`Stopped after ${MAX_CALLS.toLocaleString()} API calls without a match. These two are unusually far apart.`);
      else showMessage(e.message);
    } finally {
      clearInterval(timer);
      $('stage').classList.remove('searching');
      $('go').disabled = false;
      $('cancel').hidden = true;
      $('ticker').innerHTML = '&nbsp;';
    }
  }

  function render(chain) {
    const degrees = (chain.length - 1) / 2;
    const first = info.get(chain[0]).name;
    const last = info.get(chain[chain.length - 1]).name;
    const v = $('verdict');
    if (degrees === 0) {
      v.textContent = 'That is the same person twice.';
    } else {
      v.innerHTML = `<span></span> is <em>${degrees}</em> ${degrees === 1 ? 'film' : 'films'} from <span></span>`;
      const [s1, s2] = v.querySelectorAll('span');
      s1.textContent = first;
      s2.textContent = last;
    }

    const strip = $('strip');
    strip.innerHTML = '';
    chain.forEach((key, i) => {
      const n = info.get(key);
      if (i > 0) {
        const link = document.createElement('li');
        link.className = 'link';
        link.setAttribute('aria-hidden', 'true');
        link.style.setProperty('--i', i * 2 - 1);
        strip.appendChild(link);
      }
      const li = document.createElement('li');
      li.style.display = 'contents';
      const a = document.createElement('a');
      a.className = `frame ${n.kind === 'p' ? 'person' : 'movie'}${i === 0 || i === chain.length - 1 ? ' endpoint' : ''}`;
      a.href = `https://www.themoviedb.org/${n.kind === 'p' ? 'person' : 'movie'}/${n.id}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.setProperty('--i', i * 2);
      const src = img(n.image, 'w185');
      const pic = src ? document.createElement('img') : document.createElement('div');
      pic.className = 'pic' + (src ? '' : ' noimg');
      if (src) { pic.src = src; pic.alt = ''; pic.loading = 'lazy'; }
      else pic.textContent = n.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = n.name;
      a.append(pic, t);
      if (n.kind === 'm') {
        const s = document.createElement('span');
        s.className = 's';
        s.textContent = n.year;
        a.append(s);
      }
      li.appendChild(a);
      strip.appendChild(li);
    });

    const story = $('story');
    story.innerHTML = '';
    for (let i = 1; i < chain.length; i += 2) {
      const p1 = info.get(chain[i - 1]), m = info.get(chain[i]), p2 = info.get(chain[i + 1]);
      const r1 = roles.get(roleKey(chain[i - 1], chain[i]));
      const r2 = roles.get(roleKey(chain[i + 1], chain[i]));
      const li = document.createElement('li');
      li.innerHTML = `<span class="deg"></span><span><strong></strong><span class="role"></span> and <strong></strong><span class="role"></span> are both in <strong></strong> (<span class="yr"></span>).</span>`;
      li.querySelector('.deg').textContent = String((i + 1) / 2);
      const strongs = li.querySelectorAll('strong');
      const rs = li.querySelectorAll('.role');
      strongs[0].textContent = p1.name;
      strongs[1].textContent = p2.name;
      strongs[2].textContent = m.name;
      rs[0].textContent = r1 ? ` (as ${r1})` : '';
      rs[1].textContent = r2 ? ` (as ${r2})` : '';
      li.querySelector('.yr').textContent = m.year;
      story.appendChild(li);
    }

    $('result').hidden = false;
  }

  async function surprise() {
    try {
      const pages = await Promise.all([1, 2, 3].map((page) => tmdb('/person/popular', { page })));
      const pool = pages.flatMap((d) => d.results || []).filter((p) => p.known_for_department === 'Acting');
      if (pool.length < 2) throw new Error('TMDB returned too few popular actors to pick from.');
      const i = Math.floor(Math.random() * pool.length);
      let j = Math.floor(Math.random() * (pool.length - 1));
      if (j >= i) j++;
      setPick('a', pool[i]);
      setPick('b', pool[j]);
      run();
    } catch (e) {
      showMessage(e.message);
    }
  }

  async function loadPerson(id) {
    const p = await tmdb(`/person/${id}`);
    return { id: p.id, name: p.name, profile_path: p.profile_path };
  }

  async function boot() {
    wirePicker('a');
    wirePicker('b');
    $('pair-form').addEventListener('submit', (e) => { e.preventDefault(); run(); });
    $('random').addEventListener('click', surprise);
    $('cancel').addEventListener('click', () => controller && controller.abort());
    $('swap').addEventListener('click', () => {
      const a = picked.a, b = picked.b;
      setPick('a', b);
      setPick('b', a);
    });

    const h = new URLSearchParams(location.hash.slice(1));
    const ids = [h.get('from'), h.get('to')].filter((x) => /^\d+$/.test(x || ''));
    try {
      const pair = ids.length === 2
        ? await Promise.all(ids.map(loadPerson))
        : await Promise.all(DEFAULT_PAIR.map((p) => loadPerson(p.id)));
      setPick('a', pair[0]);
      setPick('b', pair[1]);
      run();
    } catch (e) {
      setPick('a', DEFAULT_PAIR[0]);
      setPick('b', DEFAULT_PAIR[1]);
      showMessage(e.message);
    }
  }

  boot();
})();
