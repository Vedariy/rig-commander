import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const { version } = JSON.parse(read('package.json'));
const origin = 'https://rig-commander.vercel.app';
const routes = ['/', '/guide', '/passport', '/demo', '/llms.txt', '/llms-full.txt'];
const docs = [
  ['/', 'index', 'public/index.html'],
  ['/guide', 'guide', 'public/guide/index.html'],
  ['/passport', 'passport', 'public/passport/index.html']
];

test('all discovery outputs and CLI guide mirrors match their versioned sources', () => {
  for (const [, name, path] of docs) {
    const expected = read('landing/' + name + '.html').replaceAll('{{APP_VERSION}}', version);
    assert.equal(read(path), expected);
    if (name !== 'index') assert.equal(read('openrig/' + name + '.html'), expected);
  }
  for (const name of ['llms.txt', 'llms-full.txt', 'robots.txt', 'sitemap.xml']) {
    const output = read('public/' + name);
    assert.equal(output, read('landing/' + name).replaceAll('{{APP_VERSION}}', version));
    if (name.startsWith('llms')) {
      assert.ok(output.startsWith('# RigCommander'));
      assert.match(output, /\n> /);
      assert.ok(output.includes('v' + version));
      assert.match(output, /[А-Яа-я]/);
      assert.ok(output.includes('MIT') && output.includes('tmux'));
    }
  }
  const index = read('public/llms.txt');
  const links = ['/', '/demo', '/guide', '/passport', '/llms-full.txt'].map(route => origin + route);
  links.push('https://github.com/Vedariy/rig-commander', 'https://www.npmjs.com/package/rig-commander');
  for (const url of links) assert.ok(index.includes('](' + url + ')'), url);
});

test('pages declare canonical URLs, version, crawler directives and typed JSON-LD', () => {
  for (const [route, name, path] of docs) {
    const html = read(path);
    assert.ok(html.includes(`<link rel="canonical" href="${origin}${route}">`));
    assert.ok(html.includes('rel="alternate" type="text/plain" href="/llms.txt"'));
    assert.ok(html.includes('name="robots" content="index, follow'));
    assert.ok(html.includes(`name="app-version" content="${version}"`));
    const graphs = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map(m => JSON.parse(m[1]));
    assert.ok(graphs.length);
    for (const graph of graphs) assert.equal(graph['@context'], 'https://schema.org');
    const nodes = graphs.flatMap(graph => graph['@graph']);
    const ofType = type => nodes.find(node => [node['@type']].flat().includes(type));
    if (name !== 'passport') {
      const how = ofType('HowTo');
      assert.equal(how.version, version);
      assert.deepEqual(how.step.map(s => s.position), [1, 2, 3]);
      assert.ok(how.step.every(s => s['@type'] === 'HowToStep' && s.name && s.text));
      assert.match(how.step[1].text, /npx rig-commander@latest/);
    }
    if (name !== 'index') {
      const article = ofType('TechArticle');
      assert.equal(article.version, version);
      assert.equal(article.url, origin + route);
      assert.ok(article.headline);
      continue;
    }
    const app = ofType('SoftwareApplication');
    assert.equal(app.name, 'RigCommander');
    assert.equal(app.softwareVersion, version);
    assert.equal(app.applicationCategory, 'DeveloperApplication');
    assert.equal(app.operatingSystem, 'macOS, Linux');
    assert.equal(app.license, 'https://opensource.org/licenses/MIT');
    assert.equal(app.isAccessibleForFree, true);
    assert.equal(Number(app.offers.price), 0);
    assert.equal(app.offers.priceCurrency, 'USD');
    assert.equal(app.url, origin + '/');
    assert.equal(app.codeRepository, 'https://github.com/Vedariy/rig-commander');
    assert.equal(app.downloadUrl, 'https://www.npmjs.com/package/rig-commander');
    assert.ok(app.description && app.image && app.featureList.length);
    assert.deepEqual(ofType('WebSite').inLanguage, ['en', 'ru']);
    assert.ok(html.includes('rel="alternate" type="text/plain" href="/llms-full.txt"'));
    const faq = ofType('FAQPage').mainEntity;
    const visible = html.split('id="faq">')[1].split('</section>')[0];
    assert.ok(faq.length >= 6 && faq.length <= 8);
    assert.equal((visible.match(/<summary>/g) || []).length, faq.length);
    assert.equal((visible.match(/<p lang="ru">/g) || []).length, faq.length);
    for (const question of faq) {
      assert.equal(question['@type'], 'Question');
      assert.equal(question.acceptedAnswer['@type'], 'Answer');
      assert.ok(visible.includes('>' + question.name + '</span>'));
      assert.ok(visible.includes('>' + question.acceptedAnswer.text + '</p>'));
    }
    assert.match(html, /<noscript>[\s\S]*?href="\/guide#quickstart"[\s\S]*?<\/noscript>/);
  }
});

