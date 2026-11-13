// How two answers are recognised as the same company. Shared by "Plan angles"
// and "Read answers" (scripts/build.mjs copies it into both).
//   domainKey('https://www.Acme.io/about') -> 'acme.io'
//   nameKey('ACME, Inc.')                  -> 'acme'
// A profile on a shared site (LinkedIn, Crunchbase, ...) is not a company
// website, so it gives no domain key and the name decides.
const SHARED_HOSTS = ['linkedin.com', 'facebook.com', 'x.com', 'twitter.com', 'instagram.com', 'youtube.com', 'tiktok.com', 'crunchbase.com', 'wikipedia.org', 'google.com', 'medium.com', 'substack.com', 'github.com', 'linktr.ee', 'bit.ly', 'wordpress.com', 'blogspot.com', 'wixsite.com', 'notion.site', 'glassdoor.com', 'indeed.com', 'yelp.com', 'bloomberg.com', 'pitchbook.com'];
const SITE_PREFIXES = ['www', 'www2', 'careers', 'jobs', 'blog', 'news', 'newsroom', 'press', 'investors', 'ir', 'about', 'shop', 'store', 'app', 'en', 'm'];
const LEGAL_WORDS = ['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'plc', 'gmbh', 'ag', 'sa', 'sas', 'srl', 'bv', 'nv', 'ab', 'as', 'oy', 'pty', 'pte', 'lp', 'llp', 'group', 'holdings'];

function domainKey(website) {
  let host = String(website ?? '').trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/^.*@/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return '';
  let labels = host.split('.');
  while (labels.length > 2 && SITE_PREFIXES.includes(labels[0])) labels = labels.slice(1);
  host = labels.join('.');
  if (SHARED_HOSTS.some((shared) => host === shared || host.endsWith(`.${shared}`))) return '';
  return host;
}

function nameKey(name) {
  const words = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length > 1 && LEGAL_WORDS.includes(words[words.length - 1])) words.pop();
  if (words.length > 1 && words[0] === 'the') words.shift();
  return words.join(' ');
}
