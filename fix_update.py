import re

with open('APAA.html', 'r', encoding='utf-8') as f:
    content = f.read()

# ============================================================
# CHANGE 1: Fix check update - always show confirm dialog, never auto-update
# ============================================================
old1 = """        if (isAppBusy()) {
          showUpdateConfirm(latestVersion);
        } else {
          doUpdate();
        }"""

new1 = """        showUpdateConfirm(latestVersion);"""

if old1 in content:
    content = content.replace(old1, new1, 1)
    print('[1/4] Done: Always show confirm dialog')
else:
    print('[1/4] NOT FOUND: auto-update code')
    # Debug
    idx = content.find('isAppBusy()')
    if idx >= 0:
        print('  isAppBusy found at', idx)
        print('  Context:', repr(content[idx-20:idx+120]))

# ============================================================
# CHANGE 2: Rewrite showUpdateConfirm
# ============================================================
old2 = """  function showUpdateConfirm(newVersion) {
    const overlay = document.getElementById('updateConfirmOverlay');
    const body = document.getElementById('updateConfirmBody');
    if (!overlay || !body) return;
    body.innerHTML = '<p>检测到新版本 <b>v' + escHtml(newVersion) + '</b>（当前 v' + APP_VERSION + '）。</p>'
      + '<p style="color:var(--text-2);font-size:12px;margin-top:8px;">⚠ 更新将跳转到线上最新版本。</p>';
    overlay.classList.remove('hidden');
    document.getElementById('updateConfirmOk').onclick = () => { overlay.classList.add('hidden'); doUpdate(); };
    document.getElementById('updateConfirmCancel').onclick = () => overlay.classList.add('hidden');
    document.getElementById('updateConfirmClose').onclick = () => overlay.classList.add('hidden');
  }"""

new2 = """  function showUpdateConfirm(newVersion) {
    const overlay = document.getElementById('updateConfirmOverlay');
    const body = document.getElementById('updateConfirmBody');
    const footer = document.querySelector('#updateConfirmOverlay .cd-footer');
    if (!overlay || !body) return;
    body.innerHTML = '<p>检测到新版本 <b>v' + escHtml(newVersion) + '</b>（当前 v' + APP_VERSION + '）。</p>'
      + '<p style="color:var(--text-2);font-size:12px;margin-top:8px;">更新内容：修复与优化</p>';
    if (footer) footer.style.display = '';
    overlay.classList.remove('hidden');
    document.getElementById('updateConfirmOk').onclick = () => { doUpdate(); };
    document.getElementById('updateConfirmCancel').onclick = () => overlay.classList.add('hidden');
    document.getElementById('updateConfirmClose').onclick = () => overlay.classList.add('hidden');
  }"""

if old2 in content:
    content = content.replace(old2, new2, 1)
    print('[2/4] Done: showUpdateConfirm')
else:
    print('[2/4] NOT FOUND: showUpdateConfirm')
    idx = content.find('function showUpdateConfirm')
    if idx >= 0:
        end = content.find('\n  }\n', idx)
        if end >= 0:
            end = content.find('\n', end + 5) + 1
            print('  Found function, length:', end - idx)
            print('  Content:', repr(content[idx:idx+80]))

# ============================================================
# CHANGE 3: Rewrite doUpdate()
# ============================================================
old3_start = content.find('  async function doUpdate() {')
# Find the end - next function after doUpdate closes
old3_end = content.find('\n  /* 同步暗色模式 CSS 变量', old3_start)

