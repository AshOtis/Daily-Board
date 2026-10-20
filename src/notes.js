/* Daily Board: finding daily notes and reading what's in them. Everything here only reads note text. */

// Where daily notes live: the core Daily Notes plugin's settings, unless you set your own
function dbConfig(app, d) {
  let folder = d.folder || '', format = d.format || '', template = d.template || '';
  if (d.useCore !== false) {
    try {
      const core = app.internalPlugins && app.internalPlugins.getPluginById && app.internalPlugins.getPluginById('daily-notes');
      const o = core && core.instance && core.instance.options;
      if (o) { folder = o.folder || ''; format = o.format || ''; template = o.template || ''; }
    } catch (e) { /* fall back to our own settings */ }
  }
  return { folder: String(folder).replace(/^\/+|\/+$/g, ''), format: format || 'YYYY-MM-DD', template };
}

function dbPath(cfg, date) {
  const name = window.moment(date).format(cfg.format);
  return (cfg.folder ? cfg.folder + '/' : '') + name + '.md';
}

function dbDay(date) { const x = new Date(date); x.setHours(0, 0, 0, 0); return x; }
function dbAdd(date, days) { const x = new Date(date); x.setDate(x.getDate() + days); return x; }
function dbKey(date) { return window.moment(date).format('YYYY-MM-DD'); }
function dbWeekStart(date, startDay) { const x = dbDay(date); x.setDate(x.getDate() - ((x.getDay() - startDay + 7) % 7)); return x; }

// Pull the useful bits out of a daily note's text
function dbParse(text, promptHeading) {
  let body = String(text || '').replace(/\r\n/g, '\n');
  body = body.replace(/^---\n[\s\S]*?\n---\n?/, '');                 // properties
  const noCode = body.replace(/```[\s\S]*?```/g, '');
  const lines = noCode.split('\n');

  let focus = 0;
  for (const m of noCode.matchAll(/Focused (\d+) min/g)) focus += Number(m[1]);

  const open = [], done = [];
  for (const l of lines) {
    const m = l.match(/^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/);
    if (m) (m[1] === ' ' ? open : done).push(dbPlain(m[2]));
  }

  // the writing prompt: first paragraph under the prompt heading (One Page uses "Reflection")
  let prompt = '';
  if (promptHeading) {
    const h = promptHeading.trim().toLowerCase();
    const i = lines.findIndex(l => /^#{1,6}\s+/.test(l) && l.replace(/^#{1,6}\s+/, '').trim().toLowerCase() === h);
    if (i >= 0) for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (/^#{1,6}\s/.test(t)) break;
      prompt = dbPlain(t.replace(/^>\s*/, '')); break;
    }
  }

  // the first few lines of what you actually wrote (skipping headings, tasks, focus logs and the prompt)
  const words = [], snippet = [];
  let inPrompt = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (/^#{1,6}\s/.test(l)) { inPrompt = promptHeading && l.replace(/^#{1,6}\s+/, '').trim().toLowerCase() === promptHeading.trim().toLowerCase(); continue; }
    if (!l) continue;
    const plain = dbPlain(l.replace(/^\s*[-*+]\s+(\[.\]\s+)?/, '').replace(/^>\s*/, '').replace(/^\d+\.\s+/, ''));
    for (const w of plain.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(w)) words.push(w);
    if (inPrompt) continue;
    if (/^\s*[-*+]\s+\[.\]/.test(raw) || /Focused \d+ min|Parked thought/.test(l) || /^!\[\[|^<|^\|/.test(l)) continue;
    if (snippet.join(' ').length < 240 && plain) snippet.push(plain);
  }
  return { focus, open, done, prompt, words: words.length, snippet: snippet.join(' ') };
}

// Markdown → plain text for previews
function dbPlain(s) {
  return String(s)
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, (m, a) => a.split('/').pop())
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|==)/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dbMins(m) { return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`; }

// ISO week number, for the week headings
function dbWeekNo(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dn = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dn);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y) / 864e5 + 1) / 7);
}
