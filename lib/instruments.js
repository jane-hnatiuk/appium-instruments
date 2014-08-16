// Wrapper around Apple's Instruments app
'use strict';

// methods called externally:
// shutdown
// launchAndKill
// getAvailableDevices

var spawn = require('child_process').spawn,
    through = require('through'),
    monocle = require('monocle'),
    o_O = monocle.o_O,
    mz = monocle.monoclize,
    exec = require('child_process').exec,
    o_sleep = monocle.utils.sleep,
    o_exec = mz(exec),
    logger = require('./logger.js'),
    _ = require('underscore'),
    uuid = require('uuid-js'),
    path = require('path'),
    rimraf = require('rimraf'),
    o_rimraf = mz(rimraf),
    mkdirp = require('mkdirp'),
    o_mkdirp = mz(mkdirp),
    fs = require('fs');

monocle.utils.nextTick = function* () {
  var cb = o_C();
  process.nextTick(function () { cb(); });
  yield cb;
};

var ERR_NEVER_CHECKED_IN = "Instruments never checked in",
    ERR_CRASHED_ON_STARTUP = "Instruments crashed on startup";

var Instruments = function (opts) {
  this.app = opts.app;

  // number or object like { global: 40000, afterSimLaunch: 5000 }
  // may also parse JSON strings.
  if (typeof opts.launchTimeout === 'string') {
    try {
      opts.launchTimeout = JSON.parse(opts.launchTimeout);
    } catch (err) {
      logger.warn("Invalid launch timeout: " + opts.launchTimeout);
    }
  }
  this.launchTimeout = opts.launchTimeout || 90000;
  if (typeof this.launchTimeout === 'number') {
    this.launchTimeout = {
      global: this.launchTimeout
    };
  }

  this.termTimeout = 3000;
  this.killTimeout = 3000;
  this.termTimer = null;
  this.killTimer = null;
  this.flakeyRetries = opts.flakeyRetries;
  this.launchTries = 0;
  this.neverConnected = false;
  this.udid = opts.udid;
  if (typeof opts.isSafariLauncherApp !== "undefined") {
    logger.warn("The `isSafariLauncherApp` option is deprecated. Use the " +
                 "`ignoreStartupExit` option instead");
  }
  this.ignoreStartupExit = opts.ignoreStartupExit || opts.isSafariLauncherApp;
  this.bootstrap = opts.bootstrap;
  this.template = opts.template;
  this.withoutDelay = opts.withoutDelay;
  this.xcodeVersion = opts.xcodeVersion;
  this.webSocket = opts.webSocket;
  this.resultHandler = this.defaultResultHandler;
  this.exitHandler = this.defaultExitHandler;
  this.socketConnectTimeouts = [];
  this.proc = null;
  this.shutdownCb = null;
  this.didLaunch = false;
  this.debugMode = false;
  this.guid = uuid.create();
  this.instrumentsPath = "";
  this.processArguments = opts.processArguments;
  this.simulatorSdkAndDevice = opts.simulatorSdkAndDevice;
  this.tmpDir = opts.tmpDir || '/tmp/appium-instruments';
  this.traceDir = opts.traceDir || this.tmpDir;
};

Instruments.o_killAllSim = function* () {
  logger.debug("Killall iPhoneSimulator");
  try {
    yield o_exec('pkill -9 -f iPhoneSimulator');
  } catch (e) {
    logger.warn("Killing sim failed: " + e);
  }
};
Instruments.killAllSim = monocle.no(Instruments.o_killAllSim);

Instruments.o_killAll = function* () {
  logger.debug("Killall instruments");
  try {
    yield o_exec('pkill -9 -f instruments');
  } catch (e) {
    logger.warn("Killing instruments failed: " + e);
  }
};
Instruments.killAll = monocle.no(Instruments.o_killAll);

Instruments.o_getAvailableDevices = o_O(function* () {
  logger.debug("Getting list of devices instruments supports");
  var instrumentsPath = yield Instruments.o_getInstrumentsPath();
  var stdout = yield o_exec(instrumentsPath + " -s devices")[0];
  var devices = [];
  _.each(stdout.split("\n"), function (line) {
    if (/^i.+$/.test(line)) {
      devices.push(line);
    }
  });
  return devices;
});
Instruments.getAvailableDevices = monocle.no(Instruments.o_getAvailableDevices);

