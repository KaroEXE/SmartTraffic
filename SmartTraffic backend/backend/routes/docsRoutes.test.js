const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const vm = require('node:vm');
const { createDocsRoutes } = require('./docsRoutes');
const { createTrafficRoutes, createSimulationRoutes } = require('./trafficRoutes');
const spec = require('../docs/openapi');
const { validateObservation } = require('../utils/validation');

test('Swagger documents all traffic and simulation routes with valid references and examples', () => {
  const handler = (req, res) => res.end();
  const controller = new Proxy({}, { get: (target, name) => (name === 'postTrafficHandlers' ? [handler] : handler) });
  const ids = new Set();
  for (const [prefix, router] of [
    ['/api', createTrafficRoutes(controller)],
    ['/api/simulation', createSimulationRoutes(controller, controller)],
  ]) {
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const path = prefix + layer.route.path.replace(/:([A-Za-z]+)/g, '{$1}');
      for (const method of Object.keys(layer.route.methods)) {
        const operation = spec.paths[path]?.[method];
        assert.ok(operation, method + ' ' + path + ' documented');
        assert.ok(!ids.has(operation.operationId), 'Unique operationId');
        ids.add(operation.operationId);
      }
    }
  }
  function checkRefs(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) assert.ok(spec.components.schemas[value.$ref.split('/').pop()], value.$ref);
    for (const child of Object.values(value)) checkRefs(child);
  }
  checkRefs(spec);
  for (const example of Object.values(spec.paths['/api/traffic'].post.requestBody.content['application/json'].examples)) {
    assert.equal(validateObservation(example.value).ok, true);
  }
});

test('Swagger redirect, HTML, initializer, spec and local assets work over HTTP', async () => {
  const app = express();
  app.use('/api', createDocsRoutes());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const redirect = await fetch(origin + '/api/docs', { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/api/docs/');
    const page = await fetch(origin + '/api/docs/');
    assert.equal(page.status, 200);
    const html = await page.text();
    let options;
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    vm.runInNewContext(scripts[0][1], {
      URL, window: { location: { href: origin + '/api/docs/' } },
      SwaggerUIBundle: (value) => { options = value; },
    });
    assert.equal(options.url, origin + '/api/openapi.json');
    assert.equal(options.validatorUrl, null);
    const response = await fetch(options.url);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).openapi, '3.0.3');
    for (const [, asset] of html.matchAll(/(?:href|src)="(\.\/assets\/[^"]+)"/g)) {
      const result = await fetch(new URL(asset, origin + '/api/docs/'));
      assert.equal(result.status, 200, asset);
      assert.ok((await result.text()).length > 100);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
