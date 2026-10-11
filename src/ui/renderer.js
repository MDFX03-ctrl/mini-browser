'use strict';
const IS_OVERLAY = new URLSearchParams(location.search).has('overlay');
document.documentElement.classList.toggle('overlay-page', IS_OVERLAY);

const $ = (id) => document.getElementById(id);
if (IS_OVERLAY) { $('profile-panel').classList.add('surface'); $('overlays').append($('profile-panel')); }
const address = $('address');
let browserState;
let dirty = false;
let noticeTimer;
let focusFindPending = false;
let currentNotice = '';
let bookmarkSignature = '';
let profileSignature = '';
let profileEdit = null;
let profilePending = false;
let tabSignature = '';
let tabDrag = null;
let suppressTabClick = 0;
let listDrag = null;
let accessSignature = '';
let downloadsSignature = '';
let extrasSignature = '';
let pictureProfileId = null;
let bookmarkEditSignature = '';

function renderBasics(state) {
  $('restore-bar').hidden = IS_OVERLAY || !state.restoreOffer;
  if (state.restoreOffer) $('restore-text').textContent = `Restore ${state.restoreOffer === 1 ? 'your tab' : `your ${state.restoreOffer} tabs`} from last time?`;
  $('update-restart').hidden = !state.updateReady;
  if (state.updateReady) $('update-restart').textContent = `Restart to update to ${state.updateReady}`;
  $('menu-toggle').classList.toggle('update-ready', !!state.updateReady);
  $('fullscreen-notice').hidden = !IS_OVERLAY || !state.fullscreenNotice || !!state.overlay;
  $('find-bar').hidden = !state.find.open || state.overlay !== 'find';
  if (document.activeElement !== $('find-text')) $('find-text').value = state.find.text;
  $('find-count').textContent = state.find.text ? `${state.find.ordinal} / ${state.find.matches}` : '';
  $('find-next').disabled = $('find-previous').disabled = !state.find.text;
  $('zoom-notice').hidden = !state.zoomNotice;
  $('zoom-notice').textContent = `${state.zoomPercent}%`;
  $('downloads-panel').hidden = !state.downloadsPanelOpen;
  $('downloads-toggle').setAttribute('aria-expanded', String(state.downloadsPanelOpen));
  $('downloads-toggle').hidden = !state.downloads.length && !state.downloadsPanelOpen;
  const signature = JSON.stringify(state.downloads);
  if (signature === downloadsSignature) return;
  downloadsSignature = signature;
  const list = $('downloads-list'); list.replaceChildren();
  if (!state.downloads.length) { const empty = document.createElement('p'); empty.textContent = 'No downloads in this window.'; list.append(empty); }
  for (const download of [...state.downloads].reverse()) {
    const row = document.createElement('div'); row.className = 'download-row'; row.dataset.id = download.id;
    const name = document.createElement('strong'); name.textContent = download.name; name.title = download.path;
    const status = document.createElement('span'); status.className = 'download-status';
    status.textContent = download.error || (download.state === 'progressing'
      ? download.total ? `${Math.floor(download.received / download.total * 100)}% · ${Math.round(download.received / 1024)} KB / ${Math.round(download.total / 1024)} KB` : `${Math.round(download.received / 1024)} KB received`
      : download.state === 'completed' ? 'Completed' : download.state === 'cancelled' ? 'Cancelled' : download.state === 'blocked' ? 'Blocked' : 'Download failed');
    row.append(name, status);
    if (download.state === 'progressing') {
      const progress = document.createElement('progress'); progress.max = download.total || 1;
      if (download.total) progress.value = download.received;
      progress.setAttribute('aria-label', download.name + ' progress'); row.append(progress);
    }
    const actions = document.createElement('div'); actions.className = 'download-actions';
    for (const [command, label] of download.state === 'completed' ? [['open', download.confirmationRequired ? 'This type of file can harm your computer — Open anyway' : 'Open file'], ['show', 'Show in folder']] : download.cancellable ? [['cancel', 'Cancel']] : []) {
      const button = document.createElement('button'); button.className = 'text-button'; button.textContent = label;
      button.addEventListener('click', async () => { const result = await window.miniBrowser.download(command, download.id); if (result.confirmationRequired) { download.confirmationRequired = true; downloadsSignature = ''; renderBasics(browserState); } else if (!result.ok) showNotice(result.error); });
      actions.append(button);
    }
    row.append(actions); list.append(row);
  }
}

