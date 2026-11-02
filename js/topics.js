// Темы, по которым собирается лента, и список проверенных источников.
// Этот модуль используется и в браузере, и в Node-скрипте обновления ленты.

export const TOPICS = [
  { id: 'physics',    name: 'Физика и математика',      short: 'Физика',     emoji: '⚛️', hint: 'физика, математика, химия' },
  { id: 'space',      name: 'Космос',                    short: 'Космос',     emoji: '🔭', hint: 'астрономия, космология, планеты, космонавтика' },
  { id: 'biology',    name: 'Биология',                  short: 'Биология',   emoji: '🧬', hint: 'эволюция, генетика, зоология, микробиология' },
  { id: 'medicine',   name: 'Медицина и здоровье',       short: 'Медицина',   emoji: '🩺', hint: 'исследования, болезни, организм человека' },
  { id: 'history',    name: 'История и археология',      short: 'История',    emoji: '🏺', hint: 'история, археология, антропология' },
  { id: 'tech',       name: 'Технологии и общество',     short: 'Технологии', emoji: '💡', hint: 'как технологии меняют жизнь, ИИ, инженерия, изобретения' },
  { id: 'mind',       name: 'Психология и нейронаука',   short: 'Мозг',       emoji: '🧠', hint: 'мозг, поведение, память, сознание' },
  { id: 'economics',  name: 'Экономика и общество',      short: 'Экономика',  emoji: '📈', hint: 'экономические идеи, города, работа, демография, социология' },
  { id: 'culture',    name: 'Культура и искусство',      short: 'Культура',   emoji: '🎭', hint: 'литература, живопись, музыка, кино, архитектура, язык' },
  { id: 'nature',     name: 'Природа и экология',        short: 'Природа',    emoji: '🌿', hint: 'климат, экосистемы, океаны, животные, охрана природы' },
  { id: 'philosophy', name: 'Философия',                 short: 'Философия',  emoji: '🤔', hint: 'идеи, этика, сознание, история мысли' },
  { id: 'geography',  name: 'География и путешествия',   short: 'География',  emoji: '🧭', hint: 'места, народы, языки, карты' },
  { id: 'everyday',   name: 'Необычное в обычном',       short: 'Необычное',  emoji: '🔍', hint: 'неожиданные факты о еде, вещах, привычках, словах и быте' },
];

export const TOPIC_IDS = TOPICS.map((t) => t.id);
export const topicById = (id) => TOPICS.find((t) => t.id === id) || { id, name: id, short: id, emoji: '📄', hint: '' };

// Проверенные издания. Используются как allowed_domains для веб-поиска Claude
// (до 64 доменов; суффикс пути допустим только для web_search).
export const TRUSTED_DOMAINS = [
  // English
  'quantamagazine.org', 'aeon.co', 'psyche.co', 'nautil.us', 'smithsonianmag.com',
  'bbc.com/future', 'bbc.com/culture', 'bbc.com/travel', 'arstechnica.com', 'theatlantic.com',
  'knowablemagazine.org', 'scientificamerican.com', 'theconversation.com', 'noemamag.com',
  'undark.org', 'atlasobscura.com', 'hakaimagazine.com', 'daily.jstor.org', 'bigthink.com',
  'worksinprogress.co', 'publicdomainreview.org', 'lithub.com', 'asimov.press', 'sapiens.org',
  'technologyreview.com', 'spectrum.ieee.org', 'restofworld.org', 'e360.yale.edu',
  'news.mongabay.com', 'themarginalian.org', 'ourworldindata.org', 'hyperallergic.com',
  'thepointmag.com',
  // Русский
  'nplus1.ru', 'naked-science.ru', 'postnauka.org', 'arzamas.academy', 'kot.sh',
  'elementy.ru', 'chrdk.ru', 'nkj.ru', 'indicator.ru', 'trv-science.ru', 'vokrugsveta.ru',
  'knife.media', 'sysblok.ru', 'gorky.media', 'polka.academy', 'diletant.media',
  'econs.online', 'iq.hse.ru', 'habr.com', 't-j.ru', 'theoryandpractice.ru', 'colta.ru',
  'biomolecula.ru', 'antropogenez.ru',
];
