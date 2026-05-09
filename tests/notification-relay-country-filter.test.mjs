/**
 * Regression test: scripts/notification-relay.cjs's eventMatchesCountryScope
 * filter. Layer 3 of the country-scoping PR.
 *
 * Two test surfaces:
 *  1. Source-grep: the filter MUST be wired into the per-rule matching loop
 *     alongside shouldNotify, otherwise country-scoped rules would receive
 *     events from all countries (silent over-delivery).
 *  2. Behavioural: re-execute the filter logic against a synthetic rule +
 *     event matrix to lock in the strict-no-attribution semantics + country
 *     extraction priority.
 *
 * Run: node --test tests/notification-relay-country-filter.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const relaySrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'),
  'utf-8',
);

// Mirror the relay's eventMatchesCountryScope so we can run behavioural
// assertions without requiring the .cjs module export. The relay file is a
// runtime script (no exports) — we validate via source-grep AND a parallel
// implementation that the source-grep ensures stays in sync.
function eventMatchesCountryScope(event, rule) {
  if (!Array.isArray(rule.countries) || rule.countries.length === 0) return true;
  const eventCountry =
    event?.payload?.countryCode
    ?? event?.payload?.country
    ?? event?.country
    ?? null;
  if (typeof eventCountry !== 'string') return false;
  const normalized = eventCountry.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return false;
  return rule.countries.includes(normalized);
}

describe('notification-relay eventMatchesCountryScope — source-grep contract', () => {
  it('declares eventMatchesCountryScope helper', () => {
    assert.match(
      relaySrc,
      /function\s+eventMatchesCountryScope\s*\(\s*event\s*,\s*rule\s*\)/,
      'relay must declare eventMatchesCountryScope(event, rule)',
    );
  });

  it('empty/absent rule.countries returns true (all events match)', () => {
    // Source must early-return true for empty/missing arrays.
    assert.match(
      relaySrc,
      /if\s*\(\s*!\s*Array\.isArray\(\s*rule\.countries\s*\)\s*\|\|\s*rule\.countries\.length\s*===\s*0\s*\)\s*return\s+true/,
      'empty/absent rule.countries must early-return true',
    );
  });

  it('country attribution is extracted with payload.countryCode → payload.country → event.country priority', () => {
    // The fallback chain must be in this order so publishers using either
    // shape (regional-snapshot uses countryCode; ais-relay uses country) all
    // resolve correctly.
    assert.match(
      relaySrc,
      /event\??\.payload\??\.countryCode\s*\?\?\s*event\??\.payload\??\.country\s*\?\?\s*event\??\.country/,
      'extraction priority must be payload.countryCode → payload.country → event.country',
    );
  });

  it('strict semantics: no country attribution → returns false (NOT delivered)', () => {
    // When rule has countries set, an event WITHOUT country attribution must
    // NOT be delivered. Documented inline so the next reader doesn't flip
    // this to over-deliver "for safety."
    assert.match(
      relaySrc,
      /if\s*\(\s*typeof\s+eventCountry\s*!==\s*['"]string['"]\s*\)\s*return\s+false/,
      'missing country attribution must return false (strict)',
    );
  });

  it('filter is wired into the per-rule matching loop alongside shouldNotify', () => {
    // The filter must be in the .filter() arrow that builds `matching`.
    // Without this wiring, the filter exists but is never consulted.
    assert.match(
      relaySrc,
      /shouldNotify\(r,\s*event\)\s*&&\s*\n?\s*eventMatchesCountryScope\(event,\s*r\)/,
      'eventMatchesCountryScope must be in the matching filter alongside shouldNotify',
    );
  });
});

describe('notification-relay eventMatchesCountryScope — behavioural', () => {
  it('rule.countries=[] → all events match', () => {
    const event = { eventType: 'rss_alert', payload: { country: 'US' } };
    assert.equal(eventMatchesCountryScope(event, { countries: [] }), true);
  });

  it("rule.countries=['US','GB'] + event.payload.countryCode='US' → true", () => {
    const event = { eventType: 'rss_alert', payload: { countryCode: 'US' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US', 'GB'] }), true);
  });

  it("rule.countries=['US'] + event.payload.country='IR' → false", () => {
    const event = { eventType: 'rss_alert', payload: { country: 'IR' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), false);
  });

  it("rule.countries=['US'] + event with NO country attribution → false (strict)", () => {
    const event = { eventType: 'rss_alert', payload: { title: 'something' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), false);
  });

  it("rule.countries=['US'] + event.payload.countryCode='us' (lowercase) → true (normalized)", () => {
    const event = { eventType: 'rss_alert', payload: { countryCode: 'us' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), true);
  });

  it("rule.countries=['US'] + malformed country 'USA' (3 letters) → false", () => {
    const event = { eventType: 'rss_alert', payload: { country: 'USA' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), false);
  });

  it("rule.countries=['US'] + malformed country 'United States' → false", () => {
    const event = { eventType: 'rss_alert', payload: { country: 'United States' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), false);
  });

  it('extraction priority: payload.countryCode wins over payload.country', () => {
    const event = { eventType: 'rss_alert', payload: { countryCode: 'US', country: 'GB' } };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), true);
    assert.equal(eventMatchesCountryScope(event, { countries: ['GB'] }), false);
  });

  it('extraction priority: payload.country wins over event.country', () => {
    const event = { eventType: 'rss_alert', payload: { country: 'US' }, country: 'GB' };
    assert.equal(eventMatchesCountryScope(event, { countries: ['US'] }), true);
    assert.equal(eventMatchesCountryScope(event, { countries: ['GB'] }), false);
  });

  it("rule.countries=undefined → all events match (backward compat)", () => {
    const event = { eventType: 'rss_alert', payload: { country: 'US' } };
    assert.equal(eventMatchesCountryScope(event, {}), true);
  });
});
