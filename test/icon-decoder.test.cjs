'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const { MAX_ICON_BYTES, iconSource, inlineIcon, isSvg } = require('../src/icon-decoder.cjs');

test('SVG bytes override wrong MIME types and SVGZ expands only within the icon budget', () => {
  const svg = Buffer.from('\ufeff<?xml version="1.0"?><!-- icon --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M0 0h32v32H0z"/></svg>');
  assert.equal(isSvg(svg),true);
  assert.equal(isSvg(Buffer.from('<!DOCTYPE html><html><svg></svg></html>')),false);
  assert.equal(iconSource(svg,'image/x-icon').split(';')[0],'data:image/svg+xml');
  assert.equal(iconSource(gzipSync(svg),'image/svg+xml'),iconSource(svg));
  assert.equal(iconSource(gzipSync(Buffer.alloc(MAX_ICON_BYTES+1)),'image/svg+xml'),null);
  assert.equal(iconSource(Buffer.alloc(MAX_ICON_BYTES+1),'image/png'),null);
  assert.equal(iconSource(Buffer.from('bad gzip').fill(0x1f,0,1).fill(0x8b,1,2)),null);
});

test('inline icons accept bounded image data only, with no file or executable URLs', () => {
  const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"/>';
  for (const url of ['data:image/svg+xml,'+encodeURIComponent(svg),'data:image/svg+xml;charset=utf-8;base64,'+Buffer.from(svg).toString('base64')]) assert.equal(inlineIcon(url).buffer.toString(),svg);
  for (const value of ['data:text/html,<script>alert(1)</script>','file:///C:/private.png','javascript:alert(1)','data:image/png;base64,!!!!','data:image/svg+xml,%ZZ','data:image/png;base64,'+Buffer.alloc(MAX_ICON_BYTES+1).toString('base64')]) assert.equal(inlineIcon(value),null);
});
