'use strict';
// Single entry point for content data. The built-in data files are merged with
// the site owner's edits from /admin/settings (src/settings.js):
//   siteFaq           <- setting 'siteFaq' ([{ q, a }])
//   pages.<key>       <- setting 'page:<key>' ({ title, bodyHtml })
//   blog              <- `posts` table (a row with a built-in slug replaces or,
//                        when deleted = 1, hides that built-in post)
// The {{site}} placeholder is resolved lazily, so a brand change applies at once.
// Results are cached per (site name, settings version).
const config = require('../config');
const settings = require('../settings');
const { brand } = require('../views/layout');

function load(name, fallback) {
  try {
    return require(`./${name}`);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') return fallback;
    throw e;
  }
}

function deepBrand(value) {
  if (typeof value === 'string') return brand(value);
  if (Array.isArray(value)) return value.map(deepBrand);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepBrand(v);
    return out;
  }
  return value;
}

// Built-in content exactly as shipped (with {{site}} placeholders).
const builtin = {
  industries: load('industries', []),
  blog: load('blog', []),
  siteFaq: load('siteFaq', []),
  pages: load('pages', {}),
};
const builtinSlugs = new Set(builtin.blog.map(p => p.slug));
const PAGE_KEYS = ['terms', 'privacy', 'about'];

let memo = { key: null, values: new Map() };
function cached(name, build) {
  const key = `${config.siteName}\u0000${settings.version()}`;
  if (memo.key !== key) memo = { key, values: new Map() };
  if (!memo.values.has(name)) memo.values.set(name, build());
  return memo.values.get(name);
}

const byDateDesc = (a, b) => String(b.date).localeCompare(String(a.date));

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function fromRow(r) {
  const base = builtin.blog.find(p => p.slug === r.slug);
  return {
    slug: r.slug,
    title: r.title,
    metaDescription: r.meta_description,
    date: r.date,
    updated: isoDay(r.updated_at),
    readingMinutes: r.reading_minutes,
    bodyHtml: r.body_html,
    related: base ? base.related || [] : [],
    published: !!r.published,
  };
}

// Raw (unbranded) merged list; drafts only when asked (admin preview).
function mergedBlog({ drafts = false } = {}) {
  const rows = settings.posts.all();
  const rowSlugs = new Set(rows.map(r => r.slug));
  const out = builtin.blog.filter(p => !rowSlugs.has(p.slug)).map(p => ({ ...p, published: true }));
  for (const r of rows) {
    if (r.deleted) continue;
    if (!r.published && !drafts) continue;
    out.push(fromRow(r));
  }
  return out.sort(byDateDesc);
}

function validFaq(list) {
  if (!Array.isArray(list)) return null;
  return list.filter(f => f && typeof f.q === 'string' && typeof f.a === 'string' && f.q.trim() && f.a.trim());
}

const api = {
  get industries() {
    return cached('industries', () => deepBrand(builtin.industries));
  },
  // Published posts, newest first.
  get blog() {
    return cached('blog', () => deepBrand(mergedBlog()));
  },
  get siteFaq() {
    return cached('siteFaq', () => deepBrand(validFaq(settings.get('siteFaq')) || builtin.siteFaq));
  },
  get pages() {
    return cached('pages', () => {
      const out = {};
      const keys = new Set([...Object.keys(builtin.pages), ...PAGE_KEYS]);
      for (const k of keys) {
        const base = builtin.pages[k] || null;
        const o = settings.get(`page:${k}`) || null;
        if (!base && !o) continue;
        out[k] = deepBrand({
          title: (o && o.title) || (base && base.title) || '',
          bodyHtml: (o && o.bodyHtml) || (base && base.bodyHtml) || '',
        });
      }
      return out;
    });
  },
  industryById: id => api.industries.find(i => i.id === id) || null,
  industryBySlug: slug => api.industries.find(i => i.seo && i.seo.slug === slug) || null,
  postBySlug: slug => api.blog.find(p => p.slug === slug) || null,
  // Unpublished posts too; only for the admin's preview.
  draftBySlug: slug => {
    const p = mergedBlog({ drafts: true }).find(x => x.slug === slug);
    return p ? deepBrand(p) : null;
  },

  // ---- For the admin panel -----------------------------------------------------------
  builtin,
  PAGE_KEYS,
  isBuiltinPost: slug => builtinSlugs.has(slug),
  // Every post the admin can see: built-in (as shipped / edited / deleted) and own posts.
  adminPosts() {
    const rows = settings.posts.all();
    const rowBySlug = new Map(rows.map(r => [r.slug, r]));
    const out = [];
    for (const p of builtin.blog) {
      const r = rowBySlug.get(p.slug);
      if (!r) out.push({ slug: p.slug, title: p.title, date: p.date, source: 'builtin', published: true, deleted: false });
      else if (r.deleted) out.push({ slug: p.slug, title: p.title, date: p.date, source: 'builtin', published: false, deleted: true });
      else out.push({ slug: p.slug, title: r.title, date: r.date, source: 'edited', published: !!r.published, deleted: false });
    }
    for (const r of rows) {
      if (builtinSlugs.has(r.slug)) continue;
      out.push({ slug: r.slug, title: r.title, date: r.date, source: 'custom', published: !!r.published, deleted: false });
    }
    return out.sort(byDateDesc);
  },
  // Editable (unbranded) fields of one post, or null.
  rawPost(slug) {
    const r = settings.posts.get(slug);
    if (r && !r.deleted) {
      return { slug: r.slug, title: r.title, metaDescription: r.meta_description, date: r.date, readingMinutes: r.reading_minutes, bodyHtml: r.body_html, published: !!r.published, builtin: builtinSlugs.has(slug), edited: true };
    }
    const p = builtin.blog.find(x => x.slug === slug);
    if (!p || (r && r.deleted)) return null;
    return { slug: p.slug, title: p.title, metaDescription: p.metaDescription, date: p.date, readingMinutes: p.readingMinutes, bodyHtml: p.bodyHtml, published: true, builtin: true, edited: false };
  },
  // Editable (unbranded) static page.
  rawPage(key) {
    const base = builtin.pages[key] || { title: '', bodyHtml: '' };
    const o = settings.get(`page:${key}`) || null;
    return { title: (o && o.title) || base.title, bodyHtml: (o && o.bodyHtml) || base.bodyHtml, edited: !!o };
  },
};

module.exports = api;
