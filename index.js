const spawn = require('child_process').spawn;
const request = require('request');
const EventEmitter = require('events').EventEmitter;
const utils = require('./utils.js');
RegExp.prototype.toJSON = function() { return 're:' + this.source; }; // для сохранения regexp в моках
const f = utils.format;
var browserArgs = JSON.parse(process.env.BROWSER_ARGS);

function debug(str) {
  if (process.env.DEBUG) {
    console.log(`debug: ` + str);
  }
}

class RemoteBrowser extends EventEmitter {
  constructor() {
    super();
    this.state = 'notStarted';
    this.currentStep = 0;
    this.stepInsertOffset = 1;
    this.steps = [];
  }
  startRemoteBrowser() {
    if (this.state != 'notStarted') return;
    this.state = 'starting';
    
    debug('start remote server');
    this.server = spawn('./node_modules/phantomjs-prebuilt/bin/phantomjs', ['./node_modules/frontend-e2e-tests-env/browser-server.js', process.env.BROWSER_ARGS]);
    this.server.stderr.on('data', (data) => {
      process.stdout.write(data.toString('utf8'));
    });

    this.server.stdout.on('data', (data) => {
      process.stdout.write(data.toString('utf8'));
      if (data.indexOf('Server started') > -1) {
        this.port = /Server started at (\d+)/.exec(data)[1];
        this.state = 'started';
        this.stepInsertOffset = 1;
        this.processSteps();
      }
      if (data.indexOf('page.initialized') > -1) {
        this.emit('page.initialized');
      }
    });

    this.server.on('close', (code) => {
      debug(`child process exited with code ${code}`);
      this.state = 'notStarted';
    });

    // TODO: Добавить отлуп каспера по таймауту
  }

  open(url) {
    return this.then(() => {
      return new Promise((resolve, reject) => {
        this.sendCmd({name: 'open', params: {url}}, (resp) => {
          if (resp.status == 'ok') {
            resolve();
          } else {
            debug(`open page error: ${resp.status}`);
            this.emit('error');
          }
        });
      });
    });
  }

  waitForText(text, onTimeout) {
    return this.waitFor(() => {
      return this.getPlainText().then((pageText) => pageText.indexOf(text) > -1 ? Promise.resolve() : Promise.reject());
    }, onTimeout);
  }

  waitForSelector(selector, onTimeout) {
    return this.waitFor(() => this.checkSelectorExists(selector), onTimeout);
  }

  waitWhileSelector(selector, onTimeout) {
    return this.waitFor(() => this.checkSelectorNotExists(selector), onTimeout);
  }

  waitWhileText(selector, onTimeout) {
    return this.waitFor(() => {
      return this.getPlainText().then((pageText) => pageText.indexOf(text) == -1 ? Promise.resolve() : Promise.reject());
    }, onTimeout);
  }

  waitForUrl(url, onTimeout) {
    return this.waitFor(() => {
      return new Promise((resolve, reject) => {
        this.getCurrentUrl().then((currentUrl) => {
          if (url.exec && url.exec(currentUrl) || currentUrl.indexOf(url) !== -1) {
            resolve();
          } else {
            reject();
          }
        });
      });
    }, onTimeout);
  }

  waitWhileVisible(selector, onTimeout) {
    return this.waitFor(() => this.checkVisibility(selector), onTimeout);
  }

  waitUntilVisible(selector, onTimeout) {
    return this.waitFor(() => this.checkVisibility(selector), onTimeout);
  }

  waitStart() {
    this.pendingWait = true;
  }

  waitDone() {
    this.pendingWait = false;
  }

  wait(timeout, then) {
    return this.then(() => {
      return new Promise((resolve, reject) => {
        this.waitStart();
        setTimeout((self) => {
          self.waitDone();
          resolve();
        }, timeout, this)
      })
    })
  }

  waitFor(fn, onTimeout) {
    const startWaitingTime = +new Date();
    if (process.env.E2E_TESTS_WITH_PAUSES === 'true') {
      this.CHECK_INTERVAL += 300;
    }
    return this.then(() => {
      return new Promise((resolve, reject) => {
        const condNotSatisfied = () => {
          const currentTime = +new Date();

          if (currentTime - startWaitingTime < this.WAIT_TIMEOUT) {
            setTimeout(() => waiter(), this.CHECK_INTERVAL);
          } else {
            onTimeout && onTimeout();
            this.emit('timeout');
            resolve();
          }
        }

        const waiter = () => {
          const res = fn();
          if (res && res.then) {
            res.then(() => {
              resolve();
            }, () => {
              condNotSatisfied();
            });
          } else {
            if (res) {
              resolve();
            } else {
              condNotSatisfied();
            }
          }
        }

        waiter();
      });
    });
  }