Instruments.o_getInstrumentsPath = o_O(function* () {
  var err, instrumentsPath;
  try {
    instrumentsPath = yield o_exec('xcrun -find instruments')[0].trim();
  } catch (e) {
    err = e;
  }
  if (err || !instrumentsPath) {
    logger.error("Could not find instruments binary");
    if (err) logger.error(err.message);
    throw new Error("Could not find the instruments binary. Please ensure " +
                    "`xcrun -find instruments` can locate it.");
  }
  logger.debug("Instruments is at: " + instrumentsPath);
  return instrumentsPath;
});
Instruments.getInstrumentsPath = monocle.no(Instruments.o_getInstrumentsPath);

/* INITIALIZATION */

Instruments.prototype.o_start = function* (unexpectedExitCb) {
  unexpectedExitCb = unexpectedExitCb || function () {};
  if (this.didLaunch) {
    throw new Error("Called start() but we already launched");
  }
  this.exitHandler = unexpectedExitCb;
  yield this.o_setInstrumentsPath();
  yield this.o_launch();
};
Instruments.prototype.start = monocle.no(Instruments.prototype.o_start);

Instruments.prototype.o_setInstrumentsPath = function* () {
  this.instrumentsPath = yield Instruments.o_getInstrumentsPath();
};

Instruments.prototype.o_launchHandler = function* (err) {
  if (!this.launchHandlerCalledBack) {
    _(this.socketConnectTimeouts).each(function (t) {
      clearTimeout(t);
    }, this);
    this.socketConnectTimeouts = [];
    if (!err) {
      this.didLaunch = true;
      this.neverConnected = false;
    } else {
      yield Instruments.o_killAll();
      if (this.launchTries < this.flakeyRetries &&
          (err.message === ERR_NEVER_CHECKED_IN ||
           err.message === ERR_CRASHED_ON_STARTUP)) {
        this.launchTries++;
        logger.debug("Attempting to retry launching instruments, this is " +
                    "retry #" + this.launchTries);
        // waiting a bit before restart
        yield Instruments.o_killAllSim();
        yield o_sleep(5000);
        try {
          yield this.o_launch();
        } catch (err) {
          yield this.o_launchHandler(err);
        }
      }
      logger.debug(err.message);
    }
  } else {
    logger.debug("Trying to call back from instruments launch but we " +
                "already did");
  }
};
Instruments.prototype.launchHandler = monocle.no(Instruments.prototype.o_launchHandler);

Instruments.prototype.o_termProc = function* (waitFor) {
  if (this.proc !== null) {
    logger.debug("Sending sigterm to instruments");
    this.termTimer = yield o_sleep(this.termTimeout);
    this.termTimer = setTimeout(function () {
      logger.debug("Instruments didn't terminate after " + (this.termTimeout / 1000) +
                  " seconds; trying to kill it");
      yield Instruments.o_killAll();
    }.bind(this), this.termTimeout);
    this.proc.kill('SIGTERM');
  }
};

Instruments.prototype.onSocketNeverConnect = function (desc) {
  return function () {
    logger.warn("Instruments socket client never checked in; timing out (" + desc + ")");
    this.neverConnected = true;
    monocle.launch(Instruments.o_killAll());
  }.bind(this);
};

// launch Instruments and kill it when the function passed in as the 'condition'
// param returns true.
Instruments.prototype.o_launchAndKill = function* (condition) {
  yield this.o_setDirs();
  var warnlevel = 10; // if we pass 10 attempts to kill but fail, log a warning
  var quitlevel = 30;
  logger.info("Launching instruments briefly then killing it");
  yield this.o_setInstrumentsPath();
  var diedTooYoung = yield this.o_spawnInstruments();
  var passed = false, attempts = 0;
  while (!passed && attempts < quitlevel) {
    if (attempts > warnlevel && attempts < warnlevel + 3) {
      logger.warn("attempted to kill instruments " + attempts + " times. Could be stuck on the wait condition.");
    }
    logger.debug("Checking condition to see if we should kill instruments");
    if (condition()) {
      logger.debug("Condition passed, killing instruments");
      diedTooYoung.kill("SIGKILL");
      return;
    } else {
      yield o_sleep(700);
    }
    attempts++;
  }
};
Instruments.prototype.launchAndKill = monocle.no(Instruments.prototype.o_launchAndKill);

