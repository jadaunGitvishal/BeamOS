'use strict';

// Phase 5 Stage A — campaign status is derived from the date window vs. today
// (lib/campaign-status.js). Pure function, no DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const { campaignStatus, isCampaignActive, todayStr } = require('../lib/campaign-status');

const c = (start_date, end_date) => ({ start_date, end_date });

test('draft: today is before start_date', () => {
  assert.equal(campaignStatus(c('2026-06-01', '2026-06-30'), '2026-05-31'), 'draft');
  assert.equal(campaignStatus(c('2026-06-01', '2026-06-30'), '2026-01-01'), 'draft');
});

test('live: today is within [start_date, end_date], inclusive of both ends', () => {
  assert.equal(campaignStatus(c('2026-06-01', '2026-06-30'), '2026-06-01'), 'live', 'first day');
  assert.equal(campaignStatus(c('2026-06-01', '2026-06-30'), '2026-06-15'), 'live', 'mid');
  assert.equal(campaignStatus(c('2026-06-01', '2026-06-30'), '2026-06-30'), 'live', 'last day');
});

test('completed: today is after end_date', () => {
  assert.equal(campaignStatus(c('2026-06-01', '2026-06-30'), '2026-07-01'), 'completed');
  assert.equal(campaignStatus(c('2026-06-01', '2026-06-30'), '2027-01-01'), 'completed');
});

test('single-day campaign (start == end): live on that day, done the next', () => {
  assert.equal(campaignStatus(c('2026-06-15', '2026-06-15'), '2026-06-14'), 'draft');
  assert.equal(campaignStatus(c('2026-06-15', '2026-06-15'), '2026-06-15'), 'live');
  assert.equal(campaignStatus(c('2026-06-15', '2026-06-15'), '2026-06-16'), 'completed');
});

test('isCampaignActive is false only once completed', () => {
  assert.equal(isCampaignActive(c('2026-06-01', '2026-06-30'), '2026-05-01'), true);
  assert.equal(isCampaignActive(c('2026-06-01', '2026-06-30'), '2026-06-10'), true);
  assert.equal(isCampaignActive(c('2026-06-01', '2026-06-30'), '2026-07-10'), false);
});

test('todayStr returns YYYY-MM-DD', () => {
  assert.match(todayStr(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(todayStr(new Date('2026-03-04T22:00:00Z')), '2026-03-04');
});