  evaluate(fn, ...args) {
    return this.then(() => {
      return new Promise((resolve, reject) => {
        this.sendCmd({name: 'evaluate', params: {fn: fn.toString(), args}}, (resp) => {
          resolve(resp.result);
        });
      });
    });
  }

  click(selector, x, y) {
    return this.then(() => {
      return new Promise((resolve, reject) => {
        this.sendCmd({name: 'click', params: {selector, x, y}}, (resp) => {
          if (resp.status == 'ok') {
            resolve();
          } else {
            debug(`click error: ${resp.status}`);
            reject();
          }
        });
      });
    });
  }

  sendKeys(selector, keys, options) {
    this.click(selector);
    this._sendKeys(selector, keys, options);
  }

  clickLabel(label, tag) {
    tag = tag || "*";
    var escapedLabel = utils.quoteXPathAttributeString(label);
    var selector = this.xpath(f('//%s[text()=%s]', tag, escapedLabel));
    return this.click(selector);
  }

  _sendKeys(selector, keys, options) {
    return this.then(() => {
      return new Promise((resolve, reject) => {
        this.sendCmd({name: 'sendKeys', params: {selector, keys, options}}, (resp) => {
          if (resp.status == 'ok') {
            resolve();
          } else {
            debug(`click error: ${resp.status}`);
            reject();
          }
        });
      });
    });
  }

  exit() {
    return this.then(() => {
      return new Promise((resolve, reject) => {
        this.sendCmd({name: 'exit'}, (resp) => {
          this.server.kill();
          resolve();
        });
      });
    });
  }

  then(fn) {
    debug(`currentStep: ${this.currentStep}, stepInsertOffset: ${this.stepInsertOffset}, stepsCount: ${this.steps.length}`);
    this.steps.splice(this.currentStep + this.stepInsertOffset, 0, fn);
    this.stepInsertOffset++;
    this.processSteps();
    return this;
  }

  processSteps(lastRes) {
    if (this.state == 'notStarted') {
      this.startRemoteBrowser();
      return;
    }

    if (this.state != 'started' || this.processing) return;

    if (this.currentStep >= this.steps.length) {
      this.emit('stepsFinished');
      return;
    }

    this.processing = true;

    const step = this.steps[this.currentStep];

    try {
      const stepRes = step(lastRes);
      const processNext = (curRes) => {
        this.currentStep++;
        this.stepInsertOffset = 1;
        this.processing = false;
        this.processSteps(curRes);
      };

      if (stepRes && stepRes.then) {
        stepRes.then(processNext, () => { debug('step processing failed'); });
      } else {
        processNext(stepRes);
      }
    } catch (e) {
      this.emit('error', e);
    }
  }

  getPlainText() {
    return new Promise((resolve, reject) => {
      this.sendCmd({name: 'getPlainText'}, (resp) => {
        resolve(resp.result);
      });
    });
  }

  getCurrentUrl() {
    return new Promise((resolve, reject) => {
      this.sendCmd({name: 'getCurrentUrl'}, (resp) => {
        resolve(resp.result);
      });
    });
  }

  checkSelectorExists(selector) {
    return new Promise((resolve, reject) => {
      this.sendCmd({name: 'checkSelectorExists', params: {selector}}, (resp) => {
        if (resp.status == 'ok') {
          resolve();
        } else {
          reject();
        }
      });
    });
  }

  checkSelectorNotExists(selector) {
    return new Promise((resolve, reject) => {
      this.sendCmd({name: 'checkSelectorExists', params: {selector}}, (resp) => {
        if (resp.status == 'notFound') {
          resolve();
        } else {
          reject();
        }
      });
    });
  }

  checkVisibility(selector) {
    return new Promise((resolve, reject) => {
      this.sendCmd({name: 'checkVisibility', params: {selector}}, (resp) => {
        if (resp.status == 'ok') {
          resolve();
        } else {
          reject();
        }
      });
    });
  }

