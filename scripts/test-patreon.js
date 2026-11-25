// Run offline with: node --test scripts/test-patreon.js
// Runs plugins/multi/patreon.ts (compiled to ES5) against synthetic fixtures in
// scripts/fixtures/patreon/. The network is a fake `fetchApi` (scripts/patreon-test-kit.js).
// Expected values come from the spec (workflow/context/patreon-plugin.md) and the fixture data.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as cheerio from 'cheerio';
import ts from 'typescript';
import {
  COLLECTION,
  DECLINED_ID,
  FORMER_ID,
  PAID,
  SEARCH_PAGE1_CURSOR,
  SEARCH_PAGE2_KEY,
  addPost,
  benchCampaign,
  campaignPosts,
  classifyPosts,
  countNodes,
  createHarness,
  firstNode,
  lockCampaignPosts,
  runModule,
  servePages,
  smokeScenarios,
  syntheticR1,
  walkDoc,
  keyOf,
  collectionsOf,
} from './patreon-test-kit.js';

const require = createRequire(import.meta.url);
// PATREON_PLUGIN=/abs/path.ts tests another copy of the plugin (used for mutation checks).
const compile = relative =>
  ts.transpileModule(
    readFileSync(
      relative.startsWith('/')
        ? relative
        : new URL('../' + relative, import.meta.url),
      'utf8',
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES5,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
const readFixtures = dir =>
  readdirSync(new URL(dir, import.meta.url))
    .filter(name => name.endsWith('.json') && name !== 'index.json')
    .map(name =>
      JSON.parse(readFileSync(new URL(dir + name, import.meta.url), 'utf8')),
    );

const h = createHarness({
  pluginCode: compile(process.env.PATREON_PLUGIN || 'plugins/multi/patreon.ts'),
  fixtures: readFixtures('./fixtures/patreon/'),
  loggedOutFixtures: readFixtures('./fixtures/patreon-logged-out/'),
  libs: {
    FilterTypes: runModule(compile('src/types/filters.ts'), require)
      .FilterTypes,
    NovelStatus: runModule(compile('src/types/constants.ts'), require)
      .NovelStatus,
    cheerio,
  },
});

// ---------------------------------------------------------------------------
// Facts from the fixtures
// ---------------------------------------------------------------------------

const LOCK = '🔒 ';
const campaign = campaignPosts(h.table); // 244 posts, oldest first
const r1 = h.captured('/api/current_user');
const r1Campaign = {};
for (const item of r1.included) {
  if (item.type === 'campaign') r1Campaign[item.id] = item.attributes;
}
const r1Members = r1.included.filter(item => item.type === 'member');
const memberCampaign = member => member.relationships.campaign.data.id;
const paidIds = r1Members
  .filter(m => m.attributes.patron_status === 'active_patron')
  .map(memberCampaign);
const freeIds = r1Members
  .filter(m => m.attributes.patron_status !== 'active_patron')
  .filter(m => m.attributes.is_free_member || m.attributes.is_free_trial)
  .map(memberCampaign);
const r5 = h.captured('/api/collection/' + COLLECTION).data;
const r7 = classifyPosts(h.table);
const pick = (urls, keys) => keys.map(key => urls[key]).find(Boolean);
const avatar = id =>
  pick(r1Campaign[id].avatar_photo_image_urls, [
    'thumbnail_large',
    'default',
    'original',
  ]);
const popularOptions = show => ({
  filters: { show: { value: show } },
  showLatestNovels: false,
});
const tag = name => ({
  message: new RegExp('^\\[patreon:' + name + '\\]'),
});
const paragraphsOf = doc => countNodes(doc, 'paragraph');
const linkHrefs = doc => {
  const hrefs = [];
  walkDoc(JSON.parse(doc), node => {
    for (const mark of node.marks || []) {
      if (mark.type === 'link') hrefs.push(mark.attrs.href);
    }
  });
  return hrefs;
};
const marksOf = (doc, type) => {
  let n = 0;
  walkDoc(JSON.parse(doc), node => {
    for (const mark of node.marks || []) if (mark.type === type) n++;
  });
  return n;
};
const respond = (status, body = {}) => ({
  status,
  headers: { 'content-type': 'application/vnd.api+json' },
  body,
});

const pageOf = (cursor, data, next) => ({ cursor, data, next });
// A synthetic R6 post: the first captured post under another id.
const fakePost = id => ({
  ...JSON.parse(JSON.stringify(campaign[0])),
  id: String(id),
});
const postParams = cursor => ({
  'filter[campaign_id]': PAID,
  sort: 'published_at',
  ...(cursor ? { 'page[cursor]': cursor } : {}),
});

const r1Failure = (status, body, headers) => world =>
  world.on('/api/current_user', {}, { status, headers: headers || {}, body });

// ---------------------------------------------------------------------------
// popularNovels
// ---------------------------------------------------------------------------

test('popularNovels page 1: paid creator, its collections, then free memberships', async () => {
  const { plugin } = h.boot();
  const novels = await plugin.popularNovels(1, popularOptions('all'));
  assert.equal(PAID, paidIds[0]);
  // Each kept creator (paid first, then free), followed by its own collections.
  const expected = [];
  for (const id of [...paidIds, ...freeIds]) {
    expected.push('campaign/' + id);
    for (const col of collectionsOf(h.table, id)) {
      expected.push('collection/' + col.id);
    }
  }
  assert.deepEqual(
    novels.map(n => n.path),
    expected,
  );
  const byPath = Object.fromEntries(novels.map(n => [n.path, n]));
  for (const id of [...paidIds, ...freeIds]) {
    assert.equal(byPath['campaign/' + id].name, r1Campaign[id].name);
    assert.equal(byPath['campaign/' + id].cover, avatar(id));
  }
  for (const col of [...paidIds, ...freeIds].flatMap(id =>
    collectionsOf(h.table, id),
  )) {
    const novel = byPath['collection/' + col.id];
    assert.ok(novel.name.includes(col.attributes.title));
    assert.equal(novel.cover, col.attributes.thumbnail.default);
  }
});

test('popularNovels leaves out former and declined memberships', async () => {
  const { plugin, world } = h.boot();
  // Pair: the R1 that the plugin gets does list both of them.
  const listed = syntheticR1(h.table)
    .body.included.filter(item => item.type === 'member')
    .map(item => item.attributes.patron_status);
  assert.ok(
    listed.includes('former_patron') && listed.includes('declined_patron'),
  );
  const paths = (await plugin.popularNovels(1, popularOptions('all'))).map(
    n => n.path,
  );
  assert.ok(!paths.includes('campaign/' + FORMER_ID));
  // Real capture: both former_patron members still follow for free (is_free_member: true).
  // They can read public posts, so they stay, as free memberships.
  const r1 = h.table.get(keyOf('/api/current_user', {})).body;
  const realFormer = r1.included
    .filter(i => i.type === 'member')
    .filter(i => i.attributes.patron_status === 'former_patron')
    .map(i => i.relationships.campaign.data.id);
  assert.equal(realFormer.length, 2);
  for (const id of realFormer) assert.ok(paths.includes('campaign/' + id));
  assert.ok(!paths.includes('campaign/' + DECLINED_ID));
  assert.equal(
    world.requests.filter(r => r.params['filter[campaign_id]'] === FORMER_ID)
      .length,
    0,
  );
});

test('popularNovels show filter: creators, collections, all', async () => {
  for (const [show, expectCampaigns, expectCollections] of [
    ['creators', true, false],
    ['collections', false, true],
    ['all', true, true],
  ]) {
    const { plugin, world } = h.boot();
    const paths = (await plugin.popularNovels(1, popularOptions(show))).map(
      n => n.path,
    );
    const campaigns = paths.filter(p => p.startsWith('campaign/'));
    const collections = paths.filter(p => p.startsWith('collection/'));
    const kept = [...paidIds, ...freeIds];
    const allCollections = kept.flatMap(id => collectionsOf(h.table, id));
    assert.equal(kept.length, 13);
    assert.equal(campaigns.length, expectCampaigns ? kept.length : 0, show);
    assert.equal(
      collections.length,
      expectCollections ? allCollections.length : 0,
      show,
    );
    // R1 once, plus one R2 per membership only when collections are shown.
    assert.equal(world.to('/api/current_user').length, 1);
    assert.equal(
      world.to('/api/collection').length,
      expectCollections ? 13 : 0,
    );
  }
  // An omitted filter value behaves like "all".
  const { plugin } = h.boot();
  assert.deepEqual(
    (await plugin.popularNovels(1, { filters: {} })).map(n => n.path),
    (await h.boot().plugin.popularNovels(1, popularOptions('all'))).map(
      n => n.path,
    ),
  );
});

test('popularNovels page 2 is empty and sends no request', async () => {
  const { plugin, world } = h.boot();
  assert.deepEqual(await plugin.popularNovels(2, popularOptions('all')), []);
  assert.equal(world.requests.length, 0);
});

test('popularNovels logged out rejects with LOGIN_REQUIRED', async () => {
  const { plugin } = h.boot({ loggedOut: true });
  await assert.rejects(
    plugin.popularNovels(1, popularOptions('all')),
    tag('LOGIN_REQUIRED'),
  );
});

// ---------------------------------------------------------------------------
// searchNovels
// ---------------------------------------------------------------------------

const search1 = h.captured('/api/search_feed/v1/campaign', {
  'filter[query]': 'litrpg',
});
const search1Campaigns = search1.included.filter(i => i.type === 'campaign');

test('searchNovels page 1 returns the creators of the search result', async () => {
  const { plugin, world } = h.boot();
  const found = await plugin.searchNovels('litrpg', 1);
  assert.deepEqual(
    found.map(n => n.path),
    search1Campaigns.map(c => 'campaign/' + c.id),
  );
  assert.deepEqual(
    found.map(n => n.name),
    search1Campaigns.map(c => c.attributes.name),
  );
  assert.equal(
    found[0].cover,
    pick(search1Campaigns[0].attributes.avatar_photo_image_urls, [
      'thumbnail_large',
      'default',
      'original',
    ]),
  );
  const [req] = world.to('/api/search_feed/v1/campaign');
  assert.equal(req.params['filter[query]'], 'litrpg');
  assert.equal(req.params['page[cursor]'], undefined);
});

test('searchNovels page 2 uses the cursor of page 1; a last page ends the search', async () => {
  const { plugin, world } = h.boot();
  const first = await plugin.searchNovels('litrpg', 1);
  const second = await plugin.searchNovels('litrpg', 2);
  const requests = world.to('/api/search_feed/v1/campaign');
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1].params['page[cursor]'],
    SEARCH_PAGE1_CURSOR(h.table),
  );
  // Expected page 2: the captured page 2 (its campaigns, in order).
  const page2 = h.table.get(SEARCH_PAGE2_KEY(h.table)).body;
  const byId = Object.fromEntries(
    page2.included.filter(i => i.type === 'campaign').map(i => [i.id, i]),
  );
  const cards = Object.fromEntries(
    page2.included
      .filter(i => i.type === 'launcher-card-campaign')
      .map(i => [i.id, i.relationships.campaign.data.id]),
  );
  const expectedPaths = page2.data.map(
    item => 'campaign/' + cards[item.relationships.card_campaign.data.id],
  );
  assert.equal(second.length, 24);
  assert.deepEqual(
    second.map(n => n.path),
    expectedPaths,
  );
  for (const n of second) {
    assert.equal(
      n.name,
      byId[n.path.slice('campaign/'.length)].attributes.name,
    );
  }
  const firstPaths = first.map(n => n.path);
  assert.ok(second.every(n => !firstPaths.includes(n.path)));
  // Page 2 has no next cursor, so page 3 is empty and needs no request.
  assert.deepEqual(await plugin.searchNovels('litrpg', 3), []);
  assert.equal(world.to('/api/search_feed/v1/campaign').length, 2);
});