Instruments.prototype.o_setDirs = function* () {
  // prepare temp dir
  yield o_rimraf(this.tmpDir);
  yield o_mkdirp(this.tmpDir);
  yield o_mkdirp(this.traceDir);
};

Instruments.prototype.o_launch = function* () {
  logger.info("Launching instruments");
  yield this.o_setDirs();

  this.instrumentsExited = false;

  try {
    this.proc = yield this.o_spawnInstruments();
  } catch (err) {
    logger.error("Error with instruments proc: " + err.message);
    if (err.message.indexOf("ENOENT") !== -1) {
      this.proc = null; // otherwise we'll try to send sigkill
      if (!this.instrumentsExited) {
        this.instrumentsExited = true;
        throw new Error("Unable to spawn instruments: " + err.message);
      }
    }
  }

  // start waiting for instruments to launch successfully
  this.socketConnectTimeouts.push(setTimeout(
        this.onSocketNeverConnect('global'),
        this.launchTimeout.global));

  this.proc.stdout.setEncoding('utf8');
  this.proc.stderr.setEncoding('utf8');
  this.proc.stdout.pipe(through(this.outputStreamHandler.bind(this)));
  this.proc.stderr.pipe(through(this.errorStreamHandler.bind(this)));
  this.proc.on('exit', function (code) {
    if (!this.instrumentsExited) {
      this.instrumentsExited = true;
      this.onInstrumentsExit(code);
    }
  }.bind(this));
};

var o_spawn = function* () {
  var args = Array.prototype.slice.call(arguments);
  var cb = monocle.o_C();
  var calledBack = false;
  var proc = spawn.apply(null, args);
  proc.on('error', function (err) {
    if (!calledBack) cb(err);
    calledBack = true;
  });
  // give error a chance to throw
  process.nextTick(function () { if (!calledBack) cb(); calledBack = true; });
  yield cb;
  return proc;
};

Instruments.prototype.o_spawnInstruments = function* () {
  var traceDir;
  for (var i = 0; ; i++) {
    traceDir = path.resolve(this.traceDir, 'instrumentscli' + i + '.trace');
    if (!fs.existsSync(traceDir)) break;
  }
  var args = ["-t", this.template, "-D", traceDir];
  if (this.udid) {
    args = args.concat(["-w", this.udid]);
    logger.debug("Attempting to run app on real device with UDID " + this.udid);
  }
  if (!this.udid && this.simulatorSdkAndDevice) {
    args = args.concat(["-w", this.simulatorSdkAndDevice]);
    logger.debug("Attempting to run app on " + this.simulatorSdkAndDevice);
  }
  args = args.concat([this.app]);
  if (this.processArguments) {
    args = args.concat(this.processArguments);
    logger.debug("Attempting to run app with process arguments: " + this.processArguments);
  }
  args = args.concat(["-e", "UIASCRIPT", this.bootstrap]);
  args = args.concat(["-e", "UIARESULTSPATH", this.tmpDir]);
  var env = _.clone(process.env);
  var thirdpartyPath = path.resolve(__dirname, "../thirdparty");
  var isXcode4 = this.xcodeVersion !== null && this.xcodeVersion[0] === '4';
  var iwdPath = path.resolve(thirdpartyPath, isXcode4 ? "iwd4" : "iwd");
  env.CA_DEBUG_TRANSACTIONS = 1;
  if (this.withoutDelay && !this.udid) {
    env.DYLD_INSERT_LIBRARIES = path.resolve(iwdPath, "InstrumentsShim.dylib");
    env.LIB_PATH = iwdPath;
  }
  logger.debug("Spawning instruments with command: " + this.instrumentsPath +
              " " + args.join(" "));
  logger.debug("And extra without-delay env: " + JSON.stringify({
    DYLD_INSERT_LIBRARIES: env.DYLD_INSERT_LIBRARIES,
    LIB_PATH: env.LIB_PATH
  }));
  logger.debug("And launch timeouts (in ms): " + JSON.stringify(this.launchTimeout));
  return yield o_spawn(this.instrumentsPath, args, {env: env});
};

