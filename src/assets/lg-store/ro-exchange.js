#!/usr/bin/env node
'use strict';

// Runs on the TV. One live RO (Right Object) exchange per app, driving the TV's
// own libncg_agent.so through ncg/ncg_native.node (N-API addon). Everything
// stays in one node process: the SDX headers fetched from the SDX service are
// used for the RO POST and never touch disk, and the HTTP POST uses node's own
// networking (native DNS -- no static-glibc caveat).
//
// Flow:
//   1. SDX service-request headers (luna) -- in memory only
//   2. RightSessionID + RightObjectURL from the applicense endpoint of the
//      selected store region (--country, or the TV's current region when
//      omitted) unless --sid/--ro-url are given
//   3. addon.init(libncg_agent.so, MAC, secret dir)
//   4. addon.makeRequest(sid) -> HTTP POST to the RO URL (SDX headers)
//   5. addon.save(response)   (rc 0xF0000422 is expected for online licenses)
//   6. addon.cekList() -> the 32-byte CEK for the license
//   7. optional: --verify-file -> addon.openFile + cekFromHandle proves the CEK
//      verifies that NCG file's header through the library itself
//
// Output: exactly one JSON line on stdout, then exit 0 (ok) / 1 (error).
// The signed SDX headers are deliberately NOT included in the output.
//
// Usage (on the TV):
//   node ro-exchange.js --addon /tmp/ncgrow/ncg_native.node \
//     --app-id com.foo.bar --version 1.2.3 \
//     [--country CC] [--api-version 10.0.0] [--sid RSID] [--ro-url URL] \
//     [--so-path /usr/lib/libncg_agent.so.2.0.0] \
//     [--device-id 00:11:22:33:44:55] \
//     [--verify-file /tmp/ncgrow/files/index.html] \
//     [--secret-dir /tmp/ncgrow/secret] [--timeout 30000]
// pmloglib (a webOS logging module) does not exist on the TV's node; stub it
// with no-ops so a require() of it cannot throw.
var Module = require('module');
var originalLoad = Module._load;
var noop = function () {};
var logger = function () {
  return { log: noop, info: noop, warn: noop, warning: noop, error: noop };
};

Module._load = function (request) {
  if (request === 'pmloglib') {
    return {
      log: noop,
      info: noop,
      warning: noop,
      error: noop,
      Console: logger,
      Context: logger
    };
  }
  return originalLoad.apply(this, arguments);
};

var fs = require('fs');
var http = require('http');
var https = require('https');
var path = require('path');
var palmbus = require('palmbus');

var args = {};
for (var i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i]] = process.argv[i + 1];
}

var ADDON_PATH = args['--addon'] || '';
var APP_ID = args['--app-id'] || '';
var APP_VERSION = args['--version'] || '';
var API_VERSION = args['--api-version'] || '10.0.0';
var COUNTRY = args['--country'] || '';
var SID = args['--sid'] || '';
var RO_URL = args['--ro-url'] || '';
var SO_PATH = args['--so-path'] || '';
var DEVICE_ID = args['--device-id'] || '';
var VERIFY_FILE = args['--verify-file'] || '';
var SECRET_DIR = args['--secret-dir'] || '/tmp/ncgrow/secret';
var TIMEOUT_MS = Number(args['--timeout'] || 30000);

var APP_INFO = { sid: SID, roUrl: RO_URL };

function fail(stage, error) {
  console.log(JSON.stringify({ ok: false, stage: stage, error: String(error) }));
  process.exit(1);
}

if (!ADDON_PATH) fail('args', 'missing --addon');
if (!APP_ID || !/^[A-Za-z0-9._-]+$/.test(APP_ID)) fail('args', 'missing/invalid --app-id');
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(APP_VERSION)) fail('args', 'missing/invalid --version');
if (COUNTRY) {
  if (!/^(?:[A-Za-z]{2}|C01)$/i.test(COUNTRY)) fail('args', 'invalid --country code');
  COUNTRY = COUNTRY.toUpperCase();
  if (COUNTRY === 'C01') COUNTRY = 'CN';
}

var native;
try {
  native = require(ADDON_PATH);
} catch (error) {
  fail('addon', 'cannot load ' + ADDON_PATH + ': ' + error.message);
}

// SDX headers ----------------------------------------------------------------
// Anonymous private handle (no app id); the SDX service answers it.
function openPrivateHandle() {
  try {
    return new palmbus.Handle('', false);
  } catch (error) {
    throw new Error('anonymous private palmbus handle unavailable: ' + error.message);
  }
}

function callLunaRaw(handle, uri, payload, timeoutMs, callback) {
  var done = false;
  var timer;
  var finish = function (error, response) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    callback(error, response);
  };
  var call;
  try {
    call = handle.call(uri, JSON.stringify(payload || {}));
  } catch (error) {
    finish(error);
    return;
  }
  call.on('response', function (message) {
    var response;
    try {
      response = JSON.parse(message.payload());
    } catch (error) {
      finish(new Error('invalid JSON from ' + uri));
      return;
    }
    finish(null, response);
  });
  call.on('error', function (error) {
    finish(new Error(String(error && error.message || error)));
  });
  timer = setTimeout(function () {
    finish(new Error('timeout calling ' + uri));
  }, timeoutMs);
}

