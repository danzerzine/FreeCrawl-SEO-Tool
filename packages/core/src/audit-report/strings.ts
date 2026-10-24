/**
 * Interface words of the audit report in Russian and English. Sentences
 * that hold numbers are functions so each language can agree its nouns
 * with the number. Numbers arrive already formatted.
 */

import { oneOr, plural, type AuditLang } from './texts.js';

export interface Ui {
  htmlLang: string;
  docTitle: (host: string) => string;
  kind: string;
  crawledOn: (date: string) => string;
  pagesCount: (n: number, s: string) => string;
  preparedBy: (who: string) => string;
  leadLabel: string;
  headlineFast: string;
  headlineOneFix: string;
  headlineMain: (title: string) => string;
  headlineNone: string;
  letterCrawl: (n: number, ns: string, i: number, is: string) => string;
  letterMore: (n: number, ns: string, reason: string) => string;
  letterTop: (title: string, b: string, t: number, ts: string, why: string) => string;
  letterOneFix: string;
  letterFast: (ms: string) => string;
  letterSlow: (ms: string) => string;
  fineCap: (limit: string | null, sitemap: string | null) => string;
  scoreTitle: string;
  scoreOf: (v: string) => string;
  outOf100: string;
  scoreMean: (i: number, is: string) => string;
  scoreNone: string;
  sevAria: string;
  sevCritical: (n: number) => string;
  sevWarning: (n: number) => string;
  sevInfo: (n: number) => string;
  tilesAria: string;
  tilePages: string;
  tileIndexable: string;
  tileMedian: string;
  tileSitemap: string;
  ms: string;
  startTitle: string;
  startSub: (n: number) => string;
  oneFix: string;
  ofOpen: string;
  ofAll: string;
  fixesTitle: string;
  fixesSub: string;
  thIssue: string;
  thSeverity: string;
  thPages: string;
  thShare: string;
  grpStart: string;
  grpTemplate: (n: number) => string;
  grpPages: string;
  whatToDo: string;
  sevPill: Record<'critical' | 'warning', string>;
  smallOpen: string;
  smallAll: string;
  more: (issues: number, is: string, notes: number, ns: string) => string;
  idxTitle: string;
  idxSub: (n: string) => string;
  idxOpen: string;
  idxAria: string;
  reasonRow: Record<string, string>;
  reasonLetter: Record<string, readonly [string, string]>;
  reasonOther: string;
  depthTitle: string;
  depthSub: (deep: number, ds: string, pct: string, orphans: number, os: string) => string;
  depthAria: string;
  depthHome: string;
  depthOrphan: string;
  titlesTitle: string;
  descTitle: string;
  lenSub: string;
  lenOk: (min: number, max: number) => string;
  lenLong: (max: number) => string;
  lenShort: (min: number) => string;
  titleMissing: string;
  descMissing: string;
  sitemapTitle: string;
  sitemapNone: string;
  sitemapUrls: string;
  sitemapClosed: string;
  sitemapMissing: string;
  sectionsTitle: string;
  sectionsSub: string;
  thSection: string;
  thSecPages: string;
  thSecOpen: string;
  thSecMs: string;
  trafficTitle: string;
  trafficSub: (crawl: string, src: 'metrica' | 'gsc', period: string | null) => string;
  trafficCallout: (
    sec: string,
    pages: string,
    visits: string,
    zero: number,
    zs: string,
    src: 'metrica' | 'gsc',
  ) => string;
  trafficUncrawled: (share: string, sec: string | null, src: 'metrica' | 'gsc') => string;
  legendPages: string;
  legendVisits: (src: 'metrica' | 'gsc') => string;
  thPagesVisits: (src: 'metrica' | 'gsc') => string;
  thZero: (src: 'metrica' | 'gsc') => string;
  okTitle: string;
  okSub: string;
  okSpeed: (median: string, p90: string) => string;
  howTitle: string;
  howSub: string;
  factStart: string;
  factTime: string;
  factLimit: string;
  factRobots: string;
  robotsYes: string;
  robotsNo: string;
  factAgent: string;
  note1: string;
  note2: (mean: string, penalty: number) => string;
  note3: (limit: string | null) => string;
}

