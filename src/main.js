/* Daily Board: your daily notes as a board of week cards, or one long stream you can write in. */

const DB_VIEW = 'daily-board-view';
const DB_DEPTH = 3;
const DB_DEFAULTS = {
  useCore: true, folder: '', format: '', template: '',
  weekStart: 1, weeks: 3, streamDays: 14, promptHeading: 'Reflection', subfolders: true,
  layout: 'board', onlyThoughts: false, onlyFocus: false,
  bg: 'none', bgImage: '', bgDim: 35, bgBlur: 0, bgGlow: 35, bgAuroraDim: 50, openOnStart: false,
};
const DB_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

class DailyBoard extends Plugin {
  async onload() {
    this.d = Object.assign({}, DB_DEFAULTS, await this.loadData());
    this.cache = new Map();                       // path -> { mtime, info }
    this.registerView(DB_VIEW, leaf => new DBView(leaf, this));
    this.addRibbonIcon('calendar-days', 'Open Daily Board', () => this.open());
    this.addCommand({ id: 'open', name: 'Open the board', callback: () => this.open() });
    this.addCommand({ id: 'open-stream', name: 'Open the stream', callback: async () => { this.d.layout = 'stream'; await this.save(); this.open(); } });
    this.addSettingTab(new DBSettings(this.app, this));
    const changed = f => { if (f && f.path && f.path.endsWith('.md')) { this.cache.delete(f.path); this.soon(); } };
    const moved = f => { this.idx = null; changed(f); };
    this.registerEvent(this.app.vault.on('modify', changed));
    this.registerEvent(this.app.vault.on('create', moved));
    this.registerEvent(this.app.vault.on('delete', moved));
    this.registerEvent(this.app.vault.on('rename', (f, old) => { this.cache.delete(old); moved(f); }));
    this.app.workspace.onLayoutReady(() => { if (this.d.openOnStart) this.open(); });
  }

  save() { return this.saveData(this.d); }
  cfg() { return dbConfig(this.app, this.d); }
  views() { return this.app.workspace.getLeavesOfType(DB_VIEW).map(l => l.view).filter(v => v instanceof DBView); }
  redraw() { this.views().forEach(v => v.render()); }
  soon() { clearTimeout(this.t); this.t = window.setTimeout(() => this.views().forEach(v => v.render(true)), 400); }

  async open() {
    let leaf = this.app.workspace.getLeavesOfType(DB_VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: DB_VIEW, active: true }); }
    this.app.workspace.revealLeaf(leaf);
  }

  file(date) {
    const cfg = this.cfg();
    const f = this.app.vault.getAbstractFileByPath(dbPath(cfg, date));
    if (f && f.extension === 'md') return f;
    if (!this.d.subfolders || !cfg.folder) return null;
    // not where Daily Notes would put it, so look for the same file name in any folder inside (an archive, say)
    return this.names(cfg).get(window.moment(date).format(cfg.format).split('/').pop()) || null;
  }

  // file name -> note, for every note anywhere under the daily notes folder (built once, reset when files move)
  names(cfg) {
    const sig = cfg.folder + '|' + cfg.format;
    if (this.idx && this.idx.sig === sig) return this.idx.map;
    // walk only the daily notes folder itself, at most DB_DEPTH folders down (Archive/2026/October is 3)
    const map = new Map();
    const walk = (folder, depth) => {
      for (const c of folder.children || []) {
        if (c.children) { if (depth < DB_DEPTH) walk(c, depth + 1); }
        else if (c.extension === 'md' && !map.has(c.basename)) map.set(c.basename, c);
      }
    };
    const root = this.app.vault.getAbstractFileByPath(cfg.folder);
    if (root && root.children) walk(root, 0);
    this.idx = { sig, map };
    return map;
  }

  async info(file) {
    const hit = this.cache.get(file.path);
    if (hit && hit.mtime === file.stat.mtime) return hit.info;
    const info = dbParse(await this.app.vault.cachedRead(file), this.d.promptHeading);
    this.cache.set(file.path, { mtime: file.stat.mtime, info });
    return info;
  }

  // Make the daily note for a day, using your Daily Notes template if you have one
  async create(date) {
    const cfg = this.cfg(), path = dbPath(cfg, date);
    const existing = this.file(date);
    if (existing) return existing;
    let text = '';
    if (cfg.template) {
      const t = this.app.metadataCache.getFirstLinkpathDest(cfg.template, '') || this.app.vault.getAbstractFileByPath(cfg.template.replace(/\.md$/, '') + '.md');
      if (t) {
        const m = window.moment(date), now = window.moment();
        text = (await this.app.vault.read(t))
          .replace(/{{\s*date\s*:\s*([^}]+?)\s*}}/gi, (a, f) => m.format(f))
          .replace(/{{\s*time\s*:\s*([^}]+?)\s*}}/gi, (a, f) => now.format(f))
          .replace(/{{\s*date\s*}}/gi, m.format(cfg.format))
          .replace(/{{\s*time\s*}}/gi, now.format('HH:mm'))
          .replace(/{{\s*title\s*}}/gi, m.format(cfg.format).split('/').pop());
      }
    }
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
    return this.app.vault.create(path, text);
  }
}