function renderAccess(state) {
  $('site-permissions').disabled = !state.siteOrigin;
  $('site-permissions').setAttribute('aria-expanded', String(state.sitePanelOpen));
  const prompt = state.permissionPrompt;
  const panel = $('access-panel');
  panel.hidden = !prompt && !state.sitePanelOpen;
  const signature = JSON.stringify([prompt, state.sitePanelOpen, state.siteOrigin, state.sitePermissions, state.permissionError]);
  if (signature === accessSignature) return;
  accessSignature = signature;
  panel.replaceChildren();
  if (panel.hidden) return;
  const heading = document.createElement('strong');
  heading.textContent = prompt ? prompt.kind === 'screen' ? 'Share your screen' : 'Website permission' : 'Site permissions';
  const origin = document.createElement('p'); origin.className = 'permission-origin';
  origin.textContent = prompt?.origin || state.siteOrigin;
  panel.append(heading, origin);
  if (prompt && prompt.origin !== prompt.topOrigin) {
    const embedded = document.createElement('p'); embedded.textContent = `Embedded in ${prompt.topOrigin}`; panel.append(embedded);
  }
  const action = (label, callback, id) => {
    const button = document.createElement('button'); button.className = 'text-button'; button.textContent = label;
    if (id) button.id = id;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { const result = await callback(); if (!result.ok) showNotice(result.error); }
      finally { button.disabled = false; }
    }); return button;
  };
  const actions = document.createElement('div'); actions.className = 'profile-actions';
  if (prompt) {
    const respond = (choice, source, audio) => window.miniBrowser.respondPermission(prompt.id, choice, source, audio);
    if (prompt.kind === 'screen') {
      const sources = document.createElement('div'); sources.className = 'share-sources';
      let selected;
      const share = action('Share', () => respond('share', selected, audio.checked), 'permission-share'); share.disabled = true;
      for (const source of prompt.sources) {
        const button = document.createElement('button'); button.className = 'share-source'; button.dataset.id = source.id;
        const thumbnail = document.createElement('img'); thumbnail.src = source.thumbnail; thumbnail.alt = '';
        const name = document.createElement('span'); name.textContent = source.name; button.append(thumbnail, name);
        button.addEventListener('click', () => {
          selected = source.id; share.disabled = false;
          for (const item of sources.children) item.setAttribute('aria-pressed', String(item === button));
        }); sources.append(button);
      }
      panel.append(sources);
      const audioLabel = document.createElement('label'); audioLabel.className = 'share-audio';
      const audio = document.createElement('input'); audio.type = 'checkbox'; audio.id = 'share-audio';
      audioLabel.append(audio, ' Also share system audio'); audioLabel.hidden = !prompt.audioRequested;
      panel.append(audioLabel);
      actions.append(share, action('Cancel', () => respond('dismiss'), 'permission-dismiss'));
    } else {
      const message = document.createElement('p'); message.textContent = `Allow access to: ${prompt.labels.join(', ')}?`; panel.append(message);
      actions.append(action('Allow', () => respond('allow'), 'permission-allow'), action('Block', () => respond('block'), 'permission-block'), action('Not now', () => respond('dismiss'), 'permission-dismiss'));
    }
  } else {
    for (const entry of state.sitePermissions) {
      const row = document.createElement('label'); row.className = 'permission-row';
      const text = document.createElement('span'); text.textContent = entry.label;
      if (entry.origin !== state.siteOrigin) { const frame = document.createElement('small'); frame.textContent = entry.origin; text.append(frame); }
      const select = document.createElement('select'); select.dataset.permission = entry.permission; select.setAttribute('aria-label', `${entry.label}: ${entry.origin}`);
      for (const value of ['ask', 'allow', 'block']) { const option = document.createElement('option'); option.value = value; option.textContent = value === 'ask' ? 'Ask' : value === 'allow' ? 'Allow' : 'Block'; select.append(option); }
      select.value = entry.state;
      select.addEventListener('change', async () => { const result = await window.miniBrowser.updatePermission('set', entry.origin, entry.permission, select.value); if (!result.ok) { showNotice(result.error); accessSignature = ''; renderAccess(browserState); } });
      row.append(text, select); panel.append(row);
    }
    const help = document.createElement('p'); help.textContent = 'Changes reload this site to stop active access. Screen sharing always asks you to choose a source.'; panel.append(help);
    if (state.permissionError) { const error = document.createElement('p'); error.textContent = state.permissionError; panel.append(error); }
    actions.append(action('Reset this site', () => window.miniBrowser.updatePermission('reset'), 'permission-reset'), action('Close', () => window.miniBrowser.sitePanel(false), 'permission-close'));
  }
  panel.append(actions);
}