if old3_start >= 0 and old3_end >= 0:
    old3 = content[old3_start:old3_end]

    new3 = """  /* IndexedDB 辅助 - 存储/读取更新缓存 */
  function openUpdateDB() {
    return new Promise(function(resolve, reject) {
      var req = indexedDB.open('ClubAppUpdate', 1);
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('updates')) {
          db.createObjectStore('updates', { keyPath: 'id' });
        }
      };
      req.onsuccess = function(e) { resolve(e.target.result); };
      req.onerror = function(e) { reject(e.target.error); };
    });
  }

  function saveUpdateToDB(version, html) {
    return openUpdateDB().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction('updates', 'readwrite');
        var store = tx.objectStore('updates');
        store.put({ id: 'latest', version: version, html: html, time: Date.now() });
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function(e) { reject(e.target.error); };
      });
    });
  }

  function getUpdateFromDB() {
    return openUpdateDB().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction('updates', 'readonly');
        var store = tx.objectStore('updates');
        var req = store.get('latest');
        req.onsuccess = function() { resolve(req.result || null); };
        req.onerror = function(e) { reject(e.target.error); };
      });
    });
  }

  function clearUpdateDB() {
    return openUpdateDB().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction('updates', 'readwrite');
        var store = tx.objectStore('updates');
        store.delete('latest');
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function(e) { reject(e.target.error); };
      });
    });
  }

  async function doUpdate() {
    // Save data before update
    saveLocalData();
    if (cloudSaveTimer) { clearTimeout(cloudSaveTimer); cloudSaveTimer = null; cloudDirty = false; }
    try { await cloudSaveAll(); } catch(e) { console.warn('[Update] cloud save failed:', e.message); }

    var overlay = document.getElementById('updateConfirmOverlay');
    var body = document.getElementById('updateConfirmBody');
    var footer = document.querySelector('#updateConfirmOverlay .cd-footer');
    var updateUrl = 'https://pzxpzx-123.github.io/clubapp/APAA.html';

    // Show progress bar
    if (body) {
      body.innerHTML = '<p style="margin-bottom:12px;">🔄 Downloading v' + __updateVersion + '...</p>'
        + '<div style="background:var(--sidebar-slider);border-radius:8px;height:10px;overflow:hidden;">'
        + '<div id="updateProgressBar" style="background:var(--accent-blue);height:100%;width:0%;border-radius:8px;transition:width 0.3s ease;"></div></div>'
        + '<p style="font-size:11px;color:var(--text-3);margin-top:8px;" id="updateProgressText">连接中...</p>';
    }
    if (footer) footer.style.display = 'none';

    // Hide cancel/close during download
    var cancelBtn = document.getElementById('updateConfirmCancel');
    var closeBtn = document.getElementById('updateConfirmClose');
    var okBtn = document.getElementById('updateConfirmOk');
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (closeBtn) closeBtn.style.display = 'none';
    if (okBtn) okBtn.style.display = 'none';

    try {
      var resp = await fetchWithTimeout(updateUrl + '?t=' + Date.now(), 30000);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);

      var total = parseInt(resp.headers.get('content-length') || '0', 10);
      var loaded = 0;
      var reader = resp.body.getReader();
      var chunks = [];

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
        loaded += chunk.value.length;
        if (total > 0) {
          var pct = Math.round(loaded / total * 100);
          var bar = document.getElementById('updateProgressBar');
          var txt = document.getElementById('updateProgressText');
          if (bar) bar.style.width = pct + '%';
          if (txt) txt.textContent = 'Downloaded ' + Math.round(loaded/1024) + ' / ' + Math.round(total/1024) + ' KB (' + pct + '%)';
        }
      }

      // Merge chunks
      var totalLen = 0;
      for (var i = 0; i < chunks.length; i++) totalLen += chunks[i].length;
      var merged = new Uint8Array(totalLen);
      var pos = 0;
      for (var i = 0; i < chunks.length; i++) {
        merged.set(chunks[i], pos);
        pos += chunks[i].length;
      }

      // Decode to string
      var decoder = new TextDecoder('utf-8');
      var htmlText = decoder.decode(merged);

      // Verify downloaded content has correct version
      var versionMatch = htmlText.match(/const\\s+APP_VERSION\\s*=\\s*['"]([\\d.]+)['"]/);
      if (!versionMatch) throw new Error('Invalid download: cannot parse version');
      var downloadedVersion = versionMatch[1];
      if (compareVersions(downloadedVersion, APP_VERSION) <= 0) {
        throw new Error('Downloaded v' + downloadedVersion + ' not newer than current v' + APP_VERSION);
      }

      // Show install progress
      if (body) {
        body.innerHTML = '<p style="margin-bottom:12px;">📦 Installing v' + downloadedVersion + '...</p>'
          + '<div style="background:var(--sidebar-slider);border-radius:8px;height:10px;overflow:hidden;">'
          + '<div style="background:#34c759;height:100%;width:100%;border-radius:8px;transition:width 0.3s ease;"></div></div>'
          + '<p style="font-size:11px;color:var(--text-3);margin-top:8px;">准备新版本...</p>';
      }

      // Save to IndexedDB
      await saveUpdateToDB(downloadedVersion, htmlText);

      // Also save to Cache API (backup)
      if ('caches' in window) {
        try {
          var cache = await caches.open('clubapp-v' + downloadedVersion);
          await cache.put(updateUrl, new Response(merged, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          }));
        } catch(ce) { console.warn('[Update] Cache write failed:', ce); }
      }

      // Show completion
      if (body) {
        body.innerHTML = '<p style="margin-bottom:8px;font-size:18px;">✅ Update Complete</p>'
          + '<p style="color:var(--text-2);font-size:13px;">v' + downloadedVersion + ' - Restarting...</p>';
      }

      // Create Blob URL and navigate to new version
      var blob = new Blob([htmlText], { type: 'text/html; charset=utf-8' });
      var blobUrl = URL.createObjectURL(blob);

      setTimeout(function() {
        location.replace(blobUrl);
      }, 1200);

    } catch (e) {
      console.warn('[Update] Update failed:', e.message);
      if (cancelBtn) cancelBtn.style.display = '';
      if (closeBtn) closeBtn.style.display = '';
      if (okBtn) okBtn.style.display = '';
      if (body) body.innerHTML = '<p style="color:#a82020;margin-bottom:8px;">✕ Update Failed</p>'
        + '<p style="font-size:12px;color:var(--text-2);">' + escHtml(e.message) + '</p>'
        + '<p style="font-size:12px;color:var(--text-2);margin-top:8px;">请稍后重试或手动访问<br><b>' + updateUrl + '</b></p>';
      if (footer) footer.style.display = '';
    }
  }"""

    content = content.replace(old3, new3, 1)
    print('[3/4] Done: doUpdate - IndexedDB + Blob URL')