const RU_PAGES = ['страница', 'страницы', 'страниц'] as const;

const ru: Ui = {
  htmlLang: 'ru',
  docTitle: (h) => `Аудит ${h}`,
  kind: 'технический аудит',
  crawledOn: (d) => `Обход ${d}`,
  pagesCount: (n, s) => `${s} ${plural(n, RU_PAGES, 'ru')}`,
  preparedBy: (w) => `Подготовил: ${w}`,
  leadLabel: 'Вывод',
  headlineFast: 'Сайт быстрый. ',
  headlineOneFix: 'Главная правка — одна строка в шаблоне',
  headlineMain: (t) => `Главное — ${t}`,
  headlineNone: 'Серьёзных проблем не найдено',
  letterCrawl: (n, ns, i, is) =>
    `Из ${ns} ${oneOr(n, 'страницы', 'страниц')}, которые мы обошли, для поиска ${oneOr(i, 'открыта', 'открыты')} ${is}`,
  letterMore: (_n, ns, reason) => ` Ещё ${ns} ${reason}.`,
  letterTop: (title, b, t, ts, why) =>
    `Главная проблема: ${title} — ${b} из ${ts} ${oneOr(t, 'страницы', 'страниц')}. ${why}.`,
  letterOneFix: ' Это одна правка в шаблоне сайта.',
  letterFast: (ms) => `Сервер обычно отвечает за ${ms} мс: скорость чинить не нужно.`,
  letterSlow: (ms) =>
    `Сервер обычно отвечает за ${ms} мс: это медленно, скорость стоит разобрать отдельно.`,
  fineCap: (limit, sitemap) =>
    `Обход остановился на лимите${limit ? ` ${limit} страниц` : ' страниц'}` +
    (sitemap ? `, а в карте сайта ${sitemap} адресов` : '') +
    '. Цифры о страницах без ссылок и о покрытии карты сайта неполные',
  scoreTitle: 'Техническое здоровье',
  scoreOf: (v) => `${v} из 100`,
  outOf100: 'из 100',
  scoreMean: (i, is) =>
    `Среднее по ${is} ${oneOr(i, 'странице, открытой', 'страницам, открытым')} для поиска.`,
  scoreNone: 'Нет страниц, открытых для поиска: оценивать нечего.',
  sevAria: 'Число проблем по важности',
  sevCritical: (n) => oneOr(n, 'серьёзная', 'серьёзных'),
  sevWarning: (n) => oneOr(n, 'важная', 'важных'),
  sevInfo: (n) => plural(n, ['замечание', 'замечания', 'замечаний'], 'ru'),
  tilesAria: 'Ключевые цифры',
  tilePages: 'страниц обошли',
  tileIndexable: 'открыты для поиска',
  tileMedian: 'ответ сервера, медиана',
  tileSitemap: 'адресов в карте сайта',
  ms: 'мс',
  startTitle: 'Начать отсюда',
  startSub: (n) =>
    `${n === 1 ? 'Правка' : n === 2 ? 'Две правки' : 'Три правки'} с самым большим влиянием на поиск. Полный список ниже.`,
  oneFix: 'Одна правка, ',
  ofOpen: ' открытых страниц.',
  ofAll: ' страниц.',
  fixesTitle: 'Все проблемы по порядку',
  fixesSub:
    'Сначала правки из блока выше, потом остальные правки шаблона, потом проблемы отдельных страниц по числу затронутых страниц.',
  thIssue: 'Проблема и что сделать',
  thSeverity: 'Важность',
  thPages: 'Страниц',
  thShare: 'Доля',
  grpStart: 'Начать отсюда',
  grpTemplate: (n) => (n === 1 ? 'Ещё одна правка в шаблоне сайта' : 'Ещё правки в шаблоне сайта'),
  grpPages: 'По страницам',
  whatToDo: 'Что сделать:',
  sevPill: { critical: 'серьёзная', warning: 'важная' },
  smallOpen: 'открытых',
  smallAll: 'всего',
  more: (i, is, n, ns) => {
    const parts = [];
    if (i) parts.push(`${is} ${plural(i, ['проблема', 'проблемы', 'проблем'], 'ru')}`);
    if (n) parts.push(`${ns} ${plural(n, ['замечание', 'замечания', 'замечаний'], 'ru')}`);
    return `Ещё ${parts.join(' и ')}: полный список проверок — в выгрузке сводки проблем (issues-summary.csv).`;
  },
  idxTitle: 'Что видит поиск',
  idxSub: (n) => `Из ${n} обойдённых страниц`,
  idxOpen: 'открыты для поиска',
  idxAria: 'Доли страниц по доступности для поиска',
  reasonRow: {
    indexable: 'Открыты для поиска',
    canonical: 'Указывают на другую страницу как основную',
    canonicalised: 'Указывают на другую страницу как основную',
    'robots-blocked': 'Закрыты в robots.txt',
    robots: 'Закрыты в robots.txt',
    redirect: 'Перенаправление',
    noindex: 'Запрет индексации (noindex)',
    'client-error': 'Ошибка 4xx',
    'server-error': 'Ошибка 5xx',
    'no-response': 'Нет ответа',
  },
  reasonLetter: {
    canonical: [
      'указывает на другую страницу как основную',
      'указывают на другую страницу как основную',
    ],
    canonicalised: [
      'указывает на другую страницу как основную',
      'указывают на другую страницу как основную',
    ],
    'robots-blocked': ['закрыта в robots.txt', 'закрыты в robots.txt'],
    robots: ['закрыта в robots.txt', 'закрыты в robots.txt'],
    redirect: ['перенаправляет на другой адрес', 'перенаправляют на другие адреса'],
    noindex: ['закрыта тегом noindex', 'закрыты тегом noindex'],
    'client-error': ['отвечает ошибкой 4xx', 'отвечают ошибкой 4xx'],
    'server-error': ['отвечает ошибкой 5xx', 'отвечают ошибкой 5xx'],
    'no-response': ['не ответила', 'не ответили'],
  },
  reasonOther: 'Другое',
  depthTitle: 'Сколько кликов от главной',
  depthSub: (deep, ds, pct, orphans, os) =>
    `${ds} ${plural(deep, RU_PAGES, 'ru')} (${pct}) глубже трёх кликов; ${os} ${oneOr(orphans, 'не достижима', 'не достижимы')} по ссылкам с главной.`,
  depthAria: 'Распределение страниц по числу кликов от главной',
  depthHome: 'главная',
  depthOrphan: 'без ссылок',
  titlesTitle: 'Длина заголовков',
  descTitle: 'Длина описаний',
  lenSub: 'Страницы, открытые для поиска',
  lenOk: (a, b) => `${a}–${b} знаков`,
  lenLong: (b) => `длиннее ${b}`,
  lenShort: (a) => `короче ${a}`,
  titleMissing: 'нет заголовка',
  descMissing: 'нет описания',
  sitemapTitle: 'Карта сайта',
  sitemapNone: 'В этом обходе карту сайта не читали.',
  sitemapUrls: 'Адресов в карте сайта',
  sitemapClosed: 'Из них закрыты от поиска',
  sitemapMissing: 'Открыты для поиска, но нет в карте',
  sectionsTitle: 'Разделы сайта',
  sectionsSub: 'По первой части адреса',
  thSection: 'Раздел',
  thSecPages: 'Страниц',
  thSecOpen: 'Открыты',
  thSecMs: 'Ответ, мс',
  trafficTitle: 'Где страницы и где поисковый трафик',
  trafficSub: (crawl, src, period) =>
    `Обход ${crawl}; ${src === 'metrica' ? 'визиты из поиска по Метрике' : 'клики из поиска по Search Console'}` +
    (period ? ` за ${period}` : '') +
    '. Доля страниц считается среди открытых для поиска.',
  trafficCallout: (sec, pages, visits, zero, zs, src) =>
    `Раздел ${sec} даёт ${pages} открытых страниц и ${visits} ${src === 'metrica' ? 'поисковых визитов' : 'кликов из поиска'}` +
    (zero
      ? `; ${zs} ${plural(zero, RU_PAGES, 'ru')} ${oneOr(zero, 'этого раздела не получила', 'этого раздела не получили')} из поиска ни ${src === 'metrica' ? 'одного визита' : 'одного клика'}.`
      : '.'),
  trafficUncrawled: (share, sec, src) =>
    ` Ещё ${share} ${src === 'metrica' ? 'визитов' : 'кликов'} приходят на адреса, которых нет в обходе` +
    (sec ? ` (больше всего — ${sec})` : '') +
    '.',
  legendPages: 'доля страниц',
  legendVisits: (src) => (src === 'metrica' ? 'доля визитов из поиска' : 'доля кликов из поиска'),
  thPagesVisits: (src) => (src === 'metrica' ? 'Страницы и визиты' : 'Страницы и клики'),
  thZero: (src) => (src === 'metrica' ? 'Страниц без визитов' : 'Страниц без кликов'),
  okTitle: 'Проверено, в порядке',
  okSub: 'Здесь проблем не нашлось.',
  okSpeed: (m, p) => ` Половина страниц отвечает быстрее ${m} мс, 90% быстрее ${p} мс.`,
  howTitle: 'Как обходили и как посчитано',
  howSub: 'Чтобы повторить обход и сравнить',
  factStart: 'Стартовый адрес',
  factTime: 'Время',
  factLimit: 'Лимит страниц',
  factRobots: 'robots.txt',
  robotsYes: 'соблюдался',
  robotsNo: 'не соблюдался',
  factAgent: 'Робот',
  note1:
    'Открыта для поиска: страница отвечает 200, не закрыта в robots.txt и meta robots и не указывает на другую страницу как основную.',
  note2: (mean, penalty) =>
    `Оценка: для каждой открытой страницы 100 баллов, минус 50 за каждую серьёзную проблему и минус 10 за важную, затем среднее по страницам (${mean}). ` +
    `Проблема шаблона, которая есть почти на всех страницах, вычитается один раз на весь сайт: серьёзная −15, важная −5 (${penalty ? `здесь −${penalty}` : 'здесь таких нет'}).`,
  note3: (limit) =>
    `Обход ограничен${limit ? ` ${limit} страниц` : ' лимитом страниц'}. Страница «без ссылок» значит, что ссылки на неё не нашлись среди обойдённых страниц.`,
};

