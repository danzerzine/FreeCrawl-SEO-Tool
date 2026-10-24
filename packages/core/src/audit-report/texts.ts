/**
 * Words of the audit report (`--what audit`) in Russian and English: the
 * checks' plain-language title, why it matters and what to do, the group
 * names of the «checked, fine» chips, and number / plural helpers. A check
 * without a written text falls back to its catalog label and a line that
 * depends only on its severity.
 */

import { fillThresholdLabel, type SeoThresholds, type UrlCategory } from '@freecrawl/shared-types';

export type AuditLang = 'ru' | 'en';
export type AuditSeverity = 'critical' | 'warning' | 'info';

/** A check in words. `why` starts lower-case (it is also used mid-sentence); `short` is the start-band imperative. */
export interface CheckText {
  title: string;
  why: string;
  fix: string;
  short: string;
}

type Pair = Record<AuditLang, Omit<CheckText, 'short'> & { short?: string }>;

const CHECKS: Partial<Record<UrlCategory, Pair>> = {
  'issues:x-content-type-options-missing': {
    ru: {
      title: 'Нет заголовка X-Content-Type-Options',
      why: 'браузер может неверно угадать тип файла',
      fix: 'Добавить в ответ сервера X-Content-Type-Options: nosniff.',
      short: 'Добавить заголовок nosniff',
    },
    en: {
      title: 'No X-Content-Type-Options header',
      why: 'the browser may guess a file’s type wrong',
      fix: 'Send X-Content-Type-Options: nosniff in the server response.',
      short: 'Add the nosniff header',
    },
  },
  'issues:meta-missing': {
    ru: {
      title: 'Нет описания страницы (meta description)',
      why: 'поисковик сам сочинит сниппет, обычно хуже',
      fix: 'Выводить описание в шаблоне страницы: {{descriptionMinChars}}–{{descriptionMaxChars}} знаков из анонса.',
      short: 'Выводить описание страницы',
    },
    en: {
      title: 'No meta description',
      why: 'the search engine writes its own snippet, usually a worse one',
      fix: 'Output a description in the page template: {{descriptionMinChars}}–{{descriptionMaxChars}} characters from the summary.',
      short: 'Output a page description',
    },
  },
  'issues:form-input-unlabeled': {
    ru: {
      title: 'Поле формы без подписи',
      why: 'незрячие пользователи не поймут, что вводить',
      fix: 'Добавить label или aria-label к полям форм в шаблоне.',
      short: 'Подписать поля форм',
    },
    en: {
      title: 'Form field without a label',
      why: 'screen-reader users cannot tell what to enter',
      fix: 'Give each form field in the template a label or aria-label.',
      short: 'Label the form fields',
    },
  },
  'issues:canonical-missing': {
    ru: {
      title: 'Нет канонического адреса (canonical)',
      why: 'поисковик сам решает, какую из копий страницы показывать',
      fix: 'Добавить <link rel="canonical"> на себя в шаблон страниц.',
      short: 'Добавить canonical в шаблон',
    },
    en: {
      title: 'No canonical URL',
      why: 'the search engine decides on its own which copy of a page to show',
      fix: 'Add a self-referencing <link rel="canonical"> to the page template.',
      short: 'Add canonical to the template',
    },
  },
  'issues:non-indexable-in-sitemap': {
    ru: {
      title: 'В карте сайта страницы, закрытые от поиска',
      why: 'робот тратит обход впустую, сигналы противоречат друг другу',
      fix: 'Убрать из sitemap.xml адреса, закрытые от поиска: с canonical на другую страницу, noindex, перенаправления.',
      short: 'Почистить карту сайта',
    },
    en: {
      title: 'Sitemap lists pages closed to search',
      why: 'the crawler wastes its visits and the signals contradict each other',
      fix: 'Remove from sitemap.xml the URLs closed to search: canonicalised to another page, noindex, redirects.',
      short: 'Clean up the sitemap',
    },
  },
  'issues:orphan-page': {
    ru: {
      title: 'Страницы, на которые никто не ссылается',
      why: 'их находят только через карту сайта, веса они почти не получают',
      fix: 'Связать ссылками из разделов или убрать, если не нужны.',
      short: 'Связать страницы ссылками',
    },
    en: {
      title: 'Pages nothing links to',
      why: 'they are found only through the sitemap and get almost no link weight',
      fix: 'Link to them from their sections, or remove them if they are not needed.',
      short: 'Link the pages',
    },
  },
  'issues:title-too-long': {
    ru: {
      title: 'Заголовок длиннее {{titleMaxChars}} знаков',
      why: 'в выдаче обрежется',
      fix: 'Сократить, главное слово ставить в начало.',
      short: 'Сократить заголовки',
    },
    en: {
      title: 'Title longer than {{titleMaxChars}} characters',
      why: 'it gets cut off in search results',
      fix: 'Shorten it and put the key word first.',
      short: 'Shorten the titles',
    },
  },
  'issues:content-thin': {
    ru: {
      title: 'Мало текста (меньше {{thinContentWords}} слов)',
      why: 'поисковику не за что зацепиться',
      fix: 'Дописать или объединить с соседними страницами.',
      short: 'Дописать тонкие страницы',
    },
    en: {
      title: 'Thin content (under {{thinContentWords}} words)',
      why: 'there is little for search to go on',
      fix: 'Expand the text or merge the page with its neighbours.',
      short: 'Expand thin pages',
    },
  },
  'issues:title-pixel-width-too-long': {
    ru: {
      title: 'Заголовок не влезает в ширину выдачи',
      why: 'в выдаче обрежется',
      fix: 'Сократить до {{titleMaxPx}} пикселей (примерно 55 знаков).',
      short: 'Сократить заголовки',
    },
    en: {
      title: 'Title wider than search results show',
      why: 'it gets cut off in search results',
      fix: 'Shorten it to {{titleMaxPx}} pixels (about 55 characters).',
      short: 'Shorten the titles',
    },
  },
  'issues:lang-content-mismatch': {
    ru: {
      title: 'Язык в разметке не совпадает с текстом',
      why: 'поиск может показать страницу не той аудитории',
      fix: 'Поправить атрибут lang на страницах, где текст на другом языке.',
      short: 'Поправить атрибут lang',
    },
    en: {
      title: 'Markup language does not match the text',
      why: 'search may show the page to the wrong audience',
      fix: 'Fix the lang attribute on pages whose text is in another language.',
      short: 'Fix the lang attribute',
    },
  },
  'issues:title-duplicate': {
    ru: {
      title: 'Одинаковые заголовки у разных страниц',
      why: 'страницы конкурируют между собой',
      fix: 'Сделать заголовки уникальными.',
    },
    en: {
      title: 'Duplicate titles',
      why: 'the pages compete with each other',
      fix: 'Make each title unique.',
    },
  },
  'issues:h1-multiple': {
    ru: {
      title: 'Несколько заголовков H1',
      why: 'неясно, о чём страница',
      fix: 'Оставить один H1.',
    },
    en: {
      title: 'Several H1 headings',
      why: 'it is unclear what the page is about',
      fix: 'Keep one H1.',
    },
  },
  'issues:h1-duplicate': {
    ru: {
      title: 'Одинаковые H1 у разных страниц',
      why: 'страницы похожи друг на друга',
      fix: 'Сделать H1 уникальными.',
    },
    en: {
      title: 'Duplicate H1 headings',
      why: 'the pages look alike',
      fix: 'Make each H1 unique.',
    },
  },
  'issues:title-too-short': {
    ru: {
      title: 'Заголовок короче {{titleMinChars}} знаков',
      why: 'мало слов для поиска',
      fix: 'Дописать тему страницы.',
    },
    en: {
      title: 'Title shorter than {{titleMinChars}} characters',
      why: 'too few words for search',
      fix: 'Add the page topic.',
    },
  },
  'issues:h1-missing': {
    ru: { title: 'Нет заголовка H1', why: 'неясно, о чём страница', fix: 'Добавить H1 в шаблон.' },
    en: {
      title: 'No H1 heading',
      why: 'it is unclear what the page is about',
      fix: 'Add an H1 to the template.',
    },
  },
  'issues:duplicate-content-exact': {
    ru: {
      title: 'Полные дубли страниц',
      why: 'поисковик выберет одну, вторая выпадет',
      fix: 'Оставить одну, со второй поставить перенаправление.',
      short: 'Убрать дубли',
    },
    en: {
      title: 'Exact duplicate pages',
      why: 'search keeps one and drops the other',
      fix: 'Keep one and redirect the other to it.',
      short: 'Remove the duplicates',
    },
  },
  'issues:title-missing': {
    ru: {
      title: 'Нет заголовка страницы',
      why: 'в выдаче будет случайный текст',
      fix: 'Добавить <title>.',
      short: 'Добавить заголовки',
    },
    en: {
      title: 'No page title',
      why: 'search results show arbitrary text instead',
      fix: 'Add a <title>.',
      short: 'Add the titles',
    },
  },
  'issues:page-empty': {
    ru: {
      title: 'Пустая страница (меньше 30 слов)',
      why: 'страница без текста открыта для поиска',
      fix: 'Наполнить, закрыть от индексации или убрать ссылки на неё.',
      short: 'Разобраться с пустыми страницами',
    },
    en: {
      title: 'Empty page (under 30 words)',
      why: 'a page with no text is open to search',
      fix: 'Fill it, close it to indexing, or remove the links to it.',
      short: 'Deal with empty pages',
    },
  },
  'issues:inlinks-non-indexable-only': {
    ru: {
      title: 'Ссылаются только закрытые от поиска страницы',
      why: 'страница почти не получает веса',
      fix: 'Поставить ссылки с открытых страниц.',
    },
    en: {
      title: 'Linked only from pages closed to search',
      why: 'the page gets almost no link weight',
      fix: 'Add links from pages open to search.',
    },
  },
  'issues:inlinks-nofollow-only': {
    ru: {
      title: 'Ссылаются только ссылками nofollow',
      why: 'страница почти не получает веса',
      fix: 'Поставить обычные ссылки с открытых страниц.',
    },
    en: {
      title: 'Linked only with nofollow links',
      why: 'the page gets almost no link weight',
      fix: 'Add plain links from pages open to search.',
    },
  },
  'issues:viewport-missing': {
    ru: {
      title: 'Нет настройки для телефонов (viewport)',
      why: 'на телефоне страница будет мелкой',
      fix: 'Добавить meta viewport.',
    },
    en: {
      title: 'No viewport meta tag',
      why: 'the page renders tiny on phones',
      fix: 'Add a meta viewport tag.',
    },
  },
  'issues:blocked-by-robots': {
    ru: {
      title: 'Ссылки на адреса, закрытые в robots.txt',
      why: 'робот видит ссылку, но не может прочитать страницу',
      fix: 'Проверить, нужен ли запрет в robots.txt, или убрать ссылки на эти адреса.',
    },
    en: {
      title: 'Links to URLs blocked by robots.txt',
      why: 'crawlers see the link but cannot read the page',
      fix: 'Check that the robots.txt rule is wanted, or remove the links to these URLs.',
    },
  },
  'issues:non-200-in-sitemap': {
    ru: {
      title: 'В карте сайта адреса, которые не отвечают 200',
      why: 'робот тратит обход на неработающие адреса',
      fix: 'Убрать их из sitemap.xml или указать рабочие адреса.',
    },
    en: {
      title: 'Sitemap lists URLs that do not answer 200',
      why: 'the crawler spends visits on broken URLs',
      fix: 'Remove them from sitemap.xml or list the working URLs.',
    },
  },
  'issues:redirect-in-sitemap': {
    ru: {
      title: 'В карте сайта адреса с перенаправлением',
      why: 'на каждом адресе робот делает лишний шаг',
      fix: 'Заменить их в sitemap.xml на конечные адреса.',
    },
    en: {
      title: 'Sitemap lists redirecting URLs',
      why: 'the crawler takes an extra hop for each',
      fix: 'Replace them in sitemap.xml with the final URLs.',
    },
  },
  'issues:meta-too-long': {
    ru: {
      title: 'Описание длиннее {{descriptionMaxChars}} знаков',
      why: 'в выдаче обрежется',
      fix: 'Сократить до {{descriptionMaxChars}} знаков, главное — в начале.',
    },
    en: {
      title: 'Description longer than {{descriptionMaxChars}} characters',
      why: 'it gets cut off in search results',
      fix: 'Shorten it to {{descriptionMaxChars}} characters, the point first.',
    },
  },
  'issues:meta-too-short': {
    ru: {
      title: 'Описание короче {{descriptionMinChars}} знаков',
      why: 'поисковик скорее заменит его своим текстом',
      fix: 'Дописать, о чём страница и зачем её открыть.',
    },
    en: {
      title: 'Description shorter than {{descriptionMinChars}} characters',
      why: 'search will likely replace it with its own text',
      fix: 'Say what the page is about and why to open it.',
    },
  },
  'issues:meta-duplicate': {
    ru: {
      title: 'Одинаковые описания у разных страниц',
      why: 'сниппеты в выдаче не отличаются друг от друга',
      fix: 'Сделать описания уникальными.',
    },
    en: {
      title: 'Duplicate descriptions',
      why: 'the snippets look the same in search results',
      fix: 'Make each description unique.',
    },
  },
  'issues:response-slow': {
    ru: {
      title: 'Сервер отвечает дольше секунды',
      why: 'робот обходит меньше страниц, люди уходят раньше',
      fix: 'Найти медленные шаблоны и ускорить ответ: кэш, запросы к базе.',
      short: 'Ускорить ответ сервера',
    },
    en: {
      title: 'Server answers slower than one second',
      why: 'crawlers fetch fewer pages and people leave sooner',
      fix: 'Find the slow templates and speed them up: caching, database queries.',
      short: 'Speed up the server',
    },
  },
  'issues:response-very-slow': {
    ru: {
      title: 'Сервер отвечает дольше трёх секунд',
      why: 'робот обходит меньше страниц, люди уходят, не дождавшись',
      fix: 'Найти медленные шаблоны и ускорить ответ: кэш, запросы к базе.',
      short: 'Ускорить ответ сервера',
    },
    en: {
      title: 'Server answers slower than three seconds',
      why: 'crawlers fetch fewer pages and people leave before it loads',
      fix: 'Find the slow templates and speed them up: caching, database queries.',
      short: 'Speed up the server',
    },
  },
  'issues:broken-links-internal': {
    ru: {
      title: 'Ссылки на неработающие страницы сайта',
      why: 'люди и робот попадают на ошибку',
      fix: 'Исправить или убрать ссылки на страницы с ошибкой.',
      short: 'Починить битые ссылки',
    },
    en: {
      title: 'Links to broken pages of the site',
      why: 'people and crawlers land on an error',
      fix: 'Fix or remove the links to error pages.',
      short: 'Fix the broken links',
    },
  },
  'issues:broken-links-all': {
    ru: {
      title: 'Ссылки на неработающие адреса',
      why: 'люди и робот попадают на ошибку',
      fix: 'Исправить или убрать ссылки на адреса с ошибкой.',
      short: 'Починить битые ссылки',
    },
    en: {
      title: 'Links to broken URLs',
      why: 'people and crawlers land on an error',
      fix: 'Fix or remove the links to error URLs.',
      short: 'Fix the broken links',
    },
  },
  'issues:redirect-chain-long': {
    ru: {
      title: 'Длинные цепочки перенаправлений',
      why: 'робот может не дойти до конца, вес ссылок теряется',
      fix: 'Ставить ссылки и перенаправления сразу на конечный адрес.',
    },
    en: {
      title: 'Long redirect chains',
      why: 'crawlers may give up before the end and link weight leaks',
      fix: 'Point links and redirects straight at the final URL.',
    },
  },
  'issues:redirect-loop': {
    ru: {
      title: 'Перенаправление по кругу',
      why: 'страница не открывается ни у людей, ни у робота',
      fix: 'Разорвать цикл: перенаправлять сразу на рабочий адрес.',
      short: 'Разорвать круговые перенаправления',
    },
    en: {
      title: 'Redirect loop',
      why: 'the page opens for neither people nor crawlers',
      fix: 'Break the loop: redirect straight to a working URL.',
      short: 'Break the redirect loops',
    },
  },
  'issues:canonical-to-non-200': {
    ru: {
      title: 'Canonical указывает на адрес с ошибкой',
      why: 'поисковик не примет такой canonical',
      fix: 'Указать в canonical рабочую страницу.',
    },
    en: {
      title: 'Canonical points to a URL that does not answer 200',
      why: 'search ignores such a canonical',
      fix: 'Point the canonical at a working page.',
    },
  },
  'issues:canonical-to-redirect': {
    ru: {
      title: 'Canonical указывает на перенаправление',
      why: 'поисковику приходится угадывать основную страницу',
      fix: 'Указать в canonical конечный адрес.',
    },
    en: {
      title: 'Canonical points to a redirect',
      why: 'search has to guess the main page',
      fix: 'Point the canonical at the final URL.',
    },
  },
  'issues:multiple-canonicals': {
    ru: {
      title: 'Несколько canonical на странице',
      why: 'поисковик отбросит их все',
      fix: 'Оставить один canonical.',
    },
    en: {
      title: 'Several canonicals on a page',
      why: 'search discards all of them',
      fix: 'Keep one canonical.',
    },
  },
  'issues:hsts-missing': {
    ru: {
      title: 'Нет заголовка HSTS',
      why: 'браузер может открыть сайт по незащищённому протоколу',
      fix: 'Добавить в ответ сервера Strict-Transport-Security.',
    },
    en: {
      title: 'No HSTS header',
      why: 'the browser may open the site over plain HTTP',
      fix: 'Send Strict-Transport-Security in the server response.',
    },
  },
  'issues:x-frame-options-missing': {
    ru: {
      title: 'Нет заголовка X-Frame-Options',
      why: 'страницу можно встроить в чужой сайт',
      fix: 'Добавить X-Frame-Options или frame-ancestors в Content-Security-Policy.',
    },
    en: {
      title: 'No X-Frame-Options header',
      why: 'another site can embed the page',
      fix: 'Send X-Frame-Options, or frame-ancestors in Content-Security-Policy.',
    },
  },
  'issues:mixed-content': {
    ru: {
      title: 'HTTP-ресурсы на HTTPS-странице',
      why: 'браузер блокирует часть ресурсов и называет страницу небезопасной',
      fix: 'Загружать все ресурсы по HTTPS.',
    },
    en: {
      title: 'HTTP resources on an HTTPS page',
      why: 'the browser blocks some of them and calls the page insecure',
      fix: 'Load every resource over HTTPS.',
    },
  },
  'issues:http-not-https': {
    ru: {
      title: 'Страницы по HTTP',
      why: 'браузер помечает их как небезопасные',
      fix: 'Перевести на HTTPS и перенаправлять со старых адресов.',
      short: 'Перевести страницы на HTTPS',
    },
    en: {
      title: 'Pages served over HTTP',
      why: 'browsers mark them as not secure',
      fix: 'Move them to HTTPS and redirect the old URLs.',
      short: 'Move pages to HTTPS',
    },
  },
  'issues:page-large': {
    ru: {
      title: 'Тяжёлая страница (больше 1 МБ)',
      why: 'дольше грузится, особенно на телефоне',
      fix: 'Уменьшить HTML: убрать встроенные данные и лишнюю разметку.',
    },
    en: {
      title: 'Heavy page (over 1 MB)',
      why: 'it loads slower, on phones most of all',
      fix: 'Slim the HTML: drop inlined data and extra markup.',
    },
  },
  'issues:structured-data-invalid': {
    ru: {
      title: 'Ошибки в микроразметке JSON-LD',
      why: 'поиск не покажет расширенный сниппет',
      fix: 'Исправить разметку по отчёту валидатора.',
    },
    en: {
      title: 'Invalid JSON-LD markup',
      why: 'search will not show a rich result',
      fix: 'Fix the markup the validator reports.',
    },
  },
  'issues:title-placeholder': {
    ru: {
      title: 'Заголовок-заглушка',
      why: 'в выдаче будет служебный текст',
      fix: 'Вписать настоящий заголовок.',
    },
    en: {
      title: 'Placeholder title',
      why: 'search results show filler text',
      fix: 'Write a real title.',
    },
  },
};