const SEARCH_PATH = '/api/search_feed/v1/campaign';
const searchParams = cursor => ({
  'filter[query]': 'litrpg',
  ...(cursor ? { 'page[cursor]': cursor } : {}),
});
// The captured page 2 with another `next` (a synthetic page: only the cursor differs).
const searchPage = next => {
  const entry = h.table.get(SEARCH_PAGE2_KEY(h.table));
  const body = JSON.parse(JSON.stringify(entry.body));
  body.meta.pagination.cursors.next = next;
  return { ...entry, body };
};
const searchCursorsSent = world =>
  world.to(SEARCH_PATH).map(r => r.params['page[cursor]']);

test('searchNovels: a page whose next equals its own cursor ends the search', async () => {
  const N1 = SEARCH_PAGE1_CURSOR(h.table);
  const { plugin, world } = h.boot({
    setup: w => w.on(SEARCH_PATH, searchParams(N1), searchPage(N1)),
  });
  await plugin.searchNovels('litrpg', 1);
  assert.equal((await plugin.searchNovels('litrpg', 2)).length, 24);
  assert.deepEqual(await plugin.searchNovels('litrpg', 3), []);
  assert.deepEqual(searchCursorsSent(world), [undefined, N1]);
});

test('searchNovels: a refetched page with a new next drops the cursors of later pages', async () => {
  const N1 = SEARCH_PAGE1_CURSOR(h.table);
  const N2 = 'cursor-after-2';
  const N3 = 'cursor-after-3';
  const N2_NEW = 'cursor-after-2-new';
  const N3_NEW = 'cursor-after-3-new';
  const { plugin, world } = h.boot({
    setup: w => {
      // Page 2 answers with N2 the first time and with N2_NEW when it is read again.
      w.on(SEARCH_PATH, searchParams(N1), [searchPage(N2), searchPage(N2_NEW)]);
      w.on(SEARCH_PATH, searchParams(N2), searchPage(N3));
      w.on(SEARCH_PATH, searchParams(N3), searchPage(null));
      w.on(SEARCH_PATH, searchParams(N2_NEW), searchPage(N3_NEW));
      w.on(SEARCH_PATH, searchParams(N3_NEW), searchPage(null));
    },
  });
  await plugin.searchNovels('litrpg', 1);
  await plugin.searchNovels('litrpg', 2);
  await plugin.searchNovels('litrpg', 3);
  assert.deepEqual(searchCursorsSent(world), [undefined, N1, N2]);
  await plugin.searchNovels('litrpg', 2); // page 2 again: now hands out N2_NEW
  const before = world.to(SEARCH_PATH).length;
  await plugin.searchNovels('litrpg', 4);
  // Page 4 must be reached through the new page 3, never through the old N3.
  assert.deepEqual(searchCursorsSent(world).slice(before - 1), [
    N1,
    N2_NEW,
    N3_NEW,
  ]);
});

