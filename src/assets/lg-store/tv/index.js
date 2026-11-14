#!/usr/bin/env node
'use strict';

// LS2-launched JS service for webOS Dev Manager. Performs one live RO (Right
// Object) exchange per luna call, driving the TV's own libncg_agent.so through
// the ncg_native.node addon the desktop app uploads first. Runs with a proper
// LS2 identity, which is required on webOS 11 (fw 43.x): palmbus handles
// created from an SSH session crash the native module
// ("basic_string::_S_construct null not valid") because findMyAppId() builds a
// std::string from a null script name outside a launched service.
//
// Called by the desktop app: luna://com.webos.devman.sdx/exchange with params:
//   addonPath, appId, appVersion, verifyFile, secretDir,
//   [country] [apiVersion] [deviceId] [soPath] [sid] [roUrl] [timeout]
// Responds with the same JSON the original ro-exchange.js printed on stdout.

var Module = require('module');
var originalLoad = Module._load;
var noop = function () {};
var logger = function () {
  return { log: noop, info: noop, warn: noop, warning: noop, error: noop };
};

Module._load = function (request) {
  if (request === 'pmloglib') {
    return {
      log: noop, info: noop, warning: noop, error: noop,
      Console: logger, Context: logger
    };
  }
  return originalLoad.apply(this, arguments);
};

var fs = require('fs');
var http = require('http');
var https = require('https');
var path = require('path');
var Service = require('webos-service');

var service = new Service('com.webos.devman.sdx');
// Keep the service resident: webos-service exits after ~5 s idle, which could
// tear down an exchange still waiting on the network.
setInterval(function () {}, 60000);

function fail(message, stage, error) {
  message.respond({ ok: false, stage: stage, error: String(error && error.message || error) });
}