function reorderHandle(card, kind, key) {
  const handle = document.createElement('button');
  handle.className = 'reorder-handle';
  handle.textContent = '⠿';
  handle.title = 'Drag to reorder (Alt+↑ / Alt+↓)';
  handle.setAttribute('aria-label', 'Reorder ' + kind);
  handle.draggable = true;
  const order = () => kind === 'profile' ? browserState.profiles.map(p => p.id) : browserState.bookmarks.map(b => b.url);
  const save = async (keys) => {
    const result = await (kind === 'profile' ? window.miniBrowser.reorderProfiles(keys) : window.miniBrowser.reorderBookmarks(keys));
    if (!result.ok) showNotice(result.error);
  };
  card.draggable = true;
  card.addEventListener('dragstart', (event) => {
    listDrag = { kind, key, profile: browserState.activeProfile.id };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', kind);
    event.dataTransfer.setDragImage(card, 12, 12);
  });
  card.addEventListener('dragend', () => { listDrag = null; document.querySelectorAll('.drop-before').forEach(c => c.classList.remove('drop-before')); });
  card.addEventListener('dragover', (event) => {
    if (listDrag?.kind !== kind || listDrag.profile !== browserState.activeProfile.id) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; card.classList.add('drop-before');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drop-before'));
  card.addEventListener('drop', (event) => {
    card.classList.remove('drop-before');
    if (listDrag?.kind !== kind || listDrag.profile !== browserState.activeProfile.id) return;
    event.preventDefault();
    const keys = order(), from = keys.indexOf(listDrag.key), to = keys.indexOf(key);
    listDrag = null;
    if (from < 0 || to < 0 || from === to) return;
    keys.splice(to, 0, keys.splice(from, 1)[0]); save(keys);
  });
  handle.addEventListener('keydown', (event) => {
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const keys = order(), from = keys.indexOf(key), to = from + (event.key === 'ArrowUp' ? -1 : 1);
    if (to >= 0 && to < keys.length) { keys.splice(to, 0, keys.splice(from, 1)[0]); save(keys); }
  });
  return handle;
}

function tabPointerDown(event, tab, select) {
  if (event.button !== 0 || tabDrag) return;
  tabDrag = { id: tab.id, pointer: event.pointerId, x: event.clientX, y: event.clientY, element: select, started: false };
  select.setPointerCapture(event.pointerId);
}
document.addEventListener('pointermove', (event) => {
  if (!tabDrag || event.pointerId !== tabDrag.pointer || tabDrag.started) return;
  if (Math.hypot(event.clientX - tabDrag.x, event.clientY - tabDrag.y) < 6) return;
  tabDrag.started = true;
  tabDrag.element.closest('.tab-card').classList.add('dragging');
  document.body.classList.add('tab-dragging');
  tabDrag.request = window.miniBrowser.startTabDrag(tabDrag.id);
});
async function endTabPointer(cancel = false) {
  const drag = tabDrag;
  if (!drag) return;
  if (drag.started) suppressTabClick = Date.now() + 500;
  if (drag.element.hasPointerCapture(drag.pointer)) drag.element.releasePointerCapture(drag.pointer);
  if (!drag.started) { tabDrag = null; return; }
  try {
    if (drag.started) {
      const result = await drag.request;
      if (!result.ok) throw new Error(result.error);
      const finished = await window.miniBrowser.endTabDrag(result.token, cancel);
      if (!finished.ok) throw new Error(finished.error);
    }
  } catch (error) { showNotice(error.message); }
  finally {
    if (tabDrag === drag) tabDrag = null;
    document.body.classList.remove('tab-dragging');
    tabSignature = '';
    if (browserState) renderTabs(browserState);
  }
}
document.addEventListener('pointerup', () => endTabPointer());
document.addEventListener('pointercancel', () => endTabPointer(true));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && tabDrag) { event.preventDefault(); endTabPointer(true); } });

function renderTabs(state) {
  if (tabDrag) return;
  const signature = JSON.stringify([state.tabs, state.activeTabId]);
  if (signature === tabSignature) return;
  tabSignature = signature;
  const focused = document.activeElement;
  const focusedId = focused?.closest('.tab-card')?.dataset.id;
  const focusedClose = focused?.classList.contains('tab-close');
  $('tabs').replaceChildren(...state.tabs.map((tab) => {
    const card = document.createElement('div');
    card.className = 'tab-card';
    card.dataset.id = tab.id;
    card.classList.toggle('active', tab.id === state.activeTabId);
    card.classList.toggle('pinned', tab.pinned);
    card.addEventListener('contextmenu', event => { event.preventDefault(); window.miniBrowser.ui('tab-menu', tab.id); });
    const select = document.createElement('button');
    select.className = 'tab-select';
    select.setAttribute('role', 'tab');
    select.setAttribute('aria-selected', String(tab.id === state.activeTabId));
    select.tabIndex = tab.id === state.activeTabId ? 0 : -1;
    if (tab.icon) { const icon = document.createElement('img'); icon.src = tab.icon; icon.alt = ''; icon.className = 'tab-favicon'; select.append(icon); }
    else { const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', tab.mode === 'welcome' ? '#window-icon' : '#globe'); icon.append(use); select.append(icon); }
    const label = document.createElement('span'); label.className = 'tab-label';
    label.textContent = `${tab.loading ? '◦ ' : ''}${tab.title || (tab.mode === 'welcome' ? 'New tab' : tab.url || 'Website')}${tab.muted ? ' · Muted' : tab.audible ? ' · Playing' : ''}`;
    select.append(label);
    select.title = tab.title || tab.url || 'New tab';
    select.addEventListener('pointerdown', (event) => tabPointerDown(event, tab, select));
    select.addEventListener('click', () => { if (Date.now() >= suppressTabClick) window.miniBrowser.selectTab(tab.id); });
    select.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = state.tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? state.tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + state.tabs.length) % state.tabs.length;
      window.miniBrowser.selectTab(state.tabs[next].id).then(() => $('tabs').querySelector('[aria-selected="true"]')?.focus());
    });
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab (Ctrl+W)';
    close.setAttribute('aria-label', `Close tab: ${tab.title || 'New tab'}`);
    close.addEventListener('click', () => window.miniBrowser.closeTab(tab.id));
    card.addEventListener('auxclick', (event) => {
      if (event.button === 1) { event.preventDefault(); window.miniBrowser.closeTab(tab.id); }
    });
    card.append(select, close);
    return card;
  }));
  const active = [...$('tabs').children].find((card) => card.dataset.id === state.activeTabId);
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (focusedId) {
    const card = [...$('tabs').children].find((card) => card.dataset.id === focusedId) || active;
    card?.querySelector(focusedClose ? '.tab-close' : '.tab-select')?.focus({ preventScroll: true });
  }
}

