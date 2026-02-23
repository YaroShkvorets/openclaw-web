// Served at /setup/app.js — Pinax-branded OpenClaw Setup
(function () {
  var $ = function (id) { return document.getElementById(id); };

  var statusEl = $('status');
  var statusDetailsEl = $('statusDetails');
  var authGroupEl = $('authGroup');
  var authChoiceEl = $('authChoice');
  var logEl = $('log');
  var consoleCmdEl = $('consoleCmd');
  var consoleArgEl = $('consoleArg');
  var consoleRunEl = $('consoleRun');
  var consoleOutEl = $('consoleOut');
  var configPathEl = $('configPath');
  var configTextEl = $('configText');
  var configReloadEl = $('configReload');
  var configSaveEl = $('configSave');
  var configOutEl = $('configOut');
  var importFileEl = $('importFile');
  var importRunEl = $('importRun');
  var importOutEl = $('importOut');

  // Accordion logic
  document.querySelectorAll('.accordion-trigger').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var content = btn.nextElementSibling;
      var isOpen = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!isOpen));
      if (!isOpen) {
        content.style.maxHeight = content.scrollHeight + 'px';
        content.style.opacity = '1';
      } else {
        content.style.maxHeight = '0';
        content.style.opacity = '0';
      }
    });
  });

  // Auto-open first section
  var firstTrigger = document.querySelector('.accordion-trigger');
  if (firstTrigger) firstTrigger.click();

  function isInteractiveOAuth(optionValue, optionLabel) {
    var v = String(optionValue || '');
    var l = String(optionLabel || '');
    return l.indexOf('OAuth') !== -1 || v.indexOf('cli') !== -1 || v.indexOf('codex') !== -1 || v.indexOf('portal') !== -1;
  }

  function renderAuth(groups) {
    authGroupEl.innerHTML = '';

    var advancedToggle = $('showAdvancedAuth');
    if (!advancedToggle) {
      var label = document.createElement('label');
      label.className = 'toggle-label';
      label.innerHTML = '<input type="checkbox" id="showAdvancedAuth" /> Show interactive OAuth options';
      authGroupEl.parentNode.insertBefore(label, authChoiceEl);
    }

    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var opt = document.createElement('option');
      opt.value = g.value;
      opt.textContent = g.label + (g.hint ? ' — ' + g.hint : '');
      authGroupEl.appendChild(opt);
    }

    function rerenderChoices() {
      var sel = null;
      for (var j = 0; j < groups.length; j++) {
        if (groups[j].value === authGroupEl.value) sel = groups[j];
      }
      authChoiceEl.innerHTML = '';
      var opts = (sel && sel.options) ? sel.options : [];
      var showAdv = Boolean($('showAdvancedAuth') && $('showAdvancedAuth').checked);

      var firstNonInteractive = null;
      for (var k = 0; k < opts.length; k++) {
        var o = opts[k];
        var interactive = isInteractiveOAuth(o.value, o.label);
        if (interactive && !showAdv) continue;
        if (!interactive && !firstNonInteractive) firstNonInteractive = o.value;

        var opt2 = document.createElement('option');
        opt2.value = o.value;
        opt2.textContent = o.label + (interactive ? ' (interactive)' : '');
        authChoiceEl.appendChild(opt2);
      }
      if (firstNonInteractive) authChoiceEl.value = firstNonInteractive;
    }

    authGroupEl.onchange = rerenderChoices;
    var advEl = $('showAdvancedAuth');
    if (advEl) advEl.onchange = rerenderChoices;
    rerenderChoices();
  }

  function httpJson(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error('HTTP ' + res.status + ': ' + (t || res.statusText)); });
      return res.json();
    });
  }

  function refreshStatus() {
    statusEl.textContent = 'Checking...';
    if (statusDetailsEl) statusDetailsEl.textContent = '';

    return httpJson('/setup/api/status').then(function (j) {
      var ver = j.openclawVersion ? j.openclawVersion : '';
      var badge = j.configured
        ? '<span class="badge badge-ok">Configured</span>'
        : '<span class="badge badge-warn">Not configured</span>';
      statusEl.innerHTML = badge + (ver ? ' <span class="version-tag">' + ver + '</span>' : '');

      if (statusDetailsEl) {
        statusDetailsEl.textContent = 'Gateway: ' + (j.gatewayTarget || '(unknown)');
      }

      if (configReloadEl && configTextEl) loadConfigRaw();
    }).catch(function (e) {
      statusEl.innerHTML = '<span class="badge badge-err">Error</span> ' + String(e);
    });
  }

  function loadAuthGroupsFast() {
    return httpJson('/setup/api/auth-groups').then(function (j) {
      if (j && j.authGroups && j.authGroups.length > 0) {
        renderAuth(j.authGroups);
        return;
      }
      throw new Error('Missing authGroups');
    }).catch(function () { renderAuth([]); });
  }

  // Run setup
  $('run').onclick = function () {
    var payload = {
      flow: $('flow').value,
      authChoice: authChoiceEl.value,
      authSecret: $('authSecret').value,
      telegramToken: $('telegramToken').value,
      discordToken: $('discordToken').value,
      slackBotToken: $('slackBotToken').value,
      slackAppToken: $('slackAppToken').value,
      customProviderId: $('customProviderId').value,
      customProviderBaseUrl: $('customProviderBaseUrl').value,
      customProviderApi: $('customProviderApi').value,
      customProviderApiKeyEnv: $('customProviderApiKeyEnv').value,
      customProviderModelId: $('customProviderModelId').value,
    };
    logEl.textContent = 'Running setup...\n';
    fetch('/setup/api/run', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (res) { return res.text(); })
      .then(function (text) {
        var j; try { j = JSON.parse(text); } catch (_e) { j = { ok: false, output: text }; }
        logEl.textContent += (j.output || JSON.stringify(j, null, 2));
        return refreshStatus();
      }).catch(function (e) { logEl.textContent += '\nError: ' + String(e) + '\n'; });
  };

  // Debug console
  function runConsole() {
    var cmd = consoleCmdEl.value;
    var arg = consoleArgEl ? consoleArgEl.value : '';
    if (consoleOutEl) consoleOutEl.textContent = '$ ' + cmd + (arg ? ' ' + arg : '') + '\n';
    return httpJson('/setup/api/console/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: cmd, arg: arg }),
    }).then(function (j) {
      if (consoleOutEl) consoleOutEl.textContent += (j.output || JSON.stringify(j, null, 2));
      return refreshStatus();
    }).catch(function (e) {
      if (consoleOutEl) consoleOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }
  if (consoleRunEl) consoleRunEl.onclick = runConsole;

  // Config editor
  function loadConfigRaw() {
    if (!configTextEl) return;
    if (configOutEl) configOutEl.textContent = '';
    return httpJson('/setup/api/config/raw').then(function (j) {
      if (configPathEl) configPathEl.textContent = (j.path || '') + (j.exists ? '' : ' (not created yet)');
      configTextEl.value = j.content || '';
    }).catch(function (e) {
      if (configOutEl) configOutEl.textContent = 'Error: ' + String(e);
    });
  }

  function saveConfigRaw() {
    if (!configTextEl) return;
    if (!confirm('Save config and restart gateway?')) return;
    if (configOutEl) configOutEl.textContent = 'Saving...\n';
    return httpJson('/setup/api/config/raw', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: configTextEl.value }),
    }).then(function (j) {
      if (configOutEl) configOutEl.textContent = 'Saved → ' + (j.path || '') + '\nGateway restarted.';
      return refreshStatus();
    }).catch(function (e) {
      if (configOutEl) configOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }
  if (configReloadEl) configReloadEl.onclick = loadConfigRaw;
  if (configSaveEl) configSaveEl.onclick = saveConfigRaw;

  // Import
  function runImport() {
    var f = importFileEl.files && importFileEl.files[0];
    if (!f) { alert('Pick a .tar.gz file first'); return; }
    if (!confirm('Import backup? This overwrites files and restarts the gateway.')) return;
    if (importOutEl) importOutEl.textContent = 'Uploading ' + f.name + '...\n';
    f.arrayBuffer().then(function (buf) {
      return fetch('/setup/import', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/gzip' }, body: buf,
      });
    }).then(function (res) {
      return res.text().then(function (t) {
        if (importOutEl) importOutEl.textContent += t + '\n';
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + t);
        return refreshStatus();
      });
    }).catch(function (e) {
      if (importOutEl) importOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }
  if (importRunEl) importRunEl.onclick = runImport;

  // Pairing
  var pairingBtn = $('pairingApprove');
  if (pairingBtn) {
    pairingBtn.onclick = function () {
      var channel = prompt('Channel (telegram or discord):');
      if (!channel) return;
      channel = channel.trim().toLowerCase();
      if (channel !== 'telegram' && channel !== 'discord') { alert('Must be "telegram" or "discord"'); return; }
      var code = prompt('Pairing code:');
      if (!code) return;
      logEl.textContent += '\nApproving ' + channel + ' pairing...\n';
      fetch('/setup/api/pairing/approve', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: channel, code: code.trim() }),
      }).then(function (r) { return r.text(); })
        .then(function (t) { logEl.textContent += t + '\n'; })
        .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
    };
  }

  // Device pairing
  var devicesRefreshBtn = $('devicesRefresh');
  var devicesListEl = $('devicesList');

  function approveDevice(requestId) {
    if (!confirm('Approve device ' + requestId + '?')) return;
    if (devicesListEl) devicesListEl.textContent = 'Approving...';
    return httpJson('/setup/api/devices/approve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: requestId }),
    }).then(function (j) {
      if (devicesListEl) devicesListEl.textContent = j.output || 'Approved.';
      return refreshStatus();
    }).catch(function (e) {
      if (devicesListEl) devicesListEl.textContent = 'Error: ' + String(e);
    });
  }

  function refreshDevices() {
    if (!devicesListEl) return;
    devicesListEl.textContent = 'Loading...';
    return httpJson('/setup/api/devices/pending').then(function (j) {
      var ids = j.requestIds || [];
      if (!ids.length) { devicesListEl.textContent = 'No pending requests.'; return; }
      devicesListEl.innerHTML = '';
      for (var i = 0; i < ids.length; i++) {
        (function (id) {
          var row = document.createElement('div');
          row.style.marginTop = '0.25rem';
          var btn = document.createElement('button');
          btn.className = 'btn btn-sm';
          btn.textContent = 'Approve ' + id;
          btn.onclick = function () { approveDevice(id); };
          row.appendChild(btn);
          devicesListEl.appendChild(row);
        })(ids[i]);
      }
    }).catch(function (e) { devicesListEl.textContent = 'Error: ' + String(e); });
  }
  if (devicesRefreshBtn) devicesRefreshBtn.onclick = refreshDevices;

  // Reset
  $('reset').onclick = function () {
    if (!confirm('Reset setup? This deletes the config so you can re-run onboarding.')) return;
    logEl.textContent = 'Resetting...\n';
    fetch('/setup/api/reset', { method: 'POST', credentials: 'same-origin' })
      .then(function (res) { return res.text(); })
      .then(function (t) { logEl.textContent += t + '\n'; return refreshStatus(); })
      .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
  };

  // Init
  loadAuthGroupsFast();
  refreshStatus();
})();