function sdxHeaders(response) {
  var headers = {};
  Object.keys(response).forEach(function (key) {
    if (key !== 'returnValue' && key !== 'header' && key !== 'HOST') {
      headers[key] = String(response[key]);
    }
  });
  return headers;
}

// plain HTTP helper ----------------------------------------------------------
// useTls: store endpoints are https/443; the RO server is plain http/80.
function requestHttp(hostname, port, requestPath, headers, method, body,
                     useTls, callback) {
  var request = (useTls ? https : http).request({
    hostname: hostname,
    port: port,
    method: method,
    path: requestPath,
    headers: headers
  }, function (response) {
    var chunks = [];
    response.on('data', function (chunk) { chunks.push(chunk); });
    response.on('end', function () {
      callback(null, {
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      });
    });
  });
  request.on('error', function (error) { callback(error); });
  request.setTimeout(TIMEOUT_MS, function () {
    request.destroy(new Error('request timeout'));
  });
  if (body) request.end(body);
  else request.end();
}

// The store region to query: the TV's current region (SDX HOST) unless
// --country selects a different one. Same pattern as tv/download-ipk.js.
function storeRegion(sdx, country) {
  var headers = sdxHeaders(sdx);
  if (!country) return { hostname: sdx.HOST, headers: headers };
  headers['X-Device-Country'] = country === 'CN' ? 'C01' : country;
  headers['X-Device-Country-Group'] = country;
  if (country === 'CN') {
    headers['X-Device-Language'] = 'zh-CN';
    headers['X-Device-Locale'] = 'zh-CN';
  }
  return { hostname: country + '.nextlgsdp.com', headers: headers };
}

// applicense (sid + RO URL) --------------------------------------------------
function fetchApplicense(sdx, callback) {
  if (APP_INFO.sid && APP_INFO.roUrl) {
    callback(null);
    return;
  }
  var region = storeRegion(sdx, COUNTRY);
  var query = 'app_id=' + encodeURIComponent(APP_ID) +
    '&dev_usb_flag=0&version=' + encodeURIComponent(APP_VERSION);
  var requestPath = '/apps/' + API_VERSION + '/applicense/applicenseurl?' + query;
  requestHttp(region.hostname, 443, requestPath, region.headers, 'GET', null,
    true, function (error, result) {
      if (error) { callback(error); return; }
      if (result.statusCode !== 200) {
        callback(new Error('applicense request to ' + region.hostname +
          ' failed (status ' + result.statusCode + ')'));
        return;
      }
      var j = null;
      try { j = JSON.parse(result.body); } catch (error2) {
        callback(new Error('applicense returned invalid JSON from ' +
          region.hostname));
        return;
      }
      var sec = j.secureURL || {};
      var sid = sec.RightSessionID || '';
      var ro = sec.RightObjectURL || '';
      if (APP_INFO.sid && !sid) sid = APP_INFO.sid;
      if (APP_INFO.roUrl && !ro) ro = APP_INFO.roUrl;
      if (sid && ro) {
        APP_INFO = { sid: sid, roUrl: ro };
        callback(null);
        return;
      }
      callback(new Error('no RightSessionID/RightObjectURL for ' + APP_ID +
        ' in the ' + (COUNTRY || "TV's current") + ' store (try --country, ' +
        'or --sid/--ro-url)'));
    });
}

// The RO POST: plain http (port 80); SDX headers stay in memory.
function postRo(sdx, body, callback) {
  var host = APP_INFO.roUrl.replace(/^http:\/\//, '');
  var slash = host.indexOf('/');
  var hostname = slash === -1 ? host : host.slice(0, slash);
  var requestPath = slash === -1 ? '/' : host.slice(slash);
  var requestHeaders = {};
  Object.keys(sdx).forEach(function (key) { requestHeaders[key] = sdx[key]; });
  requestHeaders['Host'] = hostname;
  requestHeaders['Content-Type'] =
    'application/x-www-form-urlencoded; charset=utf-8';
  requestHeaders['Connection'] = 'close';
  requestHttp(hostname, 80, requestPath, requestHeaders, 'POST', body,
    false, function (error, result) {
      if (error) return callback(error);
      if (result.statusCode !== 200) {
        return callback(new Error('RO POST status ' + result.statusCode));
      }
      callback(null, result.body);
    });
}

// TV-local discovery ---------------------------------------------------------
function readMac() {
  var ifaces = ['eth0', 'eth1'];
  for (var i = 0; i < ifaces.length; i += 1) {
    try {
      var mac = fs.readFileSync('/sys/class/net/' + ifaces[i] + '/address',
        'utf8').trim();
      if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) &&
          mac !== '00:00:00:00:00:00') {
        return mac;
      }
    } catch (error) { /* try the next interface */ }
  }
  return '';
}