function renderProfiles(state) {
  const toggle = $('profile-toggle');
  if (toggle.dataset.picture !== (state.activeProfile.picture || '') || toggle.dataset.name !== state.activeProfile.name) {
    toggle.dataset.picture = state.activeProfile.picture || ''; toggle.dataset.name = state.activeProfile.name;
    toggle.textContent = state.activeProfile.name.slice(0, 1).toUpperCase();
    if (state.activeProfile.picture) { const image = document.createElement('img'); image.src = state.activeProfile.picture; image.alt = ''; toggle.replaceChildren(image); }
  }
  $('profile-toggle').title = `Profile: ${state.activeProfile.name}`;
  $('profile-toggle').setAttribute('aria-label', `Browser profiles: ${state.activeProfile.name}`);
  const signature = JSON.stringify([state.profiles, state.activeProfile.id, state.openProfiles, profilePending]);
  if (signature !== profileSignature) {
    profileSignature = signature;
    $('profile-list').replaceChildren(...state.profiles.map((profile) => {
      const card = document.createElement('div');
      card.className = 'profile-card'; card.dataset.id = profile.id;
      card.classList.toggle('current', profile.id === state.activeProfile.id);
      const open = document.createElement('button'); open.className = 'profile-open'; open.disabled = profilePending;
      const name = document.createElement('strong'); name.textContent = profile.name;
      const status = document.createElement('small');
      status.textContent = profile.id === state.activeProfile.id ? 'This window' : state.openProfiles.includes(profile.id) ? 'Already open' : 'Open in new window';
      open.append(name, status);
      open.addEventListener('click', () => profileRequest(() => window.miniBrowser.switchProfile(profile.id), true));
      const portrait = document.createElement('div'); portrait.className = 'profile-portrait';
      const picture = document.createElement('button'); picture.className = 'profile-picture'; picture.disabled = profilePending;
      picture.title = `${profile.picture ? 'Change' : 'Add'} profile picture: ${profile.name}`; picture.setAttribute('aria-label', picture.title);
      picture.textContent = profile.name.slice(0, 1).toUpperCase();
      if (profile.picture) { const image = document.createElement('img'); image.src = profile.picture; image.alt = ''; picture.replaceChildren(image); }
      picture.addEventListener('click', () => { pictureProfileId = profile.id; $('profile-picture-file').value = ''; $('profile-picture-file').click(); });
      portrait.append(picture);
      if (profile.picture) {
        const remove = document.createElement('button'); remove.className = 'profile-picture-remove'; remove.textContent = '×';
        remove.title = `Remove profile picture: ${profile.name}`; remove.setAttribute('aria-label', remove.title); remove.disabled = profilePending;
        remove.addEventListener('click', () => profileRequest(() => window.miniBrowser.setProfilePicture(profile.id, null))); portrait.append(remove);
      }
      card.append(reorderHandle(card, 'profile', profile.id), portrait, open);
      for (const command of ['rename', 'delete']) {
        const button = document.createElement('button'); button.className = 'profile-edit profile-' + command;
        button.textContent = command === 'rename' ? '✎' : '×'; button.title = `${command === 'rename' ? 'Rename' : 'Delete'} ${profile.name}`;
        button.setAttribute('aria-label', button.title);
        button.disabled = profilePending || (command === 'delete' && state.profiles.length === 1);
        button.addEventListener('click', () => editProfile(command, profile)); card.append(button);
      }
      return card;
    }));
  }
}

$('profile-picture-file').addEventListener('change', async event => {
  const file = event.target.files[0], id = pictureProfileId; pictureProfileId = null;
  if (!file || !id) return;
  let bitmap;
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('Choose a PNG, JPEG, or WebP image smaller than 10 MB.');
    bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const side = Math.min(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 128, 128);
    await profileRequest(() => window.miniBrowser.setProfilePicture(id, canvas.toDataURL('image/png')));
  } catch (error) { $('profile-error').textContent = error.message || 'This image could not be opened.'; $('profile-error').hidden = false; }
  finally { bitmap?.close(); }
});

function resetProfileForm() {
  profileEdit = null;
  $('profile-form').hidden = true;
  $('profile-confirm').hidden = true;
  $('profile-error').hidden = true;
}

async function setProfilePanel(open) {
  if (profilePending) return;
  resetProfileForm();
  await window.miniBrowser.profilePanel(open);
  if (!open && !IS_OVERLAY) $('profile-toggle').focus();
}

async function profileRequest(request, close = false) {
  if (profilePending) return;
  profilePending = true;
  const controls = [...$('profile-panel').querySelectorAll('button, input, select')];
  controls.forEach((control) => { control.disabled = true; });
  try {
    const result = await request();
    if (!result.ok) throw new Error(result.error);
    resetProfileForm();
    // Explicitly refresh even when a profile command does not navigate.
    render(await window.miniBrowser.getState());
    profilePending = false;
    if (close) await setProfilePanel(false);
  } catch (error) {
    $('profile-error').textContent = error.message;
    $('profile-error').hidden = false;
  } finally {
    profilePending = false;
    controls.forEach((control) => { control.disabled = false; });
    if (browserState) renderProfiles(browserState);
  }
}