// ---------------------------------------------------------------------------
// parseNovel
// ---------------------------------------------------------------------------

test('parseNovel campaign: 244 chapters, oldest first, with metadata', async () => {
  const { plugin, world } = h.boot();
  const novel = await plugin.parseNovel('campaign/' + PAID);
  assert.equal(novel.path, 'campaign/' + PAID);
  assert.equal(novel.name, r1Campaign[PAID].name);
  assert.equal(novel.cover, avatar(PAID));
  // Expected values from the real R4 fixture: creator full_name, summary text.
  const r4 = h.table.get(keyOf('/api/campaigns/' + PAID, {})).body;
  const creator = r4.included.find(item => item.type === 'user');
  assert.equal(novel.author, creator.attributes.full_name);
  // A space before each tag keeps the words of adjacent blocks apart.
  const words = cheerio
    .load(r4.data.attributes.summary.replace(/</g, ' <'))
    .root()
    .text()
    .split(/\s+/)
    .filter(Boolean);
  assert.ok(words.length > 0);
  for (const word of words) assert.ok(novel.summary.includes(word));
  assert.ok(!/[<>]/.test(novel.summary));
  assert.equal(novel.chapters.length, 244);
  assert.deepEqual(
    novel.chapters.map(c => c.path),
    campaign.map(p => 'posts/' + p.id),
  );
  assert.deepEqual(
    novel.chapters.map(c => c.name),
    campaign.map(p => p.attributes.title),
  );
  assert.deepEqual(
    novel.chapters.map(c => c.chapterNumber),
    campaign.map((_, i) => i + 1),
  );
  assert.deepEqual(
    novel.chapters.map(c => c.releaseTime),
    campaign.map(p => p.attributes.published_at),
  );
  // Requests: R4, then R6 pages that follow the cursor.
  assert.equal(world.to('/api/campaigns/' + PAID).length, 1);
  const pages = world.to('/api/posts');
  assert.equal(pages.length, 3);
  assert.equal(pages[0].params['page[cursor]'], undefined);
  assert.equal(pages[0].params.sort, 'published_at');
  assert.equal(pages[0].params['filter[collection_id]'], undefined);
  assert.equal(
    pages[1].params['page[cursor]'],
    h.captured('/api/posts', {
      'filter[campaign_id]': PAID,
      sort: 'published_at',
    }).meta.pagination.cursors.next,
  );
});

const LOCKED_AT = [0, 99, 100, 150, 243];
const withLocks = ids => world => {
  ids.out = lockCampaignPosts(world, h.table, LOCKED_AT);
};

test('parseNovel prefixes locked posts with the lock sign', async () => {
  const ids = {};
  const { plugin } = h.boot({ setup: withLocks(ids) });
  const novel = await plugin.parseNovel('campaign/' + PAID);
  assert.equal(ids.out.length, LOCKED_AT.length);
  assert.equal(novel.chapters.length, 244);
  campaign.forEach((post, i) => {
    const expected = LOCKED_AT.includes(i)
      ? LOCK + post.attributes.title
      : post.attributes.title;
    assert.equal(novel.chapters[i].name, expected, 'chapter ' + (i + 1));
  });
});

test('parseNovel hideLocked removes locked posts (boolean and string form)', async () => {
  const expected = campaign
    .filter((_, i) => !LOCKED_AT.includes(i))
    .map(p => 'posts/' + p.id);
  for (const stored of [true, 'true']) {
    const { plugin } = h.boot({
      stored: { hideLocked: stored },
      setup: withLocks({}),
    });
    const novel = await plugin.parseNovel('campaign/' + PAID);
    assert.deepEqual(
      novel.chapters.map(c => c.path),
      expected,
      String(stored),
    );
    assert.ok(novel.chapters.every(c => !c.name.startsWith(LOCK)));
    // Numbers are positions in the FULL list: the app keeps chapters it saved before.
    assert.deepEqual(
      novel.chapters.map(c => c.chapterNumber),
      campaign.map((_, i) => i + 1).filter(n => !LOCKED_AT.includes(n - 1)),
    );
  }
  // Pair: other values keep the locked posts.
  for (const stored of [false, 'false', undefined]) {
    const { plugin } = h.boot({
      stored: { hideLocked: stored },
      setup: withLocks({}),
    });
    const novel = await plugin.parseNovel('campaign/' + PAID);
    assert.equal(novel.chapters.length, 244, String(stored));
  }
  // With nothing locked, hideLocked changes nothing.
  const { plugin } = h.boot({ stored: { hideLocked: true } });
  assert.equal(
    (await plugin.parseNovel('campaign/' + PAID)).chapters.length,
    244,
  );
});

