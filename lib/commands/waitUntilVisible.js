const waitFor = require('./waitFor');
const expectVisibilityState = require('./expectVisibilityState');

/**
 * @param {!RemoteBrowser=} context
 * @param {string|{type: string, path: string}} selector
 * @param {Function=} onTimeout
 * @returns {Promise}
 */
module.exports = async function waitUntilVisible(context, selector, onTimeout) {
  return waitFor(context, () => expectVisibilityState('visible', context, selector), 'waitUntilVisible', onTimeout);
};