function renderBookmarks(items) {
  const signature = JSON.stringify(items);
  if (signature === bookmarkSignature) return;
  bookmarkSignature = signature;
  const list = $('bookmarks-list');
  list.replaceChildren();
  $('bookmark-bar').replaceChildren();
  $('bookmarks-empty').hidden = items.length > 0;
  $('welcome').classList.toggle('has-bookmarks', items.length > 0);
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'bookmark-card';
    const open = document.createElement('button');
    open.className = 'bookmark-open';
    open.title = item.url;
    const monogram = document.createElement('span');
    monogram.className = 'bookmark-monogram';
    monogram.textContent = new URL(item.url).hostname.replace(/^www\./, '').slice(0, 1).toUpperCase();
    monogram.setAttribute('aria-hidden', 'true');
    if (item.icon) {
      const icon = document.createElement('img'); icon.src = item.icon; icon.alt = ''; icon.width = 24; icon.height = 24;
      icon.addEventListener('error', () => { monogram.textContent = new URL(item.url).hostname.replace(/^www\./, '').slice(0, 1).toUpperCase(); }, { once: true });
      monogram.replaceChildren(icon);
    }
    const details = document.createElement('span');
    details.className = 'bookmark-details';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const host = document.createElement('span');
    host.textContent = new URL(item.url).hostname;
    details.append(title, host);
    open.append(monogram, details);
    open.addEventListener('click', async () => {
      const result = await window.miniBrowser.navigate(item.url);
      if (!result.ok) showNotice(result.error);
    });
    const remove = document.createElement('button');
    remove.className = 'bookmark-remove';
    remove.textContent = '×';
    remove.title = `Remove ${item.title}`;
    remove.setAttribute('aria-label', `Remove bookmark: ${item.title}`);
    remove.addEventListener('click', async () => {
      const result = await window.miniBrowser.removeBookmark(item.url);
      if (!result.ok) showNotice(result.error);
    });
    card.dataset.url = item.url;
    const contextMenu = event => { event.preventDefault(); window.miniBrowser.ui('bookmark-menu', { url:item.url, x:event.clientX, y:event.clientY }); };
    card.addEventListener('contextmenu', contextMenu);
    card.append(reorderHandle(card, 'bookmark', item.url), open, remove);
    list.append(card);
    const bar = document.createElement('div'); bar.className = 'bookmark-bar-card'; bar.dataset.url = item.url;
    bar.addEventListener('contextmenu', contextMenu);
    const barOpen = document.createElement('button'); barOpen.className = 'bookmark-open'; barOpen.title = item.url;
    const barIcon = monogram.cloneNode(true), barTitle = document.createElement('strong'); barTitle.textContent = item.title;
    barOpen.append(barIcon, barTitle); barOpen.addEventListener('click', () => window.miniBrowser.navigate(item.url));
    bar.append(barOpen, reorderHandle(bar, 'bookmark', item.url)); $('bookmark-bar').append(bar);
  }
}

function focusAddress() {
  address.focus();
  address.select();
}

function showNotice(message) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = !message;
  if (message) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 5000);
}

function render(state) {
  if (browserState?.overlay !== state.overlay && (state.overlay === 'profiles' || browserState?.overlay === 'profiles')) resetProfileForm();
  if (browserState?.activeProfile.id !== state.activeProfile.id || browserState?.activeTabId !== state.activeTabId) {
    dirty = false;
    closeBookmarkForm();
  }
  browserState = state;
  let insecure = false;
  try {
    const address = new URL(state.url);
    const host = address.hostname.toLowerCase();
    const local = host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
    insecure = address.protocol === 'http:' && !local;
  } catch {}
  $('site-permissions').querySelector('svg').hidden = false;
  $('site-permissions').querySelector('svg use').setAttribute('href', insecure ? '#warning' : '#globe');
  $('site-permissions').title = insecure ? 'Not secure — Site permissions' : 'Site permissions';
  $('site-permissions').setAttribute('aria-label', insecure ? 'Not secure. Site permissions' : 'Site permissions');
  if (document.activeElement !== address || !dirty) address.value = state.url;
  $('back').disabled = !state.canGoBack;
  $('forward').disabled = !state.canGoForward;
  $('reload').disabled = state.mode === 'welcome';
  $('reload').setAttribute('aria-label', state.loading ? 'Stop loading' : 'Reload');
  $('reload').title = state.loading ? 'Stop loading (Esc)' : 'Reload (Ctrl+R)';
  $('reload-icon').setAttribute('href', state.loading ? '#stop' : '#refresh');
  $('pin').setAttribute('aria-pressed', String(state.pinned));
  $('pin').title = state.pinned ? 'Unpin from top (Ctrl+Shift+P)' : 'Keep on top (Ctrl+Shift+P)';
  $('pin').setAttribute('aria-label', state.pinned ? 'Unpin from top' : 'Keep on top');
  $('loading').hidden = !state.loading;
  $('welcome').hidden = state.mode !== 'welcome';
  $('error').hidden = state.mode !== 'error';
  $('error-detail').textContent = state.error;
  $('bookmark').disabled = !state.canBookmark;
  $('bookmark').setAttribute('aria-pressed', String(state.bookmarked));
  $('bookmark').title = state.bookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
  $('bookmark').setAttribute('aria-label', state.bookmarked ? 'Remove bookmark' : 'Bookmark this page');
  renderBookmarks(state.bookmarks);
  renderProfiles(state);
  renderTabs(state);
  renderAccess(state);
  renderBasics(state);
  if (focusFindPending && state.find.open && state.overlay === 'find') { focusFindPending = false; $('find-text').focus(); $('find-text').select(); }
  renderExtras(state);
  if (IS_OVERLAY) requestAnimationFrame(measureOverlay);
  $('chrome').hidden = !state.chromeVisible;
  document.body.classList.toggle('controls-hidden', !state.chromeVisible);
  document.body.style.setProperty('--chrome-height', `${state.chromeVisible ? state.chromeHeight + state.panelHeight : 0}px`);
  document.body.style.setProperty('--toolbar-height', `${state.chromeHeight}px`);
  $('bookmark-bar').hidden = !state.bookmarkBar || !state.bookmarks.length;
  $('hide-ui').setAttribute('aria-pressed', String(state.autoHide));
  $('hide-ui').setAttribute('aria-label', state.autoHide ? 'Show browser controls' : 'Auto-hide browser controls');
  $('hide-ui').title = state.autoHide ? 'Show controls (Ctrl+Shift+H / Esc)' : 'Auto-hide controls (Ctrl+Shift+H)';
  $('window-title').textContent = state.title || 'Mini Browser';
  $('maximize').title = state.maximized ? 'Restore window' : 'Maximize';
  $('maximize').setAttribute('aria-label', $('maximize').title);
  $('profile-panel').hidden = !IS_OVERLAY || !state.profilePanelOpen;
  $('profile-toggle').setAttribute('aria-expanded', String(state.profilePanelOpen));
  if (state.mode !== 'welcome') closeBookmarkForm();
  if (state.notice !== currentNotice) {
    currentNotice = state.notice;
    showNotice(state.notice);
  }
}

