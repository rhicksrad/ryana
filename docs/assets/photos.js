// Photo banner for signed-in pages. Photos live in the private "photos" storage bucket
// and are shown through short-lived signed links, so they're never public.
import { sb, q } from './client.js';
import { h, toast } from './shell.js';

const BUCKET = 'photos';
const ROTATE_MS = 9000;
const MAX_SIDE = 1600;
const LINK_SECONDS = 6 * 60 * 60;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const ICON_TRASH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>';
const ICON_NEXT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 3 5 5-5 5"/></svg>';

function greeting(name) {
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name}`;
}

/** Shrink a photo to at most MAX_SIDE px and re-encode as JPEG (keeps uploads small, strips metadata). */
async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not read that image.'))), 'image/jpeg', 0.85));
}

export function initPhotos(el, name) {
  let photos = [];
  let index = 0;
  let timer = null;
  let front = 0;

  const imgs = [0, 1].map(() => h('img', { class: 'hero-img', alt: '', decoding: 'async' }));
  const fileInput = h('input', {
    type: 'file', accept: 'image/*', multiple: true, class: 'hidden',
    onchange: (e) => upload([...e.target.files]).finally(() => { e.target.value = ''; }),
  });
  const addBtn = h('button', { class: 'hero-btn', type: 'button', onclick: () => fileInput.click() }, '+ Add photos');
  const nextBtn = h('button', { class: 'hero-btn icon', type: 'button', 'aria-label': 'Next photo', title: 'Next photo', innerHTML: ICON_NEXT, onclick: () => step(1) });
  const delBtn = h('button', { class: 'hero-btn icon', type: 'button', 'aria-label': 'Remove this photo', title: 'Remove this photo', innerHTML: ICON_TRASH, onclick: removeCurrent });
  const sub = h('p', { class: 'hero-sub' });

  el.replaceChildren(
    ...imgs,
    h('div', { class: 'hero-shade' }),
    h('div', { class: 'hero-text' }, h('p', { class: 'hero-hi' }, greeting(name)), sub),
    h('div', { class: 'hero-actions' }, nextBtn, delBtn, addBtn),
    fileInput,
  );

  function render() {
    const has = photos.length > 0;
    el.classList.toggle('empty', !has);
    nextBtn.classList.toggle('hidden', photos.length < 2);
    delBtn.classList.toggle('hidden', !has);
    sub.textContent = has ? 'Ryan & Ana' : 'Add a few photos of you two. Only you and Ana can see them.';
    if (!has) return imgs.forEach((img) => img.classList.remove('show'));
    // Load the next photo into the hidden image, then cross-fade to it.
    const back = 1 - front;
    const img = imgs[back];
    img.alt = 'Photo of Ryan and Ana';
    img.onload = () => {
      img.classList.add('show');
      if (front !== back) imgs[front].classList.remove('show');
      front = back;
    };
    if (img.src === photos[index].url && img.complete) img.onload(); // same src never fires load again
    else img.src = photos[index].url;
  }

  function step(n) {
    if (!photos.length) return;
    index = (index + n + photos.length) % photos.length;
    render();
    restart();
  }

  function restart() {
    clearInterval(timer);
    if (photos.length > 1 && !reducedMotion) timer = setInterval(() => !document.hidden && step(1), ROTATE_MS);
  }

  async function refresh(showPath) {
    const files = await q(sb.storage.from(BUCKET).list('', { limit: 200, sortBy: { column: 'created_at', order: 'desc' } }));
    const names = files.filter((f) => f.id).map((f) => f.name);
    photos = names.length
      ? (await q(sb.storage.from(BUCKET).createSignedUrls(names, LINK_SECONDS)))
          .filter((s) => s.signedUrl).map((s) => ({ path: s.path, url: s.signedUrl }))
      : [];
    const at = photos.findIndex((p) => p.path === showPath);
    index = at >= 0 ? at : Math.floor(Math.random() * photos.length) || 0;
    render();
    restart();
  }

  async function upload(files) {
    if (!files.length) return;
    addBtn.disabled = true;
    addBtn.textContent = `Adding ${files.length}…`;
    let first = null;
    try {
      for (const file of files) {
        const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        await q(sb.storage.from(BUCKET).upload(path, await shrink(file), { contentType: 'image/jpeg' }));
        first ??= path;
      }
    } catch (err) {
      toast(err.message);
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = '+ Add photos';
    }
    await refresh(first);
  }

  async function removeCurrent() {
    const photo = photos[index];
    if (!photo || !confirm('Remove this photo for both of you?')) return;
    try {
      await q(sb.storage.from(BUCKET).remove([photo.path]));
    } catch (err) {
      toast(err.message);
    }
    await refresh();
  }

  render();
  refresh().catch((err) => toast(err.message));
}
