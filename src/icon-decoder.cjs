'use strict';
const { gunzipSync } = require('node:zlib');
const MAX_ICON_BYTES = 262144;

function isSvg(buffer) {
  let head = buffer.subarray(0, 8192);
  let text;
  if (head[0] === 0xff && head[1] === 0xfe) text = head.toString('utf16le');
  else if (head[0] === 0xfe && head[1] === 0xff) text = Buffer.from(head.subarray(0, head.length - head.length % 2)).swap16().toString('utf16le');
  else text = head.toString('utf8');
  return /^\s*(?:(?:<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*<svg(?:\s|>)/i.test(text);
}

function inlineIcon(address) {
  if (typeof address !== 'string' || address.length > MAX_ICON_BYTES * 3 + 100) return null;
  const match = /^data:(image\/[a-z\d.+-]+)(?:;charset=[\w-]+)?(;base64)?,([\s\S]*)$/i.exec(address);
  if (!match) return null;
  try {
    if (match[2] && !/^[A-Za-z\d+/]*={0,2}$/.test(match[3])) return null;
    const buffer = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]));
    return buffer.length && buffer.length <= MAX_ICON_BYTES ? { buffer, contentType:match[1].toLowerCase(), url:address } : null;
  } catch { return null; }
}

function iconSource(buffer, contentType = '', address = '') {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_ICON_BYTES) return null;
  try {
    // Support SVGZ even when the server omits Content-Encoding. Chromium's
    // network stack already handles ordinary HTTP gzip/brotli responses.
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = gunzipSync(buffer, { maxOutputLength:MAX_ICON_BYTES });
  } catch { return null; }
  let type = contentType.split(';')[0].trim().toLowerCase();
  if (isSvg(buffer) || /\.svgz?(?:[?#]|$)/i.test(address)) type = 'image/svg+xml';
  if (!/^image\/[a-z\d.+-]+$/.test(type)) type = 'application/octet-stream';
  return `data:${type};base64,${buffer.toString('base64')}`;
}

// Serialized into the existing trusted shell, never into a website. SVG is
// loaded only as an image: it is never inserted as markup or a document.
// Chromium's image context disables SVG scripts and external resources.
function rasterizeIcon(source) {
  return new Promise(resolve => {
    const image = new Image(32, 32);
    let finished = false;
    const done = value => {
      if (finished) return;
      finished = true; clearTimeout(timer); image.onload = image.onerror = null; image.src = ''; resolve(value);
    };
    const timer = setTimeout(() => done(null), 4000);
    image.onerror = () => done(null);
    image.onload = async () => {
      let bitmap;
      try {
        if (image.naturalWidth > 8192 || image.naturalHeight > 8192 || image.naturalWidth * image.naturalHeight > 16777216) return done(null);
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
        // A Blob bitmap selects the initial frame of animated raster images.
        // SVG (including viewBox-only icons) falls back to the image decoder.
        try {
          const encoded = source.slice(source.indexOf(',') + 1), bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
          const type = source.slice(5, source.indexOf(';'));
          bitmap = await createImageBitmap(new Blob([bytes], { type }), { resizeWidth:32, resizeHeight:32, resizeQuality:'high' });
        } catch { /* Image supports additional formats and SVG sizing modes. */ }
        if (finished) return;
        context.drawImage(bitmap || image, 0, 0, 32, 32);
        done(canvas.toDataURL('image/png'));
      } catch { done(null); }
      finally { bitmap?.close(); }
    };
    image.src = source;
  });
}
module.exports = { MAX_ICON_BYTES, isSvg, inlineIcon, iconSource, rasterizeIcon };