class DBView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.offset = 0; this.shown = plugin.d.streamDays; this.editing = null; this.jump = null; this.seq = 0; }
  getViewType() { return DB_VIEW; }
  getDisplayText() { return 'Daily Board'; }
  getIcon() { return 'calendar-days'; }
  async onOpen() { this.contentEl.addClass('db'); this.render(); }

  // what sits behind the board: nothing (your theme shows through), a built-in aurora picture, or your own picture
  paintBackground() {
    const host = this.containerEl, d = this.plugin.d;
    let bg = d.bg || 'none', url = '';
    if (bg === 'custom') {
      const f = d.bgImage ? this.app.vault.getAbstractFileByPath(d.bgImage) : null;
      if (f) url = `url("${this.app.vault.getResourcePath(f)}")`; else bg = 'none';
    }
    for (const k of ['warm', 'north', 'aurora']) host.toggleClass('db-bg-' + k, bg === k);
    host.toggleClass('db-bg-host', bg !== 'none');
    if (bg === 'none') { host.setCssProps({ '--db-bg': '' }); return; }
    host.setCssProps({ '--db-bg': url, '--db-dim': String((bg === 'aurora' ? (d.bgAuroraDim ?? 50) : d.bgDim) / 100), '--db-blur': d.bgBlur + 'px', '--db-glow': String((d.bgGlow ?? 35) / 100) });
  }

  async render(fromVault) {
    if (fromVault && this.editing) return;          // never pull the rug out from under someone typing
    const seq = ++this.seq, p = this.plugin, d = p.d;
    const scroll = this.contentEl.scrollTop;
    this.paintBackground();
    const wrap = createDiv({ cls: 'db-wrap' });

    const today = dbDay(new Date());
    const thisWeek = dbWeekStart(today, d.weekStart);

    // header + stats
    const top = wrap.createDiv({ cls: 'db-top' });
    const left = top.createDiv();
    left.createEl('h1', { text: 'Daily Board' });
    const cfg = p.cfg();
    left.createDiv({ cls: 'db-sub', text: `${cfg.folder || 'Vault root'} · ${cfg.format}` });
    const stats = top.createDiv({ cls: 'db-stats' });

    let streak = 0;
    for (let i = p.file(today) ? 0 : 1; i < 400; i++) { if (p.file(dbAdd(today, -i))) streak++; else break; }
    let weekFocus = 0, weekWords = 0, openThoughts = 0;
    for (let i = 0; i < 7; i++) { const f = p.file(dbAdd(thisWeek, i)); if (f) { const n = await p.info(f); weekFocus += n.focus; weekWords += n.words; } }
    for (let i = 0; i < 30; i++) { const f = p.file(dbAdd(today, -i)); if (f) openThoughts += (await p.info(f)).open.length; }
    if (seq !== this.seq) return;
    const stat = (n, l, hot) => { const s = stats.createDiv({ cls: 'db-stat' + (hot ? ' is-hot' : '') }); s.createDiv({ cls: 'db-n', text: n }); s.createDiv({ cls: 'db-l', text: l }); };
    stat(streak === 1 ? '1 day' : `${streak} days`, 'current streak', streak > 0);
    stat(dbMins(weekFocus), 'focused this week');
    stat(weekWords.toLocaleString(), 'words this week');
    stat(String(openThoughts), 'open tasks, 30 days');

    // bar
    const bar = wrap.createDiv({ cls: 'db-bar' });
    if (d.layout === 'board') {
      const nav = bar.createDiv({ cls: 'db-nav' });
      const b = (t, label, fn) => { const x = nav.createEl('button', { cls: 'db-btn', text: t, attr: { 'aria-label': label } }); x.onclick = fn; return x; };
      b('‹', 'Earlier weeks', () => { this.offset += d.weeks; this.render(); });
      const from = dbAdd(thisWeek, -7 * (this.offset + d.weeks - 1)), to = dbAdd(thisWeek, -7 * this.offset + 6);
      nav.createSpan({ cls: 'db-range', text: `${window.moment(from).format('D MMM')} – ${window.moment(to).format('D MMM YYYY')}` });
      const nx = b('›', 'Later weeks', () => { this.offset = Math.max(0, this.offset - d.weeks); this.render(); });
      if (!this.offset) nx.disabled = true;
      b('Today', 'Back to this week', () => { this.offset = 0; this.render(); });
    }
    bar.createDiv({ cls: 'db-sp' });
    const chip = (key, text) => {
      const c = bar.createEl('button', { cls: 'db-chip' + (d[key] ? ' is-on' : ''), text });
      c.onclick = () => { d[key] = !d[key]; p.save(); this.render(); };
    };
    chip('onlyThoughts', 'Open tasks'); chip('onlyFocus', 'Focus sessions');
    const seg = bar.createDiv({ cls: 'db-seg' });
    [['board', 'Board'], ['stream', 'Stream']].forEach(([k, t]) => {
      const b = seg.createEl('button', { cls: d.layout === k ? 'is-on' : '', text: t });
      b.onclick = () => { d.layout = k; p.save(); this.render(); };
    });

    if (d.layout === 'board') await this.board(wrap, today, thisWeek);
    else await this.stream(wrap, today);
    if (seq !== this.seq) return;
    this.contentEl.empty(); this.contentEl.appendChild(wrap);
    if (this.jump) { const t = wrap.querySelector(`[data-day="${this.jump}"]`); this.jump = null; if (t) t.scrollIntoView({ block: 'start' }); }
    else this.contentEl.scrollTop = scroll;
  }

  dim(n) { const d = this.plugin.d; return (d.onlyThoughts && !n.open.length) || (d.onlyFocus && !n.focus); }

  async board(wrap, today, thisWeek) {
    const p = this.plugin, d = p.d;
    for (let w = 0; w < d.weeks; w++) {
      const ws = dbAdd(thisWeek, -7 * (this.offset + w));
      const week = wrap.createDiv({ cls: 'db-week' });
      const head = week.createDiv({ cls: 'db-week-h' });
      const grid = week.createDiv({ cls: 'db-grid' });
      let f = 0, words = 0;
      for (let i = 0; i < 7; i++) {
        const day = dbAdd(ws, i), file = p.file(day), key = dbKey(day);
        const isToday = +day === +today, future = day > today;
        const card = grid.createDiv({ cls: 'db-day' + (isToday ? ' is-today' : '') + (future ? ' is-future' : '') + (!file && !future ? ' is-empty' : '') });
        const h = card.createDiv({ cls: 'db-dh' });
        h.createSpan({ cls: 'db-dn', text: `${DB_DOW[day.getDay()]} ${day.getDate()}` });
        h.createSpan({ cls: 'db-dd', text: isToday ? 'today' : window.moment(day).format('MMM') });
        if (future) continue;
        if (!file) {
          const g = card.createDiv({ cls: 'db-ghost' }); g.createEl('b', { text: 'No note' }); g.appendText('+ Create this day');
          card.onclick = async () => { await p.create(day); d.layout = 'stream'; await p.save(); this.jump = key; this.render(); };
          continue;
        }
        const n = await p.info(file);
        f += n.focus; words += n.words;
        if (this.dim(n)) card.addClass('is-dim');
        if (n.snippet) card.createDiv({ cls: 'db-txt', text: n.snippet });
        if (n.prompt) card.createDiv({ cls: 'db-prompt', text: '✎ ' + n.prompt });
        if (n.open.length) {
          const ul = card.createEl('ul', { cls: 'db-tasks' });
          n.open.slice(0, 3).forEach(t => ul.createEl('li', { text: t }));
          if (n.open.length > 3) ul.createEl('li', { cls: 'db-more', text: `+${n.open.length - 3} more` });
        }
        const meta = card.createDiv({ cls: 'db-meta' });
        if (n.focus) meta.createSpan({ cls: 'db-pill is-focus', text: '⏱ ' + dbMins(n.focus) });
        meta.createSpan({ cls: 'db-pill', text: `${n.words} words` });
        if (n.focus) { const heat = card.createDiv({ cls: 'db-heat', attr: { 'aria-label': 'Focus time' } }); for (let k = 1; k <= 6; k++) heat.createEl('i', { cls: n.focus >= k * 15 ? 'is-on' : '' }); }
        card.setAttr('aria-label', 'Click: show in the stream · Ctrl/Cmd-click: open the note');
        card.onclick = e => {
          if (e.ctrlKey || e.metaKey) { this.app.workspace.getLeaf('tab').openFile(file); return; }
          d.layout = 'stream'; p.save(); this.jump = key; this.shown = Math.max(this.shown, Math.round((today - day) / 864e5) + 3); this.render();
        };
      }
      head.createEl('b', { text: `Week ${dbWeekNo(ws)}` });
      head.createSpan({ text: `${window.moment(ws).format('D MMM')} – ${window.moment(dbAdd(ws, 6)).format('D MMM')} · ${dbMins(f)} focus · ${words.toLocaleString()} words` });
    }
  }

  async stream(wrap, today) {
    const p = this.plugin;
    const list = wrap.createDiv({ cls: 'db-stream' });
    for (let i = 0; i < this.shown; i++) {
      const day = dbAdd(today, -i), file = p.file(day), key = dbKey(day);
      if (!file) {
        const miss = list.createDiv({ cls: 'db-miss', attr: { 'data-day': key } });
        miss.createSpan({ text: `${DB_DOW[day.getDay()]} ${window.moment(day).format('D MMM')} · no note` });
        const b = miss.createEl('button', { cls: 'db-btn', text: '+ Create' });
        b.onclick = async () => { await p.create(day); this.jump = key; this.render(); };
        continue;
      }
      const n = await p.info(file);
      const entry = list.createDiv({ cls: 'db-entry' + (i === 0 ? ' is-today' : '') + (this.dim(n) ? ' is-dim' : ''), attr: { 'data-day': key } });
      const eh = entry.createDiv({ cls: 'db-eh' });
      const title = eh.createEl('a', { cls: 'db-etitle', text: file.basename, attr: { 'aria-label': 'Open the note' } });
      title.onclick = e => { e.preventDefault(); this.app.workspace.getLeaf(e.ctrlKey || e.metaKey ? 'tab' : false).openFile(file); };
      eh.createSpan({ cls: 'db-wd', text: DB_DOW[day.getDay()] + (i === 0 ? ' · today' : '') });
      eh.createDiv({ cls: 'db-sp' });
      if (n.focus) eh.createSpan({ cls: 'db-pill is-focus', text: '⏱ ' + dbMins(n.focus) });
      eh.createSpan({ cls: 'db-pill', text: `${n.words} words` });
      const edit = eh.createEl('button', { cls: 'db-btn db-edit', attr: { 'aria-label': 'Edit here' } });
      setIcon(edit, 'pencil');
      const body = entry.createDiv({ cls: 'db-body markdown-rendered' });
      await this.showNote(body, file);
      const startEdit = () => this.edit(body, file);
      edit.onclick = startEdit;
      body.addEventListener('dblclick', e => { if (!e.target.closest('a, input')) startEdit(); });
    }
    const more = wrap.createEl('button', { cls: 'db-btn db-load', text: 'Show earlier days' });
    more.onclick = () => { this.shown += 14; this.render(); };
  }

  async showNote(body, file) {
    const text = (await this.app.vault.cachedRead(file)).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    body.empty();
    if (!text.trim()) { body.createDiv({ cls: 'db-emptytext', text: 'Empty note. Double-click to write.' }); return; }
    await MarkdownRenderer.render(this.app, text, body, file.path, this);
    // internal links open the note; ticking a task updates the file
    body.querySelectorAll('a.internal-link').forEach(a => a.addEventListener('click', e => {
      e.preventDefault(); this.app.workspace.openLinkText(a.getAttribute('data-href') || a.getAttribute('href'), file.path, e.ctrlKey || e.metaKey);
    }));
    body.querySelectorAll('input.task-list-item-checkbox').forEach((box, idx) => box.addEventListener('click', async e => {
      e.stopPropagation();
      await this.app.vault.process(file, t => {
        let k = -1;
        return t.replace(/^(\s*[-*+]\s+\[)( |x|X)(\])/gm, (m, a, c, b) => (++k === idx ? a + (c === ' ' ? 'x' : ' ') + b : m));
      });
    }));
  }

  // Write in place: the note's markdown in a box that grows as you type, saved as you go
  edit(body, file) {
    if (this.editing) return;
    this.editing = file.path;
    this.app.vault.read(file).then(text => {
      body.empty(); body.addClass('is-editing');
      const ta = body.createEl('textarea', { cls: 'db-editor' });
      ta.value = text; ta.spellcheck = true;
      const fit = () => { ta.setCssStyles({ height: 'auto' }); ta.setCssStyles({ height: ta.scrollHeight + 2 + 'px' }); };
      let timer = 0, saved = text;
      const save = async () => { clearTimeout(timer); if (ta.value !== saved) { saved = ta.value; await this.app.vault.modify(file, saved); } };
      const done = async () => { await save(); this.editing = null; body.removeClass('is-editing'); this.plugin.cache.delete(file.path); this.render(); };
      ta.addEventListener('input', () => { fit(); clearTimeout(timer); timer = window.setTimeout(save, 800); });
      ta.addEventListener('keydown', e => { if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) { e.preventDefault(); ta.blur(); } });
      ta.addEventListener('blur', done);
      body.createDiv({ cls: 'db-hint', text: 'Saved as you type · Esc or click away to finish' });
      fit(); ta.focus();
    });
  }
}