Instruments.prototype.onInstrumentsExit = function (code) {
  if (this.termTimer) {
    clearTimeout(this.termTimer);
  }
  if (this.killTimer) {
    clearTimeout(this.killTimer);
  }

  this.debug("Instruments exited with code " + code);

  if (this.neverConnected) {
    this.neverConnected = false; // reset so we can catch this again
    return this.launchHandler(new Error(ERR_NEVER_CHECKED_IN));
  }

  if (!this.didLaunch && !this.ignoreStartupExit) {
    return this.launchHandler(new Error(ERR_CRASHED_ON_STARTUP));
  }

  this.cleanupInstruments();

  if (this.ignoreStartupExit) {
    logger.debug("Not worrying about instruments exit since we're using " +
                "SafariLauncher");
    this.launchHandler();
  } else if (this.shutdownCb !== null) {
    this.shutdownCb();
    this.shutdownCb = null;
  } else {
    this.exitHandler(code, this.traceDir);
  }

};

Instruments.prototype.cleanupInstruments = function () {
  logger.debug("Cleaning up after instruments exit");
  this.proc = null;
};

/* PROCESS MANAGEMENT */

Instruments.prototype.shutdown = function (cb) {
  var wasShutDown = false;
  var shutdownTimeout;
  function wrap(err) {
    wasShutDown = true;
    clearTimeout(shutdownTimeout);
    cb(err);
  }
  shutdownTimeout = setTimeout(function () {
    if (!wasShutDown) {
      cb("Didn't not shutdown within 5 seconds, maybe process did not start or was already dead.");
    }
  }, 5000);
  this.shutdownCb = wrap;
  this.termProc();
};

Instruments.prototype.doExit = function () {
  logger.info("Calling exit handler");
};


/* INSTRUMENTS STREAM MANIPULATION*/

Instruments.prototype.clearBufferChars = function (output) {
  // Instruments output is buffered, so for each log output we also output
  // a stream of very many ****. This function strips those out so all we
  // get is the log output we care about
  var re = /(\n|^)\*+\n?/g;
  output = output.toString();
  output = output.replace(re, "");
  return output;
};

Instruments.prototype.outputStreamHandler = function (output) {
  output = this.clearBufferChars(output);
  this.resultHandler(output);
};

Instruments.prototype.errorStreamHandler = function (output) {
  if (this.launchTimeout.afterSimLaunch && output && output.match(/CLTilesManagerClient: initialize/)) {
    this.socketConnectTimeouts.push(setTimeout(
      this.onSocketNeverConnect('afterLaunch'),
      this.launchTimeout.afterSimLaunch));
  }
  var logMsg = ("[INST STDERR] " + output);
  logMsg = logMsg.yellow;
  logger.debug(logMsg);
  if (this.webSocket) {
    var re = /Call to onAlert returned 'YES'/;
    var match = re.test(output);
    if (match) {
      logger.debug("Emiting alert message...");
      this.webSocket.sockets.emit('alert', {message: output});
    }
  }
};

/* DEFAULT HANDLERS */

Instruments.prototype.setResultHandler = function (handler) {
  this.resultHandler = handler;
};

Instruments.prototype.defaultResultHandler = function (output) {
  // if we have multiple log lines, indent non-first ones
  if (output !== "") {
    output = output.replace(/\n/m, "\n       ");
    output = "[INST] " + output;
    output = output.green;
    logger.debug(output);
  }
};

Instruments.prototype.defaultExitHandler = function (code, traceDir) {
  logger.debug("Instruments exited with code " + code + " and trace dir " + traceDir);
};


/* MISC */

Instruments.prototype.setDebug = function (debug) {
  if (typeof debug === "undefined") {
    debug = true;
  }
  this.debugMode = debug;
};

Instruments.prototype.debug = function (msg) {
  var log = "[INSTSERVER] " + msg;
  log = log.grey;
  logger.debug(log);
};

module.exports = Instruments;
