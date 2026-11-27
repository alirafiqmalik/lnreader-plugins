import { fetchApi } from '@libs/fetch';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { storage } from '@libs/storage';
import { Plugin } from '@/types/plugin';
import { load as parseHTML } from 'cheerio';

/*
 * Fork-only plugin. It reads the posts of the user's Patreon memberships with
 * cookie-authenticated GET calls. The user logs in through the app WebView
 * (globe icon); the plugin never sees credentials. Design: workflow/context/patreon-plugin.md
 *
 * Modules, in order: 1 types and errors, 2 boundary, 3 parsers, 4 novel kinds,
 * 5 profiles, 6 renderer, 7 plugin class.
 */

const SITE = 'https://www.patreon.com';
const PAGE_SIZE = 100;
const SEARCH_PAGE_SIZE = 24;
const MAX_PAGES = 200;
const LOCK_PREFIX = '🔒 ';

// ---------------------------------------------------------------------------
// 1. Types and errors
// ---------------------------------------------------------------------------

// The tag in square brackets is stable, so tests and users can match it.
const ERRORS = {
  LOGIN_REQUIRED:
    '[patreon:LOGIN_REQUIRED] Sign in to Patreon to resume reading. Open the Patreon source, tap the globe icon, and sign in with your Patreon email and password. Then return and retry.',
  LOCKED: '[patreon:LOCKED] This post is locked. Check your access on Patreon.',
  INVALID_SESSION_RESPONSE:
    '[patreon:INVALID_SESSION_RESPONSE] Could not confirm your Patreon sign-in. Try again.',
  RATE_LIMITED:
    '[patreon:RATE_LIMITED] Patreon is limiting requests. Wait a few minutes and try again.',
  BLOCKED:
    '[patreon:BLOCKED] Patreon did not answer with data (bot check or block page). Open the WebView on this source to pass the check, then try again.',
  NOT_FOUND: '[patreon:NOT_FOUND] Patreon has no such page or post.',
  HTTP: '[patreon:HTTP] Patreon request failed. HTTP status:',
  BAD_PATH: '[patreon:BAD_PATH] Unknown path:',
};

type ErrorCode = keyof typeof ERRORS;

function fail(code: ErrorCode, detail?: string): Error {
  return new Error(detail ? ERRORS[code] + ' ' + detail : ERRORS[code]);
}

type CampaignInfo = {
  id: string;
  name: string;
  author?: string;
  cover?: string;
  summary?: string;
  url?: string;
};

type CollectionInfo = {
  id: string;
  campaignId: string;
  title: string;
  cover?: string;
  description?: string;
};

type PostSummary = {
  id: string;
  title: string;
  publishedAt: string;
  postType: string;
  canView: boolean;
};

type Attachment = { name: string; url: string; mimetype: string };

type PostBody = {
  id: string;
  campaignId?: string;
  title: string;
  canView: boolean;
  contentJson?: string;
  contentHtml?: string;
  postFile?: { name: string; url: string };
  embed?: { title: string; url: string };
  attachments: Attachment[];
};

type Membership = { campaign: CampaignInfo; kind: 'paid' | 'free' };

// ---------------------------------------------------------------------------
// 2. Boundary: one request function, error mapping, JSON:API access
// ---------------------------------------------------------------------------

type Param = [string, string];

type JsonApiRef = { id: string; type: string };
type JsonApiResource = {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: JsonApiRef | JsonApiRef[] | null }>;
};
type JsonApiDoc = {
  data?: JsonApiResource | JsonApiResource[] | null;
  included?: JsonApiResource[];
  meta?: { pagination?: { cursors?: { next?: string | null } } };
};
type Included = Record<string, JsonApiResource>;

const COMMON_FLAGS: Param[] = [
  ['json-api-version', '1.0'],
  ['json-api-use-default-includes', 'false'],
  ['json-api-use-default-fields', 'false'],
];

// The one place that builds query strings: names get %5B / %5D, values are encoded.
function buildQuery(params: Param[]): string {
  return params
    .map(p => encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]))
    .join('&');
}

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

