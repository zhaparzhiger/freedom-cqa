// Руки «Аудитора»: снимок экрана для модели и действия с любыми элементами — как у пользователя с мышью и клавиатурой.
// Снимок — список видимых интерактивных элементов с ref (e1, e2…), по ref модель нажимает, вводит текст, выбирает.
// ref живут до следующего снимка: после каждого действия модель получает новый.

const SKIP = '.ai, .ai *, #tour, #tour *, [hidden], [hidden] *';
const INTERACTIVE = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'summary',
  '[role="button"]',
  '[role="tab"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="option"]',
  '[contenteditable="true"]',
].join(',');

// смысловые блоки страницы (карточки показателей, секции, графики, таблицы) — их Аудитор выделяет, когда объясняет страницу
const BLOCKS = [
  '#view header.head',
  '#view .lane-l',
  '#view .lane-r',
  '#view .toolbar',
  '#view .ops-col',
  '#view section.sheet',
  '#view div.sheet',
  '#view .d-zones',
  '#view table',
  '#view .count-line',
  '#view .msgs',
  '#view .score',
  '#view [id^="crit-"]',
  '#view [data-explain]',
].join(',');
const HEADING = 'h1, h2, h3, .sheet-h b, .cap, b, strong';

// действия, которые меняют данные или тратят вызовы модели: без явного «да» пользователя не нажимаем
// (открыть форму — можно; отправить, сохранить, удалить, оценить — только после «да»)
const DANGER = /удал|delete|примен|сохран|оцени|принять|принят|отклон|подать|отправ|импорт|загрузить|активир|создать|решени|пересч|запуст|сброс/i;

const clean = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const visible = (el) => {
  if (el.closest(SKIP)) return false;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
};

// текст подписи без самих полей внутри неё (иначе в подпись попадают все варианты списка)
const ownText = (node) => {
  if (!node) return '';
  const c = node.cloneNode(true);
  c.querySelectorAll('select, option, textarea, input, button').forEach((x) => x.remove());
  return c.textContent;
};