test('parseNovel collection: only the posts of the collection, ordered by date', async () => {
  const { plugin, world } = h.boot();
  const novel = await plugin.parseNovel('collection/' + COLLECTION);
  const wanted = new Set(r5.attributes.post_ids.map(String));
  const expected = campaign
    .filter(p => wanted.has(p.id))
    .sort((a, b) =>
      a.attributes.published_at < b.attributes.published_at ? -1 : 1,
    );
  assert.equal(expected.length, 54);
  assert.equal(novel.path, 'collection/' + COLLECTION);
  assert.ok(novel.name.includes(r5.attributes.title));
  assert.equal(novel.cover, r5.attributes.thumbnail.default);
  assert.equal(novel.summary, r5.attributes.description);
  assert.ok(novel.author && novel.author.length > 0);
  assert.deepEqual(
    novel.chapters.map(c => c.path),
    expected.map(p => 'posts/' + p.id),
  );
  assert.deepEqual(
    novel.chapters.map(c => c.releaseTime),
    expected.map(p => p.attributes.published_at),
  );
  assert.deepEqual(
    novel.chapters.map(c => c.chapterNumber),
    expected.map((_, i) => i + 1),
  );
  // R5 once, then R6 filtered by the collection.
  assert.equal(world.to('/api/collection/' + COLLECTION).length, 1);
  const [req] = world.to('/api/posts');
  assert.equal(req.params['filter[collection_id]'], COLLECTION);
  assert.equal(req.params['filter[campaign_id]'], PAID);
});

test('parseNovel stops at a cursor it used before: each post once, no more R6 requests', async () => {
  // Pages: (none) -> c1 -> c2 -> c1. The last `next` repeats a cursor already used.
  const { plugin, world } = h.boot({
    setup: w =>
      servePages(
        w,
        '/api/posts',
        { 'filter[campaign_id]': PAID, sort: 'published_at' },
        h.table.get(keyOf('/api/posts', postParams())),
        [
          pageOf(undefined, [fakePost(1001), fakePost(1002)], 'c1'),
          pageOf('c1', [fakePost(1003)], 'c2'),
          pageOf('c2', [fakePost(1004)], 'c1'),
        ],
      ),
  });
  const novel = await plugin.parseNovel('campaign/' + PAID);
  assert.deepEqual(
    novel.chapters.map(c => c.path),
    ['posts/1001', 'posts/1002', 'posts/1003', 'posts/1004'],
  );
  assert.deepEqual(
    novel.chapters.map(c => c.chapterNumber),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    world.to('/api/posts').map(r => r.params['page[cursor]']),
    [undefined, 'c1', 'c2'],
  );
});

test('parseNovel follows distinct cursors to the end (pair of the repeated-cursor test)', async () => {
  const { plugin, world } = h.boot({
    setup: w =>
      servePages(
        w,
        '/api/posts',
        { 'filter[campaign_id]': PAID, sort: 'published_at' },
        h.table.get(keyOf('/api/posts', postParams())),
        [
          pageOf(undefined, [fakePost(1001)], 'c1'),
          pageOf('c1', [fakePost(1002)], 'c2'),
          pageOf('c2', [fakePost(1003)], undefined),
        ],
      ),
  });
  const novel = await plugin.parseNovel('campaign/' + PAID);
  assert.deepEqual(
    novel.chapters.map(c => c.path),
    ['posts/1001', 'posts/1002', 'posts/1003'],
  );
  assert.equal(world.to('/api/posts').length, 3);
});

test('popularNovels stops at an R2 cursor it used before: each collection once', async () => {
  const r2Params = { 'filter[campaign_id]': PAID, sort: '-edited_at' };
  const r2 = h.table.get(keyOf('/api/collection', r2Params));
  const fakeCollection = id => ({
    ...JSON.parse(JSON.stringify(r2.body.data[0])),
    id: String(id),
  });
  const { plugin, world } = h.boot({
    setup: w =>
      servePages(w, '/api/collection', r2Params, r2, [
        pageOf(undefined, [fakeCollection(7001)], 'x1'),
        pageOf('x1', [fakeCollection(7002)], 'x2'),
        pageOf('x2', [fakeCollection(7003)], 'x1'),
      ]),
  });
  const paths = (await plugin.popularNovels(1, popularOptions('collections')))
    .map(n => n.path)
    .filter(p => ['7001', '7002', '7003'].includes(p.slice(11)));
  assert.deepEqual(paths, [
    'collection/7001',
    'collection/7002',
    'collection/7003',
  ]);
  assert.deepEqual(
    world
      .to('/api/collection')
      .filter(r => r.params['filter[campaign_id]'] === PAID)
      .map(r => r.params['page[cursor]']),
    [undefined, 'x1', 'x2'],
  );
});

// ---------------------------------------------------------------------------
// parseChapter
// ---------------------------------------------------------------------------