  sendCmd(cmd, cb) {
    debug(`processing cmd: ${JSON.stringify(cmd)}`);
    request.post({
      method: 'POST',
      url: 'http://localhost:' + this.port,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd)
    }, (error, response, body) => {
      // debug(`response received: ${body}`);
      if (error) {
        const error = `Error while processing cmd: ${JSON.stringify(cmd)}`;
        debug(error);
        this.emit('error', error);
      } else {
        cb(JSON.parse(body));
      }
    });
  }

  injectStubIntoApp(stub) {
    this.evaluate(function(method, url, data) {
      
      window.mocks = window.mocks || [];
      window.mocks.push({ method: method, url: url, data: data });
    }, stub.method, stub.url, stub.data);
  }

  addStubToQueue(stub) {
    return this.then(() => {
      return new Promise((resolve, reject) => {
        this.sendCmd({name: 'addStubToQueue', params: {stub}}, (resp) => {
          if (resp.status == 'ok') {
            resolve();
          } else {
            reject();
          }
        });
      });
    });
  }

  addTestSetting(setting, value) {
    return this.then(() => {
      return new Promise((resolve, reject) => {
        this.sendCmd({name: 'addTestSetting', params: {setting, value}}, (resp) => {
          if (resp.status == 'ok') {
            resolve();
          } else {
            reject();
          }
        });
      });
    });
  }

  getCurrentMocks() {
    this.evaluate(function(){
      return window.mocks;
    });
  }

  capture(filename) {
    return this.then(() => {
      return new Promise((resolve, reject) => {
        this.sendCmd({name: 'capture', params: {filename}}, (resp) => {
          if (resp.status == 'ok') {
            resolve();
          } else {
            reject();
          }
        });
      });
    })
  }

  captureInPath(path) {
    return this.then(() => {
      return new Promise((resolve, reject) => {
        this.sendCmd({name: 'captureInPath', params: {path}}, (resp) => {
          if (resp.status == 'ok') {
            resolve();
          } else {
            reject();
          }
        });
      });
    })
  }

  getCount(selector) {
    return new Promise((resolve, reject) => {
      this.sendCmd({name: 'getCount', params: {selector}}, (resp) => {
        resolve(resp.result);
      });
    });
  }

  waitForCount(selector, expectedCount, onTimeout) {
    return this.waitFor(() => {
      return new Promise((resolve, reject) => {
        this.getCount(selector).then((foundCount) => {
          if (foundCount === expectedCount) {
            resolve();
          } else {
            // console.log('ERROR: Expected count of \'' + selector + '\' to be ' + expectedCount + ', but it was ' + foundCount)
            reject();
          }
        });
      });
    }, onTimeout);
  }

  waitForSelectorValue(selector, expectedValue, onTimeout) {
    return new Promise((resolve, reject) => {
      this.waitForSelector(selector);
      this.evaluate(function(evSelector) {
          var el = window.__utils__.findOne(evSelector);
          return el ? el.value : undefined;
        }, selector);
      this.then((actualValue) => {
        if (actualValue === expectedValue) {
          resolve();
        } else {
          // console.log('Expected value of \'' + selector + '\' to be "' + expectedValue + '", but it was "' + actualValue + '"', 'ERROR');
          reject();
        }
      })
    })
  }

  waitForSelectorText(selector, expectedText, exactMatch) {
    var exactMatch = (typeof exactMatch === 'undefined') ? false : exactMatch;
    return new Promise((resolve, reject) => {
      this.waitForSelector(selector);
      this.evaluate(function(evSelector) {
        var text = window.__utils__.fetchText(evSelector);
        return text;
      }, selector);
      this.then((value) => {
        if (exactMatch && value === expectedText || !exactMatch && value.indexOf(expectedText) >= 0) {
          resolve()
        } else {
          reject();
        }
      })
    })
  }

  scrollSelectorToTop(selectorArg) {
    this.evaluate(function(selector) {
      var el = window.__utils__.findOne(selector);
      el.scrollTop = 0;
    }, selectorArg);
  }

  scrollSelectorToBottom(selectorArg) {
    this.evaluate(function(selector) {
      var el = window.__utils__.findOne(selector);
      el.scrollTop = el.scrollHeight;
    }, selectorArg);
  }

  xpath(expression) {
    return {
        type: 'xpath',
        path: expression,
        toString: function() {
            return this.type + ' selector: ' + this.path;
        }
    };
  }

  fillForm(selector, vals, options) {
    return this.then(() => {
      return new Promise((resolve, reject) => {
        this.sendCmd({name: 'fillForm', params: {selector, vals, options}}, (resp) => {
          if (resp.status == 'ok') {
            resolve();
          } else {
            reject();
          }
        });
      });
    });
  }

  fillSelectors(formSelector, vals, submit) {
    return this.fillForm(formSelector, vals, {
      submit: submit,
      selectorType: 'css'
    });
  }

};


RemoteBrowser.prototype.WAIT_TIMEOUT = browserArgs.waitTimeout || 30000;
RemoteBrowser.prototype.CHECK_INTERVAL = 50;

module.exports = RemoteBrowser;
