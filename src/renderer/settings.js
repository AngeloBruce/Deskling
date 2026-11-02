// =============================================================================
// settings.js (ventana) — Llena el formulario y manda a main SOLO lo que cambió:
// así un interruptor del menú de Clawd no se pisa si esta ventana quedó abierta.
// Cada campo dice qué opción edita con data-path. Quien valida es main (src/settings.js).
// =============================================================================

const fields = [...document.querySelectorAll('[data-path]')];
const statusEl = document.getElementById('status');
let data = null;   // lo que mandó main: valores, límites y catálogos
let loaded = {};   // cómo estaba cada campo al cargar, para saber qué cambió

const getPath = (obj, dotted) => dotted.split('.').reduce((o, k) => o?.[k], obj);

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  let at = obj;
  for (const k of keys) at = at[k] ??= {};
  at[last] = value;
}

// --- Pasar valores entre la config y cada tipo de campo ---

function writeField(el, value) {
  const type = el.dataset.type;
  if (type === 'choice') setChoice(el, value);
  else if (type === 'list') el.value = (value || []).join('\n');
  else if (type === 'words') el.value = (value || []).join(' ');
  else if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value ?? '';
}

function readField(el) {
  const type = el.dataset.type;
  if (type === 'choice') return el.querySelector('[aria-checked="true"]')?.dataset.value;
  if (type === 'list') return el.value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (type === 'words') return el.value.split(/\s+/).filter(Boolean);
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') return el.value === '' ? undefined : Number(el.value);
  return el.value;
}

// --- Botoncitos de apariencia ---

function setChoice(group, value) {
  for (const b of group.querySelectorAll('button')) {
    const on = b.dataset.value === value;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

function buildChoices(path, items) {
  const group = document.querySelector(`[data-path="${path}"]`);
  group.replaceChildren(...items.map((item) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.value = item.id;
    if (item.color) {
      const swatch = document.createElement('i');
      swatch.style.background = item.color;
      b.append(swatch);
    }
    b.append(item.label);
    b.addEventListener('click', () => { setChoice(group, item.id); preview(); });
    return b;
  }));
  // flechas para moverse dentro del grupo
  group.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const buttons = [...group.querySelectorAll('button')];
    const at = buttons.indexOf(document.activeElement);
    const next = buttons[(at + step + buttons.length) % buttons.length];
    next.click();
    next.focus();
  });
}

function preview() {
  window.ajustes.preview({
    skin: readField(document.querySelector('[data-path="appearance.skin"]')),
    accessory: readField(document.querySelector('[data-path="appearance.accessory"]')),
    size: readField(document.querySelector('[data-path="appearance.size"]')),
  });
}

// --- Selects que dependen de otra opción ---

function fillSelect(select, items) {
  select.replaceChildren(...items.map((item) => {
    const o = document.createElement('option');
    o.value = item.id;
    o.textContent = item.label || item.id;
    return o;
  }));
}

function updatePreset() {
  const preset = document.getElementById('preset');
  const item = data.catalog.personalities.find((p) => p.id === preset.value);
  document.getElementById('preset-hint').textContent = item?.hint || '';
  document.getElementById('custom-field').hidden = preset.value !== 'custom';
}

function updateProvider() {
  const id = document.getElementById('provider').value;
  const hasKey = data.catalog.providers.find((p) => p.id === id)?.hasKey;
  document.getElementById('provider-key').textContent = hasKey
    ? 'API key: configurada.'
    : 'API key: falta. Agrégala en el archivo .env y reinicia la app.';
}

// --- Cargar y guardar ---

function load(next) {
  data = next;
  loaded = {};
  for (const el of fields) {
    const value = getPath(data.values, el.dataset.path);
    writeField(el, value);
    loaded[el.dataset.path] = JSON.stringify(readField(el));
  }
  updatePreset();
  updateProvider();
}

async function save() {
  const patch = {};
  for (const el of fields) {
    const value = readField(el);
    if (value !== undefined && JSON.stringify(value) !== loaded[el.dataset.path]) setPath(patch, el.dataset.path, value);
  }
  const res = await window.ajustes.save(patch);
  statusEl.classList.toggle('error', !res.ok);
  statusEl.textContent = res.ok ? 'Guardado.' : 'No se pudo guardar. Revisa logs/errors.log.';
  if (res.data) load(res.data); // muestra lo que quedó de verdad (por ejemplo, un número ajustado al rango)
}

// --- Arranque ---

async function init() {
  const first = await window.ajustes.get();
  const { catalog, limits } = first;
  fillSelect(document.getElementById('preset'), catalog.personalities);
  fillSelect(document.getElementById('provider'), catalog.providers);
  buildChoices('appearance.skin', catalog.skins);
  buildChoices('appearance.accessory', catalog.accessories);
  buildChoices('appearance.size', catalog.sizes.map((s) => ({ ...s, label: `${s.label} (${s.w} px)` })));
  for (const [path, range] of Object.entries(limits)) {
    const el = document.querySelector(`[data-path="${path}"]`);
    if (el) Object.assign(el, { min: range.min, max: range.max, step: 1 });
  }
  load(first);
}

document.getElementById('preset').addEventListener('change', updatePreset);
document.getElementById('provider').addEventListener('change', updateProvider);
document.getElementById('save').addEventListener('click', save);
document.getElementById('cancel').addEventListener('click', () => window.ajustes.close()); // main descarta la vista previa
document.getElementById('open-json').addEventListener('click', () => window.ajustes.openJson());
document.querySelector('main').addEventListener('input', () => { statusEl.textContent = ''; });

// Pestañas
const tabs = [...document.querySelectorAll('#tabs button')];
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => {
    for (const t of tabs) {
      t.setAttribute('aria-selected', String(t === tab));
      document.getElementById(t.dataset.tab).hidden = t !== tab;
    }
    document.querySelector('main').scrollTop = 0;
  });
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = tabs[(i + step + tabs.length) % tabs.length];
    next.click();
    next.focus();
  });
});

init();