test('every named Open-All crawler group retains the duplicate-deck exclusion', () => {
  const expected = '* OAI-SearchBot ChatGPT-User GPTBot ClaudeBot Claude-SearchBot Claude-User PerplexityBot Perplexity-User Google-Extended Applebot-Extended Amazonbot Meta-ExternalAgent DuckAssistBot'.split(' ');
  const robots = read('public/robots.txt');
  const groups = robots.split(/\n\s*\n/).filter(block => block.startsWith('User-agent:'));
  assert.equal(groups.length, expected.length);
  for (const agent of expected) {
    assert.ok(groups.some(block => block === `User-agent: ${agent}\nAllow: /\nDisallow: /deck`), agent);
  }
  assert.ok(robots.includes('Sitemap: ' + origin + '/sitemap.xml'));
});

test('sitemap contains exactly the six canonical URLs in valid sitemap markup', () => {
  const xml = read('public/sitemap.xml').trim();
  // The shipped sitemap uses a small fixed XML vocabulary and only absolute ASCII URLs.
  const document = /^<\?xml version="1.0" encoding="UTF-8"\?>\s*<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">([\s\S]*)<\/urlset>$/.exec(xml);
  assert.ok(document);
  const entry = /<url>\s*<loc>(https:\/\/[a-z0-9./-]+)<\/loc>\s*<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>\s*<priority>(0(?:\.\d+)?|1(?:\.0+)?)<\/priority>\s*<\/url>/g;
  const entries = [...document[1].matchAll(entry)];
  assert.equal(document[1].replace(entry, '').trim(), '');
  assert.deepEqual(entries.map(m => m[1]).sort(), routes.map(r => origin + r).sort());
  for (const [, , date] of entries) assert.equal(new Date(date).toISOString().slice(0, 10), date);
});

test('Vercel discovery headers preserve clean URLs and scope noindex to the deck alias', () => {
  const config = JSON.parse(read('vercel.json'));
  assert.equal(config.cleanUrls, true);
  const headers = source => Object.fromEntries((config.headers.find(rule => rule.source === source)?.headers || [])
    .map(({ key, value }) => [key.toLowerCase(), value]));
  for (const file of ['/llms.txt', '/llms-full.txt', '/robots.txt']) {
    assert.equal(headers(file)['content-type'], 'text/plain; charset=utf-8');
    assert.equal(headers(file)['cache-control'], 'public, max-age=3600, s-maxage=86400');
  }
  assert.equal(headers('/sitemap.xml')['content-type'], 'application/xml; charset=utf-8');
  for (const [route] of docs) assert.equal(headers(route).link, `<${origin}/llms.txt>; rel="alternate"; type="text/plain"`);
  for (const rule of config.headers.filter(rule => headers(rule.source)['x-robots-tag'])) {
    assert.ok(['/deck', '/deck/(.*)'].includes(rule.source));
  }
  for (const source of ['/deck', '/deck/(.*)']) assert.equal(headers(source)['x-robots-tag'], 'noindex, follow');
});
