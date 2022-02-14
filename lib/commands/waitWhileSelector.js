const waitFor = require('./waitFor');
const expectSelector = require('./expectSelector');

/**
 * @param {!RemoteBrowser=} context
 * @param {string|{type: string, path: string}} selector
 * @param {Function=} onTimeout
 * @returns {Promise}
 */
module.exports = async function waitWhileSelector(context, selector, onTimeout) {
  return waitFor(context, () => expectSelector('notExists', context, selector), 'waitWhileSelector', onTimeout);
};