class DBImagePicker extends FuzzySuggestModal {
  constructor(app, onPick) { super(app); this.onPick = onPick; this.setPlaceholder('Pick an image from your vault'); }
  getItems() { return this.app.vault.getFiles().filter(f => /^(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(f.extension)); }
  getItemText(f) { return f.path; }
  onChooseItem(f) { this.onPick(f); }
}

class DBSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl, p = this.plugin, d = p.d;
    el.empty();
    const go = () => { p.cache.clear(); p.save(); p.redraw(); };
    new Setting(el).setName('Open when Obsidian starts').setDesc('Show the board as the front tab every time you open this vault.')
      .addToggle(t => t.setValue(d.openOnStart).onChange(v => { d.openOnStart = v; p.save(); }));

    new Setting(el).setName('Daily notes').setHeading();
    new Setting(el).setName('Use the Daily Notes settings').setDesc('Read the folder, date format and template from Obsidian\'s core Daily Notes plugin.')
      .addToggle(t => t.setValue(d.useCore !== false).onChange(v => { d.useCore = v; go(); this.display(); }));
    if (d.useCore === false) {
      new Setting(el).setName('Folder').addText(t => t.setPlaceholder('Daily Notes').setValue(d.folder).onChange(v => { d.folder = v.trim(); go(); }));
      new Setting(el).setName('Date format').setDesc('As in the Daily Notes plugin, for example YYYY-MM-DD.')
        .addText(t => t.setPlaceholder('YYYY-MM-DD').setValue(d.format).onChange(v => { d.format = v.trim(); go(); }));
      new Setting(el).setName('Template').setDesc('Used when you create a day from the board.')
        .addText(t => t.setPlaceholder('Templates/Daily').setValue(d.template).onChange(v => { d.template = v.trim(); p.save(); }));
    } else {
      const c = p.cfg();
      el.createDiv({ cls: 'setting-item-description db-cfg', text: `Using: ${c.folder || 'vault root'} · ${c.format}${c.template ? ' · template ' + c.template : ''}` });
    }
    new Setting(el).setName('Include subfolders').setDesc('Also find daily notes in folders inside the daily notes folder, such as an Archive folder (up to 3 folders deep). New days are still created in the main folder.')
      .addToggle(t => t.setValue(d.subfolders !== false).onChange(v => { d.subfolders = v; p.idx = null; go(); }));
    new Setting(el).setName('Prompt heading').setDesc('Cards show the first line under this heading as the day\'s prompt. One Page writes its prompt under "Reflection".')
      .addText(t => t.setValue(d.promptHeading).onChange(v => { d.promptHeading = v.trim(); go(); }));

