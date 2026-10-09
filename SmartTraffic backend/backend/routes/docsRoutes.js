const express = require('express');
const swaggerUiPath = require('swagger-ui-dist').absolutePath();
const specification = require('../docs/openapi');

function createDocsRoutes() {
  const router = express.Router({ strict: true });
  router.get('/openapi.json', (req, res) => res.json(specification));
  router.get('/docs', (req, res) => res.redirect(301, req.baseUrl + '/docs/'));
  router.get('/docs/', (req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Smart Traffic AI API - Swagger</title>
  <link rel="stylesheet" href="./assets/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="./assets/swagger-ui-bundle.js"></script>
  <script>
    // Relative to the page's URL, including a reverse proxy's path prefix.
    const base = new URL(window.location.href);
    base.pathname = base.pathname.replace(/\\/docs\\/?$/, '/');
    SwaggerUIBundle({
      url: new URL('openapi.json', base).href,
      dom_id: '#swagger-ui',
      deepLinking: true,
      displayRequestDuration: true,
      validatorUrl: null
    });
  </script>
</body>
</html>`);
  });
  router.use('/docs/assets', express.static(swaggerUiPath, { index: false }));
  return router;
}

module.exports = { createDocsRoutes };