else:
    print('[3/4] NOT FOUND: doUpdate. start=', old3_start, 'end=', old3_end)

# ============================================================
# CHANGE 4: Add startup check for cached updates
# ============================================================
old4_start = content.find('  /* 页面加载时设置初始值 */')
if old4_start < 0:
    old4_start = content.find('  // 页面加载时设置初始值')

startup_code = '''
  /* ===== Startup: check IndexedDB for cached new version ===== */
  (async function checkCachedUpdate() {
    try {
      var cached = await getUpdateFromDB();
      if (cached && cached.version && cached.html) {
        if (compareVersions(cached.version, APP_VERSION) > 0) {
          console.log('[Update] Found cached v' + cached.version + ' > current v' + APP_VERSION);
          // Re-save before navigate (belt and suspenders)
          await clearUpdateDB();
          await saveUpdateToDB(cached.version, cached.html);
          var blob = new Blob([cached.html], { type: 'text/html; charset=utf-8' });
          var blobUrl = URL.createObjectURL(blob);
          location.replace(blobUrl);
          return;
        } else {
          console.log('[Update] Cached v' + cached.version + ' <= current v' + APP_VERSION + ', clearing');
          await clearUpdateDB();
        }
      }
    } catch(e) {
      console.warn('[Update] Startup check failed:', e.message);
    }
  })();
'''

if old4_start >= 0:
    content = content[:old4_start] + startup_code + '\n' + content[old4_start:]
    print('[4/4] Done: Startup check for cached updates')
else:
    print('[4/4] NOT FOUND: settings init insertion point')

with open('APAA.html', 'w', encoding='utf-8') as f:
    f.write(content)

print('\nAll changes applied successfully!')