// plain HTTP helper ----------------------------------------------------------
// useTls: store endpoints are https/443; the RO server is plain http/80.
function requestHttp(hostname, port, requestPath, headers, method, body,
                     useTls, timeoutMs, callback) {
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
  request.setTimeout(timeoutMs, function () {
    request.destroy(new Error('request timeout'));
  });
  if (body) request.end(body);
  else request.end();
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

// The store region to query: the TV's current region (SDX HOST) unless
// country selects a different one. Same pattern as tv/download-ipk.js.
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
function fetchApplicense(p, appInfo, sdx, callback) {
  if (appInfo.sid && appInfo.roUrl) {
    callback(null);
    return;
  }
  var region = storeRegion(sdx, p.country);
  var query = 'app_id=' + encodeURIComponent(p.appId) +
    '&dev_usb_flag=0&version=' + encodeURIComponent(p.appVersion);
  var requestPath = '/apps/' + p.apiVersion + '/applicense/applicenseurl?' + query;
  requestHttp(region.hostname, 443, requestPath, region.headers, 'GET', null,
    true, p.timeoutMs, function (error, result) {
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
      if (appInfo.sid && !sid) sid = appInfo.sid;
      if (appInfo.roUrl && !ro) ro = appInfo.roUrl;
      if (sid && ro) {
        appInfo.sid = sid;
        appInfo.roUrl = ro;
        callback(null);
        return;
      }
      callback(new Error('no RightSessionID/RightObjectURL for ' + p.appId +
        ' in the ' + (p.country || "TV's current") + ' store'));
    });
}

// The RO POST: plain http (port 80); SDX headers stay in memory.
function postRo(p, appInfo, sdx, body, callback) {
  var host = appInfo.roUrl.replace(/^http:\/\//, '');
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
    false, p.timeoutMs, function (error, result) {
      if (error) return callback(error);
      if (result.statusCode !== 200) {
        return callback(new Error('RO POST status ' + result.statusCode));
      }
      callback(null, result.body);
    });
}

// TV-local discovery ---------------------------------------------------------
function readMac(p) {
  if (p.deviceId) return p.deviceId;
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

function findSo(p) {
  if (p.soPath) return p.soPath;
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
service.registerMethod('/exchange', function (message) {
  var p = message.payload || {};
  p.timeoutMs = Number(p.timeout || 30000);
  if (!p.addonPath) return fail(message, 'args', 'missing addonPath');
  if (!p.appId || !/^[A-Za-z0-9._-]+$/.test(p.appId)) return fail(message, 'args', 'missing/invalid appId');
  if (!p.appVersion || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(p.appVersion)) return fail(message, 'args', 'missing/invalid appVersion');
  if (!p.verifyFile) return fail(message, 'args', 'missing verifyFile');
  var country = (p.country || '').toUpperCase();
  if (country === 'C01') country = 'CN';
  p.country = country;
  p.apiVersion = p.apiVersion || '10.0.0';
  var appInfo = { sid: p.sid || '', roUrl: p.roUrl || '' };

  var native;
  try {
    native = require(p.addonPath);
  } catch (error) {
    return fail(message, 'addon', 'cannot load ' + p.addonPath + ': ' + error.message);
  }

  service.call('luna://com.webos.service.sdx/getHttpHeaderForServiceRequest', {},
    function (m) {
      var sdx = (m && m.payload) || {};
      if (sdx.returnValue === false) {
        return fail(message, 'sdx', sdx.errorText || 'SDX call rejected');
      }
      var headers = sdxHeaders(sdx);
      if (!headers['X-Device-Model']) {
        return fail(message, 'sdx', 'SDX response is missing X-Device-Model');
      }
      if (!p.country && (!sdx.HOST || !/^[A-Za-z0-9.-]+$/.test(sdx.HOST))) {
        return fail(message, 'sdx', 'SDX returned an invalid host (pass country)');
      }

      fetchApplicense(p, appInfo, sdx, function (appError) {
        if (appError) return fail(message, 'applicense', appError.message);
        var mac = readMac(p);
        if (!mac) return fail(message, 'device-id', 'could not read the TV MAC (pass deviceId)');
        var so = findSo(p);
        if (!so) return fail(message, 'so-path', 'libncg_agent.so not found (pass soPath)');

        var initRc = native.init(so, mac, p.secretDir || '/tmp/ncgrow/secret');
        if (initRc !== 0) {
          return fail(message, 'init', 'NCG_Init rc=' + initRc + ' (so=' + so + ')');
        }

        var body;
        try {
          body = native.makeRequest(appInfo.sid);
        } catch (error) {
          return fail(message, 'make-request', error.message);
        }

        postRo(p, appInfo, sdx, Buffer.from(body), function (postError, resp) {
          if (postError) return fail(message, 'ro-post', postError.message);

          var saveRc;
          try {
            saveRc = native.save(resp);
          } catch (error) {
            return fail(message, 'save', error.message);
          }
          // 0xF0000422: license accepted, DB save refused by design for online
          // verification -- the in-memory license is valid.
          if (saveRc !== 0 && (saveRc >>> 0) !== 0xF0000422) {
            return fail(message, 'save', 'NCG_SaveROResponseMsg rc=0x' +
              (saveRc >>> 0).toString(16));
          }

          var licenses;
          try {
            licenses = native.cekList();
          } catch (error) {
            return fail(message, 'cek-list', error.message);
          }
          if (!licenses.length) {
            return fail(message, 'cek', 'no license in memory after save (save rc=0x' +
              (saveRc >>> 0).toString(16) + ')');
          }
          var cek = licenses[0];

          var finish = function (verified, verifyDetail) {
            message.respond({
              ok: true,
              appId: p.appId,
              appVersion: p.appVersion,
              sid: appInfo.sid,
              roUrl: appInfo.roUrl,
              soPath: so,
              deviceId: mac,
              initRc: initRc,
              saveRc: saveRc >>> 0,
              verified: verified,
              verifyDetail: verifyDetail,
              cek: { cid: cek.cid, b64: cek.cekB64 },
              licenses: licenses
            });
          };

          var id;
          try {
            id = native.openFile(p.verifyFile);
          } catch (error) {
            return finish(false, 'openFile threw: ' + error.message);
          }
          if (id < 0) {
            return finish(false, 'NCG_OpenAndVerifyFile failed for ' + p.verifyFile +
              ' (CEK does not verify this file?)');
          }
          var handleCek = native.cekFromHandle(id);
          native.closeFile(id);
          if (handleCek === cek.cekB64) {
            finish(true, 'library CEK for ' + p.verifyFile +
              ' matches the license CEK');
          } else {
            finish(false, 'library CEK for ' + p.verifyFile +
              ' differs from the license CEK');
          }
        });
      });
    });
});