function labelOf(el) {
  const aria = el.getAttribute('aria-label');
  const byId = el.id && ownText(document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
  const wrap = ownText(el.closest('label'));
  const field = ownText(el.closest('.field, .fld, .row-f')?.querySelector('label, .lbl, .k'));
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return clean(aria || byId || wrap || field || el.placeholder || el.name || el.title);
  return clean(aria || el.innerText || el.title || el.value || el.getAttribute('alt'));
}

function roleOf(el) {
  const r = el.getAttribute('role');
  if (r) return r;
  if (el.tagName === 'A') return 'link';
  if (el.tagName === 'SELECT') return 'select';
  if (el.tagName === 'TEXTAREA') return 'textarea';
  if (el.tagName === 'INPUT') return ['checkbox', 'radio', 'range', 'file', 'number', 'search', 'date'].includes(el.type) ? el.type : 'input';
  if (el.isContentEditable) return 'textbox';
  return 'button';
}

let refs = new Map();

// подпись блока: его заголовок и начало текста
function blockLabel(el) {
  if (el.tagName === 'TABLE') return clean('таблица: ' + [...el.querySelectorAll('th')].map((t) => t.innerText).join(', '), 120);
  const h = clean(el.querySelector(HEADING)?.innerText, 60);
  const all = clean(el.innerText, 140);
  return h && !all.startsWith(h) ? clean(h + ' — ' + all, 140) : all;
}

/** Снимок текущего экрана: адрес, заголовок, кратко текст страницы и все элементы, с которыми можно работать. */
const isDanger = (el, label) => ['button', 'tab', 'option'].includes(roleOf(el)) && DANGER.test(label);

export function snapshot({ textLimit = 1800, max = 220 } = {}) {
  document.querySelectorAll('[data-ai-ref]').forEach((el) => el.removeAttribute('data-ai-ref'));
  refs = new Map();
  const lines = [];
  let n = 0;
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (lines.length >= max) break;
    if (!visible(el)) continue;
    const ref = `e${++n}`;
    el.setAttribute('data-ai-ref', ref);
    refs.set(ref, el);
    const role = roleOf(el);
    const label = labelOf(el);
    // компактная строка вместо объекта: снимок уходит модели после каждого действия
    let s = `${ref} ${role} «${label}»`;
    if (role === 'checkbox' || role === 'radio' || role === 'switch') s += (el.checked ?? el.getAttribute('aria-checked') === 'true') ? ' [отмечено]' : ' [не отмечено]';
    else if (role === 'select') s += ` = «${clean(el.selectedOptions[0]?.text, 60)}» варианты: ${[...el.options].slice(0, 20).map((o) => clean(o.text, 40)).join(' | ')}`;
    else if ('value' in el && role !== 'button' && role !== 'link' && el.value) s += ` = «${clean(el.value, 120)}»`;
    if (role === 'link') s += ` → ${el.getAttribute('href')}`;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s += ' [недоступна]';
    if (el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current')) s += ' [выбрано]';
    if (el.getAttribute('aria-expanded')) s += el.getAttribute('aria-expanded') === 'true' ? ' [раскрыто]' : ' [свёрнуто]';
    if (isDanger(el, label)) s += ' [нужно подтверждение]';
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) s += ' [за экраном]';
    lines.push(s);
  }
  const blocks = [];
  let b = 0;
  for (const el of document.querySelectorAll(BLOCKS)) {
    if (blocks.length >= 45) break;
    if (!visible(el) || el.getBoundingClientRect().height < 24 || el.closest('ul.cards li')) continue;
    if (!blockLabel(el)) continue; // пустой блок (холст, декор) нечем объяснить
    const ref = `b${++b}`;
    el.setAttribute('data-ai-ref', ref);
    refs.set(ref, el);
    const r = el.getBoundingClientRect();
    blocks.push(`${ref} «${blockLabel(el)}»${r.bottom < 0 || r.top > innerHeight ? ' [за экраном]' : ''}`);
  }
  const view = document.getElementById('view');
  return {
    route: location.hash || '#/',
    title: clean(document.querySelector('#view h1, #view h2')?.innerText, 120),
    text: clean(view?.innerText, textLimit),
    elements: lines.join('\n'),
    blocks: blocks.join('\n'),
    note: 'ref действуют до следующего снимка. Элементы «за экраном» можно нажимать сразу — прокрутка не нужна. Блоки (b…) и элементы (e…) выделяй через highlight или tour, когда объясняешь страницу. В подписи блока — его заголовок и текст: говори о блоке только то, что в ней есть.',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ждём, пока экран перестанет меняться после действия (перерисовка, загрузка данных)
async function settle(max = 3500) {
  const view = document.getElementById('view') || document.body;
  let changed = Date.now();
  const mo = new MutationObserver(() => (changed = Date.now()));
  mo.observe(view, { subtree: true, childList: true, attributes: true, characterData: true });
  const start = Date.now();
  await sleep(250);
  while (Date.now() - start < max && (Date.now() - changed < 350 || document.querySelector('#view .spinner'))) await sleep(100);
  mo.disconnect();
}

// значение поля через «родной» сеттер — иначе обработчики, слушающие input, не увидят изменения
function setValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function key(el, k) {
  const opts = { key: k, code: k, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
}

/**
 * Выполнить действие над элементом по ref.
 * name: click | type_text | select_option | set_checkbox | scroll_to | press_key
 * pointTo — функция подлёта аватара к элементу (из assistant.js), чтобы пользователь видел, что нажимается.
 */
export async function act(name, args = {}, pointTo) {
  const el = args.ref ? refs.get(String(args.ref)) : null;
  if (name !== 'press_key' && name !== 'read_screen' && (!el || !el.isConnected)) {
    return { error: `элемент ${args.ref} не найден — экран изменился. Вот новый снимок, возьми ref из него.`, screen: snapshot() };
  }
  if (name === 'read_screen') return { screen: snapshot() };
  if (name === 'highlight') {
    if (pointTo) await pointTo(el, args.caption || '');
    return { ok: `выделено «${clean(el.matches(BLOCKS) ? blockLabel(el) : labelOf(el), 60)}»` };
  }
  const label = el ? labelOf(el) : '';
  if (name === 'click' && isDanger(el, label) && args.confirmed !== true) {
    return { needs_confirmation: true, label, message: `«${label}» меняет данные или тратит вызовы модели. Спроси пользователя и после «да» повтори click с confirmed=true.` };
  }
  if (el && el.disabled) return { error: `«${label}» сейчас недоступна (disabled)`, screen: snapshot() };
  if (el && pointTo) await pointTo(el, args.caption || (name === 'type_text' ? `Ввожу: ${clean(args.text, 40)}` : label ? `Нажимаю «${clean(label, 40)}»` : ''));

  let done;
  if (name === 'click') {
    el.focus?.({ preventScroll: true });
    el.click();
    done = `нажато «${label}»`;
  } else if (name === 'type_text') {
    if (el.tagName === 'SELECT') return { error: 'это выпадающий список — используй select_option' };
    if (el.type === 'file') return { error: 'выбор файла с диска может сделать только пользователь — попроси его нажать кнопку' };
    el.focus();
    if (el.isContentEditable) {
      el.textContent = args.text ?? '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else setValue(el, (args.append ? el.value : '') + String(args.text ?? ''));
    done = `введено в «${label}»`;
    if (args.submit) {
      key(el, 'Enter');
      if (el.form) el.form.requestSubmit?.();
      done += ' и отправлено';
    }
  } else if (name === 'select_option') {
    if (el.tagName !== 'SELECT') return { error: 'это не выпадающий список — нажми на элемент через click' };
    const want = clean(args.option, 80).toLowerCase();
    const opt = [...el.options].find((o) => clean(o.text).toLowerCase() === want || o.value.toLowerCase() === want) || [...el.options].find((o) => clean(o.text).toLowerCase().includes(want));
    if (!opt) return { error: `нет варианта «${args.option}». Варианты: ${[...el.options].map((o) => clean(o.text, 40)).join(' | ')}` };
    setValue(el, opt.value);
    done = `выбрано «${clean(opt.text)}» в «${label}»`;
  } else if (name === 'set_checkbox') {
    const want = args.checked !== false;
    const cur = el.checked ?? el.getAttribute('aria-checked') === 'true';
    if (cur !== want) el.click();
    done = `«${label}»: ${want ? 'отмечено' : 'снято'}`;
  } else if (name === 'scroll_to') {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    done = `показан «${label}»`;
  } else if (name === 'press_key') {
    const target = el || document.activeElement || document.body;
    key(target, String(args.key || 'Escape'));
    done = `нажата клавиша ${args.key || 'Escape'}`;
  } else return { error: `нет такого действия: ${name}` };

  await settle();
  return { ok: done, screen: snapshot() };
}