/** Severity-generic lines for a check with no written text. */
const FALLBACK: Record<AuditLang, Record<AuditSeverity, { why: string; fix: string }>> = {
  ru: {
    critical: {
      why: 'мешает поиску найти или показать эти страницы',
      fix: 'Разобрать по списку страниц этой проверки.',
    },
    warning: {
      why: 'ухудшает то, как страницы выглядят и ранжируются в поиске',
      fix: 'Разобрать по списку страниц этой проверки.',
    },
    info: { why: 'на заметку, срочности нет', fix: 'Посмотреть, когда дойдут руки.' },
  },
  en: {
    critical: {
      why: 'it keeps search from finding or showing these pages',
      fix: 'Work through the pages this check lists.',
    },
    warning: {
      why: 'it hurts how the pages look and rank in search',
      fix: 'Work through the pages this check lists.',
    },
    info: { why: 'worth knowing, not urgent', fix: 'Look at it when there is time.' },
  },
};

/** Whether the report has its own words for a check. */
export function hasCheckText(key: string): boolean {
  return key in CHECKS;
}

/** A check in words, thresholds filled in; falls back to its group and catalog label. */
export function checkText(
  issue: { key: string; label: string; group: string; severity: AuditSeverity },
  lang: AuditLang,
  thresholds: SeoThresholds,
): CheckText {
  const own = CHECKS[issue.key as UrlCategory]?.[lang];
  const fill = (s: string): string => fillThresholdLabel(s, thresholds);
  if (own) {
    const title = fill(own.title);
    return { title, why: fill(own.why), fix: fill(own.fix), short: fill(own.short ?? title) };
  }
  const title = `${groupName(issue.group, lang)}: ${issue.label}`;
  return { title, ...FALLBACK[lang][issue.severity], short: title };
}

