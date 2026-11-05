// Driver road reports: stored as pending, published only after admin approval.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const { createHazardReportService } = require('../services/hazardReportService');
const { createHazardController } = require('../controllers/hazardController');
const { createHazardRoutes } = require('../routes/hazardRoutes');

const TOKEN = 'test-admin-token-123456';
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-reports-')), 'reports.json');
const BBOX = { south: 35, west: 45, north: 36, east: 46 };

async function startApp({ adminToken = TOKEN, reportLimit } = {}) {
  const file = tmpFile();
  const reports = createHazardReportService({ file });
  const app = express();
  app.use(express.json());
  app.use('/api', createHazardRoutes(createHazardController(reports, { adminToken, reportLimit })));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, p, { body, token } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { file, reports, call, close: () => new Promise((r) => server.close(r)) };
}

const bboxQuery = `?south=${BBOX.south}&west=${BBOX.west}&north=${BBOX.north}&east=${BBOX.east}`;

test('a report is hidden until an admin approves it, then published', async () => {
  const app = await startApp();
  try {
    const sent = await app.call('POST', '/hazards/reports', { body: { kind: 'speed_camera', lat: 35.56, lng: 45.43, note: ' limit 60 ' } });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.report.status, 'pending');

    assert.deepEqual((await app.call('GET', `/hazards${bboxQuery}`)).body.hazards, [], 'pending reports are not public');

    const queue = await app.call('GET', '/admin/hazard-reports', { token: TOKEN });
    assert.equal(queue.body.reports.length, 1);
    assert.equal(queue.body.reports[0].note, 'limit 60');

    const approved = await app.call('POST', `/admin/hazard-reports/${sent.body.report.id}/approve`, { token: TOKEN });
    assert.equal(approved.body.report.status, 'approved');

    const published = (await app.call('GET', `/hazards${bboxQuery}`)).body.hazards;
    assert.equal(published.length, 1);
    assert.equal(published[0].kind, 'speed_camera');
    assert.equal(published[0].verification, 'verified');
    assert.deepEqual((await app.call('GET', '/hazards?south=0&west=0&north=1&east=1')).body.hazards, [], 'outside the area');

    await app.call('POST', `/admin/hazard-reports/${sent.body.report.id}/reject`, { token: TOKEN });
    assert.deepEqual((await app.call('GET', `/hazards${bboxQuery}`)).body.hazards, [], 'rejecting unpublishes');
  } finally {
    await app.close();
  }
});

test('admin API needs the right token and is disabled without one', async () => {
  const app = await startApp();
  try {
    assert.equal((await app.call('GET', '/admin/hazard-reports')).status, 401);
    assert.equal((await app.call('GET', '/admin/hazard-reports', { token: 'wrong-token-wrong-token' })).status, 401);
    assert.equal((await app.call('POST', '/admin/hazard-reports/x/approve', { token: TOKEN })).status, 404);
  } finally {
    await app.close();
  }
  const disabled = await startApp({ adminToken: '' });
  try {
    assert.equal((await disabled.call('GET', '/admin/hazard-reports', { token: TOKEN })).status, 503);
  } finally {
    await disabled.close();
  }
});

test('invalid reports are refused and submissions are rate limited', async () => {
  const app = await startApp({ reportLimit: { max: 2, windowMs: 60000 } });
  try {
    assert.equal((await app.call('POST', '/hazards/reports', { body: { kind: 'pothole', lat: 35, lng: 45 } })).status, 400);
    assert.equal((await app.call('POST', '/hazards/reports', { body: { kind: 'speed_bump', lat: 135, lng: 45 } })).status, 400);
    assert.equal((await app.call('POST', '/hazards/reports', { body: { kind: 'speed_bump', lat: 35, lng: 45, note: 'x'.repeat(281) } })).status, 429, 'third request from this client');
    assert.equal((await app.call('GET', '/hazards?south=a')).status, 400);
  } finally {
    await app.close();
  }
});

test('reports survive a restart; an unreadable file is moved aside, not overwritten', async () => {
  const file = tmpFile();
  const first = createHazardReportService({ file });
  const r = await first.create({ kind: 'road_closure', lat: 35.5, lng: 45.5 });
  await first.approve(r.id);
  await first.flush();
  assert.equal(createHazardReportService({ file }).listApproved(BBOX).length, 1);

  fs.writeFileSync(file, '{ broken');
  const restarted = createHazardReportService({ file });
  assert.deepEqual(restarted.list('all'), []);
  const aside = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-'));
  assert.equal(aside.length, 1, 'corrupt file kept for inspection');
});