    new Setting(el).setName('Layout').setHeading();
    new Setting(el).setName('Week starts on')
      .addDropdown(dd => dd.addOptions({ 1: 'Monday', 0: 'Sunday' }).setValue(String(d.weekStart)).onChange(v => { d.weekStart = Number(v); go(); }));
    new Setting(el).setName('Weeks on the board')
      .addDropdown(dd => dd.addOptions({ 1: '1', 2: '2', 3: '3', 4: '4', 6: '6' }).setValue(String(d.weeks)).onChange(v => { d.weeks = Number(v); go(); }));
    new Setting(el).setName('Days in the stream').setDesc('How many days the stream shows before "Show earlier days".')
      .addDropdown(dd => dd.addOptions({ 7: '7', 14: '14', 30: '30' }).setValue(String(d.streamDays)).onChange(v => { d.streamDays = Number(v); p.views().forEach(x => x.shown = d.streamDays); go(); }));

    new Setting(el).setName('Background').setHeading();
    const bg = d.bg || 'none';
    new Setting(el).setName('Background').setDesc('A picture behind the board. With None, your theme\'s own background shows through.')
      .addDropdown(dd => dd.addOptions({ none: 'None', warm: 'Aurora (warm)', north: 'Aurora (northern lights)', aurora: 'Static Aurora (live colours)', custom: 'My own picture' }).setValue(bg)
        .onChange(v => { d.bg = v; p.save(); p.redraw(); this.display(); }));
    if (bg === 'custom') {
      new Setting(el).setName('Picture').setDesc(d.bgImage ? d.bgImage : 'Pick any picture in your vault.')
        .addButton(b => b.setButtonText(d.bgImage ? 'Change' : 'Choose…').onClick(() => new DBImagePicker(this.app, f => { d.bgImage = f.path; p.save(); p.redraw(); this.display(); }).open()));
    }
    if (bg === 'aurora') {
      const theme = this.app.customCss && this.app.customCss.theme;
      el.createDiv({ cls: 'setting-item-description', text: theme === 'Static Aurora'
        ? 'The board shows the theme\'s aurora glows and accents, in the same colours. When Static FM, Aurora MP3 or Hi-Fi Tuner colour the theme, the board changes with it.'
        : 'Made for the Static Aurora theme, which isn\'t active. The board uses its default colours until you switch to it.' });
      new Setting(el).setName('Glow').setDesc('How strong the aurora is behind the board.')
        .addSlider(sl => sl.setLimits(10, 100, 5).setValue(d.bgGlow ?? 35).setDynamicTooltip().onChange(v => { d.bgGlow = v; p.save(); p.redraw(); }));
      new Setting(el).setName('Darken').setDesc('Dim the glow so the cards stay easy to read.')
        .addSlider(sl => sl.setLimits(0, 90, 5).setValue(d.bgAuroraDim ?? 50).setDynamicTooltip().onChange(v => { d.bgAuroraDim = v; p.save(); p.redraw(); }));
    } else if (bg !== 'none') {
      new Setting(el).setName('Darken').setDesc('Dim the picture so the cards stay easy to read.')
        .addSlider(sl => sl.setLimits(0, 90, 5).setValue(d.bgDim).setDynamicTooltip().onChange(v => { d.bgDim = v; p.save(); p.redraw(); }));
      new Setting(el).setName('Blur').setDesc('Soften the picture.')
        .addSlider(sl => sl.setLimits(0, 20, 1).setValue(d.bgBlur).setDynamicTooltip().onChange(v => { d.bgBlur = v; p.save(); p.redraw(); }));
    }
  }
}