async function api(path: string, params: Param[]): Promise<JsonApiDoc> {
  const url =
    SITE + '/api/' + path + '?' + buildQuery(params.concat(COMMON_FLAGS));
  let res = await fetchApi(url);
  if (res.status === 502 || res.status === 503) {
    await sleep(500);
    res = await fetchApi(url);
  }
  if (res.status === 401) throw fail('LOGIN_REQUIRED');
  if (res.status === 429) throw fail('RATE_LIMITED');
  if (res.status === 404) throw fail('NOT_FOUND');
  const text = await res.text();
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = undefined; // HTML instead of JSON: a bot check or block page
  }
  const isJson = !!doc && typeof doc === 'object';
  if (res.status === 403 && !isJson) throw fail('BLOCKED');
  if (res.status < 200 || res.status >= 300) {
    throw fail('HTTP', String(res.status));
  }
  if (!isJson) throw fail('BLOCKED');
  return doc as JsonApiDoc;
}

function indexIncluded(doc: JsonApiDoc): Included {
  const index: Included = {};
  for (const res of doc.included || []) {
    index[res.type + ':' + res.id] = res;
  }
  return index;
}

function dataList(doc: JsonApiDoc): JsonApiResource[] {
  if (Array.isArray(doc.data)) return doc.data;
  return doc.data ? [doc.data] : [];
}

function nextCursor(doc: JsonApiDoc): string | undefined {
  const next = doc.meta?.pagination?.cursors?.next;
  return typeof next === 'string' && next ? next : undefined;
}

// Follows the cursor of a list endpoint. `pageSize` is optional (R2 has none).
async function collectPages<T>(
  path: string,
  params: Param[],
  parse: (doc: JsonApiDoc) => T[],
  pageSize?: number,
): Promise<T[]> {
  const all: T[] = [];
  const seen: Record<string, boolean> = {};
  let cursor: string | undefined;
  // MAX_PAGES x PAGE_SIZE = 20,000 posts: past that a partial list beats none.
  for (let page = 0; page < MAX_PAGES; page++) {
    let query = params;
    if (pageSize) query = query.concat([['page[size]', String(pageSize)]]);
    if (cursor) query = query.concat([['page[cursor]', cursor]]);
    const doc = await api(path, query);
    for (const item of parse(doc)) all.push(item);
    cursor = nextCursor(doc);
    // A repeated cursor would return the same pages again.
    if (!cursor || seen[cursor]) break;
    seen[cursor] = true;
  }
  return all;
}

// ---------------------------------------------------------------------------
// 3. Parsers: the only code that reads raw JSON:API
// ---------------------------------------------------------------------------

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : undefined;

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

const attrsOf = (res?: JsonApiResource): Record<string, unknown> =>
  res?.attributes || {};

