'use strict';

function reorder(items, keys, key) {
  if (!Array.isArray(keys) || keys.length !== items.length || new Set(keys).size !== items.length) {
    throw new Error('The list changed. Please try dragging again.');
  }
  const lookup = new Map(items.map((item) => [item[key], item]));
  if (keys.some((id) => !lookup.has(id))) throw new Error('Invalid list order.');
  return keys.map((id) => lookup.get(id));
}
module.exports = { reorder };
