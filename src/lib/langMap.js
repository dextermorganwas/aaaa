'use strict';
// TMDB uses ISO 639-1 (2-letter, e.g. "en"). TVDB v4 uses ISO 639-2/B (3-letter, e.g. "eng").
// This is a pragmatic mapping covering the languages that actually show up as "original_language"
// on TMDB frequently; anything missing falls back to passing the code through unchanged, which
// simply means that one original-language TVDB lookup step won't match - it does not break the
// rest of the provider chain.
const ISO1_TO_ISO2 = {
  en: 'eng', ja: 'jpn', ko: 'kor', zh: 'zho', cn: 'zho', fr: 'fra', de: 'deu', es: 'spa',
  it: 'ita', pt: 'por', ru: 'rus', hi: 'hin', ar: 'ara', sv: 'swe', no: 'nor', da: 'dan',
  fi: 'fin', nl: 'nld', pl: 'pol', tr: 'tur', th: 'tha', vi: 'vie', id: 'ind', el: 'ell',
  he: 'heb', cs: 'ces', hu: 'hun', ro: 'ron', uk: 'ukr', fa: 'fas', ta: 'tam', te: 'tel',
  ml: 'mal', bn: 'ben', pa: 'pan', ur: 'urd', is: 'isl', hr: 'hrv', sr: 'srp', sk: 'slk',
  bg: 'bul', et: 'est', lv: 'lav', lt: 'lit', sl: 'slv', ca: 'cat',
};
const ISO2_TO_ISO1 = Object.fromEntries(Object.entries(ISO1_TO_ISO2).map(([a, b]) => [b, a]));

function toTvdbLang(iso1) {
  if (!iso1) return null;
  return ISO1_TO_ISO2[iso1.toLowerCase()] || iso1.toLowerCase();
}

function toTmdbLang(iso2) {
  if (!iso2) return null;
  return ISO2_TO_ISO1[iso2.toLowerCase()] || iso2.toLowerCase();
}

module.exports = { toTvdbLang, toTmdbLang };
