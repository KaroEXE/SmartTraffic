const express = require('express');

/** Driver road reports, mounted at /api. See controllers/hazardController.js. */
function createHazardRoutes(controller) {
  const router = express.Router();
  router.get('/hazards', controller.listApproved);
  router.post('/hazards/reports', controller.submitReport);

  router.get('/admin/hazard-reports', controller.requireAdmin, controller.listForReview);
  router.post('/admin/hazard-reports/:id/approve', controller.requireAdmin, controller.approve);
  router.post('/admin/hazard-reports/:id/reject', controller.requireAdmin, controller.reject);
  router.delete('/admin/hazard-reports/:id', controller.requireAdmin, controller.remove);
  return router;
}

module.exports = { createHazardRoutes };