const en: Ui = {
  htmlLang: 'en',
  docTitle: (h) => `Audit of ${h}`,
  kind: 'technical audit',
  crawledOn: (d) => `Crawled ${d}`,
  pagesCount: (n, s) => `${s} ${n === 1 ? 'page' : 'pages'}`,
  preparedBy: (w) => `Prepared by ${w}`,
  leadLabel: 'Summary',
  headlineFast: 'The site is fast. ',
  headlineOneFix: 'The main fix is one line in the template',
  headlineMain: (t) => `The main thing: ${t}`,
  headlineNone: 'No serious problems found',
  letterCrawl: (n, ns, i, is) =>
    `Of the ${ns} ${n === 1 ? 'page' : 'pages'} we crawled, ${is} ${i === 1 ? 'is' : 'are'} open to search`,
  letterMore: (n, ns, reason) => ` Another ${ns} ${reason}.`,
  letterTop: (title, b, t, ts, why) =>
    `The main problem: ${title}, on ${b} of ${ts} ${t === 1 ? 'page' : 'pages'}. ${why}.`,
  letterOneFix: ' It is one fix in the site template.',
  letterFast: (ms) => `The server usually answers in ${ms} ms: speed needs no work.`,
  letterSlow: (ms) =>
    `The server usually answers in ${ms} ms: that is slow, and speed deserves its own look.`,
  fineCap: (limit, sitemap) =>
    `The crawl stopped at its limit of${limit ? ` ${limit}` : ''} pages` +
    (sitemap ? `, while the sitemap lists ${sitemap} URLs` : '') +
    '. The numbers on unlinked pages and sitemap coverage are incomplete',
  scoreTitle: 'Technical health',
  scoreOf: (v) => `${v} out of 100`,
  outOf100: 'out of 100',
  scoreMean: (i, is) => `Mean over ${is} ${i === 1 ? 'page' : 'pages'} open to search.`,
  scoreNone: 'No page is open to search, so there is nothing to score.',
  sevAria: 'Problems by severity',
  sevCritical: () => 'critical',
  sevWarning: () => 'important',
  sevInfo: (n) => (n === 1 ? 'note' : 'notes'),
  tilesAria: 'Key numbers',
  tilePages: 'pages crawled',
  tileIndexable: 'open to search',
  tileMedian: 'server response, median',
  tileSitemap: 'URLs in the sitemap',
  ms: 'ms',
  startTitle: 'Start here',
  startSub: (n) =>
    `The ${n === 1 ? 'fix' : n === 2 ? 'two fixes' : 'three fixes'} with the most impact on search. The full list is below.`,
  oneFix: 'One fix, ',
  ofOpen: ' of pages open to search.',
  ofAll: ' of pages.',
  fixesTitle: 'All problems in order',
  fixesSub:
    'First the fixes from the block above, then the other template fixes, then problems of single pages by the number of pages they touch.',
  thIssue: 'Problem and what to do',
  thSeverity: 'Severity',
  thPages: 'Pages',
  thShare: 'Share',
  grpStart: 'Start here',
  grpTemplate: (n) =>
    n === 1 ? 'One more fix in the site template' : 'More fixes in the site template',
  grpPages: 'Page by page',
  whatToDo: 'What to do:',
  sevPill: { critical: 'critical', warning: 'important' },
  smallOpen: 'open',
  smallAll: 'total',
  more: (i, is, n, ns) => {
    const parts = [];
    if (i) parts.push(`${is} more ${i === 1 ? 'problem' : 'problems'}`);
    if (n) parts.push(`${ns} ${n === 1 ? 'note' : 'notes'}`);
    return `${parts.join(' and ')}: the full list of checks is in the issue summary export (issues-summary.csv).`.replace(
      /^./,
      (c) => c.toUpperCase(),
    );
  },
  idxTitle: 'What search sees',
  idxSub: (n) => `Of ${n} pages crawled`,
  idxOpen: 'open to search',
  idxAria: 'Pages by whether search can index them',
  reasonRow: {
    indexable: 'Open to search',
    canonical: 'Point to another page as the main one',
    canonicalised: 'Point to another page as the main one',
    'robots-blocked': 'Blocked in robots.txt',
    robots: 'Blocked in robots.txt',
    redirect: 'Redirect',
    noindex: 'Closed with noindex',
    'client-error': '4xx error',
    'server-error': '5xx error',
    'no-response': 'No answer',
  },
  reasonLetter: {
    canonical: ['points to another page as the main one', 'point to another page as the main one'],
    canonicalised: [
      'points to another page as the main one',
      'point to another page as the main one',
    ],
    'robots-blocked': ['is blocked in robots.txt', 'are blocked in robots.txt'],
    robots: ['is blocked in robots.txt', 'are blocked in robots.txt'],
    redirect: ['redirects elsewhere', 'redirect elsewhere'],
    noindex: ['is closed with noindex', 'are closed with noindex'],
    'client-error': ['answers with a 4xx error', 'answer with a 4xx error'],
    'server-error': ['answers with a 5xx error', 'answer with a 5xx error'],
    'no-response': ['did not answer', 'did not answer'],
  },
  reasonOther: 'Other',
  depthTitle: 'Clicks from the home page',
  depthSub: (deep, ds, pct, orphans, os) =>
    `${ds} ${deep === 1 ? 'page' : 'pages'} (${pct}) ${deep === 1 ? 'is' : 'are'} deeper than three clicks; ${os} cannot be reached by links from the home page.`,
  depthAria: 'Pages by clicks from the home page',
  depthHome: 'home',
  depthOrphan: 'unlinked',
  titlesTitle: 'Title length',
  descTitle: 'Description length',
  lenSub: 'Pages open to search',
  lenOk: (a, b) => `${a}–${b} characters`,
  lenLong: (b) => `over ${b}`,
  lenShort: (a) => `under ${a}`,
  titleMissing: 'no title',
  descMissing: 'no description',
  sitemapTitle: 'Sitemap',
  sitemapNone: 'This crawl did not read a sitemap.',
  sitemapUrls: 'URLs in the sitemap',
  sitemapClosed: 'Of them closed to search',
  sitemapMissing: 'Open to search but not in the sitemap',
  sectionsTitle: 'Site sections',
  sectionsSub: 'By the first part of the path',
  thSection: 'Section',
  thSecPages: 'Pages',
  thSecOpen: 'Open',
  thSecMs: 'Response, ms',
  trafficTitle: 'Where the pages are and where search traffic goes',
  trafficSub: (crawl, src, period) =>
    `Crawled ${crawl}; ${src === 'metrica' ? 'search visits from Yandex Metrica' : 'search clicks from Search Console'}` +
    (period ? ` for ${period}` : '') +
    '. Page share is counted among pages open to search.',
  trafficCallout: (sec, pages, visits, zero, zs, src) =>
    `The ${sec} section holds ${pages} of the pages open to search and gets ${visits} of ${src === 'metrica' ? 'search visits' : 'search clicks'}` +
    (zero
      ? `; ${zs} of its ${zero === 1 ? 'page' : 'pages'} got no ${src === 'metrica' ? 'search visit' : 'search click'} in the period.`
      : '.'),
  trafficUncrawled: (share, sec, src) =>
    ` Another ${share} of ${src === 'metrica' ? 'visits' : 'clicks'} land on URLs the crawl does not have` +
    (sec ? ` (most of them under ${sec})` : '') +
    '.',
  legendPages: 'share of pages',
  legendVisits: (src) => (src === 'metrica' ? 'share of search visits' : 'share of search clicks'),
  thPagesVisits: (src) => (src === 'metrica' ? 'Pages and visits' : 'Pages and clicks'),
  thZero: (src) => (src === 'metrica' ? 'Pages without visits' : 'Pages without clicks'),
  okTitle: 'Checked and fine',
  okSub: 'No problems found here.',
  okSpeed: (m, p) => ` Half the pages answer faster than ${m} ms, 90% faster than ${p} ms.`,
  howTitle: 'How we crawled and counted',
  howSub: 'To repeat the crawl and compare',
  factStart: 'Start URL',
  factTime: 'Time',
  factLimit: 'Page limit',
  factRobots: 'robots.txt',
  robotsYes: 'respected',
  robotsNo: 'ignored',
  factAgent: 'User agent',
  note1:
    'Open to search: the page answers 200, is not blocked in robots.txt or meta robots and does not point to another page as the main one.',
  note2: (mean, penalty) =>
    `Score: each page open to search starts at 100 points, minus 50 per critical problem and minus 10 per important one; then the mean over pages (${mean}). ` +
    `A template problem found on almost every page is charged once for the whole site: critical −15, important −5 (${penalty ? `here −${penalty}` : 'none here'}).`,
  note3: (limit) =>
    `The crawl was limited to${limit ? ` ${limit}` : ' a number of'} pages. An “unlinked” page means no link to it was found among the crawled pages.`,
};

export const UI: Record<AuditLang, Ui> = { ru, en };