$('address-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const selected = browserState.overlay === 'suggestions' && browserState.suggestions[browserState.suggestionIndex];
  const result = await window.miniBrowser.navigate(selected ? selected.url : address.value);
  if (!result.ok) return showNotice(result.error);
  dirty = false;
  address.blur();
  if (browserState) render(browserState);
});
function requestSuggestions(input) {
  const rect = input.closest('form').getBoundingClientRect();
  return window.miniBrowser.suggest(input.value, { x: rect.x, y: rect.bottom, width: rect.width });
}
address.addEventListener('input', () => { dirty = true; requestSuggestions(address); });
address.addEventListener('focus', () => { dirty = false; });
address.addEventListener('keydown', (event) => {
  if (['ArrowDown', 'ArrowUp'].includes(event.key) && browserState?.suggestions.length) {
    event.preventDefault(); window.miniBrowser.ui('suggest-select', browserState.suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1));
  }
  if (event.key === 'Escape') {
    dirty = false;
    address.value = browserState?.url || '';
    address.blur();
    window.miniBrowser.ui('close');
  }
});
for (const name of ['back', 'forward', 'reload', 'pin', 'retry', 'home', 'bookmark', 'minimize', 'maximize']) {
  $(name).addEventListener('click', () => window.miniBrowser[name]());
}
$('hide-ui').addEventListener('click', () => window.miniBrowser.toggleUI());
$('site-permissions').addEventListener('click', () => window.miniBrowser.sitePanel(!browserState.sitePanelOpen));
$('close-window').addEventListener('click', () => window.miniBrowser.close());
$('error-home').addEventListener('click', () => window.miniBrowser.home());
function closeBookmarkForm() {
  $('bookmark-form').hidden = true;
  $('bookmark-error').hidden = true;
  $('welcome').classList.remove('adding-bookmark');
}
$('add-bookmark').addEventListener('click', () => {
  $('bookmark-form').reset();
  $('bookmark-error').hidden = true;
  $('bookmark-form').hidden = false;
  $('welcome').classList.add('adding-bookmark');
  $('bookmark-url').focus();
});
$('cancel-bookmark').addEventListener('click', () => {
  closeBookmarkForm();
  $('add-bookmark').focus();
});
$('bookmark-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await window.miniBrowser.addBookmark($('bookmark-url').value, $('bookmark-name').value);
  if (!result.ok) {
    $('bookmark-error').textContent = result.error;
    $('bookmark-error').hidden = false;
    return;
  }
  closeBookmarkForm();
  $('add-bookmark').focus();
});
$('start-address').addEventListener('input', () => requestSuggestions($('start-address')));
document.querySelector('.bookmarks-section').addEventListener('wheel', event => {
  const strip = event.currentTarget;
  if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  const before = strip.scrollLeft; strip.scrollLeft += event.deltaY;
  if (strip.scrollLeft !== before) event.preventDefault();
}, { passive:false });
$('start-address').addEventListener('keydown', event => {
  if (['ArrowDown', 'ArrowUp'].includes(event.key) && browserState?.suggestions.length) { event.preventDefault(); window.miniBrowser.ui('suggest-select', browserState.suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1)); }
});
$('start-form').addEventListener('submit', async event => {
  event.preventDefault(); const selected = browserState.overlay === 'suggestions' && browserState.suggestions[browserState.suggestionIndex];
  const result = await window.miniBrowser.navigate(selected ? selected.url : $('start-address').value);
  if (!result.ok) showNotice(result.error); else $('start-address').value = '';
});
$('new-tab').addEventListener('click', () => window.miniBrowser.newTab());
document.addEventListener('focusin', (event) => {
  if (event.target.matches('input, select')) window.miniBrowser.holdChrome(true);
});
document.addEventListener('focusout', () => {
  queueMicrotask(() => window.miniBrowser.holdChrome(document.activeElement?.matches('input, select') || false));
});
$('notice').addEventListener('click', () => showNotice(''));
$('profile-toggle').addEventListener('click', () => setProfilePanel(!browserState.profilePanelOpen));
$('profile-close').addEventListener('click', () => setProfilePanel(false));
function editProfile(command, profile) {
  resetProfileForm();
  profileEdit = { command, id: profile?.id };
  if (command === 'delete') {
    $('profile-delete-message').textContent = `Delete “${profile.name}” and its cookies, site data, and bookmarks? Its open windows will close.`;
    $('profile-confirm').hidden = false;
    $('profile-delete-confirm').focus();
    return;
  }
  $('profile-name-label').textContent = command === 'new' ? 'New profile name' : 'Profile name';
  $('profile-name').value = command === 'new' ? '' : profile.name;
  $('profile-form').hidden = false;
  $('profile-name').focus(); $('profile-name').select();
}
$('profile-new').addEventListener('click', () => editProfile('new'));
$('profile-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!profileEdit) return;
  const { command, id } = profileEdit;
  const name = $('profile-name').value;
  profileRequest(() => command === 'new' ? window.miniBrowser.createProfile(name) : window.miniBrowser.renameProfile(id, name), true);
});
$('profile-cancel').addEventListener('click', resetProfileForm);
$('profile-delete-confirm').addEventListener('click', () => {
  if (profileEdit) profileRequest(() => window.miniBrowser.deleteProfile(profileEdit.id), true);
});
$('profile-delete-cancel').addEventListener('click', resetProfileForm);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('profile-panel').hidden) setProfilePanel(false);
});
window.miniBrowser.onState(render);
$('update-restart').addEventListener('click', () => window.miniBrowser.installUpdate());
$('restore-tabs').addEventListener('click', () => window.miniBrowser.restoreTabs());
$('restore-dismiss').addEventListener('click', () => window.miniBrowser.dismissRestore());
window.miniBrowser.onFocusAddress(focusAddress);
window.miniBrowser.onFocusFind(() => {
  focusFindPending = true;
  if (browserState?.find.open && browserState.overlay === 'find') { focusFindPending = false; $('find-text').focus(); $('find-text').select(); }
});
$('find-text').addEventListener('input', () => window.miniBrowser.find('text', $('find-text').value));
$('find-bar').addEventListener('submit', event => { event.preventDefault(); window.miniBrowser.find('next'); });
$('find-text').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); window.miniBrowser.find(event.shiftKey ? 'previous' : 'next'); }
});
$('find-previous').addEventListener('click', () => window.miniBrowser.find('previous'));
$('find-close').addEventListener('click', () => window.miniBrowser.find('close'));
$('downloads-toggle').addEventListener('click', () => window.miniBrowser.downloadsPanel(!browserState.downloadsPanelOpen));
$('downloads-close').addEventListener('click', () => window.miniBrowser.downloadsPanel(false));
window.miniBrowser.getState().then(render);
let measuredPanelHeight = -1;
new ResizeObserver(() => {
  const height = Math.ceil($('browser-panels').getBoundingClientRect().height);
  if (height !== measuredPanelHeight) {
    measuredPanelHeight = height;
    window.miniBrowser.profilePanel(undefined, height);
  }
}).observe($('browser-panels'));

