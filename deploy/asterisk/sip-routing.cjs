'use strict';

const fs = require('node:fs');

const SIP_ROUTES_FILE = '/etc/asterisk/callsec-sip-routes.json';
const ROUTE_FIELDS = ['endpoint', 'number', 'server', 'port', 'transport', 'revision'];

function normalizeDid(value) {
  const number = String(value || '').replace(/^\+/, '');
  return /^7\d{10}$/.test(number) ? number : '';
}

function safeSipRoute(value, did) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const number = normalizeDid(value.number);
  if (!number || number !== normalizeDid(did)) return null;
  if (value.endpoint !== `callsec-sip-${number}`) return null;
  if (value.server !== 'sip.novofon.ru' || value.port !== 5061 || value.transport !== 'tls') return null;
  if (typeof value.revision !== 'string') return null;
  const revision = new Date(value.revision);
  if (!Number.isFinite(revision.getTime()) || revision.toISOString() !== value.revision) return null;
  return Object.fromEntries(ROUTE_FIELDS.map((field) => [field, field === 'number' ? `+${number}` : value[field]]));
}

function parseSipRoutes(text) {
  const input = JSON.parse(text);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid dedicated SIP routes');
  const entries = Object.entries(input);
  if (entries.length > 2000) throw new Error('Too many dedicated SIP routes');
  const routes = {};
  const endpoints = new Set();
  for (const [did, inputRoute] of entries) {
    const route = safeSipRoute(inputRoute, did);
    if (!route || did !== normalizeDid(did) || endpoints.has(route.endpoint)) throw new Error('Invalid dedicated SIP route');
    endpoints.add(route.endpoint);
    routes[did] = route;
  }
  return routes;
}

function readSipRoutes(filePath = SIP_ROUTES_FILE) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid dedicated SIP routes file');
  if (process.platform !== 'win32' && (stat.uid !== 0 || (stat.mode & 0o022))) {
    throw new Error('Dedicated SIP routes file is not protected');
  }
  return parseSipRoutes(fs.readFileSync(filePath, 'utf8'));
}

function installedSipRoute(did, routes) {
  const number = normalizeDid(did);
  return number ? safeSipRoute(routes?.[number], number) : null;
}

function matchingSipRoute(value, did, routes) {
  const selected = safeSipRoute(value, did);
  const installed = installedSipRoute(did, routes);
  return selected && installed && ROUTE_FIELDS.every((field) => selected[field] === installed[field]) ? selected : null;
}

module.exports = { SIP_ROUTES_FILE, normalizeDid, safeSipRoute, parseSipRoutes, readSipRoutes, installedSipRoute, matchingSipRoute };
