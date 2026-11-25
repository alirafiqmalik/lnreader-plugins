// Offline test kit for plugins/multi/patreon.ts. Shared by scripts/test-patreon.js (Node)
// and workflow/scripts/patreon-hermes.mjs (Hermes). It has no imports so that esbuild can
// bundle it for Hermes. It never touches the network: `fetchApi` serves synthetic fixtures
// from scripts/fixtures/patreon/ (made by workflow/scripts/patreon-fixtures.py).
//
// Route-key rule (same as the fixture tool): request path plus only these query parameters:
// filter[campaign_id], filter[collection_id], filter[query], page[cursor], sort.

export const PAID = '72294889'; // paid creator (campaign id in the fixtures)
export const COLLECTION = '5898598'; // its collection
export const FORMER_ID = '1000001'; // synthetic former_patron membership
export const DECLINED_ID = '1000002'; // synthetic declined_patron membership

const KEPT = [
  'filter[campaign_id]',
  'filter[collection_id]',
  'filter[query]',
  'page[cursor]',
  'sort',
];
const JSON_API = 'application/vnd.api+json';
const clone = value => JSON.parse(JSON.stringify(value));

export function keyOf(path, params) {
  const kept = {};
  for (const name of KEPT)
    if (params[name] !== undefined) kept[name] = params[name];
  return path + ' ' + JSON.stringify(kept);
}

// Percent-decodes names and values; '+' is not turned into a space (same as the fixture tool).
export function parseRequest(url) {
  const match = /^https:\/\/www\.patreon\.com(\/[^?#]*)(?:\?([^#]*))?$/.exec(
    url,
  );
  if (!match)
    throw new Error('request outside https://www.patreon.com: ' + url);
  const rawNames = [];
  const names = [];
  const params = {};
  for (const part of (match[2] || '').split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawName = eq < 0 ? part : part.slice(0, eq);
    const name = decodeURIComponent(rawName);
    rawNames.push(rawName);
    names.push(name);
    params[name] = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1));
  }
  return {
    url,
    path: match[1],
    rawQuery: match[2] || '',
    rawNames,
    names,
    params,
    key: keyOf(match[1], params),
  };
}

const R1_KEY = keyOf('/api/current_user', {});
const campaignPageKey = cursor =>
  keyOf('/api/posts', {
    'filter[campaign_id]': PAID,
    sort: 'published_at',
    ...(cursor ? { 'page[cursor]': cursor } : {}),
  });
const ok = body => ({
  status: 200,
  headers: { 'content-type': JSON_API },
  body,
});

// ---------------------------------------------------------------------------
// Fixture table and fake network
// ---------------------------------------------------------------------------

export function buildTable(fixtures) {
  const table = new Map();
  for (const fx of fixtures) {
    table.set(keyOf(fx.routeKey.path, fx.routeKey.params), fx.response);
  }
  return table;
}

// The captured posts of the paid campaign (sort=published_at chain), oldest first.
export function campaignPosts(table) {
  const posts = [];
  let entry = table.get(campaignPageKey());
  while (entry) {
    posts.push(...entry.body.data);
    const next = entry.body.meta.pagination.cursors.next;
    entry = next ? table.get(campaignPageKey(next)) : undefined;
  }
  return posts;
}

function makeHeaders(map) {
  const lower = {};
  for (const name of Object.keys(map || {}))
    lower[name.toLowerCase()] = map[name];
  return { get: name => lower[String(name).toLowerCase()] ?? null };
}