function relRefs(res: JsonApiResource, name: string): JsonApiRef[] {
  const data = res.relationships?.[name]?.data;
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

function relOne(
  res: JsonApiResource,
  name: string,
  inc: Included,
): JsonApiResource | undefined {
  const ref = relRefs(res, name)[0];
  return ref ? inc[ref.type + ':' + ref.id] : undefined;
}

// First usable URL among `keys` of an object (or the string itself).
function pickUrl(value: unknown, keys: string[]): string | undefined {
  if (typeof value === 'string') return value || undefined;
  const o = obj(value);
  if (!o) return undefined;
  for (const key of keys) {
    const url = str(o[key]);
    if (url) return url;
  }
  return undefined;
}

function htmlToText(html: unknown): string | undefined {
  const source = str(html);
  if (!source) return undefined;
  const text = parseHTML(
    source.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'),
  )
    .root()
    .text()
    .trim();
  return text || undefined;
}

function parseCampaign(res: JsonApiResource, inc: Included): CampaignInfo {
  const a = attrsOf(res);
  const name = str(a.name) || str(a.vanity) || 'Campaign ' + res.id;
  const creator = relOne(res, 'creator', inc);
  return {
    id: res.id,
    name,
    author: str(attrsOf(creator).full_name) || name,
    cover: pickUrl(a.avatar_photo_image_urls, [
      'thumbnail_large',
      'default',
      'original',
    ]),
    summary: htmlToText(a.summary),
    url: str(a.url),
  };
}

function parseCollection(
  res: JsonApiResource,
  campaignId: string,
  campaignCover?: string,
): CollectionInfo {
  const a = attrsOf(res);
  return {
    id: res.id,
    campaignId,
    title: str(a.title) || 'Collection ' + res.id,
    cover: pickUrl(a.thumbnail, ['default', 'url']) || campaignCover,
    description: htmlToText(a.description),
  };
}

function parsePostSummary(res: JsonApiResource): PostSummary {
  const a = attrsOf(res);
  return {
    id: res.id,
    title: str(a.title) || 'Untitled',
    publishedAt: str(a.published_at) || '',
    postType: str(a.post_type) || '',
    canView: a.current_user_can_view !== false,
  };
}

function parsePostBody(doc: JsonApiDoc): PostBody {
  const res = dataList(doc)[0];
  if (!res) throw fail('NOT_FOUND');
  const inc = indexIncluded(doc);
  const a = attrsOf(res);
  const file = obj(a.post_file);
  const embed = obj(a.embed);
  const fileUrl = str(file?.url);
  const embedUrl = str(embed?.url);
  const attachments: Attachment[] = [];
  for (const ref of relRefs(res, 'attachments_media')) {
    const media = attrsOf(inc[ref.type + ':' + ref.id]);
    const url = str(media.download_url);
    if (url) {
      attachments.push({
        name: str(media.file_name) || 'Attachment',
        url,
        mimetype: str(media.mimetype) || '',
      });
    }
  }
  return {
    id: res.id,
    campaignId: relRefs(res, 'campaign')[0]?.id,
    title: str(a.title) || 'Untitled',
    // Patreon sends a body only to readers who may see it. Without the flag,
    // a post with no body is treated as locked.
    canView:
      a.current_user_can_view === true ||
      (a.current_user_can_view == null &&
        !!(str(a.content_json_string) || str(a.content))),
    contentJson: str(a.content_json_string),
    contentHtml: str(a.content),
    postFile: fileUrl
      ? { name: str(file?.name) || 'File', url: fileUrl }
      : undefined,
    embed: embedUrl
      ? { title: str(embed?.subject) || embedUrl, url: embedUrl }
      : undefined,
    attachments,
  };
}

// Paid memberships first, then free ones. Former and declined patrons are dropped.
function parseMemberships(doc: JsonApiDoc): Membership[] {
  const user = dataList(doc)[0];
  if (!user) return [];
  const inc = indexIncluded(doc);
  const paid: Membership[] = [];
  const free: Membership[] = [];
  const seen: Record<string, boolean> = {};
  for (const ref of relRefs(user, 'active_memberships')) {
    const member = inc[ref.type + ':' + ref.id];
    if (!member) continue;
    const a = attrsOf(member);
    const campaignRes = relOne(member, 'campaign', inc);
    if (!campaignRes || seen[campaignRes.id]) continue;
    const isPaid = a.patron_status === 'active_patron';
    const isFree = a.is_free_member === true || a.is_free_trial === true;
    if (!isPaid && !isFree) continue;
    seen[campaignRes.id] = true;
    const campaign = parseCampaign(campaignRes, inc);
    if (isPaid) paid.push({ campaign, kind: 'paid' });
    else free.push({ campaign, kind: 'free' });
  }
  return paid.concat(free);
}

// R8: the identity check needs only the default resource type and ID.
async function requireSession(): Promise<void> {
  const { data } = await api('current_user', []);
  if (!data || Array.isArray(data) || data.type !== 'user' || !str(data.id)) {
    throw fail('INVALID_SESSION_RESPONSE');
  }
}

// R1
async function loadMemberships(): Promise<Membership[]> {
  const doc = await api('current_user', [
    ['include-tree', 'active_memberships{campaign}'],
    ['fields[user]', 'full_name'],
    ['fields[member]', 'is_free_member,is_free_trial,patron_status'],
    [
      'fields[campaign]',
      'name,creation_name,vanity,url,avatar_photo_image_urls,is_nsfw',
    ],
  ]);
  return parseMemberships(doc);
}

// The same name in the browse list and in the library: "Creator: Collection".
function collectionName(creator: string | undefined, title: string): string {
  return creator ? creator + ': ' + title : title;
}

// R2
async function loadCollections(
  campaignId: string,
  campaignCover?: string,
): Promise<CollectionInfo[]> {
  return collectPages(
    'collection',
    [
      ['filter[campaign_id]', campaignId],
      ['filter[must_contain_at_least_one_published_post]', 'true'],
      ['sort', '-edited_at'],
      [
        'fields[collection]',
        'title,description,num_posts,post_ids,thumbnail,url,current_user_num_locked_posts',
      ],
    ],
    doc =>
      dataList(doc).map(res => parseCollection(res, campaignId, campaignCover)),
  );
}

// ---------------------------------------------------------------------------
// 4. Novel kinds: one entry per path prefix
// ---------------------------------------------------------------------------

type NovelMeta = {
  campaignId: string;
  name: string;
  cover?: string;
  summary?: string;
  author?: string;
};

type NovelKind = {
  webUrl(id: string): string;
  loadMeta(id: string): Promise<NovelMeta>;
  chapterQuery(id: string, meta: NovelMeta): Param[];
};

// R6 filters, without paging. `sort` comes from the creator profile.
function postsQuery(
  campaignId: string,
  collectionId: string | undefined,
  sort: string,
): Param[] {
  const query: Param[] = [['filter[campaign_id]', campaignId]];
  if (collectionId) query.push(['filter[collection_id]', collectionId]);
  query.push(
    ['filter[contains_exclusive_posts]', 'true'],
    ['filter[is_draft]', 'false'],
    ['sort', sort],
    ['fields[post]', 'title,published_at,url,post_type,current_user_can_view'],
  );
  return query;
}

const NOVEL_KINDS: Record<'campaign' | 'collection', NovelKind> = {
  campaign: {
    webUrl: id => SITE + '/m/' + id,
    async loadMeta(id) {
      const doc = await api('campaigns/' + id, [
        ['include', 'creator'],
        [
          'fields[campaign]',
          'name,creation_name,summary,vanity,url,avatar_photo_image_urls,cover_photo_url_sizes,is_nsfw',
        ],
        ['fields[user]', 'full_name'],
      ]);
      const res = dataList(doc)[0];
      if (!res) throw fail('NOT_FOUND');
      const campaign = parseCampaign(res, indexIncluded(doc));
      return {
        campaignId: campaign.id,
        name: campaign.name,
        cover: campaign.cover,
        summary: campaign.summary,
        author: campaign.author,
      };
    },
    chapterQuery: (id, meta) =>
      postsQuery(meta.campaignId, undefined, 'published_at'),
  },
  collection: {
    webUrl: id => SITE + '/collection/' + id,
    async loadMeta(id) {
      const doc = await api('collection/' + id, [
        ['include', 'campaign'],
        [
          'fields[collection]',
          'title,description,num_posts,post_ids,thumbnail,url',
        ],
        [
          'fields[campaign]',
          'name,creation_name,vanity,url,avatar_photo_image_urls',
        ],
      ]);
      const res = dataList(doc)[0];
      if (!res) throw fail('NOT_FOUND');
      const inc = indexIncluded(doc);
      const campaignRes = relOne(res, 'campaign', inc);
      const campaignId = campaignRes?.id || relRefs(res, 'campaign')[0]?.id;
      if (!campaignId) throw fail('NOT_FOUND');
      const campaign = campaignRes
        ? parseCampaign(campaignRes, inc)
        : undefined;
      const collection = parseCollection(res, campaignId, campaign?.cover);
      return {
        campaignId,
        name: collectionName(campaign?.name, collection.title),
        cover: collection.cover,
        summary: collection.description,
        author: campaign?.name,
      };
    },
    chapterQuery: (id, meta) =>
      postsQuery(
        meta.campaignId,
        id,
        profileFor(meta.campaignId).collectionSort,
      ),
  },
};

function parseNovelPath(path: string): { kind: NovelKind; id: string } {
  const match = /^(campaign|collection)\/(\d+)$/.exec(path);
  if (!match) throw fail('BAD_PATH', path);
  return {
    kind: NOVEL_KINDS[match[1] as keyof typeof NOVEL_KINDS],
    id: match[2],
  };
}

function parsePostPath(path: string): string {
  const match = /^posts\/(\d+)$/.exec(path);
  if (!match) throw fail('BAD_PATH', path);
  return match[1];
}

// R6, all pages.
function listPosts(query: Param[]): Promise<PostSummary[]> {
  return collectPages(
    'posts',
    query,
    doc => dataList(doc).map(parsePostSummary),
    PAGE_SIZE,
  );
}

// ---------------------------------------------------------------------------
// 5. Creator profiles: a creator with a different layout is one entry here
// ---------------------------------------------------------------------------

type BodyPart = 'body' | 'postFile' | 'embed' | 'attachments';

type Profile = {
  isChapter(post: PostSummary): boolean;
  chapterName(post: PostSummary): string;
  collectionSort: 'published_at' | 'collection_order';
  bodyParts: BodyPart[];
};

const DEFAULT_PROFILE: Profile = {
  isChapter: () => true,
  chapterName: post => post.title,
  // collection_order is the creator's own order and can be wrong for reading
  collectionSort: 'published_at',
  bodyParts: ['body', 'postFile', 'embed', 'attachments'],
};

// Keyed by campaign id. Empty on purpose.
const PROFILES: Record<string, Partial<Profile>> = {};

function profileFor(campaignId: string): Profile {
  const override = Object.prototype.hasOwnProperty.call(PROFILES, campaignId)
    ? PROFILES[campaignId]
    : {};
  return { ...DEFAULT_PROFILE, ...override };
}

// ---------------------------------------------------------------------------
// 6. Renderer: ProseMirror JSON to HTML, table driven, pure
// ---------------------------------------------------------------------------

type PmMark = { type: string; attrs?: Record<string, unknown> };
type PmNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
  marks?: PmMark[];
};

