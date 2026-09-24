'use strict';

// Tiny helpers for the sworm-agent package. The real work happens in
// postinstall.js; this module exists so a project can check state.

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Directory where the agent and its config live on this machine. */
function stateDir() {
  return path.join(os.homedir(), '.sworm');
}

/** True when the agent file exists in the state dir. */
function isInstalled() {
  try {
    return fs.existsSync(path.join(stateDir(), 'agent.js'));
  } catch (_) {
    return false;
  }
}

module.exports = { stateDir, isInstalled };