/** Issue-catalog group label → its name on the «checked, fine» chips. */
const GROUPS: Record<string, Record<AuditLang, string>> = {
  'Page Titles': { ru: 'Заголовки страниц', en: 'Page titles' },
  'Meta Descriptions': { ru: 'Описания страниц', en: 'Meta descriptions' },
  H1: { ru: 'Заголовки H1', en: 'H1 headings' },
  H2: { ru: 'Подзаголовки H2', en: 'H2 headings' },
  Canonicals: { ru: 'Канонические адреса', en: 'Canonical URLs' },
  Content: { ru: 'Текст страниц', en: 'Content' },
  Response: { ru: 'Ответы сервера', en: 'Server responses' },
  Cookies: { ru: 'Cookies', en: 'Cookies' },
  Page: { ru: 'Страница', en: 'Page' },
  Document: { ru: 'Разметка документа', en: 'Document markup' },
  URL: { ru: 'Адреса страниц', en: 'URLs' },
  Accessibility: { ru: 'Доступность', en: 'Accessibility' },
  Mobile: { ru: 'Телефоны', en: 'Mobile' },
  Social: { ru: 'Превью для соцсетей', en: 'Social previews' },
  'Security Headers': { ru: 'Заголовки безопасности', en: 'Security headers' },
  'SSL / TLS': { ru: 'Сертификат HTTPS', en: 'HTTPS certificate' },
  Technical: { ru: 'Технические мелочи', en: 'Technical' },
  Redirects: { ru: 'Перенаправления', en: 'Redirects' },
  Performance: { ru: 'Скорость', en: 'Speed' },
  Sitemap: { ru: 'Карта сайта', en: 'Sitemap' },
  'Structured Data': { ru: 'Микроразметка', en: 'Structured data' },
  Analytics: { ru: 'Счётчики аналитики', en: 'Analytics tags' },
  Pagination: { ru: 'Постраничная навигация', en: 'Pagination' },
  Hreflang: { ru: 'Языковые версии', en: 'Language versions' },
  Images: { ru: 'Картинки', en: 'Images' },
  Links: { ru: 'Ссылки', en: 'Links' },
  JavaScript: { ru: 'JavaScript', en: 'JavaScript' },
  'PWA / Discovery': { ru: 'Манифест и иконки', en: 'Manifest and icons' },
};

