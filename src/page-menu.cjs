'use strict';
const { Menu, clipboard } = require('electron');
const { isWebUrl } = require('./navigation.cjs');

function pageMenu(content, params, openTab, activated = () => {}) {
  const items = [];
  const history = content.navigationHistory;
  if (history.canGoBack()) items.push({ label: 'Back', click: () => history.goBack() });
  if (history.canGoForward()) items.push({ label: 'Forward', click: () => history.goForward() });
  items.push({ label: 'Reload', click: () => content.reload() });
  const edit = params.editFlags || {};
  if (edit.canCopy) items.push({ label: 'Copy', click: () => content.copy() });
  if (params.isEditable && edit.canPaste) items.push({ label: 'Paste', click: () => content.paste() });
  if (edit.canSelectAll) items.push({ label: 'Select all', click: () => content.selectAll() });
  if (isWebUrl(params.linkURL)) {
    items.push({ type: 'separator' }, { label: 'Copy link', click: () => clipboard.writeText(params.linkURL) },
      { label: 'Open in new tab', click: () => openTab(params.linkURL) },
      { label: 'Download link', click: () => content.downloadURL(params.linkURL) });
  }
  if (params.mediaType === 'image' && isWebUrl(params.srcURL)) items.push({ label: 'Download image', click: () => content.downloadURL(params.srcURL) });
  return Menu.buildFromTemplate(items.map(item => item.click ? { ...item, click: () => { activated(); item.click(); } } : item));
}
module.exports = { pageMenu };