const own = (table: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(table, key);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only http(s) URLs may reach href/src. Everything else is dropped.
function safeUrl(value: unknown): string | undefined {
  const url = str(value)?.trim();
  return url && /^https?:\/\//i.test(url) ? escapeHtml(url) : undefined;
}

const MARK_RENDERERS: Record<string, (inner: string, mark: PmMark) => string> =
  {
    bold: inner => '<strong>' + inner + '</strong>',
    italic: inner => '<em>' + inner + '</em>',
    underline: inner => '<u>' + inner + '</u>',
    strike: inner => '<s>' + inner + '</s>',
    code: inner => '<code>' + inner + '</code>',
    link: (inner, mark) => {
      const href = safeUrl(mark.attrs?.href);
      return href ? '<a href="' + href + '">' + inner + '</a>' : inner;
    },
  };

// The first mark is the innermost one.
function applyMarks(html: string, marks?: PmMark[]): string {
  let out = html;
  for (const mark of marks || []) {
    if (own(MARK_RENDERERS, mark.type)) {
      out = MARK_RENDERERS[mark.type](out, mark);
    }
  }
  return out;
}

const wrap = (tag: string) => (_node: PmNode, children: string) =>
  '<' + tag + '>' + children + '</' + tag + '>';

const NODE_RENDERERS: Record<
  string,
  (node: PmNode, children: string) => string
> = {
  doc: (_node, children) => children,
  paragraph: wrap('p'),
  text: node => applyMarks(escapeHtml(node.text || ''), node.marks),
  hardBreak: () => '<br>',
  horizontalRule: () => '<hr>',
  heading: (node, children) => {
    const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 2));
    return '<h' + level + '>' + children + '</h' + level + '>';
  },
  bulletList: wrap('ul'),
  orderedList: wrap('ol'),
  listItem: wrap('li'),
  blockquote: wrap('blockquote'),
  codeBlock: (_node, children) => '<pre><code>' + children + '</code></pre>',
  image: node => {
    const src = safeUrl(node.attrs?.src);
    if (!src) return '';
    const alt = escapeHtml(str(node.attrs?.alt) || '');
    return '<p><img src="' + src + '" alt="' + alt + '"></p>';
  },
};