function button(label, callback, className = 'text-button') {
  const node = document.createElement('button'); node.textContent = label; node.className = className;
  node.addEventListener('click', async () => { const result = await callback(); if (result?.ok === false) showNotice(result.error); });
  return node;
}
function renderExtras(state) {
  $('bookmark-menu').hidden = state.overlay !== 'bookmark-menu';
  $('bookmark-edit-form').hidden = state.overlay !== 'bookmark-edit';
  const editSignature = state.overlay === 'bookmark-edit' ? JSON.stringify(state.bookmarkEdit) : '';
  if (editSignature !== bookmarkEditSignature) {
    bookmarkEditSignature = editSignature; $('bookmark-edit-error').hidden = true;
    if (state.bookmarkEdit && editSignature) {
      $('bookmark-edit-name').value = state.bookmarkEdit.title; $('bookmark-edit-url').value = state.bookmarkEdit.url;
      if (IS_OVERLAY) requestAnimationFrame(() => { $('bookmark-edit-name').focus(); $('bookmark-edit-name').select(); });
    }
  }
  $('app-menu').hidden = state.overlay !== 'menu';
  $('menu-toggle').setAttribute('aria-expanded', String(state.overlay === 'menu'));
  $('bookmark-bar-toggle').checked = state.bookmarkBar;
  $('menu-zoom').textContent = state.zoomPercent + '%';
  $('password-fill-toggle').hidden = !state.passwordOffer.length;
  $('address').setAttribute('aria-expanded', String(state.overlay === 'suggestions'));
  $('suggestions').hidden = state.overlay !== 'suggestions';
  $('password-prompt').hidden = state.overlay !== 'password' || !state.passwordPrompt;
  $('clear-data-form').hidden = state.overlay !== 'clear';
  $('clear-profile').textContent = 'Profile: ' + state.activeProfile.name;
  if (state.passwordPrompt) { $('password-site').textContent = state.passwordPrompt.origin; $('password-user').textContent = state.passwordPrompt.username || 'This login'; }
  const library = ['history', 'bookmarks', 'passwords', 'fill'].includes(state.overlay);
  $('library-panel').hidden = !library;
  const signature = JSON.stringify([state.overlay, state.suggestions, state.suggestionIndex, state.history, state.passwords, state.passwordOffer, state.bookmarks]);
  if (signature === extrasSignature) return; extrasSignature = signature;
  $('suggestions').replaceChildren(...state.suggestions.map((item, index) => {
    const row = button('', () => window.miniBrowser.navigate(item.url), 'suggestion'); row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === state.suggestionIndex));
    if (item.icon) { const icon = document.createElement('img'); icon.src = item.icon; icon.alt = ''; row.append(icon); }
    const text = document.createElement('span'), title = document.createElement('strong'), url = document.createElement('small');
    title.textContent = item.title; url.textContent = item.url; text.append(title, url); row.append(text); return row;
  }));
  if (!library) return;
  $('library-title').textContent = { history: 'History', bookmarks: 'Bookmarks', passwords: 'Passwords', fill: 'Fill saved login' }[state.overlay];
  const list = $('library-list'); list.replaceChildren();
  const items = state.overlay === 'history' ? state.history : state.overlay === 'bookmarks' ? state.bookmarks : state.overlay === 'fill' ? state.passwordOffer : state.passwords;
  if (!items.length) { const empty = document.createElement('p'); empty.textContent = 'No entries in this profile.'; list.append(empty); }
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'library-row'; row.dataset.id = item.id || item.url;
    if (state.overlay === 'history' || state.overlay === 'bookmarks') {
      row.append(button(item.title || item.url, () => window.miniBrowser.navigate(item.url), 'library-open'));
      const detail = document.createElement('small'); detail.textContent = item.url + (item.visited ? ' · ' + new Date(item.visited).toLocaleString() : ''); row.append(detail);
      if (state.overlay === 'bookmarks') row.append(button('Remove', () => window.miniBrowser.removeBookmark(item.url)));
    } else {
      const name = document.createElement('strong'); name.textContent = item.username || 'No username';
      const origin = document.createElement('small'); origin.textContent = item.origin; row.append(name, origin);
      if (state.overlay === 'fill') row.append(button('Fill', () => window.miniBrowser.password('fill', item.id), 'primary-button'));
      else {
        row.append(button('Show', async () => {
          if (!window.confirm('Show this saved password?')) return { ok: false };
          const result = await window.miniBrowser.password('show', item.id);
          if (result.ok) { let field = row.querySelector('input'); if (!field) { field = document.createElement('input'); field.readOnly = true; field.setAttribute('aria-label', 'Saved password'); row.append(field); } field.value = result.password; }
          return result;
        }), button('Copy', () => window.confirm('Copy this saved password to the clipboard?')
          ? window.miniBrowser.password('copy', item.id) : Promise.resolve({ ok: false })), button('Delete', () => window.miniBrowser.password('delete', item.id)));
      }
    }
    list.append(row);
  }
}
$('bookmark-edit-open').addEventListener('click', () => window.miniBrowser.ui('bookmark-edit', browserState.bookmarkEdit?.url));
$('bookmark-edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const result = await window.miniBrowser.editBookmark(browserState.bookmarkEdit?.url, $('bookmark-edit-url').value, $('bookmark-edit-name').value);
  if (!result.ok) { $('bookmark-edit-error').textContent = result.error; $('bookmark-edit-error').hidden = false; }
});
$('menu-toggle').addEventListener('click', () => window.miniBrowser.ui('menu'));
$('bookmark-bar-toggle').addEventListener('change', () => window.miniBrowser.ui('bookmark-bar', $('bookmark-bar-toggle').checked));
document.querySelectorAll('[data-ui]').forEach(node => node.addEventListener('click', async () => {
  const action = node.dataset.ui;
  if (action === 'new' || action === 'reopen') { await window.miniBrowser.ui('close'); window.miniBrowser.tab(action === 'new' ? 'new' : 'reopen'); }
  else window.miniBrowser.ui(action);
}));
document.querySelectorAll('[data-zoom]').forEach(node => node.addEventListener('click', () => window.miniBrowser.zoom(node.dataset.zoom)));
$('password-fill-toggle').addEventListener('click', () => window.miniBrowser.ui('fill'));
$('password-save').addEventListener('click', async () => { const result = await window.miniBrowser.password('save'); if (!result.ok) showNotice(result.error); });
for (const id of ['password-dismiss', 'password-not-now']) $(id).addEventListener('click', () => window.miniBrowser.password('dismiss'));
$('clear-data-form').addEventListener('submit', async event => {
  event.preventDefault(); const choices = {};
  for (const key of ['history', 'cache', 'cookies', 'passwords']) choices[key] = $('clear-data-form').elements[key].checked;
  const result = await window.miniBrowser.clearData(choices);
  $('clear-error').hidden = result.ok; $('clear-error').textContent = result.error || '';
});
function measureOverlay() {
  // Measure the surface itself: the scrolling container is capped by the current
  // native view height and cannot tell us how tall a newly opened menu needs to be.
  const height = [...$('overlays').children].filter(node => !node.hidden)
    .reduce((total, node) => total + node.getBoundingClientRect().height, 6);
  window.miniBrowser.ui('size', Math.ceil(height));
}
if (IS_OVERLAY) {
  const observer = new ResizeObserver(measureOverlay);
  for (const id of ['overlays', 'profile-panel', 'bookmark-edit-form']) observer.observe($(id));
}
document.addEventListener('keydown', event => {
  if (IS_OVERLAY && !event.altKey && !event.ctrlKey && !event.metaKey && !event.target.matches('input,textarea,select') && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    const buttons = [...document.querySelectorAll(browserState.overlay === 'profiles' ? '#profile-list .profile-open' : '#app-menu button')].filter(node => !node.disabled);
    const index = buttons.indexOf(document.activeElement);
    if (['menu', 'profiles'].includes(browserState.overlay)) { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
  }
});