function findSo() {
  var candidates = [
    '/usr/lib/libncg_agent.so.2.0.0',
    '/usr/lib/libncg_agent.so.2',
    '/usr/lib/libncg_agent.so'
  ];
  for (var i = 0; i < candidates.length; i += 1) {
    if (fs.existsSync(candidates[i])) return candidates[i];
  }
  // Bounded scan: the firmware tree is large; fail fast instead of hanging.
  var roots = ['/usr/lib', '/opt', '/usr'];
  var visited = 0;
  var MAX_VISIT = 20000, MAX_DEPTH = 4;
  function scan(dir, depth) {
    var entries;
    try { entries = fs.readdirSync(dir); } catch (error) { return null; }
    for (var i = 0; i < entries.length; i += 1) {
      if (visited++ > MAX_VISIT) return null;
      var name = entries[i];
      if (name === '.' || name === '..') continue;
      var full = path.join(dir, name);
      var st;
      try { st = fs.statSync(full); } catch (error) { continue; }
      if (st.isFile() && name.indexOf('libncg_agent.so') === 0) return full;
      if (st.isDirectory() && depth < MAX_DEPTH) {
        var found = scan(full, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  for (var r = 0; r < roots.length; r += 1) {
    var hit = scan(roots[r], 0);
    if (hit) return hit;
  }
  return '';
}

// the exchange ---------------------------------------------------------------
function main() {
  var handle;
  try {
    handle = openPrivateHandle();
  } catch (error) {
    fail('sdx', error.message);
  }

  callLunaRaw(handle,
    'luna://com.webos.service.sdx/getHttpHeaderForServiceRequest', {}, 10000,
    function (sdxError, sdx) {
      if (sdxError) fail('sdx', sdxError.message);
      var headers = sdxHeaders(sdx);
      if (!headers['X-Device-Model']) {
        fail('sdx', 'SDX response is missing X-Device-Model');
      }
      if (!COUNTRY && (!sdx.HOST || !/^[A-Za-z0-9.-]+$/.test(sdx.HOST))) {
        fail('sdx', 'SDX returned an invalid host (pass --country)');
      }

      fetchApplicense(sdx, function (appError) {
        if (appError) fail('applicense', appError.message);
        var mac = DEVICE_ID || readMac();
        if (!mac) fail('device-id', 'could not read the TV MAC (pass --device-id)');
        var so = SO_PATH || findSo();
        if (!so) fail('so-path', 'libncg_agent.so not found (pass --so-path)');

        var initRc = native.init(so, mac, SECRET_DIR);
        if (initRc !== 0) {
          fail('init', 'NCG_Init rc=' + initRc + ' (so=' + so + ')');
        }

        var body;
        try {
          body = native.makeRequest(APP_INFO.sid);
        } catch (error) {
          fail('make-request', error.message);
        }

        postRo(headers, Buffer.from(body), function (postError, resp) {
          if (postError) fail('ro-post', postError.message);

          var saveRc;
          try {
            saveRc = native.save(resp);
          } catch (error) {
            fail('save', error.message);
          }
          // 0xF0000422: license accepted, DB save refused by design for online
          // verification -- the in-memory license is valid.
          if (saveRc !== 0 && (saveRc >>> 0) !== 0xF0000422) {
            fail('save', 'NCG_SaveROResponseMsg rc=0x' +
              (saveRc >>> 0).toString(16));
          }

          var licenses;
          try {
            licenses = native.cekList();
          } catch (error) {
            fail('cek-list', error.message);
          }
          if (!licenses.length) {
            fail('cek', 'no license in memory after save (save rc=0x' +
              (saveRc >>> 0).toString(16) + ')');
          }
          var cek = licenses[0];

          var finish = function (verified, verifyDetail) {
            console.log(JSON.stringify({
              ok: true,
              appId: APP_ID,
              appVersion: APP_VERSION,
              sid: APP_INFO.sid,
              roUrl: APP_INFO.roUrl,
              soPath: so,
              deviceId: mac,
              initRc: initRc,
              saveRc: saveRc >>> 0,
              verified: verified,
              verifyDetail: verifyDetail,
              cek: { cid: cek.cid, b64: cek.cekB64 },
              licenses: licenses
            }));
            process.exit(0);
          };

          if (!VERIFY_FILE) { finish(null, null); return; }

          var id;
          try {
            id = native.openFile(VERIFY_FILE);
          } catch (error) {
            finish(false, 'openFile threw: ' + error.message);
            return;
          }
          if (id < 0) {
            finish(false, 'NCG_OpenAndVerifyFile failed for ' + VERIFY_FILE +
              ' (CEK does not verify this file?)');
            return;
          }
          var handleCek = native.cekFromHandle(id);
          native.closeFile(id);
          if (handleCek === cek.cekB64) {
            finish(true, 'library CEK for ' + VERIFY_FILE +
              ' matches the license CEK');
          } else {
            finish(false, 'library CEK for ' + VERIFY_FILE +
              ' differs from the license CEK');
          }
        });
      });
    });
}

main();