function renderNode(node: PmNode): string {
  const children = (node.content || []).map(renderNode).join('');
  if (own(NODE_RENDERERS, node.type)) {
    return NODE_RENDERERS[node.type](node, children);
  }
  // Unknown node: keep what can be read.
  return children || escapeHtml(node.text || '');
}

function renderDoc(json: string): string {
  return renderNode(JSON.parse(json) as PmNode);
}

// Allowed tags of Patreon's HTML `content` and their allowed attributes. Other tags
// are unwrapped (their text stays); DROPPED_HTML is removed with its content.
const ALLOWED_HTML: Record<string, string[]> = {
  p: [],
  br: [],
  hr: [],
  div: [],
  span: [],
  strong: [],
  b: [],
  em: [],
  i: [],
  u: [],
  s: [],
  code: [],
  pre: [],
  blockquote: [],
  ul: [],
  ol: [],
  li: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  a: ['href'],
  img: ['src', 'alt'],
};
const DROPPED_HTML =
  'script,style,iframe,object,embed,noscript,template,form,svg,math,link,meta,base';

// The app downloads every <img src> of a chapter before it renders anything,
// so the raw HTML must pass the same http(s) rule as the renderer.
function sanitizeHtml(html: string): string {
  const $ = parseHTML(html);
  $(DROPPED_HTML).remove();
  $('body *').each((_i, el) => {
    const node = $(el);
    const tag = el.tagName.toLowerCase();
    if (!own(ALLOWED_HTML, tag)) {
      node.replaceWith(node.contents());
      return;
    }
    for (const name of Object.keys(el.attribs || {})) {
      const allowed = ALLOWED_HTML[tag].indexOf(name) !== -1;
      const urlOk =
        (name !== 'href' && name !== 'src') || safeUrl(el.attribs[name]);
      if (!allowed || !urlOk) node.removeAttr(name);
    }
  });
  return $('body').html() || '';
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp)(\?|$)/i;

