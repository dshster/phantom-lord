const checkCmd = require('../utils/checkCommand');

module.exports = function clear(selectorArg) {
  checkCmd.call(this, { name: 'clear', params: { selectorArg } });

  this.evaluate(function (selector) { // eslint-disable-line func-names, prefer-arrow-callback
    document.querySelector(selector).value = '';
  }, selectorArg);
};