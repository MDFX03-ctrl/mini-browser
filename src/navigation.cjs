'use strict';

function isWebUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && Boolean(url.hostname)
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

function resolveAddress(value) {
  if (typeof value !== 'string' || value.length > 8192) {
    throw new Error('Please enter a shorter address.');
  }
  const input = value.trim();
  if (!input) return null;

  // Hostnames with ports are addresses, not custom URL schemes.
  const localAddress = /^(localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:]+\])(?::\d+)?(?:[/?#]|$)/i;
  if (localAddress.test(input) && !/\s/.test(input)) {
    const url = `http://${input}`;
    if (isWebUrl(url)) return new URL(url).href;
  }

  if (/^[^:/\s]+\.[^:/\s]+:\d+(?:[/?#]|$)/.test(input)) {
    const url = `https://${input}`;
    if (isWebUrl(url)) return new URL(url).href;
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(input)) {
    if (!isWebUrl(input)) throw new Error('Use an http or https website address.');
    return new URL(input).href;
  }

  if (!/\s/.test(input) && input.split(/[/?#]/)[0].includes('.')) {
    const url = `https://${input}`;
    if (isWebUrl(url)) return new URL(url).href;
  }

  throw new Error('Enter a website address, such as example.com.');
}

module.exports = { isWebUrl, resolveAddress };