function link(url: string | undefined, label: string): string {
  const href = safeUrl(url);
  return href
    ? '<p><a href="' + href + '">' + escapeHtml(label) + '</a></p>'
    : '';
}

const BODY_PARTS: Record<BodyPart, (post: PostBody) => string> = {
  body: post => {
    if (post.contentJson) return renderDoc(post.contentJson);
    return post.contentHtml ? sanitizeHtml(post.contentHtml) : '';
  },
  postFile: post => {
    const file = post.postFile;
    if (!file) return '';
    if (!IMAGE_FILE.test(file.name) && !IMAGE_FILE.test(file.url)) {
      return link(file.url, file.name);
    }
    const src = safeUrl(file.url);
    return src ? '<p><img src="' + src + '"></p>' : '';
  },
  embed: post => (post.embed ? link(post.embed.url, post.embed.title) : ''),
  attachments: post =>
    post.attachments
      .map(item => {
        if (/^image\//i.test(item.mimetype)) {
          const src = safeUrl(item.url);
          return src
            ? '<p><img src="' +
                src +
                '" alt="' +
                escapeHtml(item.name) +
                '"></p>'
            : '';
        }
        return link(item.url, item.name);
      })
      .join('\n'),
};

function renderPost(post: PostBody, profile: Profile): string {
  return profile.bodyParts
    .map(part => BODY_PARTS[part](post))
    .filter(html => html)
    .join('\n');
}

// ---------------------------------------------------------------------------
// 7. Plugin class: a thin shell over modules 1-6
// ---------------------------------------------------------------------------

// Search cursors: page N needs the cursor from page N-1.
// cursors[term][p] is the cursor that opens page p, or null when page p does not exist.
const searchCursors: Record<string, Record<number, string | null>> = {};

function hideLockedSetting(): boolean {
  const value = storage.get('hideLocked');
  return value === true || value === 'true';
}

class PatreonPlugin implements Plugin.PluginBase {
  id = 'patreondev';
  name = 'patreon[dev]';
  icon = 'src/multi/patreondev/icon.png';
  site = SITE;
  version = '1.0.1';

  filters = {
    show: {
      type: FilterTypes.Picker,
      label: 'Show',
      value: 'all',
      options: [
        { label: 'Creators and collections', value: 'all' },
        { label: 'Creators only', value: 'creators' },
        { label: 'Collections only', value: 'collections' },
      ],
    },
  } satisfies Filters;

