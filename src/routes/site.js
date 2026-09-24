'use strict';
// Mounts everything that is not the public widget API.
const express = require('express');
const auth = require('../auth');
const channels = require('../channels');

const router = express.Router();
router.use(channels.router); // webhooks: no session needed
router.use(auth.middleware);
router.use(require('./marketing'));
router.use(require('./account'));
router.use(require('./dashboard'));
router.use(require('./billing'));
router.use(require('./admin'));

module.exports = router;