export function groupName(group: string, lang: AuditLang): string {
  return GROUPS[group]?.[lang] ?? group;
}

/** Thousands grouped with a narrow no-break space (ru) or a comma (en). */
export function fmtNum(n: number, lang: AuditLang): string {
  const s = String(Math.round(Math.abs(n)));
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'ru' ? ' ' : ',');
  return (n < 0 ? '−' : '') + grouped;
}

/** A decimal with the locale separator. */
export function fmtDec(n: number, digits: number, lang: AuditLang): string {
  const s = n.toFixed(digits);
  return lang === 'ru' ? s.replace('.', ',') : s;
}

/** `a` of `b` as a percentage: whole above 1%, one decimal below, a dash without a base. */
export function fmtPct(a: number, b: number, lang: AuditLang): string {
  if (!b) return '—';
  const p = (100 * a) / b;
  return p >= 1 || p === 0 ? `${Math.round(p)}%` : `${fmtDec(p, 1, lang)}%`;
}

/**
 * Russian plural by number: forms for 1 / 2-4 / 5+ («страница», «страницы», «страниц»).
 * English: forms[0] for 1, forms[1] otherwise.
 */
export function plural(
  n: number,
  forms: readonly [string, string, string] | readonly [string, string],
  lang: AuditLang,
): string {
  const a = Math.abs(Math.trunc(n));
  if (lang === 'en' || forms.length === 2) return a === 1 ? forms[0] : forms[1]!;
  const d = a % 10;
  const dd = a % 100;
  if (d === 1 && dd !== 11) return forms[0];
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return forms[1];
  return forms[2]!;
}

/** Russian case after a number that does not depend on the 2-4 rule: the singular for 1, 21, 31 …; the plural otherwise. */
export function oneOr(n: number, one: string, other: string): string {
  const a = Math.abs(Math.trunc(n));
  return a % 10 === 1 && a % 100 !== 11 ? one : other;
}