  pluginSettings = {
    hideLocked: {
      value: false,
      label: 'Hide locked chapters (applies when a chapter list loads)',
      type: 'Switch',
    },
  };

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];
    const show = filters?.show?.value || 'all';
    const novels: Plugin.NovelItem[] = [];
    for (const { campaign } of await loadMemberships()) {
      if (show !== 'collections') {
        novels.push({
          name: campaign.name,
          path: 'campaign/' + campaign.id,
          cover: campaign.cover,
        });
      }
      if (show !== 'creators') {
        for (const col of await loadCollections(campaign.id, campaign.cover)) {
          novels.push({
            name: collectionName(campaign.name, col.title),
            path: 'collection/' + col.id,
            cover: col.cover,
          });
        }
      }
    }
    return novels;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const key = 't:' + searchTerm;
    if (pageNo <= 1 || !searchCursors[key]) searchCursors[key] = {};
    const cursors = searchCursors[key];

    const fetchPage = async (page: number): Promise<Plugin.NovelItem[]> => {
      const params: Param[] = [
        ['filter[query]', searchTerm],
        ['filter[is_for_preview]', 'false'],
        ['filter[include_nsfw]', 'false'],
        ['page[size]', String(SEARCH_PAGE_SIZE)],
        ['include-tree', 'card_campaign.campaign'],
        [
          'fields[campaign]',
          'name,creation_name,url,vanity,avatar_photo_image_urls,is_nsfw',
        ],
      ];
      const cursor = cursors[page];
      if (cursor) params.push(['page[cursor]', cursor]);
      const doc = await api('search_feed/v1/campaign', params);
      // A cursor seen before would repeat results: treat it as the end.
      const next = nextCursor(doc);
      let repeated = false;
      for (const known in cursors) {
        // Only the cursors that opened this page or an earlier one count.
        if (Number(known) <= page && cursors[known] === next) repeated = true;
      }
      const value = next && !repeated ? next : null;
      if (cursors[page + 1] !== undefined && cursors[page + 1] !== value) {
        // A changed cursor makes the cursors of later pages stale.
        for (const known in cursors) {
          if (Number(known) > page + 1) delete cursors[known];
        }
      }
      cursors[page + 1] = value;
      const inc = indexIncluded(doc);
      const novels: Plugin.NovelItem[] = [];
      for (const item of dataList(doc)) {
        const card = relOne(item, 'card_campaign', inc);
        const res = card
          ? relOne(card, 'campaign', inc)
          : item.type === 'campaign'
            ? item
            : undefined;
        if (!res) continue;
        const campaign = parseCampaign(res, inc);
        novels.push({
          name: campaign.name,
          path: 'campaign/' + campaign.id,
          cover: campaign.cover,
        });
      }
      return novels;
    };

    // Walk from page 1 and fetch earlier pages only to learn their cursors.
    for (let page = 1; page <= pageNo; page++) {
      if (page === pageNo) return fetchPage(page);
      if (cursors[page + 1] === undefined) await fetchPage(page);
      if (cursors[page + 1] === null) return [];
    }
    return [];
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const { kind, id } = parseNovelPath(novelPath);
    const meta = await kind.loadMeta(id);
    const profile = profileFor(meta.campaignId);
    const hideLocked = hideLockedSetting();

    const posts = (await listPosts(kind.chapterQuery(id, meta))).filter(post =>
      profile.isChapter(post),
    );
    if (posts.some(post => !post.canView)) await requireSession();
    // Numbers come from the full list, so they stay the same when hideLocked
    // changes (the app keeps chapters it saved before).
    const chapters = posts.map((post, index) => ({
      name: (post.canView ? '' : LOCK_PREFIX) + profile.chapterName(post),
      path: 'posts/' + post.id,
      releaseTime: post.publishedAt || null,
      chapterNumber: index + 1,
    }));

    return {
      path: novelPath,
      name: meta.name,
      cover: meta.cover,
      summary: meta.summary,
      author: meta.author,
      chapters: chapters.filter(
        (_chapter, index) => posts[index].canView || !hideLocked,
      ),
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const id = parsePostPath(chapterPath);
    const post = parsePostBody(
      await api('posts/' + id, [
        ['include', 'attachments_media'],
        [
          'fields[post]',
          'title,content,content_json_string,current_user_can_view,published_at,post_type,url,post_file,embed,image',
        ],
        ['fields[media]', 'file_name,download_url,mimetype,image_urls'],
      ]),
    );
    if (!post.canView) {
      await requireSession();
      throw fail('LOCKED');
    }
    return renderPost(post, profileFor(post.campaignId || ''));
  }

  resolveUrl(path: string): string {
    if (/^posts\/\d+$/.test(path)) return SITE + '/' + path;
    const { kind, id } = parseNovelPath(path);
    return kind.webUrl(id);
  }
}

export default new PatreonPlugin();