test('parseChapter viewable paid post: paragraphs, marks and links', async () => {
  const { plugin, world } = h.boot();
  const doc = r7.paid.attributes.content_json_string;
  const html = await plugin.parseChapter('posts/' + r7.paid.id);
  const $ = cheerio.load(html);
  assert.equal($('p').length, paragraphsOf(doc));
  assert.ok(paragraphsOf(doc) > 10);
  assert.equal($('em').length, marksOf(doc, 'italic'));
  assert.ok(marksOf(doc, 'italic') > 0);
  const expectedLinks = linkHrefs(doc).filter(u => /^https?:\/\//.test(u));
  assert.ok(expectedLinks.length > 0);
  assert.deepEqual(
    $('a')
      .map((_, a) => $(a).attr('href'))
      .get(),
    expectedLinks,
  );
  assert.ok(!/<script/i.test(html));
  // One request, no R1 for a viewable post.
  assert.equal(world.requests.length, 1);
});

test('parseChapter public post keeps its image and bold text', async () => {
  const { plugin } = h.boot();
  const doc = r7.publicImage.attributes.content_json_string;
  const html = await plugin.parseChapter('posts/' + r7.publicImage.id);
  const $ = cheerio.load(html);
  const image = firstNode(doc, 'image');
  assert.equal($('img').length, countNodes(doc, 'image'));
  assert.equal($('img').attr('src'), image.attrs.src);
  assert.equal($('strong').length, marksOf(doc, 'bold'));
  assert.ok(marksOf(doc, 'bold') > 0);
});

test('parseChapter locked post: LOCKED when logged in, LOGIN_REQUIRED when logged out', async () => {
  const path = 'posts/' + r7.locked.id;
  const lockedUser = h.boot();
  await assert.rejects(lockedUser.plugin.parseChapter(path), tag('LOCKED'));
  const anonymous = h.boot({ loggedOut: true });
  await assert.rejects(
    anonymous.plugin.parseChapter(path),
    tag('LOGIN_REQUIRED'),
  );
});

test('parseChapter locked post stays LOCKED when the R1 check itself is rate limited', async () => {
  const { plugin, world } = h.boot({
    setup: r1Failure(429, { errors: [] }),
  });
  await assert.rejects(
    plugin.parseChapter('posts/' + r7.locked.id),
    tag('LOCKED'),
  );
  assert.equal(world.to('/api/current_user').length, 1);
});

test('parseChapter attachment post: image media becomes an img, body links stay', async () => {
  const { plugin } = h.boot();
  const { post, media } = r7.attachment;
  assert.match(media.mimetype, /^image\//);
  const html = await plugin.parseChapter('posts/' + post.id);
  const $ = cheerio.load(html);
  const doc = post.attributes.content_json_string;
  assert.ok(
    $('img').filter((_, el) => $(el).attr('src') === media.download_url)
      .length === 1,
  );
  assert.equal($('br').length, countNodes(doc, 'hardBreak'));
  assert.deepEqual(
    $('a')
      .map((_, a) => $(a).attr('href'))
      .get(),
    linkHrefs(doc),
  );
});

test('parseChapter attachment with a non-image mimetype becomes a link', async () => {
  const { post, media } = r7.attachment;
  const { plugin } = h.boot({
    setup: world => {
      const body = JSON.parse(
        JSON.stringify(h.captured('/api/posts/' + post.id)),
      );
      body.included[0].attributes.mimetype = 'application/pdf';
      body.included[0].attributes.file_name = 'book.pdf';
      world.on('/api/posts/' + post.id, {}, respond(200, body));
    },
  });
  const $ = cheerio.load(await plugin.parseChapter('posts/' + post.id));
  const link = $('a').filter(
    (_, a) => $(a).attr('href') === media.download_url,
  );
  assert.equal(link.length, 1);
  assert.ok(link.text().includes('book.pdf'));
  assert.equal($('img').length, 0);
});

// ---------------------------------------------------------------------------
// Renderer (through parseChapter, with a hand-written document)
// ---------------------------------------------------------------------------

const para = (...content) => ({ type: 'paragraph', content });
const text = (value, ...marks) => ({
  type: 'text',
  text: value,
  marks: marks.map(type => (typeof type === 'string' ? { type } : type)),
});
const item = value => ({ type: 'listItem', content: [para(text(value))] });
const link = (label, href) => text(label, { type: 'link', attrs: { href } });

test('renderer: marks, escaping, URL schemes, block nodes and unknown nodes', async () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 3 },
        content: [text('Chapter title')],
      },
      para(
        text('plain '),
        text('boldword', 'bold'),
        text('italicword', 'italic'),
        text('underword', 'underline'),
        text('strikeword', 'strike'),
        text('monoword', 'code'),
        text('both', 'bold', 'italic'),
        link('goodlink', 'https://example.com/a?x=1&y=2'),
        link('badlink', 'javascript:alert(1)'),
        link('quotelink', 'https://example.com/q"onmouseover="alert(3)'),
        text('<script>alert(1)</script>'),
        { type: 'hardBreak' },
        text('after break'),
      ),
      { type: 'orderedList', content: [item('first'), item('second')] },
      { type: 'bulletList', content: [item('bullet')] },
      { type: 'blockquote', content: [para(text('quoted words'))] },
      { type: 'horizontalRule' },
      { type: 'codeBlock', content: [text('let a = 1 < 2;')] },
      { type: 'mysteryBlock', content: [para(text('inside unknown'))] },
      { type: 'mysteryLeaf', text: 'solo text' },
      { type: 'image', attrs: { src: 'javascript:alert(2)' } },
      {
        type: 'image',
        attrs: { src: 'https://example.com/i.png', alt: 'pic' },
      },
    ],
  };
  const { plugin } = h.boot({
    setup: world => addPost(world, '999000001', { doc }),
  });
  const html = await plugin.parseChapter('posts/999000001');
  const $ = cheerio.load(html);
  assert.equal($('h3').text(), 'Chapter title');
  for (const [tagName, word] of [
    ['strong', 'boldword'],
    ['em', 'italicword'],
    ['u', 'underword'],
    ['s', 'strikeword'],
    ['code', 'monoword'],
  ]) {
    assert.ok($(tagName).text().includes(word), tagName);
  }
  assert.ok(
    $('strong').text().includes('both') && $('em').text().includes('both'),
  );
  // Links: http(s) kept, javascript: dropped but its text stays, quotes cannot add attributes.
  const hrefs = $('a')
    .map((_, a) => $(a).attr('href'))
    .get();
  assert.deepEqual(hrefs, [
    'https://example.com/a?x=1&y=2',
    'https://example.com/q"onmouseover="alert(3)',
  ]);
  assert.equal($('a[onmouseover]').length, 0);
  assert.ok($.text().includes('badlink'));
  assert.ok(!/javascript:/i.test(html));
  // Text is escaped, never markup.
  assert.equal($('script').length, 0);
  assert.ok($.text().includes('<script>alert(1)</script>'));
  assert.equal($('br').length, 1);
  assert.equal($('ol li').length, 2);
  assert.equal($('ul li').length, 1);
  assert.equal($('blockquote').text().trim(), 'quoted words');
  assert.equal($('hr').length, 1);
  assert.equal($('pre code').text(), 'let a = 1 < 2;');
  // Unknown node types render their text.
  assert.ok($.text().includes('inside unknown'));
  assert.ok($.text().includes('solo text'));
  // Images: only the https one.
  assert.equal($('img').length, 1);
  assert.equal($('img').attr('src'), 'https://example.com/i.png');
});

test('renderer: a post with only HTML content is returned as that content', async () => {
  const { plugin } = h.boot({
    setup: world =>
      addPost(world, '999000002', { content: '<p>html <b>only</b> body</p>' }),
  });
  const $ = cheerio.load(await plugin.parseChapter('posts/999000002'));
  assert.equal($('p').text(), 'html only body');
  assert.equal($('b').text(), 'only');
});

// HTML fallback (`content` without `content_json_string`). Expectations come from the
// allowlist of the contract; the assertions read what a consumer of the output sees.
const readHtml = async content => {
  const { plugin } = h.boot({
    setup: world => addPost(world, '999000010', { content }),
  });
  return cheerio.load(await plugin.parseChapter('posts/999000010'));
};
const attributesOf = $ =>
  $('body *')
    .map((_, el) => Object.keys(el.attribs).map(name => [el.tagName, name]))
    .get();