const texts = new WeakMap();
function toResponse(entry) {
  if (!texts.has(entry)) {
    texts.set(
      entry,
      typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body),
    );
  }
  const text = texts.get(entry);
  return {
    ok: entry.status >= 200 && entry.status < 300,
    status: entry.status,
    headers: makeHeaders(entry.headers),
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

// handler: an entry {status, headers, body}, a list of entries (n-th request gets the n-th,
// the last one repeats), or a function (request, n) => entry.
function resolveHandler(handler, req, n) {
  if (typeof handler === 'function') return handler(req, n);
  if (Array.isArray(handler)) return handler[Math.min(n, handler.length - 1)];
  return handler;
}

export function createWorld(table, allRequests) {
  const overrides = new Map();
  const hits = new Map();
  const requests = [];
  async function fetchApi(url, init) {
    const req = parseRequest(url);
    req.init = init;
    requests.push(req);
    allRequests.push(req);
    const n = hits.get(req.key) || 0;
    hits.set(req.key, n + 1);
    let entry;
    if (overrides.has(req.key))
      entry = resolveHandler(overrides.get(req.key), req, n);
    else if (table.has(req.key)) entry = table.get(req.key);
    if (!entry) throw new Error('no fixture for ' + req.key);
    return toResponse(entry);
  }
  return {
    fetchApi,
    requests,
    // Registers (or replaces) the response for one route.
    on: (path, params, handler) => overrides.set(keyOf(path, params), handler),
    to: path => requests.filter(r => r.path === path),
  };
}

// ---------------------------------------------------------------------------
// Synthetic overrides registered by tests (each has a reason; fixtures are never edited)
// ---------------------------------------------------------------------------

// The captured R1 has active_patron, former_patron and free members. No declined_patron was
// captured: add one, plus one more former, placed first so that order alone cannot hide them.
export function syntheticR1(table) {
  const base = table.get(R1_KEY);
  const body = clone(base.body);
  const template = body.included.find(i => i.type === 'campaign');
  for (const [id, name, status] of [
    [DECLINED_ID, 'Declined Creator', 'declined_patron'],
    [FORMER_ID, 'Former Creator', 'former_patron'],
  ]) {
    const campaign = clone(template);
    campaign.id = id;
    campaign.attributes.name = name;
    const member = {
      id: 'synthetic-member-' + id,
      type: 'member',
      attributes: {
        is_free_member: false,
        is_free_trial: false,
        patron_status: status,
      },
      relationships: { campaign: { data: { id, type: 'campaign' } } },
    };
    body.included.push(campaign, member);
    body.data.relationships.active_memberships.data.unshift({
      id: member.id,
      type: 'member',
    });
  }
  return { status: base.status, headers: base.headers, body };
}

// The captured search has 4 pages. "A last page ends the search" needs a page without a next
// cursor: the captured page 2 with its cursor cleared.
export const SEARCH_PAGE2_KEY = table =>
  keyOf('/api/search_feed/v1/campaign', {
    'filter[query]': 'litrpg',
    'page[cursor]': SEARCH_PAGE1_CURSOR(table),
  });

function lastSearchPage2(table) {
  const page2 = table.get(SEARCH_PAGE2_KEY(table));
  const body = clone(page2.body);
  body.meta.pagination.cursors.next = null;
  return { ...page2, body };
}

export const SEARCH_PAGE1_CURSOR = table =>
  table.get(
    keyOf('/api/search_feed/v1/campaign', { 'filter[query]': 'litrpg' }),
  ).body.meta.pagination.cursors.next;

// Marks the posts at `indices` (positions in the captured campaign order) as not viewable.
export function lockCampaignPosts(world, table, indices) {
  const lockedIds = [];
  let cursor;
  let page = 0;
  for (;;) {
    const entry = table.get(campaignPageKey(cursor));
    const body = clone(entry.body);
    body.data.forEach((post, i) => {
      if (indices.includes(page * 100 + i)) {
        post.attributes.current_user_can_view = false;
        lockedIds.push(post.id);
      }
    });
    world.on('/api/posts', campaignParams(cursor), { ...entry, body });
    cursor = entry.body.meta.pagination.cursors.next;
    if (!cursor) break;
    page++;
  }
  return lockedIds;
}

const campaignParams = cursor => ({
  'filter[campaign_id]': PAID,
  sort: 'published_at',
  ...(cursor ? { 'page[cursor]': cursor } : {}),
});

// SYNTHETIC large campaign: `total` posts made by cloning the first captured page.
export function benchCampaign(world, table, total) {
  const first = table.get(campaignPageKey());
  const pages = Math.ceil(total / 100);
  for (let k = 0; k < pages; k++) {
    const body = clone(first.body);
    body.data = body.data.slice(0, Math.min(100, total - k * 100));
    body.data.forEach((post, i) => {
      post.id = String(900000000 + k * 100 + i);
    });
    body.meta.pagination = {
      cursors: { next: k + 1 < pages ? 'bench-cursor-' + (k + 1) : null },
      total,
    };
    world.on(
      '/api/posts',
      campaignParams(k ? 'bench-cursor-' + k : undefined),
      {
        ...first,
        body,
      },
    );
  }
}

// Serves a chain of list pages (R2 or R6) for one route. `template` is a captured entry of
// that route (its envelope is reused). pages: [{ cursor, data, next }]; `cursor` is the
// incoming page[cursor] (none for the first page), `next` the cursor the page hands out.
export function servePages(world, path, baseParams, template, pages) {
  for (const page of pages) {
    const body = clone(template.body);
    body.data = page.data;
    body.meta = {
      pagination: {
        cursors: { next: page.next === undefined ? null : page.next },
        total: page.data.length,
      },
    };
    world.on(
      path,
      {
        ...baseParams,
        ...(page.cursor ? { 'page[cursor]': page.cursor } : {}),
      },
      { ...template, body },
    );
  }
}

// R7 for a hand-written post (renderer and access tests). canView: true, false, or null
// (the attribute is left out, as if Patreon did not send the flag).
export function addPost(world, id, { doc, content, canView = true } = {}) {
  const attributes = {
    title: 'Hand written ' + id,
    post_type: 'text_only',
    published_at: '2024-01-01T00:00:00.000+00:00',
  };
  if (canView !== null) attributes.current_user_can_view = canView;
  if (doc !== undefined) {
    attributes.content_json_string =
      typeof doc === 'string' ? doc : JSON.stringify(doc);
  }
  if (content !== undefined) attributes.content = content;
  world.on(
    '/api/posts/' + id,
    {},
    ok({
      data: {
        id,
        type: 'post',
        attributes,
        relationships: { attachments_media: { data: [] } },
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Harness: a fresh plugin instance on a fresh world
// ---------------------------------------------------------------------------

export function runModule(code, requireFn, globals) {
  const exports = {};
  const names = Object.keys(globals || {});
  const fn = new Function('exports', 'require', ...names, code);
  fn(exports, requireFn, ...names.map(name => globals[name]));
  return exports;
}

export function createStorage(initial) {
  const data = { ...(initial || {}) };
  return {
    get: key => data[key],
    set: (key, value) => {
      data[key] = value;
    },
    delete: key => {
      delete data[key];
    },
  };
}

// opts: pluginCode (ES5 CommonJS text), fixtures, loggedOutFixtures, libs: {FilterTypes,
// NovelStatus, cheerio}.
export function createHarness(opts) {
  const table = buildTable(opts.fixtures);
  const loggedOutR1 = buildTable(opts.loggedOutFixtures).get(R1_KEY);
  const allRequests = [];
  function boot({ loggedOut = false, stored, setup } = {}) {
    const world = createWorld(table, allRequests);
    world.on(
      '/api/current_user',
      {},
      loggedOut ? loggedOutR1 : syntheticR1(table),
    );
    world.on(
      '/api/search_feed/v1/campaign',
      {
        'filter[query]': 'litrpg',
        'page[cursor]': SEARCH_PAGE1_CURSOR(table),
      },
      lastSearchPage2(table),
    );
    const storage = createStorage(stored);
    const delays = [];
    const stubs = {
      '@libs/fetch': { fetchApi: world.fetchApi },
      '@libs/storage': { storage },
      '@libs/filterInputs': { FilterTypes: opts.libs.FilterTypes },
      '@libs/novelStatus': { NovelStatus: opts.libs.NovelStatus },
      '@/types/plugin': {},
      cheerio: opts.libs.cheerio,
    };
    const exports = runModule(
      opts.pluginCode,
      name => {
        if (!(name in stubs)) throw new Error('unexpected require: ' + name);
        return stubs[name];
      },
      {
        setTimeout: (fn, ms) => {
          delays.push(ms);
          return setTimeout(fn, 0);
        },
      },
    );
    if (setup) setup(world, table);
    return { plugin: exports.default, world, storage, delays };
  }
  return {
    table,
    boot,
    allRequests,
    captured: (path, params) => table.get(keyOf(path, params || {})).body,
  };
}

// ---------------------------------------------------------------------------
// Facts read from fixtures (never from the plugin)
// ---------------------------------------------------------------------------

// Spec rule on the captured R1: paid (active_patron) first, then free (free member or trial).
export function keptCampaigns(table) {
  const members = table
    .get(R1_KEY)
    .body.included.filter(item => item.type === 'member');
  const ids = list => list.map(m => m.relationships.campaign.data.id);
  const a = m => m.attributes;
  const paid = members.filter(m => a(m).patron_status === 'active_patron');
  const free = members.filter(
    m =>
      a(m).patron_status !== 'active_patron' &&
      (a(m).is_free_member === true || a(m).is_free_trial === true),
  );
  return ids(paid).concat(ids(free));
}

// The collections of a creator as its R2 fixture lists them ([] when no R2 was captured).
export function collectionsOf(table, campaignId) {
  const entry = table.get(
    keyOf('/api/collection', {
      'filter[campaign_id]': campaignId,
      sort: '-edited_at',
    }),
  );
  return entry ? entry.body.data : [];
}

// popularNovels(1, all) per spec: each kept creator, followed by its collections.
export function expectedPopularPaths(table) {
  const paths = [];
  for (const id of keptCampaigns(table)) {
    paths.push('campaign/' + id);
    for (const col of collectionsOf(table, id))
      paths.push('collection/' + col.id);
  }
  return paths;
}

export function walkDoc(node, visit) {
  visit(node);
  for (const child of node.content || []) walkDoc(child, visit);
}

export function countNodes(docText, type) {
  let count = 0;
  walkDoc(JSON.parse(docText), node => {
    if (node.type === type) count++;
  });
  return count;
}

// The four captured R7 posts, identified by content.
export function classifyPosts(table) {
  const found = {};
  for (const [key, entry] of table) {
    if (!/^\/api\/posts\/\d+ /.test(key)) continue;
    const post = entry.body.data;
    const a = post.attributes;
    const has = type =>
      a.content_json_string && countNodes(a.content_json_string, type) > 0;
    if (a.current_user_can_view === false) found.locked = post;
    else if ((entry.body.included || []).some(i => i.type === 'media')) {
      found.attachment = { post, media: entry.body.included[0].attributes };
    } else if (has('image')) found.publicImage = post;
    else found.paid = post;
  }
  return found;
}

export function firstNode(docText, type) {
  let found;
  walkDoc(JSON.parse(docText), node => {
    if (!found && node.type === type) found = node;
  });
  return found;
}

// ---------------------------------------------------------------------------
// Smoke scenarios: run under Node (test-patreon.js) and under Hermes (patreon-hermes.mjs)
// ---------------------------------------------------------------------------

const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const eq = (actual, expected, msg) =>
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    msg +
      ': expected ' +
      JSON.stringify(expected) +
      ' got ' +
      JSON.stringify(actual),
  );
async function expectTag(promise, tag) {
  try {
    await promise;
  } catch (error) {
    check(
      String(error.message).indexOf('[patreon:' + tag + ']') === 0,
      'expected tag ' + tag + ' got ' + error.message,
    );
    return;
  }
  throw new Error('expected rejection with tag ' + tag);
}
const count = (text, part) => text.split(part).length - 1;

export function smokeScenarios(h) {
  const posts = campaignPosts(h.table);
  const r7 = classifyPosts(h.table);
  const popularOptions = show => ({ filters: { show: { value: show } } });
  return [
    {
      name: 'popularNovels: paid creator first, collections, no former or declined',
      async run() {
        const { plugin } = h.boot();
        const paths = (
          await plugin.popularNovels(1, popularOptions('all'))
        ).map(n => n.path);
        const expected = expectedPopularPaths(h.table);
        check(paths[0] === 'campaign/' + PAID, 'paid creator first');
        eq(paths, expected, 'novels');
        check(
          !paths.includes('campaign/' + FORMER_ID) &&
            !paths.includes('campaign/' + DECLINED_ID),
          'former/declined listed',
        );
      },
    },
    {
      name: 'searchNovels: litrpg page 1',
      async run() {
        const { plugin } = h.boot();
        const found = await plugin.searchNovels('litrpg', 1);
        const body = h.captured('/api/search_feed/v1/campaign', {
          'filter[query]': 'litrpg',
        });
        eq(
          found.map(n => n.path),
          body.included
            .filter(i => i.type === 'campaign')
            .map(i => 'campaign/' + i.id),
          'search paths',
        );
      },
    },
    {
      name: 'parseNovel campaign: 244 chapters oldest first',
      async run() {
        const { plugin } = h.boot();
        const novel = await plugin.parseNovel('campaign/' + PAID);
        check(
          novel.chapters.length === posts.length,
          'chapter count ' + novel.chapters.length,
        );
        eq(novel.chapters[0].path, 'posts/' + posts[0].id, 'first chapter');
        eq(novel.chapters[243].chapterNumber, 244, 'last number');
        eq(
          novel.chapters[243].releaseTime,
          posts[243].attributes.published_at,
          'last time',
        );
      },
    },
    {
      name: 'parseNovel collection: only the collection posts',
      async run() {
        const { plugin } = h.boot();
        const novel = await plugin.parseNovel('collection/' + COLLECTION);
        const wanted = h
          .captured('/api/collection/' + COLLECTION)
          .data.attributes.post_ids.map(String);
        eq(
          novel.chapters.map(c => c.path.slice(6)).sort(),
          wanted.slice().sort(),
          'collection chapters',
        );
      },
    },
    {
      name: 'parseChapter: viewable paid post renders every paragraph',
      async run() {
        const { plugin } = h.boot();
        const html = await plugin.parseChapter('posts/' + r7.paid.id);
        eq(
          count(html, '<p>'),
          countNodes(r7.paid.attributes.content_json_string, 'paragraph'),
          'paragraphs',
        );
        check(html.indexOf('<em>') >= 0, 'italic mark missing');
      },
    },
    {
      name: 'parseChapter: public post keeps its image',
      async run() {
        const { plugin } = h.boot();
        const html = await plugin.parseChapter('posts/' + r7.publicImage.id);
        const src = firstNode(
          r7.publicImage.attributes.content_json_string,
          'image',
        ).attrs.src;
        check(
          html.indexOf('<img src="') >= 0 && html.indexOf('src="') >= 0,
          'img missing',
        );
        check(
          html.replace(/&amp;/g, '&').indexOf(src) >= 0,
          'image src missing',
        );
      },
    },
    {
      name: 'parseChapter: locked post rejects with LOCKED, logged out with LOGIN_REQUIRED',
      async run() {
        const path = 'posts/' + r7.locked.id;
        await expectTag(h.boot().plugin.parseChapter(path), 'LOCKED');
        await expectTag(
          h.boot({ loggedOut: true }).plugin.parseChapter(path),
          'LOGIN_REQUIRED',
        );
      },
    },
    {
      name: 'parseChapter: attachment post lists its media',
      async run() {
        const { plugin } = h.boot();
        const html = await plugin.parseChapter(
          'posts/' + r7.attachment.post.id,
        );
        check(
          html
            .replace(/&amp;/g, '&')
            .indexOf(r7.attachment.media.download_url) >= 0,
          'attachment url missing',
        );
      },
    },
    {
      name: 'error: 401 on R1 rejects popularNovels with LOGIN_REQUIRED',
      async run() {
        const { plugin } = h.boot({ loggedOut: true });
        await expectTag(
          plugin.popularNovels(1, popularOptions('all')),
          'LOGIN_REQUIRED',
        );
      },
    },
  ];
}
