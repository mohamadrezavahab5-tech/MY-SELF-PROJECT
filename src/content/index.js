'use strict';
// Single entry point for content data, with the {{site}} placeholder resolved.
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

const industries = deepBrand(load('industries', []));
const blog = deepBrand(load('blog', [])).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
const siteFaq = deepBrand(load('siteFaq', []));
const pages = deepBrand(load('pages', {}));

module.exports = {
  industries,
  blog,
  siteFaq,
  pages,
  industryById: id => industries.find(i => i.id === id) || null,
  industryBySlug: slug => industries.find(i => i.seo && i.seo.slug === slug) || null,
  postBySlug: slug => blog.find(p => p.slug === slug) || null,
};