test('HTML fallback removes script, style and iframe with their content', async () => {
  const $ = await readHtml(
    '<p>keep this</p>' +
      '<script>window.SCRIPT_MARK = 1</script>' +
      '<style>.STYLE_MARK { color: red }</style>' +
      '<iframe src="https://example.com/frame">IFRAME_MARK</iframe>' +
      '<p>and this</p>',
  );
  assert.equal($('script, style, iframe').length, 0);
  for (const mark of ['SCRIPT_MARK', 'STYLE_MARK', 'IFRAME_MARK']) {
    assert.ok(!$.html().includes(mark), mark);
  }
  assert.deepEqual(
    $('p')
      .map((_, p) => $(p).text())
      .get(),
    ['keep this', 'and this'],
  );
});

test('HTML fallback strips event, style and other attributes; http(s) urls survive', async () => {
  const $ = await readHtml(
    '<p onclick="steal()" style="color:red" class="x">text</p>' +
      '<img src="https://example.com/ok.png" alt="fine" onerror="steal()">' +
      '<a href="https://example.com/page" target="_blank" onclick="x()">goodlink</a>' +
      '<a href="javascript:steal()">jslink</a>' +
      '<img src="file:///etc/passwd" alt="local">' +
      '<img src="data:image/png;base64,AAAA" alt="inline">',
  );
  // Only the attributes of the allowlist remain, and only on their tags.
  for (const [tagName, name] of attributesOf($)) {
    const allowed = { a: ['href'], img: ['src', 'alt'] }[tagName] || [];
    assert.ok(allowed.includes(name), tagName + ' keeps ' + name);
  }
  // Every url left is http(s); the bad ones lost the attribute but not the element text.
  assert.deepEqual(
    $('img[src]')
      .map((_, el) => $(el).attr('src'))
      .get(),
    ['https://example.com/ok.png'],
  );
  assert.equal($('img[src="https://example.com/ok.png"]').attr('alt'), 'fine');
  assert.deepEqual(
    $('a[href]')
      .map((_, el) => $(el).attr('href'))
      .get(),
    ['https://example.com/page'],
  );
  assert.equal($('a[href]').text(), 'goodlink');
  assert.ok($('body').text().includes('jslink'));
  assert.ok(!/javascript:|file:|data:/i.test($.html()));
  assert.equal($('p').text(), 'text');
});

test('HTML fallback unwraps an unknown tag and keeps its text', async () => {
  const $ = await readHtml(
    '<p>before <custom-x>unknown words</custom-x> after</p>' +
      '<p><font color="red">font words</font></p>',
  );
  assert.equal($('custom-x, font').length, 0);
  assert.deepEqual(
    $('p')
      .map((_, p) => $(p).text())
      .get(),
    ['before unknown words after', 'font words'],
  );
});

// ---------------------------------------------------------------------------
// Access flag (R7)
// ---------------------------------------------------------------------------

test('parseChapter access: a missing flag decides by the body; an explicit false wins', async () => {
  const doc = { type: 'doc', content: [para(text('readable words'))] };
  const open = async options => {
    const { plugin } = h.boot({
      setup: world => addPost(world, '999000020', options),
    });
    return plugin.parseChapter('posts/999000020');
  };
  // Flag missing, ProseMirror body present: renders.
  assert.match(await open({ canView: null, doc }), /readable words/);
  // Flag missing, HTML body present: renders.
  assert.match(
    await open({ canView: null, content: '<p>html words</p>' }),
    /html words/,
  );
  // Flag missing, no body: locked (the user is logged in, so LOCKED).
  await assert.rejects(open({ canView: null }), tag('LOCKED'));
  // Flag false, body present: the explicit false wins.
  await assert.rejects(open({ canView: false, doc }), tag('LOCKED'));
  // Pair: the flag true with a body renders.
  assert.match(await open({ canView: true, doc }), /readable words/);
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test('error mapping: 429 is RATE_LIMITED, 500 is HTTP, HTML is BLOCKED', async () => {
  for (const [name, setup, pattern] of [
    ['429', r1Failure(429, { errors: [] }), tag('RATE_LIMITED')],
    ['500', r1Failure(500, 'oops'), { message: /^\[patreon:HTTP\].*500/ }],
    [
      'html',
      r1Failure(
        200,
        '<!DOCTYPE html><html><body>Just a moment...</body></html>',
        {
          'content-type': 'text/html',
        },
      ),
      tag('BLOCKED'),
    ],
  ]) {
    const { plugin, world } = h.boot({ setup });
    await assert.rejects(
      plugin.popularNovels(1, popularOptions('all')),
      pattern,
      name,
    );
    // No retry for these.
    assert.equal(world.to('/api/current_user').length, 1, name);
  }
});

test('error mapping: JSON 403 is HTTP, HTML 403 is BLOCKED, 404 is NOT_FOUND', async () => {
  for (const [name, setup, pattern] of [
    [
      'json 403',
      r1Failure(403, { errors: [{ code_name: 'Forbidden' }] }),
      { message: /^\[patreon:HTTP\].*403/ },
    ],
    [
      'html 403',
      r1Failure(403, '<html><body>Access denied</body></html>', {
        'content-type': 'text/html',
      }),
      tag('BLOCKED'),
    ],
    ['404', r1Failure(404, { errors: [] }), tag('NOT_FOUND')],
  ]) {
    const { plugin, world } = h.boot({ setup });
    await assert.rejects(
      plugin.popularNovels(1, popularOptions('all')),
      pattern,
      name,
    );
    assert.equal(world.to('/api/current_user').length, 1, name);
  }
  // A missing post maps the same way through parseChapter.
  const { plugin } = h.boot({
    setup: world => world.on('/api/posts/999000030', {}, respond(404)),
  });
  await assert.rejects(
    plugin.parseChapter('posts/999000030'),
    tag('NOT_FOUND'),
  );
});

test('a 503 followed by 200 succeeds after exactly one retry', async () => {
  const { plugin, world, delays } = h.boot({
    setup: (w, table) =>
      w.on('/api/current_user', {}, [
        respond(503, 'upstream'),
        syntheticR1(table),
      ]),
  });
  const novels = await plugin.popularNovels(1, popularOptions('creators'));
  assert.equal(novels.length, 13);
  assert.equal(world.to('/api/current_user').length, 2);
  assert.deepEqual(delays, [500]);
});

test('a 503 twice fails with one retry only', async () => {
  const { plugin, world } = h.boot({
    setup: r1Failure(503, 'upstream connect error'),
  });
  await assert.rejects(plugin.popularNovels(1, popularOptions('all')), {
    message: /^\[patreon:HTTP\].*503/,
  });
  assert.equal(world.to('/api/current_user').length, 2);
});

test('errors reach every method: parseNovel and searchNovels', async () => {
  const campaignDown = h.boot({
    setup: world => world.on('/api/campaigns/' + PAID, {}, respond(401)),
  });
  await assert.rejects(
    campaignDown.plugin.parseNovel('campaign/' + PAID),
    tag('LOGIN_REQUIRED'),
  );
  const searchLimited = h.boot({
    setup: world =>
      world.on(
        '/api/search_feed/v1/campaign',
        { 'filter[query]': 'litrpg' },
        respond(429),
      ),
  });
  await assert.rejects(
    searchLimited.plugin.searchNovels('litrpg', 1),
    tag('RATE_LIMITED'),
  );
});

test('a fixture-less route fails with a clear message', async () => {
  const { plugin } = h.boot();
  await assert.rejects(
    plugin.parseChapter('posts/123456789'),
    /no fixture for \/api\/posts\/123456789/,
  );
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

test('resolveUrl for the three path kinds', () => {
  const { plugin } = h.boot();
  assert.equal(
    plugin.resolveUrl('campaign/' + PAID),
    'https://www.patreon.com/m/' + PAID,
  );
  assert.equal(
    plugin.resolveUrl('collection/' + COLLECTION),
    'https://www.patreon.com/collection/' + COLLECTION,
  );
  assert.equal(
    plugin.resolveUrl('posts/366282242'),
    'https://www.patreon.com/posts/366282242',
  );
});

test('a bad path fails with BAD_PATH and sends no request', async () => {
  const { plugin, world } = h.boot();
  for (const path of [
    '',
    'creator/12',
    'campaign/',
    'campaign/abc',
    'posts/x',
  ]) {
    assert.throws(() => plugin.resolveUrl(path), tag('BAD_PATH'), path);
  }
  for (const path of ['', 'creator/12', 'campaign/abc', 'posts/12']) {
    await assert.rejects(plugin.parseNovel(path), tag('BAD_PATH'), path);
  }
  for (const path of ['', 'campaign/12', 'posts/abc', 'collection/12']) {
    await assert.rejects(plugin.parseChapter(path), tag('BAD_PATH'), path);
  }
  assert.equal(world.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Shared with the Hermes runner
// ---------------------------------------------------------------------------

for (const scenario of smokeScenarios(h)) {
  test('smoke (also run under Hermes): ' + scenario.name, scenario.run);
}

// ---------------------------------------------------------------------------
// Request contract (uses the requests of every test above)
// ---------------------------------------------------------------------------

const COMMON = {
  'json-api-version': '1.0',
  'json-api-use-default-includes': 'false',
  'json-api-use-default-fields': 'false',
};
// From Part 1 of the spec: required names and optional names per request.
const CONTRACT = {
  R1: {
    path: /^\/api\/current_user$/,
    required: [
      'include-tree',
      'fields[user]',
      'fields[member]',
      'fields[campaign]',
    ],
    fixed: { 'include-tree': 'active_memberships{campaign}' },
    fields: {
      'fields[user]': 'full_name',
      'fields[member]': 'is_free_member,is_free_trial,patron_status',
      'fields[campaign]':
        'name,creation_name,vanity,url,avatar_photo_image_urls,is_nsfw',
    },
  },
  R2: {
    path: /^\/api\/collection$/,
    required: [
      'filter[campaign_id]',
      'filter[must_contain_at_least_one_published_post]',
      'sort',
      'fields[collection]',
    ],
    // R2 pages by cursor too (review decision "Paging (R2, R6)").
    optional: ['page[cursor]'],
    fixed: {
      'filter[must_contain_at_least_one_published_post]': 'true',
      sort: '-edited_at',
    },
    fields: {
      'fields[collection]':
        'title,description,num_posts,post_ids,thumbnail,url,current_user_num_locked_posts',
    },
  },
  R3: {
    path: /^\/api\/search_feed\/v1\/campaign$/,
    required: [
      'filter[query]',
      'filter[is_for_preview]',
      'filter[include_nsfw]',
      'page[size]',
      'include-tree',
      'fields[campaign]',
    ],
    optional: ['page[cursor]'],
    fixed: {
      'filter[is_for_preview]': 'false',
      'filter[include_nsfw]': 'false',
      'page[size]': '24',
      'include-tree': 'card_campaign.campaign',
    },
    fields: {
      'fields[campaign]':
        'name,creation_name,url,vanity,avatar_photo_image_urls,is_nsfw',
    },
  },
  R4: {
    path: /^\/api\/campaigns\/\d+$/,
    required: ['include', 'fields[campaign]', 'fields[user]'],
    fixed: { include: 'creator' },
    fields: {
      'fields[campaign]':
        'name,creation_name,summary,vanity,url,avatar_photo_image_urls,cover_photo_url_sizes,is_nsfw',
      'fields[user]': 'full_name',
    },
  },
  R5: {
    path: /^\/api\/collection\/\d+$/,
    required: ['include', 'fields[collection]', 'fields[campaign]'],
    fixed: { include: 'campaign' },
    fields: {
      'fields[collection]':
        'title,description,num_posts,post_ids,thumbnail,url',
      'fields[campaign]':
        'name,creation_name,vanity,url,avatar_photo_image_urls',
    },
  },
  R6: {
    path: /^\/api\/posts$/,
    required: [
      'filter[campaign_id]',
      'filter[contains_exclusive_posts]',
      'filter[is_draft]',
      'sort',
      'page[size]',
      'fields[post]',
    ],
    optional: ['filter[collection_id]', 'page[cursor]'],
    fixed: {
      'filter[contains_exclusive_posts]': 'true',
      'filter[is_draft]': 'false',
      'page[size]': '100',
    },
    fields: {
      'fields[post]': 'title,published_at,url,post_type,current_user_can_view',
    },
  },
  R7: {
    path: /^\/api\/posts\/\d+$/,
    required: ['include', 'fields[post]', 'fields[media]'],
    fixed: { include: 'attachments_media' },
    fields: {
      'fields[post]':
        'title,content,content_json_string,current_user_can_view,published_at,post_type,url,post_file,embed,image',
      'fields[media]': 'file_name,download_url,mimetype,image_urls',
    },
  },
};

const sameSet = (actual, expected) =>
  actual.split(',').sort().join() === expected.split(',').sort().join();

// Checks each request against Part 1 and returns the ids of the request kinds it saw.
function checkContract(requests) {
  const seen = new Set();
  for (const req of requests) {
    assert.ok(req.url.startsWith('https://www.patreon.com/api/'), req.url);
    const id = Object.keys(CONTRACT).find(key =>
      CONTRACT[key].path.test(req.path),
    );
    assert.ok(id, 'no request kind for ' + req.path);
    seen.add(id);
    const spec = CONTRACT[id];
    const allowed = [
      ...Object.keys(COMMON),
      ...spec.required,
      ...(spec.optional || []),
    ];
    for (const name of req.names) {
      assert.ok(
        allowed.includes(name),
        id + ' sends unlisted parameter ' + name,
      );
    }
    for (const name of [...Object.keys(COMMON), ...spec.required]) {
      assert.ok(req.names.includes(name), id + ' misses parameter ' + name);
    }
    for (const [name, value] of Object.entries({ ...COMMON, ...spec.fixed })) {
      assert.equal(req.params[name], value, id + ' ' + name);
    }
    // Field lists: the same members as Part 1, nothing missing, nothing extra.
    for (const [name, value] of Object.entries(spec.fields)) {
      assert.ok(
        sameSet(req.params[name], value),
        id + ' ' + name + ': expected ' + value + ' got ' + req.params[name],
      );
    }
    for (const raw of req.rawNames) {
      assert.ok(!/[[\]]/.test(raw), 'unencoded bracket in ' + raw);
    }
    for (const name of req.names.filter(n => /[[\]]/.test(n))) {
      assert.ok(req.rawQuery.includes(encodeURIComponent(name) + '='), name);
    }
    assert.ok(
      !req.init ||
        (!req.init.headers && (!req.init.method || req.init.method === 'GET')),
      'custom header or method on ' + req.url,
    );
    if (id === 'R6') {
      assert.ok(['published_at', 'collection_order'].includes(req.params.sort));
    }
  }
  return seen;
}

test('request contract: each method sends the R1-R7 requests of Part 1', async () => {
  // Drives every method itself, so the test does not depend on the other tests.
  const { plugin, world } = h.boot();
  await plugin.popularNovels(1, popularOptions('all')); // R1, R2
  await plugin.searchNovels('litrpg', 1); // R3
  await plugin.searchNovels('litrpg', 2); // R3 with a cursor
  await plugin.parseNovel('campaign/' + PAID); // R4, R6 (cursor on page 2)
  await plugin.parseNovel('collection/' + COLLECTION); // R5, R6 with a collection
  await plugin.parseChapter('posts/' + r7.paid.id); // R7
  assert.deepEqual([...checkContract(world.requests)].sort(), [
    'R1',
    'R2',
    'R3',
    'R4',
    'R5',
    'R6',
    'R7',
  ]);
  // The other tests only add requests of the same shapes (errors, retries, hand-made posts).
  checkContract(h.allRequests);
});

// ---------------------------------------------------------------------------
// Benchmark (SYNTHETIC data; asserts only request counts, prints numbers)
// ---------------------------------------------------------------------------

const median = values =>
  values.slice().sort((a, b) => a - b)[values.length >> 1];

test('benchmark (synthetic): parseNovel of a 5,000-post campaign', async () => {
  const TOTAL = 5000;
  const timings = [];
  let chapters = 0;
  for (let run = 0; run < 6; run++) {
    const { plugin, world } = h.boot({
      setup: (w, table) => benchCampaign(w, table, TOTAL),
    });
    const start = performance.now();
    const novel = await plugin.parseNovel('campaign/' + PAID);
    timings.push(performance.now() - start);
    chapters = novel.chapters.length;
    assert.equal(world.to('/api/campaigns/' + PAID).length, 1);
    assert.equal(world.to('/api/posts').length, Math.ceil(TOTAL / 100));
    assert.equal(world.requests.length, 1 + Math.ceil(TOTAL / 100));
  }
  // Floor: the same pages through the fake network and JSON.parse, without the plugin.
  const { world } = h.boot({
    setup: (w, table) => benchCampaign(w, table, TOTAL),
  });
  const floorStart = performance.now();
  let cursor;
  let rows = 0;
  do {
    const url =
      'https://www.patreon.com/api/posts?filter%5Bcampaign_id%5D=' +
      PAID +
      '&sort=published_at' +
      (cursor ? '&page%5Bcursor%5D=' + cursor : '');
    const body = JSON.parse(await (await world.fetchApi(url)).text());
    rows += body.data.length;
    cursor = body.meta.pagination.cursors.next;
  } while (cursor);
  const floor = performance.now() - floorStart;
  assert.equal(rows, TOTAL);
  assert.equal(chapters, TOTAL);
  console.log(
    `BENCH (synthetic, Node ${process.version}): parseNovel 5,000 posts / 51 requests: ` +
      `first run ${timings[0].toFixed(1)} ms, later runs median ${median(timings.slice(1)).toFixed(1)} ms ` +
      `(min ${Math.min(...timings.slice(1)).toFixed(1)}, max ${Math.max(...timings.slice(1)).toFixed(1)}); ` +
      `fake network + JSON.parse floor ${floor.toFixed(1)} ms`,
  );
});

test('benchmark (synthetic): renderer on the largest captured document repeated 200 times', async () => {
  const largest = [r7.paid, r7.publicImage]
    .map(post => post.attributes.content_json_string)
    .sort((a, b) => b.length - a.length)[0];
  const one = JSON.parse(largest);
  const doc = { type: 'doc', content: [] };
  for (let i = 0; i < 200; i++) doc.content.push(...one.content);
  const blocks =
    countNodes(largest, 'paragraph') + countNodes(largest, 'image');
  const timings = [];
  let html = '';
  for (let run = 0; run < 6; run++) {
    const { plugin } = h.boot({
      setup: world => addPost(world, '999000003', { doc }),
    });
    const start = performance.now();
    html = await plugin.parseChapter('posts/999000003');
    timings.push(performance.now() - start);
  }
  const json = JSON.stringify(doc);
  const parseStart = performance.now();
  JSON.parse(json);
  const parseOnly = performance.now() - parseStart;
  // Check that the work was done: every block of every repetition is in the output.
  assert.equal(html.split('<p>').length - 1, 200 * blocks);
  console.log(
    `BENCH (synthetic, Node ${process.version}): renderer ${largest.length} chars x 200 = ` +
      `${(json.length / 1e6).toFixed(2)} MB of JSON, ${200 * blocks} blocks: ` +
      `first run ${timings[0].toFixed(1)} ms, later runs median ${median(timings.slice(1)).toFixed(1)} ms ` +
      `(min ${Math.min(...timings.slice(1)).toFixed(1)}, max ${Math.max(...timings.slice(1)).toFixed(1)}); ` +
      `JSON.parse alone ${parseOnly.toFixed(1)} ms`,
  );
});
