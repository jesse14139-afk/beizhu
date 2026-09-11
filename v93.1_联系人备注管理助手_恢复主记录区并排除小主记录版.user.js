// ==UserScript==
// @name         v93.1、联系人备注管理助手_恢复主记录区并排除小主记录版
// @namespace    wa-remark-helper
// @version      93.1
// @description  联系人备注管理助手 v93.1：修复 v93 误把已关联子记录当作主记录过滤的问题；仅排除真正 MAIN:: 小主记录，恢复主记录专区显示。
// @match        https://web.whatsapp.com/*
// @match        https://www.instagram.com/direct/*
// @match        https://www.messenger.com/*
// @match        https://www.facebook.com/messages/*
// @match        https://web.telegram.org/k/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  var STORAGE_KEY = "wa_remarks_data";
  var SETTINGS_KEY = "wa_remarks_settings";
  var LOCAL_SYNC_URL = "http://127.0.0.1:8765";
  var LOCAL_SYNC_SOURCE_ID_KEY = "wa_local_sync_source_id";
  var LOCAL_SYNC_SOURCE_NAME_KEY = "wa_local_sync_source_name";
  var LOCAL_SYNC_LAST_STATUS = { ok:false, message:"未连接", sources:[], contacts:[], stats:null };
  var LOCAL_SYNC_UPLOAD_KEY = "wa_local_sync_realtime_upload_enabled";
  var LOCAL_SYNC_AGGREGATE_KEY = "wa_local_sync_aggregate_enabled";
  var LOCAL_SYNC_AGGREGATE_TIMER = null;
  var LOCAL_SYNC_UPLOAD_TIMER = null;
  var LOCAL_SYNC_RUNNING = false;
  var LOCAL_SYNC_LAST_AUTO_AT = 0;
  var NOTE_BAR_ID = "wa-remark-bar";

  var FIELDS = [
    { key: "f1", label: "1." },
    { key: "f2", label: "2." },
    { key: "f3", label: "3." },
    { key: "f4", label: "4." },
    { key: "f5", label: "5." },
    { key: "f6", label: "6." },
    { key: "f7", label: "7." },
    { key: "f8", label: "闪光点" },
    { key: "remark", label: "说明" }
  ];

  var STAGES = [
    { key: "s1", label: "一切" },
    { key: "s2", label: "二切" },
    { key: "s3", label: "三切" }
  ];

  var DEFAULT_TAGS1 = [
    { key: "hot", label: "HOT高意向", color: "#e53935" },
    { key: "watch", label: "观察中", color: "#fb8c00" },
    { key: "done", label: "已成交", color: "#43a047" },
    { key: "lost", label: "已流失", color: "#9e9e9e" },
    { key: "other", label: "其他", color: "#5c6bc0" },
    { key: "", label: "无标签", color: "#cfd8dc" }
  ];

  var DEFAULT_TAGS2 = [
    { key: "vip", label: "高客单", color: "#8e24aa" },
    { key: "us", label: "美区", color: "#1e88e5" },
    { key: "eu", label: "欧区", color: "#00acc1" },
    { key: "b2b", label: "B2B批发", color: "#3949ab" },
    { key: "b2c", label: "终端零售", color: "#d81b60" },
    { key: "sample", label: "已寄样", color: "#f4511e" }
  ];

  function getTags1() {
    var s = getSettings();
    return (s && Array.isArray(s.customTags1) && s.customTags1.length) ? s.customTags1 : DEFAULT_TAGS1;
  }
  function setTags1(list) {
    setSettings({ customTags1: list });
  }

  function getTags2() {
    var s = getSettings();
    return (s && Array.isArray(s.customTags2) && s.customTags2.length) ? s.customTags2 : DEFAULT_TAGS2;
  }
  function setTags2(list) {
    setSettings({ customTags2: list });
  }

  
  function getTag1Color(key) {
    var list = getTags1();
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) return list[i].color || '#cfd8dc';
    }
    return '#cfd8dc';
  }

  function getTag2Color(key) {
    var list = getTags2();
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) return list[i].color || '#78909c';
    }
    return '#78909c';
  }

  var TAGS = getTags1();

  var PLATFORM_INFO = {
    main: { key: "main", label: "主记录", short: "主记录", color: "#6D4C41" },
    wa: { key: "wa", label: "WhatsApp", short: "WA", color: "#25D366" },
    ig: { key: "ig", label: "Instagram", short: "IG", color: "#E1306C" },
    fb: { key: "fb", label: "Messenger", short: "FB", color: "#0084FF" },
    tg: { key: "tg", label: "Telegram", short: "TG", color: "#26A5E4" }
  };
  function getPlatformInfo(p) {
    return PLATFORM_INFO[p] || PLATFORM_INFO.wa;
  }
  function inferPlatform(entry, id) {
    if (entry && entry.isMainRecord) return "main";
    if (typeof id === "string" && id.indexOf("MAIN::") === 0) return "main";
    if (entry && entry.platform) return entry.platform;
    if (typeof id === "string") {
      if (id.indexOf("ig:") === 0) return "ig";
      if (id.indexOf("fb:") === 0) return "fb";
      if (id.indexOf("tg:") === 0) return "tg";
    }
    return "wa";
  }

  function loadData() {
    try { return JSON.parse(GM_getValue(STORAGE_KEY, "{}")); } catch (e) { return {}; }
  }
  function hasMeaningfulUserData(entry) {
    if (!entry) return false;
    if (entry.manualPhone && String(entry.manualPhone).trim()) return true;
    if (entry.tag && String(entry.tag).trim()) return true;
    var tag2 = Array.isArray(entry.tag2) ? entry.tag2 : (entry.tag2 ? [entry.tag2] : []);
    if (tag2.some(function (x) { return String(x || '').trim(); })) return true;
    var stages = Array.isArray(entry.stages) ? entry.stages : (entry.stages ? [entry.stages] : []);
    if (stages.some(function (x) { return String(x || '').trim(); })) return true;
    for (var i = 0; i < FIELDS.length; i++) {
      var k = FIELDS[i].key;
      if (entry[k] && String(entry[k]).trim()) return true;
    }
    return false;
  }

  function pruneEmptyChannelRecords(data) {
    try {
      Object.keys(data || {}).forEach(function (id) {
        var e = data[id];
        if (!e) return;
        if (typeof id === 'string' && id.indexOf('MAIN::') === 0) return;
        if (!hasMeaningfulUserData(e)) delete data[id];
      });
    } catch (e) {}
    return data;
  }

  function saveData(data) { pruneEmptyChannelRecords(data); GM_setValue(STORAGE_KEY, JSON.stringify(data)); try { scheduleLocalSyncAutoUpload(); } catch(e) {} }

  function getSettings() {
    try { return JSON.parse(GM_getValue(SETTINGS_KEY, "{}")); } catch (e) { return {}; }
  }
  function setSettings(patch) {
    var s = Object.assign({}, getSettings(), patch);
    GM_setValue(SETTINGS_KEY, JSON.stringify(s));
    return s;
  }

  function getFieldLabel(key) {
    var s = getSettings();
    var map = s.fieldLabels || {};
    if (map[key]) return map[key];
    for (var i = 0; i < FIELDS.length; i++) {
      if (FIELDS[i].key === key) return FIELDS[i].label;
    }
    return key;
  }
  function setFieldLabels(patchMap) {
    var s = getSettings();
    var map = Object.assign({}, s.fieldLabels || {}, patchMap);
    setSettings({ fieldLabels: map });
  }
  function getStageLabel(key) {
    var s = getSettings();
    var map = s.stageLabels || {};
    if (map[key]) return map[key];
    for (var i = 0; i < STAGES.length; i++) {
      if (STAGES[i].key === key) return STAGES[i].label;
    }
    return key;
  }
  function setStageLabels(patchMap) {
    var s = getSettings();
    var map = Object.assign({}, s.stageLabels || {}, patchMap);
    setSettings({ stageLabels: map });
  }

  function upsertField(id, baseInfo, key, value) {
    var data = loadData();
    var existed = !!data[id];
    if (!existed && !String(value || '').trim()) return;
    data[id] = Object.assign({}, data[id] || {}, baseInfo || {}, { updatedAt: Date.now() });
    data[id][key] = value;
    if (typeof id === 'string' && id.indexOf('MAIN::') !== 0 && !hasMeaningfulUserData(data[id])) {
      delete data[id];
    }
    saveData(data);
  }
  function toggleStage(id, stageKey, checked) {
    var data = loadData();
    var existed = !!data[id];
    if (!existed && !checked) return;
    if (!data[id]) data[id] = {};
    var arr = Array.isArray(data[id].stages) ? data[id].stages.slice() : [];
    var idx = arr.indexOf(stageKey);
    if (checked) { if (idx < 0) arr.push(stageKey); }
    else { if (idx >= 0) arr.splice(idx, 1); }
    data[id].stages = arr;
    data[id].updatedAt = Date.now();
    if (typeof id === 'string' && id.indexOf('MAIN::') !== 0 && !hasMeaningfulUserData(data[id])) {
      delete data[id];
    }
    saveData(data);
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function autoResize(t) {
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 150) + 'px';
  }

  function simpleHash(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  function isPhoneLikeText(str) {
    if (!str) return false;
    var s = String(str).trim();
    if (!s) return false;
    if (!/^[+]?[0-9][0-9\s\-()]{5,}$/.test(s)) return false;
    var digitCount = (s.match(/[0-9]/g) || []).length;
    return digitCount >= 6;
  }

  function normalizePhone(str) {
    if (!str) return '';
    var digits = String(str).replace(/[^0-9]/g, '');
    if (digits.length < 7) return '';
    if (digits.length > 11) digits = digits.slice(-11);
    return digits;
  }

  function createCustomCheckbox(checked, onChange, size) {
    size = size || 14;
    var wrap = document.createElement('span');
    wrap.setAttribute('role', 'checkbox');
    wrap.setAttribute('aria-checked', checked ? 'true' : 'false');
    wrap.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;' +
      'width:' + size + 'px;height:' + size + 'px;min-width:' + size + 'px;border-radius:3px;' +
      'cursor:pointer;border:1.5px solid #8696a0;box-sizing:border-box;flex:0 0 auto;' +
      'user-select:none;font-size:' + Math.round(size * 0.78) + 'px;line-height:1;color:#fff;' +
      'transition:background .15s,border-color .15s;';
    wrap.__checked = !!checked;
    function paint() {
      if (wrap.__checked) {
        wrap.style.background = '#00a884';
        wrap.style.borderColor = '#00a884';
        wrap.textContent = '\u2713';
      } else {
        wrap.style.background = 'transparent';
        wrap.style.borderColor = '#8696a0';
        wrap.textContent = '';
      }
    }
    paint();
    wrap.addEventListener('click', function (e) {
      e.stopPropagation();
      wrap.__checked = !wrap.__checked;
      wrap.setAttribute('aria-checked', wrap.__checked ? 'true' : 'false');
      paint();
      if (typeof onChange === 'function') onChange(wrap.__checked);
    });
    wrap.setChecked = function (v) {
      wrap.__checked = !!v;
      wrap.setAttribute('aria-checked', wrap.__checked ? 'true' : 'false');
      paint();
    };
    return wrap;
  }

  function createCustomCheckboxDoc(doc, checked, onChange, size) {
    size = size || 13;
    var wrap = doc.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;' +
      'width:' + size + 'px;height:' + size + 'px;min-width:' + size + 'px;border-radius:3px;' +
      'cursor:pointer;border:1.5px solid #8696a0;box-sizing:border-box;flex:0 0 auto;' +
      'user-select:none;font-size:' + Math.round(size * 0.78) + 'px;line-height:1;color:#fff;';
    wrap.__checked = !!checked;
    function paint() {
      if (wrap.__indeterminate) {
        wrap.style.background = '#00a884';
        wrap.style.borderColor = '#00a884';
        wrap.textContent = '−';
      } else if (wrap.__checked) {
        wrap.style.background = '#00a884';
        wrap.style.borderColor = '#00a884';
        wrap.textContent = '\u2713';
      } else {
        wrap.style.background = 'transparent';
        wrap.style.borderColor = '#8696a0';
        wrap.textContent = '';
      }
    }
    paint();
    wrap.addEventListener('click', function (e) {
      e.stopPropagation();
      wrap.__indeterminate = false;
      wrap.__checked = !wrap.__checked;
      paint();
      if (typeof onChange === 'function') onChange(wrap.__checked);
    });
    wrap.setChecked = function (v) { wrap.__indeterminate = false; wrap.__checked = !!v; paint(); };
    wrap.setIndeterminate = function (v) { wrap.__indeterminate = !!v; paint(); };
    return wrap;
  }

  function looksLikeStatusText(text) {
    if (!text) return true;
    var t = text.trim();
    if (!t) return true;
    var patterns = [
      /最后上线/, /上次在线/, /^在线$/, /typing/i, /正在输入/,
      /^[0-9]{1,2}:[0-9]{2}$/, /星期[一二三四五六日天]/, /\bonline\b/i,
      /[0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日/, /^昨天/, /^今天/, /\byesterday\b/i, /\btoday\b/i,
      /^[0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}$/, /点击此处查看/, /查看联系人信息/
    ];
    return patterns.some(function (p) { return p.test(t); });
  }

  function getContactName(header) {
    var candidates = [];
    header.querySelectorAll('span[title]').forEach(function (el) {
      var v = el.getAttribute('title');
      if (v) candidates.push(v.trim());
    });
    header.querySelectorAll('span[dir="auto"]').forEach(function (el) {
      var v = el.textContent;
      if (v) candidates.push(v.trim());
    });
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c && !looksLikeStatusText(c)) return c;
    }
    return '';
  }

  function getFiberKey(el) {
    if (!el) return null;
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) {
        return keys[i];
      }
    }
    return null;
  }

  function findJidDeep(obj, depth, visited) {
    if (!obj || depth > 6 || typeof obj !== 'object') return null;
    if (visited.has(obj)) return null;
    visited.add(obj);
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var val;
      try { val = obj[keys[i]]; } catch (e) { continue; }
      if (typeof val === 'string' && /@(c\.us|g\.us|lid)$/.test(val)) {
        return val;
      }
      if (val && typeof val === 'object') {
        var found = findJidDeep(val, depth + 1, visited);
        if (found) return found;
      }
    }
    return null;
  }

  function extractJidViaFiber(header) {
    var node = header;
    var hops = 0;
    while (node && hops < 25) {
      var fiberKey = getFiberKey(node);
      if (fiberKey) {
        var fiber = node[fiberKey];
        var fHops = 0;
        while (fiber && fHops < 20) {
          try {
            if (fiber.memoizedProps) {
              var jid = findJidDeep(fiber.memoizedProps, 0, new Set());
              if (jid) return jid;
            }
            if (fiber.pendingProps) {
              var jid2 = findJidDeep(fiber.pendingProps, 0, new Set());
              if (jid2) return jid2;
            }
          } catch (e) { }
          fiber = fiber.return;
          fHops++;
        }
      }
      node = node.parentElement;
      hops++;
    }
    return null;
  }

  function getFallbackIdFromAvatar(header) {
    var img = header.querySelector('img');
    if (img && img.src) return 'avatar:' + simpleHash(img.src);
    return null;
  }


  // ========================================================
  // v75.1：头像稳定缓存
  // 解决 TG/IG/FB 的 blob/临时头像 URL 在从其他平台打开管理面板时无法显示的问题。
  // 当前平台能访问头像时，将头像转为 dataURL 存入 avatarData；管理面板优先显示 avatarData。
  // ========================================================
  function cacheAvatarDataUrlIfNeeded(contactId, avatarUrl) {
    try {
      if (!contactId || !avatarUrl) return;
      if (avatarUrl.indexOf('data:image/') === 0) return;

      // v75.2：不仅缓存 TG blob，也缓存 IG / Instagram CDN / fbcdn 头像，解决从 WA 打开面板时 IG 头像不显示。
      var shouldCache =
        avatarUrl.indexOf('blob:') === 0 ||
        /instagram|cdninstagram|fbcdn/i.test(avatarUrl);

      if (!shouldCache) return;

      var data = loadData();
      var rec = data[contactId] || {};
      // v75.3：只有当头像 URL 没变时才跳过缓存；URL 变化则允许覆盖旧 avatarData，修复 IG 头像错乱固化问题。
      if (
        rec.avatarData &&
        rec.avatarData.indexOf('data:image/') === 0 &&
        rec.avatar === avatarUrl
      ) {
        return;
      }

      function saveAvatarData(dataUrl) {
        try {
          if (!dataUrl || dataUrl.indexOf('data:image/') !== 0) return;
          var data2 = loadData();
          if (!data2[contactId]) data2[contactId] = {};
          data2[contactId].avatar = avatarUrl;
          data2[contactId].avatarData = dataUrl;
          data2[contactId].updatedAt = Date.now();
          saveData(data2);
          try { refreshPanelIfOpen(); } catch (e) { }
        } catch (e) { }
      }

      function blobToDataUrl(blob) {
        try {
          var reader = new FileReader();
          reader.onload = function () { saveAvatarData(reader.result); };
          reader.readAsDataURL(blob);
        } catch (e) { }
      }

      // 1. blob URL：只能在当前来源页面 fetch，适合 Telegram。
      if (avatarUrl.indexOf('blob:') === 0) {
        fetch(avatarUrl)
          .then(function (res) { return res.blob(); })
          .then(blobToDataUrl)
          .catch(function () { });
        return;
      }

      // 2. 普通 https 图片：优先使用 Tampermonkey GM_xmlhttpRequest，绕过页面 CORS 限制，适合 IG/fbcdn。
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url: avatarUrl,
          responseType: 'blob',
          anonymous: false,
          timeout: 15000,
          onload: function (res) {
            try {
              if (res && res.response) blobToDataUrl(res.response);
            } catch (e) { }
          },
          onerror: function () { },
          ontimeout: function () { }
        });
        return;
      }

      // 3. 兜底 fetch。
      fetch(avatarUrl)
        .then(function (res) { return res.blob(); })
        .then(blobToDataUrl)
        .catch(function () { });

    } catch (e) { }
  }

  function getWaHeaderInfo() {
    var header = document.querySelector('#main header');
    if (!header) return null;
    var name = getContactName(header) || '';
    if (!name) return null;
    var id = extractJidViaFiber(header);
    if (!id) id = getFallbackIdFromAvatar(header);
    if (!id) id = 'name:' + name;
    var avImg = header.querySelector('img[src*="whatsapp.net"]') || header.querySelector('img');
    var avatar = (avImg && avImg.src) ? avImg.src : '';
    return { id: id, name: name, avatar: avatar, platform: 'wa', headerEl: header };
  }

  // ========================================================
  // FB / IG / TG 识别逻辑：恢复 58.1 稳定 DOM 查找函数，并接入 v75.1 avatar/avatarData
  // ========================================================

  var IG_USERNAME_LINK_RE = /^\/[A-Za-z0-9_.]{1,30}\/$/;
  var IG_EXCLUDED_PATHS = ['/reels/', '/explore/', '/accounts/', '/direct/'];
  var IG_SELF_LABELS = ['主页', 'Profile', '个人主页', 'Home'];

  function findIgUsernameLink() {
    var candidates = [];
    document.querySelectorAll('a[href]').forEach(function (a) {
      var href = a.getAttribute('href');
      if (!href || !IG_USERNAME_LINK_RE.test(href)) return;
      if (IG_EXCLUDED_PATHS.indexOf(href) >= 0) return;
      var text = a.textContent.trim();
      if (IG_SELF_LABELS.indexOf(text) >= 0) return;
      var rect = a.getBoundingClientRect();
      if (rect.top < 0 || rect.top > 200) return;
      candidates.push(a);
    });
    var target = null;
    for (var i = 0; i < candidates.length; i++) {
      var span = candidates[i].querySelector('span[title]');
      if (span && span.getAttribute('title')) { target = candidates[i]; break; }
    }
    if (!target) target = candidates[0];
    return target || null;
  }

  function findIgHeaderContainer(usernameLink) {
    var node = usernameLink, hops = 0, best = null;
    while (node && hops < 12) {
      var rect = node.getBoundingClientRect();
      if (rect.top < 140 && rect.width > 280 && rect.height >= 30 && rect.height <= 160) best = node;
      node = node.parentElement; hops++;
    }
    return best || usernameLink.closest('header') || usernameLink.parentElement;
  }

  // ========================================================
  // v75.3：IG 头像精准匹配
  // 避免 headerEl.querySelector('img') 抓到左侧会话列表头像或其他联系人头像
  // ========================================================
  function findIgAvatarForLink(usernameLink, headerEl) {
    try {
      if (!usernameLink) return '';
      var linkRect = usernameLink.getBoundingClientRect();
      if (!linkRect || linkRect.width <= 0 || linkRect.height <= 0) return '';

      var candidates = [];
      var scope = headerEl || document;

      function addCandidate(img, weight) {
        try {
          if (!img || !img.src) return;
          var src = img.src || '';
          if (!src) return;
          if (src.indexOf('data:image/svg') === 0) return;
          if (/emoji|sprite|static|favicon|blank/i.test(src)) return;

          var r = img.getBoundingClientRect();
          if (!r || r.width <= 0 || r.height <= 0) return;
          if (r.top < 0 || r.top > 180) return;
          if (r.width < 24 || r.height < 24 || r.width > 120 || r.height > 120) return;

          var imgCenterX = r.left + r.width / 2;
          var imgCenterY = r.top + r.height / 2;
          var linkCenterX = linkRect.left + linkRect.width / 2;
          var linkCenterY = linkRect.top + linkRect.height / 2;
          var dx = Math.abs(imgCenterX - linkCenterX);
          var dy = Math.abs(imgCenterY - linkCenterY);
          if (dy > 90) return;
          if (dx > 320) return;

          var rightPenalty = imgCenterX > linkCenterX ? 80 : 0;
          var score = dx + dy * 2 + rightPenalty + (weight || 0);
          candidates.push({ img: img, src: src, score: score });
        } catch (e) { }
      }

      if (scope && scope.querySelectorAll) {
        scope.querySelectorAll('img').forEach(function (img) { addCandidate(img, 0); });
      }

      if (!candidates.length) {
        var node = usernameLink;
        var hops = 0;
        while (node && hops < 8) {
          if (node.querySelectorAll) {
            node.querySelectorAll('img').forEach(function (img) { addCandidate(img, hops * 20); });
          }
          node = node.parentElement;
          hops++;
        }
      }

      if (!candidates.length) {
        document.querySelectorAll('img').forEach(function (img) { addCandidate(img, 120); });
      }

      if (candidates.length) {
        candidates.sort(function (a, b) { return a.score - b.score; });
        return candidates[0].src || '';
      }
    } catch (e) { }
    return '';
  }

  function getIgHeaderInfo() {
    if (location.hostname.indexOf('instagram.com') >= 0 && location.pathname.indexOf('/direct/') !== 0) return null;
    var threadMatch = location.pathname.match(/\/direct\/t\/([^\/]+)\/?/);
    var threadId = threadMatch ? threadMatch[1] : null;
    if (!threadId) return null;
    var link = findIgUsernameLink();
    if (!link) return null;
    var username = link.getAttribute('href').replace(/\//g, '');
    var titleSpan = link.querySelector('span[title]');
    var displayName = titleSpan ? titleSpan.getAttribute('title') : username;
    var headerEl = findIgHeaderContainer(link);
    if (!headerEl) return null;
    var avatar = findIgAvatarForLink(link, headerEl);
    return { id: 'ig:' + threadId, name: displayName, username: username, avatar: avatar, platform: 'ig', headerEl: headerEl };
  }

  function findFbMessagePane() {
    var all = document.querySelectorAll('div');
    var best = null, bestScore = -1;
    for (var i = 0; i < all.length; i++) {
      var el = all[i], cs = window.getComputedStyle(el), rect = el.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      if (rect.top < 80 || rect.top > window.innerHeight - 120) continue;
      if (el.clientHeight < 220 || el.clientWidth < 280) continue;
      if (rect.left < 60 && rect.width < window.innerWidth * 0.35) continue;
      if (rect.left > window.innerWidth * 0.88) continue;
      var isScrollable = (cs.overflowY === 'auto' || cs.overflowY === 'scroll');
      var hasConversationAria = false, node = el, hops = 0;
      while (node && hops < 8) {
        var aria = node.getAttribute && node.getAttribute('aria-label');
        if (aria && (/对话|Conversation/i).test(aria)) { hasConversationAria = true; break; }
        node = node.parentElement; hops++;
      }
      var score = 0;
      if (isScrollable) score += 1000;
      if (el.scrollHeight > el.clientHeight + 40) score += 800;
      if (hasConversationAria) score += 1200;
      score += Math.min(rect.width * rect.height / 1000, 1000);
      var center = rect.left + rect.width / 2;
      score -= Math.abs(center - window.innerWidth / 2) / 3;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function getFbNameFromPaneAria(pane) {
    var node = pane, hops = 0;
    while (node && hops < 12) {
      var aria = node.getAttribute && node.getAttribute('aria-label');
      if (aria) {
        var m = aria.match(/^与(.+?)的对话/) || aria.match(/^(.+?)\s*的对话/) || aria.match(/^Conversation\s+with\s+(.+)$/i) || aria.match(/with\s+(.+?)\s*$/i);
        if (m && m[1]) return m[1].trim();
      }
      node = node.parentElement; hops++;
    }
    return '';
  }

  function isFbBadHeaderText(t) {
    if (!t) return true; t = String(t).trim();
    if (!t || t.length > 80) return true;
    return /^(Messenger|Facebook|Chats|聊天|收件箱|搜索|Search|语音通话|视频通话|通话详情|聊天室详情)$/i.test(t);
  }

  function findFbHeaderDirectly() {
    var candidates = [];
    document.querySelectorAll('h1, h2, h3, div[role="heading"], span[dir="auto"]').forEach(function(el) {
      if (!el || el.closest('#wa-remark-bar')) return;
      var rect = el.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      if (rect.top < 0 || rect.top > 150) return;
      if (rect.left < 180) return;
      if (rect.left > window.innerWidth * 0.88) return;
      var t = (el.textContent || el.getAttribute('aria-label') || '').trim();
      if (isFbBadHeaderText(t)) return;
      candidates.push(el);
    });
    candidates.sort(function(a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.top - rb.top) || ((ra.width * ra.height) - (rb.width * rb.height));
    });
    var target = candidates[0];
    if (!target) return null;
    var node = target, hops = 0, best = null;
    while (node && hops < 12) {
      var r = node.getBoundingClientRect();
      if (r.top >= 0 && r.top < 150 && r.width > 150 && r.height >= 25 && r.height <= 170) best = node;
      node = node.parentElement; hops++;
    }
    return best || target;
  }

  function getFbHeaderText(headerEl) {
    if (!headerEl) return '';
    var arr = [];
    headerEl.querySelectorAll('span[title], span[dir="auto"], h1, h2, h3, div[role="heading"]').forEach(function(el){
      var v = (el.getAttribute('title') || el.textContent || '').trim();
      if (v && !isFbBadHeaderText(v)) arr.push(v);
    });
    arr.sort(function(a,b){ return a.length - b.length; });
    return arr[0] || '';
  }

  function findFbHeaderByName(name) {
    if (!name) return null;
    var candidates = [];
    document.querySelectorAll('span, div, h1, h2, h3').forEach(function (el) {
      var t = (el.textContent || '').trim();
      if (t !== name) return;
      var rect = el.getBoundingClientRect();
      if (rect.top < 0 || rect.top > 150) return;
      if (rect.width === 0 && rect.height === 0) return;
      candidates.push(el);
    });
    candidates.sort(function (a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    });
    var target = candidates[0];
    if (!target) return null;
    var node = target, hops = 0, best = null;
    while (node && hops < 12) {
      var rect = node.getBoundingClientRect();
      if (rect.top < 150 && rect.width > 150 && rect.height >= 25 && rect.height <= 160) best = node;
      node = node.parentElement; hops++;
    }
    return best;
  }

  function getFbHeaderInfo() {
    var threadMatch = location.pathname.match(/\/t\/([^\/?]+)\/?/);
    var threadId = threadMatch ? threadMatch[1] : null;
    if (!threadId) return null;
    var pane = findFbMessagePane();
    var name = pane ? getFbNameFromPaneAria(pane) : '';
    var headerEl = name ? findFbHeaderByName(name) : null;
    if (!headerEl) { headerEl = findFbHeaderDirectly(); if (headerEl && !name) name = getFbHeaderText(headerEl); }
    if (!headerEl) return null;
    if (!name) name = getFbHeaderText(headerEl);
    if (!name) name = 'Messenger 联系人';
    var avImg = headerEl.querySelector('image') || headerEl.querySelector('img');
    var avatar = avImg ? (avImg.getAttribute('xlink:href') || avImg.src || '') : '';
    return { id: 'fb:' + threadId, name: name, avatar: avatar, platform: 'fb', headerEl: headerEl };
  }

  function findTgHeaderPeerTitle() {
    var candidates = [];
    document.querySelectorAll('.sidebar-header.topbar span.peer-title[data-peer-id]').forEach(function (el) {
      if (el.closest('#column-right')) return;
      var rect = el.getBoundingClientRect();
      if (rect.top < 0 || rect.top > 120) return;
      candidates.push(el);
    });
    if (!candidates.length) return null;
    candidates.sort(function (a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    });
    return candidates[0];
  }

  function findTgHeaderContainer(peerTitleEl) {
    var node = peerTitleEl, hops = 0, best = null;
    while (node && hops < 10) {
      if (node.classList && node.classList.contains('sidebar-header') && node.classList.contains('topbar')) { best = node; break; }
      node = node.parentElement; hops++;
    }
    return best;
  }

  function getTgHeaderInfo() {
    var peerTitleEl = findTgHeaderPeerTitle();
    if (!peerTitleEl) return null;
    var peerId = peerTitleEl.getAttribute('data-peer-id');
    if (!peerId) return null;
    var threadId = peerTitleEl.getAttribute('data-thread-id') || '0';
    var name = (peerTitleEl.textContent || '').trim();
    if (!name) return null;
    var headerEl = findTgHeaderContainer(peerTitleEl);
    if (!headerEl) return null;
    var uniqueId = 'tg:' + peerId + (threadId !== '0' ? ':' + threadId : '');
    var avImg = headerEl.querySelector('.avatar img') || headerEl.querySelector('img');
    var avatar = (avImg && avImg.src) ? avImg.src : '';
    return { id: uniqueId, name: name, avatar: avatar, platform: 'tg', headerEl: headerEl };
  }

  function getContactInfoUnified() {
    if (location.hostname.indexOf('instagram.com') >= 0) {
      return getIgHeaderInfo();
    }
    if ((location.hostname.indexOf('messenger.com') >= 0 || (location.hostname.indexOf('facebook.com') >= 0 && location.pathname.indexOf('/messages') >= 0))) {
      return getFbHeaderInfo();
    }
    if (location.hostname.indexOf('web.telegram.org') >= 0) {
      return getTgHeaderInfo();
    }
    return getWaHeaderInfo();
  }

  var currentChatId = null;
  var currentChatName = null;
  var currentChatPlatform = null;
  var managePanelWindow = null;
  var __linkedFieldEditModeByChat = {};
  var __linkedFieldFocusKeyByChat = {};

  // ========================================================
  // v43：WA 姓名实时同步
  // 当同一个联系人 ID 的显示姓名发生变化时，自动同步到存储数据与管理面板
  // 典型场景：WA 原本显示手机号，后来保存联系人后变成姓名
  // ========================================================
  var __lastSyncedNameByChatId = {};

  function shouldSyncContactName(info, oldName, newName) {
    if (!info || !info.id || !newName) return false;
    if (oldName === newName) return false;
    if (looksLikeStatusText(newName)) return false;
    return true;
  }

  function syncCurrentContactName(info) {
    try {
      if (!info || !info.id) return false;

      var id = info.id;
      var newName = String(info.name || '').trim();
      var avatar = String(info.avatar || '').trim();

      var data = loadData();
      var rec = data[id];
      if (!rec) return false;

      var changed = false;

      // 1. 同步名称
      if (newName && !looksLikeStatusText(newName)) {
        var oldName = String(rec.name || '').trim();
        if (shouldSyncContactName(info, oldName, newName)) {
          rec.name = newName;
          changed = true;
        }
      }

      // 2. 同步头像
      if (avatar && rec.avatar !== avatar) {
        rec.avatar = avatar;
        changed = true;
      }
      if (avatar && avatar.indexOf('data:image/') === 0 && rec.avatarData !== avatar) {
        rec.avatarData = avatar;
        changed = true;
      }

      if (!changed) return false;

      rec.platform = rec.platform || info.platform || inferPlatform(rec, id);
      if (info.platform === 'ig' && info.username) rec.igUsername = info.username;
      rec.updatedAt = Date.now();
      data[id] = rec;

      if (rec.mainKey && data[rec.mainKey]) {
        var main = data[rec.mainKey];
        var memberIds = Array.isArray(main.memberIds) ? main.memberIds : [];
        var members = memberIds.map(function (mid) {
          var e = data[mid];
          return e ? Object.assign({ __id: mid, __platform: inferPlatform(e, mid) }, e) : null;
        }).filter(Boolean);

        if (members.length >= 2) {
          data[rec.mainKey] = buildMainRecordFromMembers(rec.mainKey, members, main);
        } else {
          if (newName) main.name = newName;
          if (avatar && !main.avatar) main.avatar = avatar;
          main.updatedAt = Date.now();
        }
      }

      saveData(data);
      refreshPanelIfOpen();
      return true;
    } catch (e) {
      return false;
    }
  }

  // ========================================================
  // 方案C：同人跨渠道关联 —— 核心数据层（已修复）
  // ========================================================
  var MAIN_PREFIX = 'MAIN::';

  function getMainKey(normalizedPhone) {
    return MAIN_PREFIX + normalizedPhone;
  }
  function isMainKey(id) {
    return typeof id === 'string' && id.indexOf(MAIN_PREFIX) === 0;
  }

  function buildTaggedValue(platform, value) {
    if (!value) return '';
    return String(value).trim();
  }

  function mergeFieldAcrossMembers(members, fieldKey) {
    var parts = [];
    var seen = {};
    members.forEach(function (m) {
      var v = m[fieldKey];
      if (v && String(v).trim()) {
        var text = buildTaggedValue(m.__platform || inferPlatform(m, m.__id), v);
        if (text && !seen[text]) { seen[text] = true; parts.push(text); }
      }
    });
    return parts.join(' / ');
  }

  function buildMainRecordFromMembers(mainKey, members, existingMain) {
    var main = existingMain ? Object.assign({}, existingMain) : {};
    main.isMainRecord = true;
    main.memberIds = members.map(function (m) { return m.__id; });
    // 主记录只作为关联索引与只读聚合展示层；备注字段每次由成员字段动态拼接，不作为可编辑底层数据
    main.__mergedFields = {};
    FIELDS.forEach(function (f) {
      var merged = mergeFieldAcrossMembers(members, f.key);
      main[f.key] = merged || '';
      main.__mergedFields[f.key] = true;
    });

    // v73.1：主记录为只读聚合层，标签1每次从成员重新计算，避免旧值滞留
    main.tag = '';
    for (var i = 0; i < members.length; i++) {
      if (members[i].tag) { main.tag = members[i].tag; break; }
    }
    // v54: 主记录自动计算所有子渠道标签2并集
    var t2Set = {};
    members.forEach(function (m) {
      var arr = Array.isArray(m.tag2) ? m.tag2 : (m.tag2 ? [m.tag2] : []);
      arr.forEach(function (t) { if (t) t2Set[t] = true; });
    });
    main.tag2 = Object.keys(t2Set);
    // v73.1：跟进阶段也必须每次重新计算并集，不能只在主记录为空时计算
    var stageSet = {};
    members.forEach(function (m) {
      (Array.isArray(m.stages) ? m.stages : []).forEach(function (s) { stageSet[s] = true; });
    });
    main.stages = Object.keys(stageSet);
    var latest = members.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })[0];
    main.name = latest ? (latest.name || main.name || '') : (main.name || '');
    main.manualPhone = (members[0] && (members[0].manualPhone || '')) || main.manualPhone || '';
    main.updatedAt = Date.now();
    return main;
  }

  function runLinkScan(opts) {
    opts = opts || {};
    var data = loadData();
    var settings = getSettings();
    var unlinkedSet = settings.unlinkedMemberIds || {};
    if (opts.force) {
      unlinkedSet = {};
      settings.unlinkedMemberIds = {};
      GM_setValue(SETTINGS_KEY, JSON.stringify(settings));
    }
    var phoneMap = {};

    Object.keys(data).forEach(function (id) {
      if (isMainKey(id)) return;
      var e = data[id];
      if (!e) return;
      if (unlinkedSet[id]) return;
      var phoneSrc = e.manualPhone || (isPhoneLikeText(e.name) ? e.name : '');
      var norm = normalizePhone(phoneSrc);
      if (!norm) return;
      if (!phoneMap[norm]) phoneMap[norm] = [];
      phoneMap[norm].push(Object.assign({ __id: id, __platform: inferPlatform(e, id) }, e));
    });

    var changed = false;
    Object.keys(phoneMap).forEach(function (norm) {
      var members = phoneMap[norm];
      if (members.length < 2) return;
      var mainKey = getMainKey(norm);
      var existingMain = data[mainKey];
      var isNewGroup = !existingMain;
      var main = buildMainRecordFromMembers(mainKey, members, existingMain);
      data[mainKey] = main;
      members.forEach(function (m) {
        var rec = data[m.__id];
        if (!rec) return;
        if (rec.mainKey !== mainKey) {
          rec.mainKey = mainKey;
          if (!rec.viewMode) rec.viewMode = 'shared';
          changed = true;
        }
      });
      if (isNewGroup) changed = true;
    });

    // v73.1：即使成员关系未变化，MAIN 聚合字段也可能已变化，必须落库
    saveData(data);

    var groupCount = Object.keys(data).filter(isMainKey).length;
    return { changed: changed, groupCount: groupCount };
  }

  function resolveEffectiveRecordId(channelId) {
    if (isMainKey(channelId)) return channelId;
    var data = loadData();
    var rec = data[channelId];
    if (!rec || !rec.mainKey || !data[rec.mainKey]) return channelId;
    if (rec.viewMode === 'independent') return channelId;
    return rec.mainKey;
  }

  function resolveTagStageRecordId(channelId) {
    if (isMainKey(channelId)) return channelId;
    var data = loadData();
    var rec = data[channelId];
    if (!rec || !rec.mainKey || !data[rec.mainKey]) return channelId;
    return rec.mainKey;
  }

  function getChannelLinkInfo(channelId) {
    var data = loadData();
    var rec = data[channelId];
    if (!rec || !rec.mainKey || !data[rec.mainKey]) return null;
    var main = data[rec.mainKey];
    var memberIds = Array.isArray(main.memberIds) ? main.memberIds : [];
    return {
      mainKey: rec.mainKey,
      main: main,
      viewMode: rec.viewMode || 'shared',
      memberIds: memberIds,
      isLinked: true,
      memberCount: memberIds.length
    };
  }

  function getMergedReadonlyRecord(channelId) {
    var data = loadData();
    var linkInfo = getChannelLinkInfo(channelId);
    var out = {};
    if (!linkInfo || !linkInfo.isLinked) return data[channelId] || {};
    var members = (linkInfo.memberIds || []).map(function (id) {
      var e = data[id];
      return e ? Object.assign({ __id: id, __platform: inferPlatform(e, id) }, e) : null;
    }).filter(Boolean);
    FIELDS.forEach(function (f) { out[f.key] = mergeFieldAcrossMembers(members, f.key); });
    return out;
  }

  function setChannelViewMode(channelId, mode) {
    var data = loadData();
    var rec = data[channelId];
    if (!rec) return;
    rec.viewMode = (mode === 'independent') ? 'independent' : 'shared';
    saveData(data);
  }

  function unlinkChannel(channelId) {
    var data = loadData();
    var rec = data[channelId];
    if (!rec || !rec.mainKey) return false;
    var mainKey = rec.mainKey;
    var main = data[mainKey];

    if (main && (rec.viewMode || 'shared') === 'shared') {
      rec.tag = rec.tag || main.tag;
      rec.stages = (Array.isArray(rec.stages) && rec.stages.length) ? rec.stages : (main.stages || []);
    }
    delete rec.mainKey;
    delete rec.viewMode;
    rec.updatedAt = Date.now();

    if (main) {
      main.memberIds = (main.memberIds || []).filter(function (id) { return id !== channelId; });
      if (main.memberIds.length < 2) {
        main.memberIds.forEach(function (remainId) {
          var remainRec = data[remainId];
          if (remainRec) {
            if ((remainRec.viewMode || 'shared') === 'shared') {
              remainRec.tag = remainRec.tag || main.tag;
              remainRec.stages = (Array.isArray(remainRec.stages) && remainRec.stages.length) ? remainRec.stages : (main.stages || []);
            }
            delete remainRec.mainKey;
            delete remainRec.viewMode;
            remainRec.updatedAt = Date.now();
          }
        });
        delete data[mainKey];
      }
    }

    var settings = getSettings();
    var unlinkedSet = settings.unlinkedMemberIds || {};
    unlinkedSet[channelId] = true;
    setSettings({ unlinkedMemberIds: unlinkedSet });

    saveData(data);
    return true;
  }

  function relinkChannelAllow(channelId) {
    var settings = getSettings();
    var unlinkedSet = settings.unlinkedMemberIds || {};
    delete unlinkedSet[channelId];
    setSettings({ unlinkedMemberIds: unlinkedSet });
  }

  function upsertFieldSmart(channelId, baseInfo, key, value) {
    if (isMainKey(channelId)) {
      upsertField(channelId, {}, key, value);
      try { refreshPanelIfOpen(); } catch (e) { }
      return;
    }
    var data = loadData();
    var existed = !!data[channelId];
    if (!existed && !String(value || '').trim()) return;
    data[channelId] = Object.assign({}, data[channelId] || {}, baseInfo || {});
    data[channelId][key] = value;
    data[channelId].updatedAt = Date.now();
    if (!hasMeaningfulUserData(data[channelId])) delete data[channelId];
    saveData(data);
    try { runLinkScanAndRefreshPanelNow(); } catch (e) { try { runLinkScan(); } catch (e2) { } try { refreshPanelIfOpen(); } catch (e3) { } }
  }

  function toggleStageSmart(channelId, stageKey, checked) {
    var effectiveId = resolveTagStageRecordId(channelId);
    toggleStage(effectiveId, stageKey, checked);
    try { runLinkScanAndRefreshPanelNow(); } catch (e) { try { runLinkScan(); } catch (e2) { } try { refreshPanelIfOpen(); } catch (e3) { } }
  }
  function upsertTagSmart(channelId, baseInfo, value) {
    if (isMainKey(channelId)) {
      upsertField(channelId, {}, 'tag', value);
      return;
    }
    var hasValue = !!String(value || '').trim();
    var data = loadData();
    if (!data[channelId] && !hasValue) return;
    var effectiveId = resolveTagStageRecordId(channelId);
    upsertField(effectiveId, (effectiveId === channelId ? (baseInfo || {}) : {}), 'tag', value);
    try { runLinkScanAndRefreshPanelNow(); } catch (e) { try { runLinkScan(); } catch (e2) { } try { refreshPanelIfOpen(); } catch (e3) { } }
  }

  function upsertTag2Smart(channelId, tags2Array) {
    var data = loadData();
    var arr0 = Array.isArray(tags2Array) ? tags2Array.filter(function (x) { return String(x || '').trim(); }) : [];
    if (!data[channelId] && arr0.length === 0) return;
    if (!data[channelId]) data[channelId] = {};
    data[channelId].tag2 = arr0;
    data[channelId].updatedAt = Date.now();
    if (!hasMeaningfulUserData(data[channelId])) {
      delete data[channelId];
      saveData(data);
      try { refreshPanelIfOpen(); } catch (e) { }
      return;
    }

    // 若属于关联组，实时更新主记录汇集的标签2并集
    if (data[channelId].mainKey && data[data[channelId].mainKey]) {
      var mainKey = data[channelId].mainKey;
      var main = data[mainKey];
      var memberIds = Array.isArray(main.memberIds) ? main.memberIds : [];
      var t2Set = {};
      memberIds.forEach(function (mid) {
        var mem = data[mid];
        if (mem) {
          var arr = Array.isArray(mem.tag2) ? mem.tag2 : (mem.tag2 ? [mem.tag2] : []);
          arr.forEach(function(t){ if (t) t2Set[t] = true; });
        }
      });
      main.tag2 = Object.keys(t2Set);
      main.updatedAt = Date.now();
    }
    saveData(data);
    try { runLinkScanAndRefreshPanelNow(); } catch (e) { }
  }

  function resolveDisplayContext(channelId) {
    var data = loadData();
    var linkInfo = getChannelLinkInfo(channelId);
    var effectiveId = resolveEffectiveRecordId(channelId);
    var tagStageId = resolveTagStageRecordId(channelId);
    return {
      effectiveId: effectiveId,
      effectiveRecord: data[effectiveId] || {},
      tagStageId: tagStageId,
      tagStageRecord: data[tagStageId] || {},
      linkInfo: linkInfo
    };
  }

  function getPlatformBadgeHtml(platform) {
    var info = getPlatformInfo(platform);
    return '<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;color:#fff;background:' +
      info.color + ';margin-left:6px;vertical-align:middle;">' + info.short + '</span>';
  }

  function getCollapseKey(platform) {
    if (platform === 'ig') return 'igBarCollapsed';
    if (platform === 'fb') return 'fbBarCollapsed';
    if (platform === 'tg') return 'tgBarCollapsed';
    return 'waBarCollapsed';
  }

  var __barRepositionHandler = null;
  var __barMutationObserver = null;

    // ========================================================
  // v44：Messenger 红框主聊天列顶置挂载（完美贴合，随窗口自由缩放，杜绝多重叠加）
  // ========================================================
  function cleanupDuplicateBars() {
    var bars = document.querySelectorAll('#' + NOTE_BAR_ID);
    if (bars.length > 1) {
      for (var i = 0; i < bars.length - 1; i++) {
        bars[i].remove();
      }
    }
  }

  function findMessengerMainChatContainer(headerEl) {
    if (!(location.hostname.indexOf('messenger.com') >= 0 || (location.hostname.indexOf('facebook.com') >= 0 && location.pathname.indexOf('/messages') >= 0)) || !headerEl) return null;

    // 1. 最稳妥方式：如果 header 拥有直接父级容器，且该父级正是聊天主列
    var p = headerEl.parentElement;
    if (p && p !== document.body) {
      return { container: p, insertAfter: headerEl };
    }

    // 2. 向上追溯查找具有有效宽度的聊天区域容器（排除全屏顶层容器）
    var node = headerEl;
    var hops = 0;
    while (node && hops < 6) {
      if (node.parentElement && node.parentElement !== document.body) {
        var parent = node.parentElement;
        var rect = parent.getBoundingClientRect();
        // 严格限制：必须属于中栏范围（不能覆盖左侧会话栏，left >= 180，且不能是全屏宽度）
        if (rect.left >= 180 && rect.width >= 300 && rect.width < window.innerWidth * 0.95) {
          return { container: parent, insertAfter: node };
        }
      }
      node = node.parentElement;
      hops++;
    }

    return null;
  }

  function embedMessengerBar(bar, headerEl) {
    if (!(location.hostname.indexOf('messenger.com') >= 0 || (location.hostname.indexOf('facebook.com') >= 0 && location.pathname.indexOf('/messages') >= 0)) || !headerEl) return false;

    cleanupDuplicateBars();

    var target = findMessengerMainChatContainer(headerEl);
    if (target && target.container) {
      // 样式设为 100% 宽度的流式嵌入，随红框宽度自由变化
      bar.style.position = 'relative';
      bar.style.top = '0px';
      bar.style.left = '0px';
      bar.style.right = 'auto';
      bar.style.bottom = 'auto';
      bar.style.width = '100%';
      bar.style.minWidth = '280px';
      bar.style.maxWidth = '100%';
      bar.style.margin = '0';
      bar.style.boxSizing = 'border-box';
      bar.style.zIndex = '100';
      bar.style.flex = '0 0 auto';
      bar.style.alignSelf = 'stretch';
      bar.style.boxShadow = '0 2px 6px rgba(0,0,0,0.06)';

      if (target.insertAfter && target.insertAfter.parentElement === target.container) {
        if (target.insertAfter.nextSibling !== bar) {
          target.container.insertBefore(bar, target.insertAfter.nextSibling);
        }
      } else {
        if (bar.parentElement !== target.container) {
          target.container.insertBefore(bar, target.container.firstChild);
        }
      }
      return true;
    }

    // 兜底方案：绝不使用顶层 prepend，而是精准吸附在 header 正下方，杜绝跑到整页顶端
    if (bar.parentElement !== document.body) document.body.appendChild(bar);
    var hr = headerEl.getBoundingClientRect ? headerEl.getBoundingClientRect() : null;
    if (hr && hr.bottom > 0) {
      bar.style.position = 'fixed';
      bar.style.top = Math.round(hr.bottom) + 'px';
      bar.style.left = Math.round(hr.left) + 'px';
      bar.style.width = Math.max(320, Math.round(hr.width)) + 'px';
      bar.style.minWidth = '320px';
      bar.style.maxWidth = '1000px';
      bar.style.margin = '0';
      bar.style.boxSizing = 'border-box';
      bar.style.zIndex = '99999';
      return true;
    }
    return false;
  }

  function setupBarPhysicalIsolation(bar, headerEl) {
    function reposition() {
      if (!document.body.contains(headerEl)) return;

      cleanupDuplicateBars();

      if ((location.hostname.indexOf('messenger.com') >= 0 || (location.hostname.indexOf('facebook.com') >= 0 && location.pathname.indexOf('/messages') >= 0))) {
        if (embedMessengerBar(bar, headerEl)) return;
      }

      // 其他平台（WA/IG/TG）继续沿用标准 fixed 定位方式
      if (bar.parentElement !== document.body) {
        document.body.appendChild(bar);
      }
      var hRect = headerEl.getBoundingClientRect();
      if (!hRect) return;
      bar.style.position = 'fixed';
      bar.style.top = hRect.bottom + 'px';
      bar.style.left = hRect.left + 'px';
      bar.style.width = Math.max(320, hRect.width) + 'px';
      bar.style.minWidth = '320px';
      bar.style.right = 'auto';
      bar.style.margin = '0';
      bar.style.zIndex = '99999';
      bar.style.boxSizing = 'border-box';
    }

    reposition();

    if (__barRepositionHandler) {
      window.removeEventListener('resize', __barRepositionHandler);
    }
    __barRepositionHandler = reposition;
    window.addEventListener('resize', __barRepositionHandler);
    window.addEventListener('scroll', __barRepositionHandler, true);

    if (__barMutationObserver) {
      __barMutationObserver.disconnect();
    }
    __barMutationObserver = new MutationObserver(function () {
      cleanupDuplicateBars();
      reposition();
    });
    __barMutationObserver.observe(document.body, { childList: true, attributes: false, subtree: true });

    if (!bar.__eventIsolated) {
      bar.__eventIsolated = true;
      ['keydown', 'keyup', 'keypress', 'input'].forEach(function (type) {
        bar.addEventListener(type, function (e) { e.stopPropagation(); });
      });
    }
  }

  // ============ 悬浮条渲染（已接入合并视图/双轨制，修复关联徽标显示） ============
  

  // ========================================================
  // v92：聊天页跨源聚合显示
  // 默认显示同电话的跨源/跨渠道聚合数据；
  // 进入编辑状态后仍只编辑当前本源当前渠道。
  // ========================================================
  function getChatRowPhoneNormV92(record, fallbackName) {
    if (!record) record = {};
    var phoneSrc = record.manualPhone || '';
    try {
      if (!phoneSrc && typeof isPhoneLikeText === 'function' && isPhoneLikeText(fallbackName || record.name)) {
        phoneSrc = fallbackName || record.name || '';
      }
    } catch (e) { }
    return normalizePhone(phoneSrc);
  }

  function getChatRowSourceIdV92(record) {
    if (!record) return getLocalSyncSourceId();
    return record.__syncSourceId || record.sourceId || record.__sourceId || getLocalSyncSourceId();
  }

  function getChatRowSourceNameV92(record) {
    if (!record) return getLocalSyncSourceName();
    return record.__syncSourceName || record.sourceName || record.__sourceName || getLocalSyncSourceName();
  }


  // ========================================================
  // v93：严格识别任何来源的小主记录 / MAIN:: 记录
  // 跨源大主记录只聚合真实渠道叶子记录，避免二次聚合导致重复。
  // ========================================================
  function isAnyMainRecordV93(id, record) {
    // v93.1 修复：只判断“记录自身是不是 MAIN 主记录”，不要因为子记录挂着 mainKey/__mainKey 就过滤。
    // 子记录通常会有 mainKey = MAIN::phone，这是正常关联标记；如果把它当主记录排除，会导致主记录区整体消失。
    var sid = String(id || '');
    var ownId = String((record && (record.__id || record.id || record._localKey || record.key)) || '');

    try { if (typeof isMainKey === 'function' && isMainKey(sid)) return true; } catch (e) {}
    try { if (ownId && typeof isMainKey === 'function' && isMainKey(ownId)) return true; } catch (e) {}

    // 兼容同步包装后的外层 key：sync::source::MAIN::phone
    if (sid.indexOf('MAIN::') >= 0) return true;
    if (ownId.indexOf('MAIN::') >= 0) return true;

    if (!record) return false;

    // 只有明确标记为聚合/主记录的对象才排除
    try { if (record.__isCrossSourceMain) return true; } catch (e) {}
    try { if (record.__isMainRecord) return true; } catch (e) {}
    try { if (record.__isGroup) return true; } catch (e) {}
    try { if (record.__platform === 'main' || record.platform === 'main') return true; } catch (e) {}

    // 注意：不要判断 record.mainKey / record.__mainKey。
    // 它们在真实 WA/IG/FB/TG 子记录上表示“归属哪个 MAIN”，不是“自己是 MAIN”。
    return false;
  }

  function buildCrossSourceChatContextV92(channelId, info) {
    var localData = loadData();
    var panelData = getPanelDisplayData();
    var localRecord = localData[channelId] || {};
    var localPhone = getChatRowPhoneNormV92(localRecord, info && info.name);

    if (!localPhone) {
      return {
        isCrossSourceLinked: false,
        mainKey: null,
        memberCount: 0,
        sourceCount: 0,
        members: [],
        mergedRecord: localRecord
      };
    }

    var members = [];
    Object.keys(panelData || {}).forEach(function (id) {
      var record = panelData[id];
      if (!record) return;
      if (isAnyMainRecordV93(id, record)) return;
      var norm = getChatRowPhoneNormV92(record, record.name);
      if (!norm || norm !== localPhone) return;
      var platform = inferPlatform(record, id);
      members.push(Object.assign({
        __id: id,
        __platform: platform,
        __sourceId: getChatRowSourceIdV92(record),
        __sourceName: getChatRowSourceNameV92(record),
        __fromLocalSync: !!record.__fromLocalSync
      }, record));
    });

    if (!members.length) {
      return {
        isCrossSourceLinked: false,
        mainKey: null,
        memberCount: 0,
        sourceCount: 0,
        members: [],
        mergedRecord: localRecord
      };
    }

    var sourceSet = {};
    members.forEach(function (m) {
      var sid = m.__sourceId || m.__syncSourceId || m.sourceId || 'local';
      sourceSet[sid] = true;
    });

    var mainKey = getMainKey(localPhone);
    var merged = null;
    try {
      merged = buildMainRecordFromMembers(mainKey, members, null);
    } catch (e) {
      merged = localRecord;
    }
    if (!merged) merged = localRecord;

    merged.__id = mainKey;
    merged.__platform = 'main';
    merged.__isMainRecord = true;
    merged.__isCrossSourceMain = true;
    merged.__members = members;
    merged.__memberCount = members.length;
    merged.__sourceCount = Object.keys(sourceSet).length;
    merged.manualPhone = localPhone;

    return {
      isCrossSourceLinked: members.length >= 2,
      mainKey: mainKey,
      memberCount: members.length,
      sourceCount: Object.keys(sourceSet).length,
      members: members,
      mergedRecord: merged
    };
  }

function renderNoteBar() {
    var info = getContactInfoUnified();
    if (!info || !info.headerEl) {
      var oldBar = document.getElementById(NOTE_BAR_ID);
      if (oldBar) oldBar.remove();
      currentChatId = null;
      currentChatName = null;
      currentChatPlatform = null;
      return;
    }

    // v75.1：缓存 blob 头像为 dataURL，避免从其他平台打开面板时 TG/IG/FB 头像失效
    try {
      if (info && info.id && info.avatar) cacheAvatarDataUrlIfNeeded(info.id, info.avatar);
    } catch (e) { }

    // v43：进入/刷新聊天时同步最新联系人姓名
    syncCurrentContactName(info);

    // 彻底清除所有现存的旧备注栏，严防多重叠加！
    document.querySelectorAll('#' + NOTE_BAR_ID).forEach(function (b) { b.remove(); });
    var bar = null;

    // 先执行关联扫描，再判断是否复用旧悬浮条；修复 WA 刚形成关联后仍停留旧输入界面的问题
    try { runLinkScan(); } catch (e) { }

    var ctxForReuse = resolveDisplayContext(info.id);
    var linkSignature = '';
    if (ctxForReuse.linkInfo && ctxForReuse.linkInfo.isLinked) {
      linkSignature = ctxForReuse.linkInfo.mainKey + '::' + ctxForReuse.linkInfo.memberCount + '::' + (__linkedFieldEditModeByChat[info.id] ? 'edit' : 'readonly');
    } else {
      linkSignature = 'nolink::' + (__linkedFieldEditModeByChat[info.id] ? 'edit' : 'readonly');
    }

    if (info.id === currentChatId && info.name === currentChatName && info.platform === currentChatPlatform && bar && bar.__linkSignature === linkSignature && !__linkedFieldFocusKeyByChat[info.id]) {
      setupBarPhysicalIsolation(bar, info.headerEl);
      return;
    }
    currentChatId = info.id;
    currentChatName = info.name;
    currentChatPlatform = info.platform;
    if (bar) bar.remove();

    var ctx = ctxForReuse;
    // v92：聊天页默认显示同电话的跨源/跨渠道聚合数据
    var crossChatCtx = buildCrossSourceChatContextV92(info.id, info);
    var linkInfo = ctx.linkInfo || {};
    if (crossChatCtx && crossChatCtx.isCrossSourceLinked) {
      linkInfo = Object.assign({}, linkInfo, {
        isLinked: true,
        mainKey: crossChatCtx.mainKey,
        memberCount: crossChatCtx.memberCount,
        sourceCount: crossChatCtx.sourceCount,
        members: crossChatCtx.members,
        isCrossSourceLinked: true
      });
    }
    var linkedEditMode = !!__linkedFieldEditModeByChat[info.id];
    // 非编辑状态：显示跨源聚合记录；编辑状态：只编辑当前本源当前渠道自己的记录
    var effRecord = (crossChatCtx && crossChatCtx.isCrossSourceLinked && !linkedEditMode) ? crossChatCtx.mergedRecord : ((linkInfo && linkInfo.isLinked && !linkedEditMode) ? getMergedReadonlyRecord(info.id) : (loadData()[info.id] || {}));
    // 标签/阶段默认随跨源聚合显示；进入编辑状态后仍沿用当前渠道自身操作逻辑
    var tagStageRecord = (crossChatCtx && crossChatCtx.isCrossSourceLinked && !linkedEditMode) ? crossChatCtx.mergedRecord : ctx.tagStageRecord;
    var settings = getSettings();
    var collapseKey = getCollapseKey(info.platform);
    var collapsed = !!settings[collapseKey];

    var baseInfoForSave = { name: info.name, platform: info.platform };
    if (info.platform === 'ig') baseInfoForSave.igUsername = info.username;

    bar = document.createElement('div');
    bar.id = NOTE_BAR_ID;
    bar.__linkSignature = linkSignature;
    bar.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:6px 12px 10px;background:#f0f2f5;border-bottom:1px solid #d1d7db;font-size:13px;max-height:45vh;overflow-y:auto;box-sizing:border-box;';

    var infoLine = document.createElement('div');
    infoLine.style.cssText = 'color:#54656f;line-height:1.8;margin-bottom:2px;display:flex;flex-direction:column;gap:4px;';

    var firstRow = document.createElement('div');
    firstRow.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:8px;';

    var nameSpan = document.createElement('span');
    nameSpan.innerHTML = '<b>\u59d3\u540d\uff1a</b>' + escapeHtml(info.name || '\u672a\u77e5') + getPlatformBadgeHtml(info.platform);
    firstRow.appendChild(nameSpan);

    if (linkInfo && linkInfo.isLinked) {
      var linkBadge = document.createElement('span');
      if (linkInfo.isCrossSourceLinked) {
        linkBadge.textContent = '\uD83D\uDD17 已跨源关联' + linkInfo.memberCount + '条';
        linkBadge.title = '该号码已关联到 ' + linkInfo.memberCount + ' 条跨源/跨渠道记录，默认显示聚合数据；输入时只编辑当前渠道';
      } else {
        linkBadge.textContent = '\uD83D\uDD17 \u5df2\u5173\u8054' + linkInfo.memberCount + '\u6e20\u9053';
        linkBadge.title = '\u8be5\u53f7\u7801\u5df2\u5173\u8054\u5230 ' + linkInfo.memberCount + ' \u4e2a\u6e20\u9053\uff0c\u6807\u7b7e/\u9636\u6bb5\u7edf\u4e00\u7ba1\u7406';
      }
      linkBadge.style.cssText = 'background:#00a884;color:#fff;font-size:11px;padding:2px 8px;border-radius:10px;cursor:default;';
      firstRow.appendChild(linkBadge);
    }

    var phoneLabel = document.createElement('span');
    phoneLabel.innerHTML = '<b>\u7535\u8bdd\uff1a</b>';
    firstRow.appendChild(phoneLabel);

    var phoneInput = document.createElement('input');
    phoneInput.type = 'text';
    phoneInput.placeholder = '\u624b\u52a8\u8f93\u5165\u7535\u8bdd\u53f7\u7801';
    phoneInput.value = (document.activeElement === phoneInput) ? phoneInput.value : (loadData()[info.id] || {}).manualPhone || '';
    phoneInput.style.cssText = 'border:1px solid #d1d7db;border-radius:4px;padding:2px 6px;font-size:12px;width:150px;background:#fff;color:#111b21;color-scheme:light;';
    var phoneTimer = null;

    phoneInput.addEventListener('input', function () {
      clearTimeout(phoneTimer);
      phoneTimer = setTimeout(function () {
        upsertField(info.id, baseInfoForSave, 'manualPhone', phoneInput.value.trim());
        try { runLinkScan(); } catch (e) { }
        refreshPanelIfOpen();
      }, 400);
    });
    firstRow.appendChild(phoneInput);

    var secondRow = document.createElement('div');
    secondRow.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:6px;';

    var toggleBtn = document.createElement('button');
    toggleBtn.textContent = collapsed ? (String.fromCharCode(0x25bc) + ' \u5c55\u5f00') : (String.fromCharCode(0x25b2) + ' \u6536\u8d77');
    toggleBtn.style.cssText = 'border:none;background:#54656f;color:#fff;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:12px;';
    toggleBtn.addEventListener('click', function () {
      var s = getSettings();
      var patch = {};
      patch[collapseKey] = !s[collapseKey];
      setSettings(patch);
      currentChatId = null;
      renderNoteBar();
    });

    var panelBtn = document.createElement('button');
    panelBtn.textContent = String.fromCodePoint(0x1F4CB) + ' \u9762\u677f';
    panelBtn.style.cssText = 'border:none;background:#00a884;color:#fff;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:12px;';
    panelBtn.addEventListener('click', openManagePanel);

    secondRow.appendChild(toggleBtn);
    secondRow.appendChild(panelBtn);

    if (linkInfo && linkInfo.isLinked) {
      var editBtn = document.createElement('button');
      editBtn.textContent = linkedEditMode ? (String.fromCodePoint(0x2705) + ' 完成') : (String.fromCodePoint(0x270F) + ' 输入');
      editBtn.title = linkedEditMode ? '点击后返回关联聚合只读显示' : '点击后输入/编辑当前渠道自己的备注字段';
      editBtn.style.cssText = 'border:none;background:' + (linkedEditMode ? '#00a884' : '#5c6bc0') + ';color:#fff;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:12px;';
      editBtn.addEventListener('click', function () {
        if (linkedEditMode) {
          // 完成：保存当前正在编辑的字段，然后返回聚合只读显示
          var active = document.activeElement;
          if (active && active.__waLinkedFieldKey) {
            try {
              upsertFieldSmart(info.id, baseInfoForSave, active.__waLinkedFieldKey, active.value);
              refreshPanelIfOpen();
            } catch (e) { }
          }
          __linkedFieldEditModeByChat[info.id] = false;
        } else {
          __linkedFieldEditModeByChat[info.id] = true;
        }
        delete __linkedFieldFocusKeyByChat[info.id];
        currentChatId = null;
        renderNoteBar();
      });
      secondRow.appendChild(editBtn);
    }

    var tagSelect = document.createElement('select');
    var curTagVal = tagStageRecord.tag || '';
    var curTagColor = getTag1Color(curTagVal);
    tagSelect.style.cssText = 'border:1px solid #d1d7db;border-radius:4px;padding:2px 4px;font-size:12px;width:96px;cursor:pointer;font-weight:600;background:' + (curTagVal ? curTagColor : '#fff') + ';color:' + (curTagVal ? '#fff' : '#111b21') + ';';
    getTags1().forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.key;
      opt.textContent = t.label;
      opt.style.background = '#fff';
      opt.style.color = '#111b21';
      if (curTagVal === t.key) opt.selected = true;
      tagSelect.appendChild(opt);
    });
    tagSelect.addEventListener('change', function () {
      var cColor = getTag1Color(tagSelect.value);
      if (tagSelect.value) {
        tagSelect.style.background = cColor;
        tagSelect.style.color = '#fff';
      } else {
        tagSelect.style.background = '#fff';
        tagSelect.style.color = '#111b21';
      }
      upsertTagSmart(info.id, baseInfoForSave, tagSelect.value);
      refreshPanelIfOpen();
    });
    secondRow.appendChild(tagSelect);

    // v56：前端悬浮备注栏打通画像选择与显示
    var frontTag2Wrap = document.createElement('div');
    frontTag2Wrap.style.cssText = 'display:inline-flex;align-items:center;position:relative;vertical-align:middle;';
    var curFrontT2 = Array.isArray(tagStageRecord.tag2) ? tagStageRecord.tag2 : (tagStageRecord.tag2 ? [tagStageRecord.tag2] : []);
    var allT2List = getTags2();
    var frontTag2Btn = document.createElement('div');
    frontTag2Btn.style.cssText = 'display:inline-flex;align-items:center;gap:3px;cursor:pointer;padding:2px 6px;border-radius:4px;border:1px dashed #bbb;background:#fff;font-size:11px;user-select:none;min-height:18px;box-sizing:border-box;';
    frontTag2Btn.title = '点击设置联系人画像(多选)';
    if (!curFrontT2.length) {
      frontTag2Btn.innerHTML = '<span style="color:#54656f;">+画像</span>';
    } else {
      var bHtml = '';
      curFrontT2.forEach(function (k) {
        var def = allT2List.filter(function(x){ return x.key === k; })[0];
        var bg = def ? def.color : '#78909c';
        var lbl = def ? def.label : k;
        bHtml += '<span style="display:inline-block;padding:1px 5px;border-radius:10px;font-size:10px;color:#fff;background:' + bg + ';white-space:nowrap;line-height:1.2;">' + escapeHtml(lbl) + '</span>';
      });
      frontTag2Btn.innerHTML = bHtml;
    }
    frontTag2Btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      showTag2SelectDropdown(window, ev, info.id, curFrontT2, function (newTags) {
        upsertTag2Smart(info.id, newTags);
        currentChatId = null;
        renderNoteBar();
        refreshPanelIfOpen();
      });
    });
    frontTag2Wrap.appendChild(frontTag2Btn);
    secondRow.appendChild(frontTag2Wrap);

    var savedStages = Array.isArray(tagStageRecord.stages) ? tagStageRecord.stages : [];
    STAGES.forEach(function (st) {
      var lbl = document.createElement('label');
      lbl.style.cssText = 'display:flex;align-items:center;gap:3px;font-size:12px;color:#111b21;cursor:pointer;background:#fff;border:1px solid #d1d7db;border-radius:4px;padding:2px 8px;';
      var cb = createCustomCheckbox(savedStages.indexOf(st.key) >= 0, function (checked) {
        toggleStageSmart(info.id, st.key, checked);
        refreshPanelIfOpen();
      }, 14);
      lbl.appendChild(cb);
      var txt = document.createElement('span');
      txt.textContent = getStageLabel(st.key);
      lbl.appendChild(txt);
      secondRow.appendChild(lbl);
    });

    infoLine.appendChild(firstRow);
    infoLine.appendChild(secondRow);
    bar.appendChild(infoLine);

    if (!collapsed) {
      FIELDS.forEach(function (field) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:flex-start;gap:6px;';

        var label = document.createElement('div');
        label.textContent = getFieldLabel(field.key);
        label.style.cssText = 'flex:0 0 80px;color:#111b21;font-weight:600;line-height:1.4;padding-top:4px;white-space:nowrap;';

        var textarea = document.createElement('textarea');
        textarea.value = effRecord[field.key] || '';
        textarea.rows = 1;

        var isLinkedReadonly = !!(linkInfo && linkInfo.isLinked && !linkedEditMode);
        textarea.readOnly = isLinkedReadonly;
        if (isLinkedReadonly) textarea.setAttribute('readonly', 'readonly');
        else textarea.removeAttribute('readonly');

        textarea.placeholder = isLinkedReadonly ? '双击可输入当前渠道内容' : '\u8f93\u5165\u5185\u5bb9...';
        textarea.style.cssText = 'flex:1;resize:none;overflow:hidden;min-height:20px;max-height:150px;border:1px solid #d1d7db;border-radius:6px;padding:4px 8px;font-size:13px;line-height:1.4;background:' + (isLinkedReadonly ? '#f7f8fa' : '#fff') + ';color:#111b21;box-sizing:border-box;cursor:' + (isLinkedReadonly ? 'pointer' : 'text') + ';';

        if (isLinkedReadonly) {
          textarea.title = '双击后输入/编辑当前渠道自己的内容';
          textarea.addEventListener('dblclick', function () {
            __linkedFieldEditModeByChat[info.id] = true;
            __linkedFieldFocusKeyByChat[info.id] = field.key;
            currentChatId = null;
            renderNoteBar();
          });
        }

        var saveTimer = null;
        function finishLinkedFieldEdit(shouldSave) {
          if (textarea.__waFinishing) return;
          textarea.__waFinishing = true;
          clearTimeout(saveTimer);
          if (shouldSave !== false) {
            upsertFieldSmart(info.id, baseInfoForSave, field.key, textarea.value);
            refreshPanelIfOpen();
          }
          if (linkInfo && linkInfo.isLinked) {
            __linkedFieldEditModeByChat[info.id] = false;
            delete __linkedFieldFocusKeyByChat[info.id];
            currentChatId = null;
            setTimeout(function () { renderNoteBar(); }, 0);
          }
        }
        if (!isLinkedReadonly) {
          textarea.__waLinkedFieldKey = field.key;
          textarea.addEventListener('input', function () {
            autoResize(textarea);
            // 输入中只自动保存草稿，不自动切回只读，避免 0.3 秒过快打断输入
            clearTimeout(saveTimer);
            saveTimer = setTimeout(function () {
              upsertFieldSmart(info.id, baseInfoForSave, field.key, textarea.value);
              refreshPanelIfOpen();
            }, 500);
          });
          textarea.addEventListener('keydown', function (e) {
            // Enter 保存并完成；Shift+Enter 保留为换行；Esc 取消并回到只读
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              finishLinkedFieldEdit(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              finishLinkedFieldEdit(false);
            }
          });
          textarea.addEventListener('blur', function () {
            // 离开输入框后保存并返回只读
            finishLinkedFieldEdit(true);
          });
        }

        if (!isLinkedReadonly && __linkedFieldFocusKeyByChat[info.id] === field.key) {
          requestAnimationFrame(function () {
            try {
              textarea.focus();
              textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
              autoResize(textarea);
            } catch (e) { }
            delete __linkedFieldFocusKeyByChat[info.id];
          });
        }

        row.appendChild(label);
        row.appendChild(textarea);
        bar.appendChild(row);
        requestAnimationFrame(function () { autoResize(textarea); });
      });
    }

    setupBarPhysicalIsolation(bar, info.headerEl);
  }

  // ============ 表格列定义 ============
  
  // === v64.0 视口计算与横滚保底参数 ===
  var MIN_FIELD_CHARS = 10;      // v72.3：1-说明九列每列最小汉字数（用户可设置）
  var CHAR_WIDTH_PX = 14;        // v72：中文字符基准宽度像素
  var FIELD_CELL_PADDING_PX = 12; // v72.3：单元格左右缓冲，降低4字宽度时过早横滚

  var FLEX_KEYS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'remark'];
  function isFlexCol(key) { return FLEX_KEYS.indexOf(key) >= 0; }
  var COLUMNS = [
    { key: '__index', label: '#', width: 36, minWidth: 36, resizable: false },
    { key: '__chk', label: '', width: 34, minWidth: 34, resizable: false },
    { key: '__platform', label: '\u6e20\u9053', width: 74, minWidth: 50, resizable: true },
    { key: '__link', label: '\u5173\u8054', width: 80, minWidth: 50, resizable: true },
    { key: '__id', label: '\u8bc6\u522b\u7801', width: 130, minWidth: 80, resizable: true },
    { key: '__avatar', label: '头像', width: 56, minWidth: 46, resizable: true },
    { key: 'name', label: '\u59d3\u540d', width: 120, minWidth: 70, resizable: true },
    { key: 'manualPhone', label: '\u7535\u8bdd', width: 140, minWidth: 80, resizable: true },
    { key: 'tag', label: '\u6807\u7b7e', width: 110, minWidth: 80, resizable: true },
    { key: 'tag2', label: '画像', width: 140, minWidth: 90, resizable: true },
    { key: '__stages', label: '\u8ddf\u8fdb\u9636\u6bb5', width: 150, minWidth: 100, resizable: true }
  ].concat(FIELDS.map(function (f) {
    return { key: f.key, label: getFieldLabel(f.key), width: (f.key === 'remark' ? 180 : 140), minWidth: 80, resizable: true };
  })).concat([
    { key: 'updatedAt', label: '\u66f4\u65b0\u65f6\u95f4', width: 110, minWidth: 80, resizable: true },
    { key: '__actions', label: '\u64cd\u4f5c', width: 90, minWidth: 90, resizable: false }
  ]);

  function getColWidths() {
    var s = getSettings();
    return s.tableColWidths || {};
  }
  function saveColWidth(key, width) {
    var s = getSettings();
    var map = Object.assign({}, s.tableColWidths || {});
    map[key] = width;
    setSettings({ tableColWidths: map });
  }
  function getFieldColWeights() {
    var s = getSettings();
    return s.fieldColWeights || {};
  }
  function saveFieldColWeight(key, weight) {
    var s = getSettings();
    var map = Object.assign({}, s.fieldColWeights || {});
    map[key] = Math.max(0.45, Math.min(5, weight || 1));
    setSettings({ fieldColWeights: map });
  }
  function calcFieldContentScore(rows, key) {
    var maxLen = 0, sum = 0, count = 0;
    (rows || []).slice(0, 200).forEach(function (r) {
      var text = String((r && (r[key] || (r.raw && r.raw[key]))) || '').trim();
      if (!text) return;
      var len = text.replace(/\s+/g, '').length;
      maxLen = Math.max(maxLen, len);
      sum += len; count++;
    });
    var avg = count ? sum / count : 0;
    return Math.min(3, Math.log(1 + maxLen + avg) / 3);
  }
  function getFieldColLocked() {
    var s = getSettings();
    return s.fieldColLocked || {};
  }
  function setFieldColLocked(key, lockedVal) {
    var s = getSettings();
    var map = Object.assign({}, s.fieldColLocked || {});
    map[key] = !!lockedVal;
    setSettings({ fieldColLocked: map });
  }
  function toggleFieldColLocked(key) {
    var locked = getFieldColLocked();
    setFieldColLocked(key, !locked[key]);
  }
  function getLayoutMinViewportWidth() {
    var s = getSettings();
    return Math.max(800, parseInt(s.layoutMinViewportWidth || 1280, 10) || 1280);
  }
  function getFieldUnifiedWidthPx() {
    var s = getSettings();
    var raw = s.fieldUnifiedWidthPx;
    if (raw === undefined || raw === null || raw === '') raw = 220;
    var n = parseInt(raw, 10) || 220;
    return Math.max(60, Math.min(1200, n));
  }
  function isFieldUnifiedWidthAuto() {
    var s = getSettings();
    if (typeof s.fieldUnifiedWidthAuto === 'boolean') return s.fieldUnifiedWidthAuto;
    // 兼容 v75.4：旧设置为0/空时默认自适应；旧设置大于0时默认手动统一宽度。
    var old = parseInt(s.fieldUnifiedWidthPx || 0, 10) || 0;
    return old <= 0;
  }
  function calcAdaptiveFieldWidths(rows, containerWidth, widths) {
    // v75.5：新增“自适应”开关。勾选时忽略统一宽度；不勾选时按统一px宽度撑开9列并触发横滚。
    var unifiedW = getFieldUnifiedWidthPx();
    if (!isFieldUnifiedWidthAuto() && unifiedW > 0) {
      var fixedResult = {};
      FLEX_KEYS.forEach(function (k) { fixedResult[k] = unifiedW; });
      var viewportW0 = (managePanelWindow && managePanelWindow.innerWidth) || containerWidth || 1200;
      var minViewport0 = getLayoutMinViewportWidth();
      if (managePanelWindow) managePanelWindow.__v724LastLayoutWidth = Math.max(viewportW0, minViewport0);
      return fixedResult;
    }
    // v72.4：极简列宽模型
    // 1) 非说明区列使用固定/手动拖拽宽度；
    // 2) 说明区9列中，🔒列使用保存宽度，🔓列平均瓜分剩余宽度；
    // 3) 当前浏览器宽度低于“横滚触发宽度”时，按触发宽度布局，自然出现横向滚动。
    var viewportW = (managePanelWindow && managePanelWindow.innerWidth) || containerWidth || 1200;
    var minViewport = getLayoutMinViewportWidth();
    var layoutWidth = Math.max(viewportW, minViewport);
    var locked = getFieldColLocked();
    var result = {};

    var fixedTotal = 0;
    COLUMNS.forEach(function (c) {
      if (!isFlexCol(c.key)) {
        fixedTotal += parseInt((widths && widths[c.key]) || c.width || c.minWidth || 80, 10);
      }
    });

    var lockedTotal = 0;
    var freeKeys = [];
    FLEX_KEYS.forEach(function (k) {
      if (locked[k]) {
        var savedW = parseInt((widths && widths[k]) || 120, 10) || 120;
        result[k] = savedW;
        lockedTotal += savedW;
      } else {
        freeKeys.push(k);
      }
    });

    var safe = 64;
    var freeWidth = layoutWidth - fixedTotal - lockedTotal - safe;
    var each = freeKeys.length ? Math.max(60, Math.floor(freeWidth / freeKeys.length)) : 0;
    freeKeys.forEach(function (k) { result[k] = each; });

    if (managePanelWindow) managePanelWindow.__v724LastLayoutWidth = layoutWidth;
    return result;
  }
  function saveFieldDragAsWeight(key, actualWidth) {
    // v72.4：拖拽说明区列后保存实际宽度；是否固定由表头锁按钮控制
    saveColWidth(key, actualWidth);
  }
  function resetColWidths() {
    setSettings({ tableColWidths: {}, fieldColWeights: {}, fieldColLocked: {} });
  }

  function refreshPanelIfOpen() {
    if (managePanelWindow && !managePanelWindow.closed && managePanelWindow.__waRefresh) {
      try { managePanelWindow.__waRefresh(); } catch (e) { }
    }
  }

  // === v73.0 主记录聚合实时刷新：编辑子记录后重算 MAIN 并刷新管理面板 ===
  var __waV73LinkScanRefreshTimer = null;

  function scheduleLinkScanAndPanelRefresh(delay) {
    delay = typeof delay === 'number' ? delay : 120;
    if (__waV73LinkScanRefreshTimer) {
      clearTimeout(__waV73LinkScanRefreshTimer);
    }
    __waV73LinkScanRefreshTimer = setTimeout(function () {
      __waV73LinkScanRefreshTimer = null;
      try { runLinkScan(); } catch (e) { }
      try { refreshPanelIfOpen(); } catch (e) { }
    }, delay);
  }

  function runLinkScanAndRefreshPanelNow() {
    if (__waV73LinkScanRefreshTimer) {
      clearTimeout(__waV73LinkScanRefreshTimer);
      __waV73LinkScanRefreshTimer = null;
    }
    try { runLinkScan(); } catch (e) { }
    try { refreshPanelIfOpen(); } catch (e) { }
  }

  function buildManagePanelShell() {
    var html = '';
    html += '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<title>\u8054\u7cfb\u4eba\u5907\u6ce8\u7ba1\u7406\u9762\u677f</title>\n<style>\n';
    html += '*{box-sizing:border-box;}\n';
    html += ':root{--bg:#f0f2f5;--card:#fff;--text:#111b21;--sub:#54656f;--border:#d9dee3;--fieldbg:#fafafa;--empty:#fff0f0;--headbg:#eef1f4;}\n';
    html += 'body.dark{--bg:#0b141a;--card:#1f2c34;--text:#e9edef;--sub:#8696a0;--border:#2a3942;--fieldbg:#111b21;--empty:#3a1f22;--headbg:#233138;}\n';
    html += 'body{margin:0;padding:18px 20px;background:var(--bg);color:var(--text);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}\n';
    html += '.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;}\n';
    html += '.toolbar h1{font-size:18px;margin:0 0 6px;flex:1 0 100%;}\n';
    html += 'input[type="text"]{padding:7px 12px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--card);color:var(--text);}\n';
    html += '#searchBox{width:200px;}\n';
    html += 'select{padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--card);color:var(--text);}\n';
    html += '.btn{border:none;padding:7px 14px;border-radius:6px;cursor:pointer;font-size:13px;color:#fff;background:#00a884;}\n';
    html += '.btn.secondary{background:#54656f;}\n.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--border);}\n.btn.danger{background:#e53935;}\n';
    html += '.btn:disabled{opacity:0.4;cursor:not-allowed;}\n';
    html += '.banner{background:#fff3cd;border:1px solid #ffe69c;color:#664d03;padding:10px 14px;border-radius:8px;margin-bottom:12px;font-size:13px;display:flex;justify-content:space-between;align-items:center;}\n';
    html += '.stats{font-size:13px;color:var(--sub);margin-bottom:10px;}\n.stats b{color:var(--text);}\n';
    html += '.platformbar,.tagbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;}\n';
    html += '.platpill,.tagpill{border-radius:14px;padding:5px 14px;font-size:12px;cursor:pointer;color:#fff;display:flex;align-items:center;gap:6px;border:2px solid transparent;user-select:none;font-weight:600;}\n';
   // ✅ 修复后的标准代码：
    html += '.platpill.active,.tagpill.active{box-shadow:0 0 0 2px #fff,0 0 0 4.5px #00a884 !important;transform:scale(1.05);font-weight:700;z-index:10;}\n';
    html += '.platpill.active::before,.tagpill.active::before{content:\'✓ \';font-weight:900;}\n';
    html += 'body.dark .platpill.active,body.dark .tagpill.active{box-shadow:0 0 0 2px #1f2c34,0 0 0 4.5px #00a884 !important;}\n';

    html += '.batchbar{display:none;align-items:center;gap:8px;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:13px;}\n';
    html += '.batchbar.show{display:flex;}\n';
    html += '.dashboard{background:var(--card);border-radius:10px;padding:16px 20px;margin-bottom:14px;border:1px solid var(--border);display:none;}\n';
    html += '.dashboard.show{display:block;}\n.dash-row{margin-bottom:12px;}\n.dash-title{font-weight:700;font-size:13px;margin-bottom:6px;}\n';
    html += '.bar-item{display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px;}\n';
    html += '.bar-label{flex:0 0 110px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}\n';
    html += '.bar-track{flex:1;height:14px;background:var(--fieldbg);border-radius:7px;overflow:hidden;}\n';
    html += '.bar-fill{height:100%;border-radius:7px;}\n.bar-val{flex:0 0 40px;text-align:right;color:var(--sub);}\n';
    html += '.main-group-section{background:var(--card);border:1.5px solid #6d4c41;border-radius:8px;margin-bottom:14px;overflow:hidden;display:none;box-shadow:0 2px 8px rgba(109,76,65,0.1);}\n';
html += '.main-group-header{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(109,76,65,0.08);border-bottom:1px solid var(--border);cursor:pointer;user-select:none;}\n';
html += '.main-group-header h3{margin:0;font-size:14px;color:#6d4c41;display:flex;align-items:center;}\n';
html += '.main-group-table-container{overflow:auto;max-height:38vh;scrollbar-width:none;-ms-overflow-style:none;}\n';
    html += '.main-group-table-container::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important;}\n';
    html += '.main-group-table-container td{white-space:normal !important;word-break:break-word;}\n';
    html += '.main-group-table-container textarea.cell-input{white-space:pre-wrap !important;word-break:break-word;overflow:hidden;min-height:32px;}\n';
    html += '.sub-table-header{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--headbg);border:1px solid var(--border);border-bottom:none;border-radius:8px 8px 0 0;margin-top:10px;}\n';
    html += '.sub-table-header h3{margin:0;font-size:14px;color:var(--text);display:flex;align-items:center;}\n';
    html += '.sub-table-header{gap:10px;flex-wrap:wrap;}\n';
    html += '.sub-table-cfg{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--text);background:var(--card);padding:3px 10px;border-radius:6px;border:1px solid var(--border);margin-left:auto;}\n';
    html += '.sub-table-cfg input{width:50px;padding:2px 4px;text-align:center;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-size:12px;}\n';
    html += '#mainTable,#mainGroupTable{table-layout:fixed !important;}\n';
    html += '#mainTable thead th,#mainGroupTable thead th{position:sticky !important;top:0 !important;z-index:30 !important;background:var(--headbg) !important;}\n';
    html += '#mainTable .col-sticky-avatar,#mainGroupTable .col-sticky-avatar{position:sticky !important;left:0 !important;z-index:16 !important;background:var(--card) !important;background-clip:padding-box !important;}\n';
    html += '#mainTable .col-sticky-name,#mainGroupTable .col-sticky-name{position:sticky !important;left:var(--v67-avatar-width,56px) !important;z-index:17 !important;background:var(--card) !important;background-clip:padding-box !important;}\n';
    html += '#mainTable thead th.col-sticky-avatar,#mainGroupTable thead th.col-sticky-avatar{z-index:50 !important;background:var(--headbg) !important;}\n';
    html += '#mainTable thead th.col-sticky-name,#mainGroupTable thead th.col-sticky-name{z-index:51 !important;background:var(--headbg) !important;}\n';
    html += 'body.dark #mainTable .col-sticky-avatar,body.dark #mainTable .col-sticky-name,body.dark #mainGroupTable .col-sticky-avatar,body.dark #mainGroupTable .col-sticky-name{background:var(--card) !important;}\n';
    html += '#waViewportBottomBar{position:fixed;left:0;right:0;bottom:0;height:16px;overflow-x:auto;overflow-y:hidden;background:rgba(240,242,245,.96);border-top:1px solid var(--border);z-index:999999;display:none;}\n';
    html += 'body.dark #waViewportBottomBar{background:rgba(11,20,26,.96);}\n';
    html += '#waViewportBottomBarInner{height:1px;}\n';

html += '.cell-readonly{background:var(--fieldbg) !important;color:var(--sub) !important;cursor:not-allowed !important;}\n';
html += '.table-container{background:var(--card);border:1px solid var(--border);border-radius:8px;overflow:auto;max-height:72vh;position:relative;}\n';
    html += '.table-scroll-clip{overflow:hidden;border:1px solid var(--border);border-top:0;border-radius:0 0 8px 8px;background:var(--card);position:relative;}\n';
    html += '.table-scroll-clip .table-container{border:0 !important;border-radius:0 !important;margin-bottom:-18px !important;padding-bottom:18px !important;padding-right:22px !important;box-sizing:border-box !important;}\n';
    html += '.table-scroll-clip .table-container table{margin-right:22px !important;}\n';
    html += '#mainGroupContainer{padding-right:22px !important;box-sizing:border-box !important;}\n';
    html += '#mainGroupContainer table{margin-right:22px !important;}\n';

    html += '.table-container::-webkit-scrollbar:horizontal{height:0 !important;display:none !important;}\n';
    html += 'table{border-collapse:separate;border-spacing:0;table-layout:fixed;width:100%;min-width:100%;}\n';
    html += 'thead th{position:sticky;top:0;background:var(--headbg);z-index:3;font-size:12px;font-weight:700;text-align:left;padding:8px 8px;border-bottom:2px solid var(--border);border-right:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;height:36px;}\n';
    html += 'th .resize-handle{position:absolute;top:0;right:-4px;width:8px;height:100%;cursor:col-resize;z-index:6;}\n';
    html += 'th .resize-handle:hover, th .resize-handle.dragging{background:rgba(0,168,132,0.5);}\n';
    html += 'td{padding:6px 8px;border-bottom:1px solid var(--border);border-right:1px solid var(--border);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;position:relative;vertical-align:top;}\n';
    html += '.wrap-mode td{white-space:normal;word-break:break-word;}\n';
    html += '.wrap-mode textarea.cell-input{white-space:pre-wrap;word-break:break-word;}\n';
    html += 'tr.row-wa td:first-child{box-shadow:inset 4px 0 0 0 #25D366;}\n';
    html += 'tr.row-ig td:first-child{box-shadow:inset 4px 0 0 0 #E1306C;}\n';
    html += 'tr.row-fb td:first-child{box-shadow:inset 4px 0 0 0 #0084FF;}\n';
    html += 'tr.row-tg td:first-child{box-shadow:inset 4px 0 0 0 #26A5E4;}\n';
    html += 'tr.row-multi td:first-child{box-shadow:inset 4px 0 0 0 #6d4c41;}\n';
    html += 'tr.row-multi{background:rgba(109,76,65,0.06);}\n';
    html += 'body.dark tr.row-multi{background:rgba(109,76,65,0.18);}\n';
    html += '.plat-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;color:#fff;font-weight:600;}\n';
    html += 'tr:hover td{filter:brightness(0.96);}\nbody.dark tr:hover td{filter:brightness(1.15);}\n';
    html += 'td.cell-empty{background:var(--empty) !important;}\n';
    html += 'input.cell-input, textarea.cell-input{width:100%;box-sizing:border-box;border:none;outline:none;background:transparent;color:var(--text);font-size:13px;font-family:inherit;padding:6px 8px;margin:0;resize:none;line-height:1.4;display:block;}\n';
    html += 'textarea.cell-input{overflow:hidden;min-height:32px;}\n';
    html += 'input.cell-input:focus, textarea.cell-input:focus{background:var(--card);box-shadow:inset 0 0 0 1px #00a884;border-radius:3px;}\n';
    html += 'td.input-td{padding:0;}\n';
    html += 'td.cell-empty input.cell-input, td.cell-empty textarea.cell-input{color:var(--sub);}\n';
    html += '.tag-sel-inline{width:100%;border:1px solid var(--border);border-radius:4px;padding:2px 4px;font-size:12px;background:var(--card);color:var(--text);}\n';
    html += '.icon-btn{border:none;background:none;cursor:pointer;font-size:14px;padding:2px 4px;}\n';
    html += '.link-btn{border:1px solid #6d4c41;background:#6d4c41;color:#fff;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;white-space:nowrap;}\n';
    html += '.id-cell{white-space:nowrap;}\n';
    html += '.chk-wrap-th{display:flex;align-items:center;justify-content:center;height:100%;}\n';
    html += '#dropZone{position:fixed;inset:0;background:rgba(0,168,132,0.15);border:4px dashed #00a884;z-index:999;display:none;align-items:center;justify-content:center;font-size:22px;color:#00a884;font-weight:700;}\n';
    html += '.row-highlight-pulse{animation:pulseGlow 2.5s ease-in-out;}\n@keyframes pulseGlow{0%{background-color:rgba(0,168,132,0.45) !important;}50%{background-color:rgba(0,168,132,0.2) !important;}100%{background-color:transparent;}}\n.link-group-bg-0{background-color:rgba(37,211,102,0.06) !important;}\n.link-group-bg-1{background-color:rgba(0,132,255,0.06) !important;}\n.link-group-bg-2{background-color:rgba(225,48,108,0.06) !important;}\n.link-group-bg-3{background-color:rgba(109,76,65,0.08) !important;}\n.link-group-bg-4{background-color:rgba(156,39,176,0.06) !important;}\nbody.dark .link-group-bg-0{background-color:rgba(37,211,102,0.14) !important;}\nbody.dark .link-group-bg-1{background-color:rgba(0,132,255,0.14) !important;}\nbody.dark .link-group-bg-2{background-color:rgba(225,48,108,0.14) !important;}\nbody.dark .link-group-bg-3{background-color:rgba(109,76,65,0.2) !important;}\nbody.dark .link-group-bg-4{background-color:rgba(156,39,176,0.14) !important;}\n.lg-act-btn{border:none;border-radius:4px;padding:2px 6px;font-size:11px;cursor:pointer;margin:1px;white-space:nowrap;line-height:1.2;}\n.lg-act-toggle{background:#5c6bc0;color:#fff;}\n.lg-act-unlink{background:#e53935;color:#fff;}\n</style>\n</head>\n<body>\n';
    html += '<div id="dropZone">\u62d6\u653e CSV \u6587\u4ef6\u5230\u6b64\u5904\u5bfc\u5165</div>\n';
    html += '<div class="toolbar">\n<h1>' + String.fromCodePoint(0x1F4CB) + ' \u8054\u7cfb\u4eba\u5907\u6ce8\u7ba1\u7406\u9762\u677f</h1>\n';
    html += '<input type="text" id="searchBox" placeholder="\u641c\u7d22\u59d3\u540d/\u7535\u8bdd/\u5907\u6ce8...">\n';
    html += '<select id="tagFilter"></select>\n';
    html += '<select id="sortSelect"><option value="updatedAt_desc">\u6309\u66f4\u65b0\u65f6\u95f4 ' + String.fromCharCode(0x2193) + '</option><option value="updatedAt_asc">\u6309\u66f4\u65b0\u65f6\u95f4 ' + String.fromCharCode(0x2191) + '</option><option value="name_asc">\u6309\u59d3\u540d A-Z</option><option value="name_desc">\u6309\u59d3\u540d Z-A</option></select>\n';
    html += '<button class="btn secondary" id="dashboardBtn">' + String.fromCodePoint(0x1F4CA) + ' \u6570\u636e\u770b\u677f</button>\n';
    html += '<button class="btn ghost" id="wrapBtn">' + String.fromCodePoint(0x1F4C4) + ' \u6362\u884c\u6a21\u5f0f</button>\n';
    html += '<button class="btn ghost" id="resetWidthBtn">' + String.fromCodePoint(0x1F504) + ' \u91cd\u7f6e\u5217\u5bbd</button>\n';
    html += '<button class="btn ghost" id="darkBtn">' + String.fromCodePoint(0x1F319) + ' \u6df1\u8272\u6a21\u5f0f</button>\n';
    html += '<button class="btn secondary" id="exportBtn">' + String.fromCodePoint(0x2B07) + String.fromCodePoint(0xFE0F) + ' \u5bfc\u51faCSV</button>\n';
    html += '<button class="btn secondary" id="importBtn">' + String.fromCodePoint(0x2B06) + String.fromCodePoint(0xFE0F) + ' \u5bfc\u5165CSV</button>\n';
    html += '<input type="file" id="importFile" accept=".csv" style="display:none;">\n';
    html += '<button class="btn ghost" id="tagMgrBtn">🏷️ 标签设置</button>\n';
    html += '<button class="btn ghost" id="fieldNameBtn">' + String.fromCodePoint(0x270F) + String.fromCodePoint(0xFE0F) + ' \u5b57\u6bb5\u547d\u540d</button>\n';
    html += '<button class="btn ghost" id="rescanBtn">' + String.fromCodePoint(0x1F517) + ' \u91cd\u626b\u5173\u8054</button>\n';
    html += '</div>\n';
    html += '<div id="banner"></div>\n';
    html += '<div id="wa-local-sync-bar-wrap"></div>\n';
    html += '<div class="stats" id="statsBar"></div>\n';
    html += '<div class="platformbar" id="platformBar"></div>\n';
    html += '<div class="tagbar" id="tagBar"></div>\n';
    html += '<div class="batchbar" id="batchBar">\n<span id="batchCount">\u5df2\u9009\u4e2d 0 \u9879</span>\n';
    html += '<select id="batchTagSelect"></select>\n<button class="btn" id="batchApplyTagBtn">\u5e94\u7528\u6807\u7b7e</button>\n';
    html += '<button class="btn secondary" id="batchExportSelectedBtn">⬇️ 导出选中</button>\n<button class="btn danger" id="batchDeleteBtn">\u5220\u9664\u9009\u4e2d</button>\n<button class="btn ghost" id="batchClearBtn">\u53d6\u6d88\u9009\u62e9</button>\n</div>\n';
    html += '<div class="dashboard" id="dashboard"></div>\n';
    html += '<div class="main-group-section" id="mainGroupSection">\n' +
  '  <div class="main-group-header" id="mainGroupToggleBar">\n' +
  '    <h3><span>🔗 跨源/跨渠道主记录专区</span><span id="mainGroupCountBadge" style="font-size:12px;background:#6d4c41;color:#fff;padding:2px 8px;border-radius:10px;margin-left:8px;">0 组</span></h3>\n' +
  '    <button class="btn ghost" id="mainGroupCollapseBtn" style="padding:2px 10px;font-size:12px;">收起 ▲</button>\n' +
  '  </div>\n' +
  '  <div class="main-group-table-container" id="mainGroupContainer">\n' +
  '    <table id="mainGroupTable"><colgroup id="mainGroupColgroup"></colgroup><thead id="mainGroupHead"></thead><tbody id="mainGroupBody"></tbody></table>\n' +
  '  </div>\n' +
  '</div>\n';
html += '<div class="sub-table-header">\n' +
      '  <h3><span>📋 各渠道联系人明细列表</span><span id="detailCountBadge" style="font-size:12px;background:#00a884;color:#fff;padding:2px 8px;border-radius:10px;margin-left:8px;">0 条</span></h3>\n' +
      '  <div class="sub-table-cfg"><span style="font-weight:700;color:var(--text);">⚙️ 列宽</span><span id="cfgViewportWidth" style="color:var(--sub);">当前 --px</span><label>横滚低于 <input type="number" id="cfgMinChars" min="800" max="3000"> px</label><label id="cfgAutoWrap" style="display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;background:rgba(0,168,132,.10);color:#008f72;font-weight:700;"><input type="checkbox" id="cfgFieldUnifiedAuto" style="width:14px;height:14px;"> f1-说明自适应</label><label id="cfgWidthWrap">统一宽度 <input type="number" id="cfgFieldUnifiedWidth" min="60" max="1200" placeholder="220"> px</label><span id="cfgWidthHint" style="color:var(--sub);font-size:11px;">输入后按 Enter 应用</span></div>\n' +
      '</div>\n' +
      '<div class="table-scroll-clip"><div class="table-container" style="border-radius:0 0 8px 8px;"><table id="mainTable"><colgroup id="tableColgroup"></colgroup><thead id="tableHead"></thead><tbody id="tableBody"></tbody></table></div></div>\n';
    html += '<div id="waViewportBottomBar"><div id="waViewportBottomBarInner"></div></div>\n</body>\n</html>';
    return html;
  }

  

    // ================= v77 本机多数据源同步模块 BEGIN =================
    function localSyncSafeClone(obj) {
      try { return JSON.parse(JSON.stringify(obj || {})); } catch (e) { return {}; }
    }
    function getLocalSyncSourceId() {
      var id = GM_getValue(LOCAL_SYNC_SOURCE_ID_KEY, "");
      if (!id) {
        id = "src_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
        GM_setValue(LOCAL_SYNC_SOURCE_ID_KEY, id);
      }
      return id;
    }
    function getLocalSyncSourceName() {
      var name = GM_getValue(LOCAL_SYNC_SOURCE_NAME_KEY, "");
      return name || ("未命名-" + getLocalSyncSourceId().slice(-6));
    }
    function setLocalSyncSourceName(name) {
      name = String(name || "").trim() || ("未命名-" + getLocalSyncSourceId().slice(-6));
      GM_setValue(LOCAL_SYNC_SOURCE_NAME_KEY, name);
      return name;
    }
    function localSyncRequest(method, path, body) {
      return new Promise(function(resolve){
        var started = Date.now();
        try {
          GM_xmlhttpRequest({
            method: method,
            url: LOCAL_SYNC_URL + path,
            headers: { "Content-Type": "application/json" },
            data: body ? JSON.stringify(body) : undefined,
            timeout: 8000,
            onload: function(res){
              var raw = res.responseText || "";
              try {
                var json = JSON.parse(raw || "{}");
                var healthy = (res.status >= 200 && res.status < 300 && json.ok !== false);
                var ret = { ok: healthy, status: res.status, data: json, raw: raw, method: method, path: path, ms: Date.now()-started };
                LOCAL_SYNC_LAST_STATUS.lastRequest = ret;
                resolve(ret);
              } catch(e) {
                var er = { ok:false, status:res.status, error:"JSON解析失败: "+(e&&e.message||e), raw: raw, method: method, path: path, ms: Date.now()-started };
                LOCAL_SYNC_LAST_STATUS.lastRequest = er;
                resolve(er);
              }
            },
            onerror: function(err){ var er={ ok:false, error:"请求失败", detail:String(err||""), method:method, path:path, ms:Date.now()-started }; LOCAL_SYNC_LAST_STATUS.lastRequest=er; resolve(er); },
            ontimeout: function(){ var er={ ok:false, error:"请求超时", method:method, path:path, ms:Date.now()-started }; LOCAL_SYNC_LAST_STATUS.lastRequest=er; resolve(er); }
          });
        } catch(e) {
          var er = { ok:false, error:"GM_xmlhttpRequest异常: "+(e&&e.message||e), method:method, path:path, ms:Date.now()-started };
          LOCAL_SYNC_LAST_STATUS.lastRequest = er;
          resolve(er);
        }
      });
    }

    function isLocalSyncRealtimeUploadEnabled() { return GM_getValue(LOCAL_SYNC_UPLOAD_KEY, "0") === "1"; }
    function setLocalSyncRealtimeUploadEnabled(v) { GM_setValue(LOCAL_SYNC_UPLOAD_KEY, v ? "1" : "0"); }
    function isLocalSyncAggregateEnabled() { return GM_getValue(LOCAL_SYNC_AGGREGATE_KEY, "0") === "1"; }
    function setLocalSyncAggregateEnabled(v) { GM_setValue(LOCAL_SYNC_AGGREGATE_KEY, v ? "1" : "0"); }
    

    // v89 跨源汇总只读保护：判断当前行是否为“其他源”汇总数据
    function isRemoteSyncRecord(row) {
      return !!(row && row.__fromLocalSync && row.__syncSourceId && row.__syncSourceId !== getLocalSyncSourceId());
    }
    function getRemoteSyncSourceLabel(row) {
      return (row && (row.__syncSourceName || row.__syncSourceId)) || '其他源';
    }
    function getRemoteSyncReadonlyTitle(row) {
      return '🔒 只读：这是来自其他源【' + getRemoteSyncSourceLabel(row) + '】的汇总数据。当前版本仅支持查看，不能在本面板修改。请到该来源浏览器/Profile 中编辑。';
    }
    function guardRemoteSyncEdit(row) {
      if (!isRemoteSyncRecord(row)) return false;
      try {
        if (managePanelWindow && !managePanelWindow.closed) managePanelWindow.alert(getRemoteSyncReadonlyTitle(row));
        else alert(getRemoteSyncReadonlyTitle(row));
      } catch(e) { try { alert(getRemoteSyncReadonlyTitle(row)); } catch(_e) {} }
      return true;
    }
    function appendRemoteSyncReadonlyBadge(doc, parent, row) {
      var badge = doc.createElement('span');
      badge.className = 'wa-remote-readonly-badge';
      badge.textContent = '🔒 只读 · ' + getRemoteSyncSourceLabel(row);
      badge.title = getRemoteSyncReadonlyTitle(row);
      parent.appendChild(badge);
    }
    function appendLocalEditableBadge(doc, parent) {
      var badge = doc.createElement('span');
      badge.className = 'wa-local-origin-badge';
      badge.textContent = '本源可编辑';
      badge.title = '这是当前浏览器/Profile 的本源数据，可以编辑并上传。';
      parent.appendChild(badge);
    }
function getPanelDisplayData() {
      if (!isLocalSyncAggregateEnabled()) return loadData() || {};
      return getLocalSyncDisplayData();
    }
    async function localSyncUploadOnly() {
      if (LOCAL_SYNC_RUNNING) return { ok:true, skipped:true, reason:"running" };
      LOCAL_SYNC_RUNNING = true;
      try {
        var h = await localSyncHealthCheck();
        if (!h.ok) return h;
        var up = await localSyncUploadAll();
        LOCAL_SYNC_LAST_STATUS.message = up.ok ? "本源上传完成" : "本源上传失败";
        return up;
      } finally { LOCAL_SYNC_RUNNING = false; LOCAL_SYNC_LAST_AUTO_AT = Date.now(); }
    }
    async function localSyncRefreshAggregate() {
      var h = await localSyncHealthCheck();
      if (!h.ok) return h;
      await localSyncFetchSourcesAndStats();
      await localSyncFetchAllContacts();
      LOCAL_SYNC_LAST_STATUS.message = "汇总刷新完成";
      return { ok:true };
    }
    function scheduleLocalSyncAutoUpload() {
      if (!isLocalSyncRealtimeUploadEnabled()) return;
      clearTimeout(LOCAL_SYNC_UPLOAD_TIMER);
      LOCAL_SYNC_UPLOAD_TIMER = setTimeout(async function(){
        try {
          v892SetRuntime({ upload:'busy', lastError:'' });
          var r = await localSyncUploadOnly();
          v892SetRuntime({
            upload: (r && r.ok) ? 'ok' : 'error',
            lastUploadAt: (r && r.ok) ? Date.now() : v892SyncRuntime().lastUploadAt,
            lastError: (r && r.ok) ? '' : ('自动上传失败：' + ((r && (r.error || r.status)) || '未知错误'))
          });
          await v892RefreshCounts();
        } catch(e) {
          v892SetRuntime({
            upload:'error',
            lastError:'自动上传异常：' + ((e && e.message) || e)
          });
        }
      }, 1200);
    }
    function startLocalSyncAggregatePolling(renderAllFn) {
      stopLocalSyncAggregatePolling();
      if (!isLocalSyncAggregateEnabled()) return;

      setTimeout(async function(){
        try {
          v892SetRuntime({ summary:'busy', lastError:'' });
          var r = await localSyncRefreshAggregate();
          v892SetRuntime({
            summary: (r && r.ok) ? 'ok' : 'error',
            lastSummaryAt: (r && r.ok) ? Date.now() : v892SyncRuntime().lastSummaryAt,
            lastError: (r && r.ok) ? '' : ('汇总失败：' + ((r && (r.error || r.status)) || '未知错误'))
          });
          await v892RefreshCounts();
          if (typeof renderAllFn === "function") renderAllFn();
        } catch(e) {
          v892SetRuntime({ summary:'error', lastError:'汇总轮询异常：' + ((e && e.message) || e) });
        }
      }, 300);

      LOCAL_SYNC_AGGREGATE_TIMER = setInterval(async function(){
        if (!isLocalSyncAggregateEnabled()) {
          stopLocalSyncAggregatePolling();
          return;
        }

        try {
          v892SetRuntime({ summary:'busy', lastError:'' });
          await localSyncFetchSourcesAndStats();
          await localSyncFetchAllContacts();

          var r = v892SyncRuntime();
          if (LOCAL_SYNC_LAST_STATUS.sources) r.totalSources = LOCAL_SYNC_LAST_STATUS.sources.length;
          if (LOCAL_SYNC_LAST_STATUS.stats) r.totalContacts = LOCAL_SYNC_LAST_STATUS.stats.totalContacts || 0;

          v892SetRuntime({
            summary:'ok',
            lastSummaryAt: Date.now(),
            lastError:''
          });

          if (typeof renderAllFn === "function") renderAllFn();
        } catch(e) {
          v892SetRuntime({ summary:'error', lastError:'汇总轮询异常：' + ((e && e.message) || e) });
        }
      }, 5000);
    }
    function stopLocalSyncAggregatePolling() {
      if (LOCAL_SYNC_AGGREGATE_TIMER) clearInterval(LOCAL_SYNC_AGGREGATE_TIMER);
      LOCAL_SYNC_AGGREGATE_TIMER = null;
    }
    function localSyncDiagText() {
      var localCount = 0;
      try { localCount = Object.keys(loadData() || {}).length; } catch(e) {}
      return [
        "v88 本地同步诊断",
        "实时上传本源: " + (isLocalSyncRealtimeUploadEnabled() ? "开启" : "关闭"),
        "实时汇总显示: " + (isLocalSyncAggregateEnabled() ? "开启" : "关闭"),
        "URL: " + LOCAL_SYNC_URL,
        "状态: " + (LOCAL_SYNC_LAST_STATUS.ok ? "已连接" : "未连接"),
        "消息: " + (LOCAL_SYNC_LAST_STATUS.message || ""),
        "当前源ID: " + getLocalSyncSourceId(),
        "当前源名: " + getLocalSyncSourceName(),
        "本地GM记录数: " + localCount,
        "汇总源数: " + ((LOCAL_SYNC_LAST_STATUS.sources || []).length),
        "汇总记录数: " + ((LOCAL_SYNC_LAST_STATUS.contacts || []).length),
        "stats: " + JSON.stringify(LOCAL_SYNC_LAST_STATUS.stats || null),
        "lastRequest: " + JSON.stringify(LOCAL_SYNC_LAST_STATUS.lastRequest || null).slice(0, 3000)
      ].join("\n");
    }
    async function localSyncHealthCheck() {
      var res = await localSyncRequest("GET", "/api/health");
      LOCAL_SYNC_LAST_STATUS.ok = !!res.ok;
      LOCAL_SYNC_LAST_STATUS.message = res.ok ? "已连接" : "未连接";
      return res;
    }

    // ================= v89.1 删除同步修复 BEGIN =================
    async function localSyncDeleteOne(contactId) {
      try {
        if (!contactId) return { ok:false, error:'missing contactId' };
        var sourceId = getLocalSyncSourceId();
        var sourceName = getLocalSyncSourceName();
        var res = await localSyncRequest("POST", "/api/contacts/delete", { sourceId:sourceId, sourceName:sourceName, contactId:contactId, deletedAt:Date.now() });
        LOCAL_SYNC_LAST_STATUS.message = (res && res.ok) ? "已同步删除 1 条" : "删除同步失败";
        return res;
      } catch(e) { return { ok:false, error:String(e && e.message || e) }; }
    }
    async function localSyncBatchDelete(contactIds) {
      try {
        contactIds = (contactIds || []).filter(Boolean);
        if (!contactIds.length) return { ok:true, skipped:true, reason:'empty contactIds' };
        var sourceId = getLocalSyncSourceId();
        var sourceName = getLocalSyncSourceName();
        var res = await localSyncRequest("POST", "/api/contacts/batch-delete", { sourceId:sourceId, sourceName:sourceName, contactIds:contactIds, deletedAt:Date.now() });
        LOCAL_SYNC_LAST_STATUS.message = (res && res.ok) ? ("已同步删除 " + contactIds.length + " 条") : "批量删除同步失败";
        return res;
      } catch(e) { return { ok:false, error:String(e && e.message || e) }; }
    }
    async function localSyncReconcileCurrentSource() {
      try {
        var sourceId = getLocalSyncSourceId();
        var sourceName = getLocalSyncSourceName();
        var data = loadData() || {};
        var ids = Object.keys(data).filter(function(id){ return data[id] && typeof data[id] === 'object'; });
        var res = await localSyncRequest("POST", "/api/contacts/source-reconcile", { sourceId:sourceId, sourceName:sourceName, contactIds:ids, reconciledAt:Date.now() });
        LOCAL_SYNC_LAST_STATUS.message = (res && res.ok) ? ("本源校准完成，保留 " + ids.length + " 条") : "本源校准失败";
        return res;
      } catch(e) { return { ok:false, error:String(e && e.message || e) }; }
    }
    async function localSyncForceRebuildCurrentSource() {
      try {
        var sourceId = getLocalSyncSourceId();
        var sourceName = getLocalSyncSourceName();
        var data = loadData() || {};
        var ids = Object.keys(data).filter(function(id) {
          return data[id] && typeof data[id] === 'object';
        });

        var rec = await localSyncRequest("POST", "/api/contacts/source-reconcile", {
          sourceId: sourceId,
          sourceName: sourceName,
          contactIds: ids,
          reconciledAt: Date.now()
        });

        if (!rec || !rec.ok) {
          LOCAL_SYNC_LAST_STATUS.message = "本源重建失败：校准失败";
          return rec || { ok:false, error:"source-reconcile failed" };
        }

        var up = await localSyncUploadAll();
        if (!up || !up.ok) {
          LOCAL_SYNC_LAST_STATUS.message = "本源重建失败：上传失败";
          return up || { ok:false, error:"upload failed" };
        }

        LOCAL_SYNC_LAST_STATUS.message = "本源重建完成，保留并上传 " + ids.length + " 条";
        return {
          ok: true,
          reconcile: rec,
          upload: up,
          kept: ids.length,
          deleted: rec.data && (rec.data.deleted || rec.data.deletedCount || 0)
        };
      } catch(e) {
        return { ok:false, error:String(e && e.message || e) };
      }
    }
    // ================= v89.1 删除同步修复 END =================

    async function localSyncUploadAll() {
      var sourceId = getLocalSyncSourceId();
      var sourceName = getLocalSyncSourceName();
      var data = loadData();
      var items = [];
      Object.keys(data || {}).forEach(function(key){
        var item = data[key];
        if (!item || typeof item !== "object") return;
        var cloned = localSyncSafeClone(item);
        if (!cloned.id) cloned.id = key;
        cloned._localKey = key;
        cloned._syncSourceId = sourceId;
        cloned._syncSourceName = sourceName;
        cloned._syncPreparedAt = Date.now();
        items.push(cloned);
      });
      var res = await localSyncRequest("POST", "/api/contacts/batch-upsert", {
        sourceId: sourceId, sourceName: sourceName, schemaVersion: 77, uploadedAt: Date.now(), items: items
      });
      LOCAL_SYNC_LAST_STATUS.ok = !!res.ok;
      LOCAL_SYNC_LAST_STATUS.message = res.ok ? "已同步" : "同步失败";
      return res;
    }
    async function localSyncFetchAllContacts() {
      var res = await localSyncRequest("GET", "/api/contacts");
      if (res.ok && res.data && Array.isArray(res.data.items)) {
        LOCAL_SYNC_LAST_STATUS.contacts = res.data.items;
        LOCAL_SYNC_LAST_STATUS.ok = true;
        LOCAL_SYNC_LAST_STATUS.message = "已拉取汇总";
      } else {
        LOCAL_SYNC_LAST_STATUS.contacts = [];
        LOCAL_SYNC_LAST_STATUS.ok = false;
        LOCAL_SYNC_LAST_STATUS.message = "拉取失败";
      }
      return res;
    }
    async function localSyncFetchSourcesAndStats() {
      var sr = await localSyncRequest("GET", "/api/sources");
      var tr = await localSyncRequest("GET", "/api/stats");
      if (sr.ok && sr.data && Array.isArray(sr.data.items)) LOCAL_SYNC_LAST_STATUS.sources = sr.data.items;
      if (tr.ok && tr.data) LOCAL_SYNC_LAST_STATUS.stats = tr.data;
      return { sources: sr, stats: tr };
    }
    function getLocalSyncDisplayData() {
      // v85：本地数据永远作为基础数据源；同步汇总只追加显示，绝不覆盖/替换本地联系人。
      var localData = {};
      try { localData = loadData() || {}; } catch (e) { localData = {}; }
      var contacts = LOCAL_SYNC_LAST_STATUS.contacts || [];
      var merged = {};
      Object.keys(localData).forEach(function(k){ merged[k] = localData[k]; });
      if (!contacts.length) return merged;
      var curSourceId = getLocalSyncSourceId();
      contacts.forEach(function(wrap){
        if (!wrap || !wrap.data) return;
        var item = localSyncSafeClone(wrap.data);
        var sid = wrap.sourceId || item._syncSourceId || "unknown";
        var cid = wrap.contactId || item.id || item._localKey || ("unknown_" + Math.random());
        if (sid === curSourceId && Object.prototype.hasOwnProperty.call(localData, cid)) return;
        item.__id = cid;
        item.__syncSourceId = sid;
        item.__syncSourceName = wrap.sourceName || item._syncSourceName || sid;
        item.__fromLocalSync = true;
        merged["sync::" + sid + "::" + cid] = item;
      });
      return merged;
    }

    // ========================================================
    // v89.2 本地同步状态呼吸灯增强模块
    // 说明：此模块以增强方式挂接在原 v89.1 同步模块上，尽量少改原逻辑。
    // ========================================================

    function v892SyncRuntime() {
      if (!LOCAL_SYNC_LAST_STATUS.runtime) {
        LOCAL_SYNC_LAST_STATUS.runtime = {
          service: 'unknown',
          upload: 'off',
          summary: 'off',
          localCount: 0,
          serverSourceCount: 0,
          totalSources: 0,
          totalContacts: 0,
          lastUploadAt: 0,
          lastSummaryAt: 0,
          lastError: ''
        };
      }
      return LOCAL_SYNC_LAST_STATUS.runtime;
    }

    function v892SetRuntime(patch) {
      var r = v892SyncRuntime();
      Object.keys(patch || {}).forEach(function(k) {
        r[k] = patch[k];
      });
      try { v892RenderSyncLights(); } catch(e) {}
    }

    function v892LocalCount() {
      try {
        var data = loadData() || {};
        return Object.keys(data).filter(function(k) {
          return data[k] && typeof data[k] === 'object';
        }).length;
      } catch(e) {
        return 0;
      }
    }

    function v892FmtTime(ts) {
      if (!ts) return '-';
      try {
        var d = new Date(ts);
        var p = function(n) { return n < 10 ? '0' + n : '' + n; };
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      } catch(e) {
        return '-';
      }
    }

    function v892StatusText(type, value) {
      if (type === 'service') {
        if (value === 'ok') return '已连接';
        if (value === 'busy') return '检测中';
        if (value === 'error') return '断开';
        return '未知';
      }

      if (type === 'upload') {
        if (value === 'ok') return '上传成功';
        if (value === 'busy') return '上传中';
        if (value === 'error') return '上传失败';
        if (value === 'idle') return '待触发';
        return '关闭';
      }

      if (type === 'summary') {
        if (value === 'ok') return '已汇总';
        if (value === 'busy') return '汇总中';
        if (value === 'error') return '汇总失败';
        if (value === 'idle') return '待刷新';
        return '关闭';
      }

      return value || '-';
    }

    function v892InjectSyncCss(doc) {
      try {
        doc = doc || ((managePanelWindow && !managePanelWindow.closed) ? managePanelWindow.document : document);
        if (!doc) return;

        var old = doc.getElementById('v892SyncCss');
        if (old) old.remove();

        var style = doc.createElement('style');
        style.id = 'v892SyncCss';
        style.textContent = ''
          + '.wa-panel-title-line{display:flex!important;align-items:center!important;gap:8px!important;flex-wrap:wrap!important;width:100%!important;margin-bottom:4px!important;}'
          + '.wa-panel-title-line h1{flex:0 0 auto!important;margin:0!important;}'

          + '.wa-title-source-box{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--sub,#54656f);background:var(--card,#fff);border:1px solid var(--border,#d9dee3);border-radius:999px;padding:3px 8px;max-width:100%;}'
          + '.wa-title-source-input{width:auto;min-width:8ch;max-width:min(42ch,40vw);padding:2px 5px!important;border:1px solid var(--border,#d9dee3)!important;border-radius:6px!important;font-size:12px!important;height:23px!important;box-sizing:content-box!important;transition:width .12s ease;background:var(--card,#fff)!important;color:var(--text,#111)!important;}'
          + '.wa-title-source-id{font-size:11px;color:var(--sub,#64748b);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'

          + '.wa-title-actions{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;}'

          + '#wa-local-sync-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 10px;margin:6px 0 8px;border:1px solid var(--border,#d9dee3);background:var(--card,#fff);border-radius:10px;font-size:12px;color:var(--text,#111);white-space:normal;overflow:visible;line-height:1.45;}'
          + '.wa-sync-status-mini{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:12px;line-height:1.5;white-space:normal;min-width:0;flex:1 1 100%;}'
          + '.wa-sync-status-item{display:inline-flex;align-items:center;gap:3px;white-space:nowrap;color:#334155;min-height:20px;}'
          + 'body.dark .wa-sync-status-item{color:#cbd5e1;}'

          + '.wa-sync-toggle-label{font-weight:700;cursor:pointer;user-select:none;}'
          + '.wa-sync-toggle-label input{margin:0 2px 0 0;vertical-align:middle;}'

          + '.wa-sync-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:2px;background:#9ca3af;flex:0 0 auto;}'
          + '.wa-sync-dot.ok{background:#16a34a;animation:v892PulseOk 1.5s infinite;}'
          + '.wa-sync-dot.busy{background:#eab308;animation:v892PulseBusy 1s infinite;}'
          + '.wa-sync-dot.idle{background:#2563eb;animation:v892PulseIdle 2s infinite;}'
          + '.wa-sync-dot.error{background:#dc2626;animation:v892PulseError .7s infinite;}'
          + '.wa-sync-dot.unknown{background:#94a3b8;animation:v892PulseIdle 2.2s infinite;}'
          + '.wa-sync-dot.off{background:#9ca3af;animation:none;}'

          + '.wa-sync-error-text{color:#dc2626;font-weight:700;max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'

          + '.wa-sync-btn{border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:999px;padding:4px 10px;font-size:12px;line-height:1.2;cursor:pointer;box-shadow:0 1px 2px rgba(15,23,42,.06);transition:all .15s ease;white-space:nowrap;}'
          + '.wa-sync-btn:hover{transform:translateY(-1px);box-shadow:0 3px 8px rgba(15,23,42,.12);border-color:#94a3b8;}'
          + '.wa-sync-btn:disabled{opacity:.55;cursor:not-allowed;transform:none;}'
          + '.wa-sync-btn.primary{background:#2563eb;color:#fff;border-color:#2563eb;}'
          + '.wa-sync-btn.green{background:#16a34a;color:#fff;border-color:#16a34a;}'
          + '.wa-sync-btn.purple{background:#7c3aed;color:#fff;border-color:#7c3aed;}'
          + '.wa-sync-btn.gray{background:#475569;color:#fff;border-color:#475569;}'
          + 'body.dark .wa-sync-btn{background:#1e293b;color:#e2e8f0;border-color:#334155;}'

          + '@media(max-width:900px){'
          + '.wa-title-source-id{max-width:180px;}'
          + '.wa-title-actions{flex:1 1 100%;}'
          + '}'

          + '@keyframes v892PulseOk{0%{box-shadow:0 0 0 0 rgba(22,163,74,.65);}70%{box-shadow:0 0 0 7px rgba(22,163,74,0);}100%{box-shadow:0 0 0 0 rgba(22,163,74,0);}}'
          + '@keyframes v892PulseBusy{0%{box-shadow:0 0 0 0 rgba(234,179,8,.7);}70%{box-shadow:0 0 0 7px rgba(234,179,8,0);}100%{box-shadow:0 0 0 0 rgba(234,179,8,0);}}'
          + '@keyframes v892PulseIdle{0%{box-shadow:0 0 0 0 rgba(37,99,235,.55);}70%{box-shadow:0 0 0 6px rgba(37,99,235,0);}100%{box-shadow:0 0 0 0 rgba(37,99,235,0);}}'
          + '@keyframes v892PulseError{0%{box-shadow:0 0 0 0 rgba(220,38,38,.8);}70%{box-shadow:0 0 0 7px rgba(220,38,38,0);}100%{box-shadow:0 0 0 0 rgba(220,38,38,0);}}';

        doc.head.appendChild(style);
      } catch(e) {}
    }


    function v894AutoSizeSourceInput(input) {
      try {
        if (!input) return;

        var doc = input.ownerDocument || document;
        var measurer = doc.getElementById('__waSourceInputMeasurer');
        if (!measurer) {
          measurer = doc.createElement('span');
          measurer.id = '__waSourceInputMeasurer';
          measurer.style.cssText =
            'position:absolute;left:-99999px;top:-99999px;visibility:hidden;white-space:pre;font-size:12px;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-weight:400;';
          doc.body.appendChild(measurer);
        }

        measurer.textContent = input.value || input.placeholder || '';
        var w = Math.ceil(measurer.getBoundingClientRect().width) + 18;
        var min = 8 * 12;
        var max = Math.max(180, Math.min(420, ((doc.defaultView && doc.defaultView.innerWidth) || 1200) * 0.4));

        input.style.width = Math.max(min, Math.min(max, w)) + 'px';
      } catch(e) {}
    }

    function v894EnsureTitleSourceBox(doc) {
      try {
        doc = doc || ((managePanelWindow && !managePanelWindow.closed) ? managePanelWindow.document : document);
        var toolbar = doc.querySelector('.toolbar');
        var h1 = toolbar && toolbar.querySelector('h1');
        if (!toolbar || !h1) return;

        if (!h1.parentElement.classList.contains('wa-panel-title-line')) {
          var line = doc.createElement('div');
          line.className = 'wa-panel-title-line';
          toolbar.insertBefore(line, h1);
          line.appendChild(h1);
        }

        var titleLine = h1.parentElement;
        var box = doc.getElementById('wa-title-source-box');

        if (!box) {
          box = doc.createElement('span');
          box.id = 'wa-title-source-box';
          box.className = 'wa-title-source-box';
          box.innerHTML =
            '<b>当前源：</b>' +
            '<input id="wa-local-sync-source-name" class="wa-title-source-input" value="' + escapeHtml(getLocalSyncSourceName()) + '" title="修改后失焦自动保存源名称">' +
            '<span id="wa-local-sync-source-id" class="wa-title-source-id">ID：' + escapeHtml(getLocalSyncSourceId()) + '</span>';
          titleLine.appendChild(box);
        }

        var actions = doc.getElementById('wa-title-sync-actions');
        if (!actions) {
          actions = doc.createElement('span');
          actions.id = 'wa-title-sync-actions';
          actions.className = 'wa-title-actions';
          actions.innerHTML =
            '<button class="wa-sync-btn primary" id="wa-local-sync-upload-once">上传一次</button>' +
            '<button class="wa-sync-btn green" id="wa-local-sync-refresh-aggregate">刷新汇总</button>' +
            '<button class="wa-sync-btn purple" id="wa-local-sync-reconcile-source">强制重建本源</button>' +
            '<button class="wa-sync-btn" id="wa-local-sync-check">检测连接</button>' +
            '<button class="wa-sync-btn gray" id="wa-local-sync-diag">同步诊断</button>';
          titleLine.appendChild(actions);
        }

        var inp = doc.getElementById('wa-local-sync-source-name');
        if (inp) v894AutoSizeSourceInput(inp);
      } catch(e) {}
    }

    function v892RenderSyncLights() {
      try {
        var doc = (managePanelWindow && !managePanelWindow.closed) ? managePanelWindow.document : document;
        var r = v892SyncRuntime();
        r.localCount = v892LocalCount();

        var service = r.service || 'unknown';
        var upload = isLocalSyncRealtimeUploadEnabled() ? (r.upload || 'idle') : 'off';
        var summary = isLocalSyncAggregateEnabled() ? (r.summary || 'idle') : 'off';

        function setHtml(id, html) {
          var el = doc.getElementById(id);
          if (el) el.innerHTML = html;
        }

        setHtml('wa-sync-service-state', '<span class="wa-sync-dot ' + service + '"></span>连接：<b>' + v892StatusText('service', service) + '</b>');
        setHtml('wa-sync-upload-state', '<span class="wa-sync-dot ' + upload + '"></span><b>' + v892StatusText('upload', upload) + '</b>');
        setHtml('wa-sync-summary-state', '<span class="wa-sync-dot ' + summary + '"></span><b>' + v892StatusText('summary', summary) + '</b>');
        setHtml('wa-sync-local-count', '<b>' + (r.localCount || 0) + '</b>');
        setHtml('wa-sync-server-count', '<b>' + (r.serverSourceCount || 0) + '</b>');
        setHtml('wa-sync-source-count', '<b>' + (r.totalSources || 0) + '</b>');
        setHtml('wa-sync-contact-count', '<b>' + (r.totalContacts || 0) + '</b>');
        setHtml('wa-sync-upload-time', '<b>' + v892FmtTime(r.lastUploadAt) + '</b>');
        setHtml('wa-sync-summary-time', '<b>' + v892FmtTime(r.lastSummaryAt) + '</b>');

        var err = doc.getElementById('wa-sync-error-text');
        if (err) {
          err.style.display = r.lastError ? 'inline-flex' : 'none';
          err.title = r.lastError || '';
          err.textContent = r.lastError ? ('错误：' + r.lastError) : '';
        }

        var upToggle = doc.getElementById('wa-local-sync-realtime-upload');
        if (upToggle) upToggle.checked = isLocalSyncRealtimeUploadEnabled();

        var aggToggle = doc.getElementById('wa-local-sync-aggregate');
        if (aggToggle) aggToggle.checked = isLocalSyncAggregateEnabled();

        var nameInput = doc.getElementById('wa-local-sync-source-name');
        if (nameInput && doc.activeElement !== nameInput) {
          nameInput.value = getLocalSyncSourceName();
          v894AutoSizeSourceInput(nameInput);
        }

        var idEl = doc.getElementById('wa-local-sync-source-id');
        if (idEl) idEl.textContent = 'ID：' + getLocalSyncSourceId();
      } catch(e) {}
    }

    async function v892RefreshCounts() {
      try {
        await localSyncFetchSourcesAndStats();

        var r = v892SyncRuntime();

        if (LOCAL_SYNC_LAST_STATUS.sources) {
          r.totalSources = LOCAL_SYNC_LAST_STATUS.sources.length;
        }

        if (LOCAL_SYNC_LAST_STATUS.stats) {
          r.totalContacts = LOCAL_SYNC_LAST_STATUS.stats.totalContacts || 0;
        }

        var cr = await localSyncRequest(
          'GET',
          '/api/contacts?sourceId=' + encodeURIComponent(getLocalSyncSourceId())
        );

        if (cr && cr.ok && cr.data) {
          r.serverSourceCount = cr.data.count || 0;
        }

        v892RenderSyncLights();
      } catch(e) {
        v892SetRuntime({
          lastError: '统计刷新失败：' + ((e && e.message) || e)
        });
      }
    }

    async function v892InitSyncStatus(renderAllFn) {
      v892InjectSyncCss((managePanelWindow && !managePanelWindow.closed) ? managePanelWindow.document : document);

      v892SetRuntime({
        upload: isLocalSyncRealtimeUploadEnabled() ? 'idle' : 'off',
        summary: isLocalSyncAggregateEnabled() ? 'idle' : 'off',
        localCount: v892LocalCount(),
        lastError: ''
      });

      try {
        v892SetRuntime({ service: 'busy' });
        var h = await localSyncHealthCheck();

        v892SetRuntime({
          service: h.ok ? 'ok' : 'error',
          lastError: h.ok ? '' : ('连接失败：' + (h.error || h.status || '未知错误'))
        });

        await v892RefreshCounts();

        if (isLocalSyncAggregateEnabled()) {
          v892SetRuntime({ summary: 'busy' });
          await localSyncRefreshAggregate();
          v892SetRuntime({
            summary: 'ok',
            lastSummaryAt: Date.now(),
            lastError: ''
          });
          startLocalSyncAggregatePolling(renderAllFn);
        }

        if (isLocalSyncRealtimeUploadEnabled()) {
          setTimeout(function() {
            try {
              scheduleLocalSyncAutoUpload();
            } catch(e) {}
          }, 1500);
        }

        if (typeof renderAllFn === 'function') {
          renderAllFn();
        }
      } catch(e) {
        v892SetRuntime({
          service: 'error',
          lastError: '初始化失败：' + ((e && e.message) || e)
        });
      }
    }

    function buildLocalSyncBarHtml() {
      return '<div id="wa-local-sync-bar">'
        + '<span id="waLocalSyncRuntimeStatus" class="wa-sync-status-mini">'
        + '<span class="wa-sync-status-item" id="wa-sync-service-state"></span>'
        + '<label class="wa-sync-status-item wa-sync-toggle-label"><input type="checkbox" id="wa-local-sync-realtime-upload" ' + (isLocalSyncRealtimeUploadEnabled() ? 'checked' : '') + '>实时上传：<span id="wa-sync-upload-state" style="display:inline-flex;align-items:center;gap:3px;"></span></label>'
        + '<label class="wa-sync-status-item wa-sync-toggle-label"><input type="checkbox" id="wa-local-sync-aggregate" ' + (isLocalSyncAggregateEnabled() ? 'checked' : '') + '>实时汇总：<span id="wa-sync-summary-state" style="display:inline-flex;align-items:center;gap:3px;"></span></label>'
        + '<span class="wa-sync-status-item">本地：<span id="wa-sync-local-count"></span></span>'
        + '<span class="wa-sync-status-item">服务端：<span id="wa-sync-server-count"></span></span>'
        + '<span class="wa-sync-status-item">源：<span id="wa-sync-source-count"></span></span>'
        + '<span class="wa-sync-status-item">记录：<span id="wa-sync-contact-count"></span></span>'
        + '<span class="wa-sync-status-item">上传：<span id="wa-sync-upload-time"></span></span>'
        + '<span class="wa-sync-status-item">汇总：<span id="wa-sync-summary-time"></span></span>'
        + '<span class="wa-sync-error-text" id="wa-sync-error-text" style="display:none;"></span>'
        + '</span></div>';
    }
    function bindLocalSyncBarEvents(renderAllFn, rootDoc) {
      var doc = rootDoc || (managePanelWindow && !managePanelWindow.closed ? managePanelWindow.document : document);
      var panelWin = (doc && doc.defaultView) || managePanelWindow || window;

      try {
        v892InjectSyncCss(doc);
        v894EnsureTitleSourceBox(doc);
      } catch(e) {}

      var nameInput = doc.getElementById('wa-local-sync-source-name');
      var upToggle = doc.getElementById('wa-local-sync-realtime-upload');
      var aggToggle = doc.getElementById('wa-local-sync-aggregate');
      var uploadBtn = doc.getElementById('wa-local-sync-upload-once');
      var refreshBtn = doc.getElementById('wa-local-sync-refresh-aggregate');
      var checkBtn = doc.getElementById('wa-local-sync-check');
      var diagBtn = doc.getElementById('wa-local-sync-diag');
      var reconcileBtn = doc.getElementById('wa-local-sync-reconcile-source');

      function refresh() {
        if (typeof renderAllFn === 'function') renderAllFn();
      }

      function show(msg) {
        try {
          panelWin.alert(msg);
        } catch(e) {
          try { alert(msg); } catch(_e) {}
        }
      }

      function confirmSafe(msg) {
        try {
          return panelWin.confirm(msg);
        } catch(e) {
          try { return confirm(msg); } catch(_e) { return false; }
        }
      }

      function setBtnBusy(btn, text) {
        if (!btn) return;
        btn.disabled = true;
        btn.__oldText = btn.textContent;
        btn.textContent = text || '处理中...';
      }

      function restoreBtn(btn, fallbackText) {
        if (!btn) return;
        btn.disabled = false;
        btn.textContent = btn.__oldText || fallbackText || btn.textContent;
        delete btn.__oldText;
      }

      if (nameInput && !nameInput.__v897Bound) {
        nameInput.__v897Bound = true;
        nameInput.__v893OldValue = nameInput.value;

        nameInput.addEventListener('input', function() {
          v894AutoSizeSourceInput(nameInput);
        });

        async function autoSaveSourceName() {
          var newName = String(nameInput.value || '').trim();

          if (!newName) {
            nameInput.value = getLocalSyncSourceName();
            v894AutoSizeSourceInput(nameInput);
            return;
          }

          if (newName === nameInput.__v893OldValue) return;

          nameInput.__v893OldValue = setLocalSyncSourceName(newName);
          nameInput.value = nameInput.__v893OldValue;
          v894AutoSizeSourceInput(nameInput);

          if (isLocalSyncRealtimeUploadEnabled()) {
            try { scheduleLocalSyncAutoUpload(); } catch(e) {}
          }

          try { v892RenderSyncLights(); } catch(e) {}
          show('修改源名称成功');
        }

        nameInput.addEventListener('blur', autoSaveSourceName);
        nameInput.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            nameInput.blur();
          }
        });

        v894AutoSizeSourceInput(nameInput);
      }

      if (upToggle) {
        upToggle.onchange = async function() {
          var on = !!upToggle.checked;
          setLocalSyncRealtimeUploadEnabled(on);

          if (on) {
            v892SetRuntime({ upload:'busy', lastError:'' });

            var r = await localSyncUploadOnly();

            v892SetRuntime({
              upload: r && r.ok ? 'ok' : 'error',
              lastUploadAt: r && r.ok ? Date.now() : v892SyncRuntime().lastUploadAt,
              lastError: r && r.ok ? '' : ('上传失败：' + ((r && (r.error || r.status)) || '未知错误'))
            });

            await v892RefreshCounts();
          } else {
            v892SetRuntime({ upload:'off' });
          }

          refresh();
        };
      }

      if (aggToggle) {
        aggToggle.onchange = async function() {
          var on = !!aggToggle.checked;
          setLocalSyncAggregateEnabled(on);

          if (on) {
            v892SetRuntime({ summary:'busy', lastError:'' });

            var r = await localSyncRefreshAggregate();

            v892SetRuntime({
              summary: r && r.ok ? 'ok' : 'error',
              lastSummaryAt: r && r.ok ? Date.now() : v892SyncRuntime().lastSummaryAt,
              lastError: r && r.ok ? '' : ('汇总失败：' + ((r && (r.error || r.status)) || '未知错误'))
            });

            await v892RefreshCounts();
            startLocalSyncAggregatePolling(renderAllFn);
          } else {
            stopLocalSyncAggregatePolling();
            LOCAL_SYNC_LAST_STATUS.contacts = [];
            v892SetRuntime({ summary:'off' });
          }

          refresh();
        };
      }

      if (uploadBtn) {
        uploadBtn.onclick = async function() {
          setBtnBusy(uploadBtn, '上传中...');
          v892SetRuntime({ upload:'busy', lastError:'' });

          try {
            var r = await localSyncUploadOnly();

            v892SetRuntime({
              upload: r && r.ok ? 'ok' : 'error',
              lastUploadAt: r && r.ok ? Date.now() : v892SyncRuntime().lastUploadAt,
              lastError: r && r.ok ? '' : ('上传失败：' + ((r && (r.error || r.status)) || '未知错误'))
            });

            await v892RefreshCounts();
            refresh();

            show(r && r.ok ? '本源上传完成。' : ('上传失败：' + ((r && (r.error || r.status)) || '请确认本地服务。')));
          } catch(e) {
            v892SetRuntime({
              upload:'error',
              lastError:'上传异常：' + ((e && e.message) || e)
            });
            show('上传失败：' + ((e && e.message) || e));
          } finally {
            restoreBtn(uploadBtn, '上传一次');
          }
        };
      }

      if (refreshBtn) {
        refreshBtn.onclick = async function() {
          setBtnBusy(refreshBtn, '刷新中...');
          v892SetRuntime({ summary:'busy', lastError:'' });

          try {
            var r = await localSyncRefreshAggregate();

            v892SetRuntime({
              summary: r && r.ok ? 'ok' : 'error',
              lastSummaryAt: r && r.ok ? Date.now() : v892SyncRuntime().lastSummaryAt,
              lastError: r && r.ok ? '' : ('刷新失败：' + ((r && (r.error || r.status)) || '未知错误'))
            });

            await v892RefreshCounts();
            refresh();

            show(r && r.ok ? '汇总刷新完成。' : ('刷新失败：' + ((r && (r.error || r.status)) || '请确认本地服务。')));
          } catch(e) {
            v892SetRuntime({
              summary:'error',
              lastError:'刷新异常：' + ((e && e.message) || e)
            });
            show('刷新失败：' + ((e && e.message) || e));
          } finally {
            restoreBtn(refreshBtn, '刷新汇总');
          }
        };
      }

      if (checkBtn) {
        checkBtn.onclick = async function() {
          setBtnBusy(checkBtn, '检测中...');
          v892SetRuntime({ service:'busy', lastError:'' });

          try {
            var r = await localSyncHealthCheck();
            await localSyncFetchSourcesAndStats();
            await v892RefreshCounts();

            v892SetRuntime({
              service: r && r.ok ? 'ok' : 'error',
              lastError: r && r.ok ? '' : ('连接失败：' + ((r && (r.error || r.status)) || '未知错误'))
            });

            refresh();

            show(r && r.ok ? '连接成功。' : ('连接失败：' + ((r && (r.error || r.status)) || '未知错误')));
          } catch(e) {
            v892SetRuntime({
              service:'error',
              lastError:'检测异常：' + ((e && e.message) || e)
            });
            show('连接检测失败：' + ((e && e.message) || e));
          } finally {
            restoreBtn(checkBtn, '检测连接');
          }
        };
      }

      if (diagBtn) {
        diagBtn.onclick = function() {
          show(localSyncDiagText() + '\n\nv89.7运行状态：\n' + JSON.stringify(v892SyncRuntime(), null, 2));
        };
      }

      if (reconcileBtn) {
        reconcileBtn.onclick = async function() {
          var localCount = 0;

          try {
            localCount = Object.keys(loadData() || {}).length;
          } catch(e) {}

          var ok = confirmSafe(
            '确定强制重建本源吗？\n\n' +
            '这会以当前浏览器/Profile 的 GM_storage 为准，校准同步服务中当前 sourceId 下的数据。\n\n' +
            '本地现有：' + localCount + ' 条\n\n' +
            '执行步骤：\n' +
            '1. 读取当前本地联系人 ID\n' +
            '2. 调用 source-reconcile 删除服务端当前源残留\n' +
            '3. 全量上传当前本地数据\n' +
            '4. 刷新统计和汇总\n\n' +
            '注意：只影响当前源，不会删除其他源数据，也不会删除浏览器本地数据。'
          );

          if (!ok) return;

          setBtnBusy(reconcileBtn, '重建中...');
          v892SetRuntime({ upload:'busy', lastError:'' });

          var r = null;

          try {
            r = await localSyncForceRebuildCurrentSource();

            v892SetRuntime({
              upload: r && r.ok ? 'ok' : 'error',
              lastUploadAt: r && r.ok ? Date.now() : v892SyncRuntime().lastUploadAt,
              lastError: r && r.ok ? '' : ('重建失败：' + ((r && (r.error || r.status)) || '未知错误'))
            });

            await v892RefreshCounts();

            if (isLocalSyncAggregateEnabled()) {
              try {
                var ar = await localSyncRefreshAggregate();

                v892SetRuntime({
                  summary: ar && ar.ok ? 'ok' : 'error',
                  lastSummaryAt: ar && ar.ok ? Date.now() : v892SyncRuntime().lastSummaryAt,
                  lastError: ar && ar.ok ? '' : ('汇总刷新失败：' + ((ar && (ar.error || ar.status)) || '未知错误'))
                });
              } catch(e) {
                v892SetRuntime({
                  summary:'error',
                  lastError:'汇总刷新异常：' + ((e && e.message) || e)
                });
              }
            }

            refresh();

            if (r && r.ok) {
              show(
                '本源重建成功。' +
                '\n\n本地保留/上传：' + (r.kept || 0) + ' 条' +
                '\n服务端删除残留：' + (r.deleted || 0) + ' 条'
              );
            } else {
              show(
                '本源重建失败。' +
                '\n\n错误：' + ((r && (r.error || r.status)) || '未知错误') +
                '\n\n请点击“同步诊断”查看 lastRequest。'
              );
            }
          } catch(e) {
            v892SetRuntime({
              upload:'error',
              lastError:'重建异常：' + ((e && e.message) || e)
            });

            show(
              '本源重建失败。' +
              '\n\n异常：' + ((e && e.message) || e) +
              '\n\n请点击“同步诊断”查看 lastRequest。'
            );
          } finally {
            restoreBtn(reconcileBtn, '强制重建本源');
            try { v892RenderSyncLights(); } catch(e) {}
          }
        };
      }

      setTimeout(v892RenderSyncLights, 0);
    }
    // ================= v77 本机多数据源同步模块 END =================

    function openManagePanel() {
    if (managePanelWindow && !managePanelWindow.closed) {
      managePanelWindow.focus();
      return;
    }
    runLinkScan();
    var win = window.open('', 'wa_remark_manage_panel');
    if (!win) { alert('\u65b0\u6807\u7b7e\u9875\u88ab\u62e6\u622a\uff0c\u8bf7\u5141\u8bb8\u672c\u7ad9\u5f39\u51fa\u65b0\u9875\u9762\u540e\u91cd\u8bd5\u3002'); return; }
    managePanelWindow = win;
    win.document.open();
    win.document.write(buildManagePanelShell());
    win.document.close();

      try {
        var v89Style = win.document.createElement('style');
        v89Style.textContent = '.wa-remote-readonly-row{background:#f8fafc!important;box-shadow:inset 4px 0 0 #94a3b8;}.wa-remote-readonly-row:hover{background:#f1f5f9!important;}.wa-remote-readonly-row textarea,.wa-remote-readonly-row input,.wa-remote-readonly-row select,.wa-remote-readonly-input{background:#f1f5f9!important;color:#64748b!important;cursor:not-allowed!important;}.wa-remote-readonly-badge{display:inline-block;padding:2px 7px;border-radius:999px;background:#e2e8f0;color:#334155;font-weight:700;font-size:12px;white-space:nowrap;line-height:1.4;}.wa-local-origin-badge{display:inline-block;padding:2px 7px;border-radius:999px;background:#dcfce7;color:#166534;font-weight:700;font-size:12px;white-space:nowrap;line-height:1.4;}.local-sync-readonly-tip{color:#64748b;font-size:12px;margin-left:8px;}body.dark .wa-remote-readonly-row{background:#1e293b!important;box-shadow:inset 4px 0 0 #64748b;}body.dark .wa-remote-readonly-row:hover{background:#263449!important;}body.dark .wa-remote-readonly-row textarea,body.dark .wa-remote-readonly-row input,body.dark .wa-remote-readonly-row select,body.dark .wa-remote-readonly-input{background:#0f172a!important;color:#94a3b8!important;}body.dark .wa-remote-readonly-badge{background:#334155;color:#cbd5e1;}body.dark .wa-local-origin-badge{background:#14532d;color:#bbf7d0;}';
        win.document.head.appendChild(v89Style);
      } catch(e) {}


    var state = {
      search: '',
      tagFilter: '', selectedTags1: [], selectedTags2: [],
      platformFilter: '',
      sort: 'updatedAt_desc',
      selected: {},
      wrapMode: (function () {
        var s = getSettings();
        return (typeof s.wrapMode === 'undefined') ? true : !!s.wrapMode;
      })(),
      dark: !!getSettings().darkMode,
      dashboardOpen: false,
      mainGroupCollapsed: false,
      expandedMainKeys: {}
    };

    function esc(s) {
      s = String(s == null ? '' : s);
      return s.replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function fmtTime(ts) {
      if (!ts) return '';
      var d = new Date(ts);
      var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
      return (d.getMonth() + 1) + '/' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    }

    function computeDisplayFields(row) {
      var rawName = row.name || '';
      var phone = row.manualPhone || '';
      var displayName = rawName;
      var nameNote = '';
      if (isPhoneLikeText(rawName)) {
        if (!phone) { phone = rawName; }
        displayName = '(\u672a\u4fdd\u5b58\u8054\u7cfb\u4eba)';
        nameNote = rawName;
      }
      return { displayName: displayName, nameNote: nameNote, displayPhone: phone };
    }

    // \u4fee\u590d\u540e\u7684 getAllRows\uff1a\u6b63\u786e\u4f7f\u7528 effectiveRecord / tagStageRecord \u5b57\u6bb5\u540d
    // v53: 下表明细严格读取各渠道本身的独立私有数据，彻底杜绝聚合数据回流污染
    function getRowPhoneNorm(e) {
      if (!e) return '';
      var phoneSrc = e.manualPhone || '';
      try {
        if (!phoneSrc && typeof isPhoneLikeText === 'function' && isPhoneLikeText(e.name)) {
          phoneSrc = e.name || '';
        }
      } catch (err) {}
      return normalizePhone(phoneSrc);
    }

    function getRowSourceId(e) {
      if (!e) return getLocalSyncSourceId();
      return e.__syncSourceId || e.sourceId || e.__sourceId || getLocalSyncSourceId();
    }

    function getRowSourceName(e) {
      if (!e) return getLocalSyncSourceName();
      return e.__syncSourceName || e.sourceName || e.__sourceName || getLocalSyncSourceName();
    }

    function countUniqueSources(members) {
      var set = {};
      (members || []).forEach(function (m) {
        var sid = m.__sourceId || m.__syncSourceId || m.sourceId || 'local';
        set[sid] = true;
      });
      return Object.keys(set).length;
    }

    function buildCrossSourceMainRows() {
      var data = getPanelDisplayData();
      var phoneMap = {};
      Object.keys(data || {}).forEach(function (id) {
        var e = data[id];
        if (!e) return;
        if (isAnyMainRecordV93(id, e)) return;
        var norm = getRowPhoneNorm(e);
        if (!norm) return;
        if (!phoneMap[norm]) phoneMap[norm] = [];
        var platform = inferPlatform(e, id);
        var member = Object.assign({
          __id: id,
          __platform: platform,
          __sourceId: getRowSourceId(e),
          __sourceName: getRowSourceName(e),
          __fromLocalSync: !!e.__fromLocalSync
        }, e);
        phoneMap[norm].push(member);
      });
      var rows = [];
      Object.keys(phoneMap).forEach(function (norm) {
        var members = phoneMap[norm] || [];
        if (members.length < 2) return;
        var mainKey = getMainKey(norm);
        var main = buildMainRecordFromMembers(mainKey, members, null);
        main.__id = mainKey;
        main.__platform = 'main';
        main.__isMainRecord = true;
        main.__isGroup = true;
        main.__isCrossSourceMain = true;
        main.__mainKey = mainKey;
        main.__members = members;
        main.__memberCount = members.length;
        main.__sourceCount = countUniqueSources(members);
        main.memberIds = members.map(function (m) { return m.__id; });
        main.manualPhone = norm;
        main.tag = main.tag || '';
        main.tag2 = Array.isArray(main.tag2) ? main.tag2 : (main.tag2 ? [main.tag2] : []);
        main.stages = Array.isArray(main.stages) ? main.stages : (main.stages ? [main.stages] : []);
        rows.push(main);
      });
      return rows;
    }

    function getAllRows() {
      var data = getPanelDisplayData();
      var rows = [];
      Object.keys(data || {}).forEach(function (id) {
        var e = data[id];
        if (!e) return;
        if (isAnyMainRecordV93(id, e)) return;
        var platform = inferPlatform(e, id);
        var row = Object.assign({
          __id: id,
          __platform: platform,
          __sourceId: getRowSourceId(e),
          __sourceName: getRowSourceName(e),
          __fromLocalSync: !!e.__fromLocalSync
        }, e);
        var ctx = resolveDisplayContext(id);
        FIELDS.forEach(function (f) { row[f.key] = e[f.key] || ''; });
        row.tag = ctx.tagStageRecord ? (ctx.tagStageRecord.tag || '') : (e.tag || '');
        row.tag2 = Array.isArray(e.tag2) ? e.tag2 : (e.tag2 ? [e.tag2] : []);
        row.stages = ctx.tagStageRecord ? (ctx.tagStageRecord.stages || []) : (e.stages || []);
        var norm = getRowPhoneNorm(e);
        row.__mainKey = norm ? getMainKey(norm) : ((ctx.linkInfo && ctx.linkInfo.mainKey) || null);
        rows.push(row);
      });
      return rows;
    }

    function getAllRowsWithMain() {
      var rows = [];
      buildCrossSourceMainRows().forEach(function (r) { rows.push(r); });
      getAllRows().forEach(function (r) { rows.push(r); });
      return rows;
    }

    function getDisplayRows() {
      var all = getAllRows();
      return all.filter(function (r) {
        if (!r.__mainKey) return true;
        return !!state.expandedMainKeys[r.__mainKey];
      });
    }

    function getMainGroupRows() {
      var mainRows = buildCrossSourceMainRows();
      var selectedTags1 = state.selectedTags1 || (state.tagFilter ? [state.tagFilter] : []);
      var selectedTags2 = state.selectedTags2 || [];
      var targetPlat = state.platformFilter || '';
      var kw = state.search.trim().toLowerCase();
      return mainRows.filter(function (main) {
        var members = Array.isArray(main.__members) ? main.__members : [];
        var memberPlats = [];
        var allTags1 = [main.tag || ''];
        var allTags2 = Array.isArray(main.tag2) ? main.tag2.slice() : (main.tag2 ? [main.tag2] : []);
        members.forEach(function (m) {
          if (m.__platform && memberPlats.indexOf(m.__platform) < 0) memberPlats.push(m.__platform);
          if (m.tag && allTags1.indexOf(m.tag) < 0) allTags1.push(m.tag);
          var mArr2 = Array.isArray(m.tag2) ? m.tag2 : (m.tag2 ? [m.tag2] : []);
          mArr2.forEach(function (t) { if (t && allTags2.indexOf(t) < 0) allTags2.push(t); });
        });
        if (targetPlat && targetPlat !== 'main' && memberPlats.indexOf(targetPlat) < 0) return false;
        if (selectedTags1.length > 0) {
          var matchT1 = selectedTags1.some(function (t) { return allTags1.indexOf(t) >= 0; });
          if (!matchT1) return false;
        }
        if (selectedTags2.length > 0) {
          var matchT2 = selectedTags2.some(function (t) { return allTags2.indexOf(t) >= 0; });
          if (!matchT2) return false;
        }
        if (kw) {
          var hay = [main.name, main.manualPhone, main.remark, main.f1, main.f2, main.f3, main.f4, main.f5, main.f6, main.f7, main.f8]
            .concat(members.map(function (m) { return [m.name, m.manualPhone, m.remark, m.f1, m.f2, m.f3, m.f4, m.f5, m.f6, m.f7, m.f8, m.__sourceName].join(' '); }))
            .map(function (v) { return (v || '').toString().toLowerCase(); }).join(' ');
          if (hay.indexOf(kw) < 0) return false;
        }
        return true;
      });
    }

    function applyFilters(rows) {
      var kw = state.search.trim().toLowerCase();
      var selectedTags1 = state.selectedTags1 || (state.tagFilter ? [state.tagFilter] : []);
      var selectedTags2 = state.selectedTags2 || [];

      return rows.filter(function (r) {
        if (state.platformFilter && r.__platform !== state.platformFilter) return false;
        if (selectedTags1.length > 0) {
          var rt1 = r.tag || '';
          if (selectedTags1.indexOf(rt1) < 0) return false;
        }
        if (selectedTags2.length > 0) {
          var rt2 = Array.isArray(r.tag2) ? r.tag2 : (r.tag2 ? [r.tag2] : []);
          var hasT2 = selectedTags2.some(function(t){ return rt2.indexOf(t) >= 0; });
          if (!hasT2) return false;
        }
        if (kw) {
          var hay = [r.name, r.manualPhone, r.remark, r.f1, r.f2, r.f3, r.f4, r.f5, r.f6, r.f7, r.f8]
            .map(function (v) { return (v || '').toString().toLowerCase(); }).join(' ');
          if (hay.indexOf(kw) < 0) return false;
        }
        return true;
      });
    }

    // v53: 展开的关联渠道强力置顶在列表最顶端，同组聚拢，其后为普通联系人
    function applySort(rows) {
      var expandedGroupRows = [];
      var normalRows = [];
      rows.forEach(function (r) {
        if (r.__mainKey && state.expandedMainKeys[r.__mainKey]) {
          expandedGroupRows.push(r);
        } else {
          normalRows.push(r);
        }
      });

      function sortFn(a, b) {
        if (state.sort === 'name_asc') return (a.name || '').localeCompare(b.name || '');
        if (state.sort === 'name_desc') return (b.name || '').localeCompare(a.name || '');
        if (state.sort === 'updatedAt_asc') return (a.updatedAt || 0) - (b.updatedAt || 0);
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      }

      normalRows.sort(sortFn);

      // 置顶的关联组成员按组聚拢
      var groupedExpanded = [];
      var visited = {};
      expandedGroupRows.forEach(function (r) {
        var mk = r.__mainKey;
        if (!visited[mk]) {
          visited[mk] = true;
          var members = expandedGroupRows.filter(function (item) { return item.__mainKey === mk; });
          members.sort(sortFn);
          members.forEach(function (m) { groupedExpanded.push(m); });
        }
      });

      return groupedExpanded.concat(normalRows);
    }

    function renderPlatformBar() {
      var bar = win.document.getElementById('platformBar');
      var rows = getAllRowsWithMain();
      var counts = {};
      rows.forEach(function (r) { counts[r.__platform] = (counts[r.__platform] || 0) + 1; });
      var html = '<span class="platpill" data-plat="" style="background:#37474f;">\u5168\u90e8 (' + rows.length + ')</span>';
      Object.keys(PLATFORM_INFO).forEach(function (k) {
        var info = PLATFORM_INFO[k];
        var c = counts[k] || 0;
        html += '<span class="platpill" data-plat="' + k + '" style="background:' + info.color + ';">' +
          info.short + ' (' + c + ')</span>';
      });
      bar.innerHTML = html;
      bar.querySelectorAll('.platpill').forEach(function (el) {
        if (el.getAttribute('data-plat') === state.platformFilter) el.classList.add('active');
        el.addEventListener('click', function () {
          var p = el.getAttribute('data-plat');
          state.platformFilter = p;
      renderAll();
        });
      });
    }

    function renderTagBar() {
      var bar = win.document.getElementById('tagBar');
      var rows = getAllRows();
      var t1List = getTags1();
      var t2List = getTags2();

      // 穿透统计：包括收起与展开的所有渠道及独立账号
      var counts1 = {};
      rows.forEach(function (r) {
        var t = r.tag || '';
        counts1[t] = (counts1[t] || 0) + 1;
      });

      var counts2 = {};
      rows.forEach(function (r) {
        var arr = Array.isArray(r.tag2) ? r.tag2 : (r.tag2 ? [r.tag2] : []);
        arr.forEach(function(t){ if (t) counts2[t] = (counts2[t] || 0) + 1; });
      });

      var html = '<div style="display:flex;flex-direction:column;gap:6px;width:100%;">';

      // 第一行：标签1体系（最前面为 全部标签1）
      var isT1AllActive = (!state.selectedTags1 || state.selectedTags1.length === 0);
      html += '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">';
      html += '<span style="font-size:12px;font-weight:700;color:var(--sub);margin-right:2px;">标签1:</span>';
      html += '<span class="tagpill t1-pill' + (isT1AllActive ? ' active' : '') + '" data-t1="__ALL__" style="background:#54656f;">全部标签1 (' + rows.length + ')</span>';

      t1List.forEach(function (t) {
        var c = counts1[t.key] || 0;
        var isAct = state.selectedTags1 && state.selectedTags1.indexOf(t.key) >= 0;
        html += '<span class="tagpill t1-pill' + (isAct ? ' active' : '') + '" data-t1="' + esc(t.key) + '" style="background:' + t.color + ' !important;">' +
          esc(t.label) + ' (' + c + ')</span>';
      });
      html += '</div>';

      // 第二行：标签2体系（方案B画像多选）
      var isT2AllActive = (!state.selectedTags2 || state.selectedTags2.length === 0);
      html += '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">';
      html += '<span style="font-size:12px;font-weight:700;color:var(--sub);margin-right:2px;">标签2:</span>';
      html += '<span class="tagpill t2-pill' + (isT2AllActive ? ' active' : '') + '" data-t2="__ALL__" style="background:#54656f;">全部画像</span>';

      t2List.forEach(function (t) {
        var c = counts2[t.key] || 0;
        var isAct = state.selectedTags2 && state.selectedTags2.indexOf(t.key) >= 0;
        html += '<span class="tagpill t2-pill' + (isAct ? ' active' : '') + '" data-t2="' + esc(t.key) + '" style="background:' + t.color + ' !important;">' +
          esc(t.label) + ' (' + c + ')</span>';
      });
      html += '</div>';

      html += '</div>';
      bar.innerHTML = html;

      // 绑定标签1点击事件（支持多选并集，点击具体标签穿透展开关联组）
      bar.querySelectorAll('.t1-pill').forEach(function (el) {
        el.addEventListener('click', function () {
          var v = el.getAttribute('data-t1');
          if (v === '__ALL__') {
            state.selectedTags1 = [];
          } else {
            var idx = state.selectedTags1.indexOf(v);
            if (idx >= 0) {
              state.selectedTags1.splice(idx, 1);
            } else {
              state.selectedTags1.push(v);
            }

          }
          renderAll();
        });
      });

      // 绑定标签2点击事件（支持多选画像筛选，穿透展开关联组）
      bar.querySelectorAll('.t2-pill').forEach(function (el) {
        el.addEventListener('click', function () {
          var v = el.getAttribute('data-t2');
          if (v === '__ALL__') {
            state.selectedTags2 = [];
          } else {
            var idx = state.selectedTags2.indexOf(v);
            if (idx >= 0) {
              state.selectedTags2.splice(idx, 1);
            } else {
              state.selectedTags2.push(v);
            }

          }
          renderAll();
        });
      });

      var sel = win.document.getElementById('tagFilter');
      if (sel) {
        sel.innerHTML = '<option value="">全部标签1</option>' + t1List.map(function (t) {
          return '<option value="' + t.key + '">' + t.label + '</option>';
        }).join('');
        sel.value = state.selectedTags1[0] || '';
      }
      var batchSel = win.document.getElementById('batchTagSelect');
      if (batchSel) {
        batchSel.innerHTML = t1List.map(function (t) { return '<option value="' + t.key + '">' + t.label + '</option>'; }).join('');
      }
    }

    function renderStats() {
      var rows = getAllRowsWithMain();
      var filtered = applyFilters(rows);
      win.document.getElementById('statsBar').innerHTML =
        '\u5171 <b>' + rows.length + '</b> \u6761\u8bb0\u5f55\uff0c\u5f53\u524d\u7b5b\u9009\u51fa <b>' + filtered.length + '</b> \u6761';
    }

    function renderDashboard() {
      var dash = win.document.getElementById('dashboard');
      dash.classList.toggle('show', state.dashboardOpen);
      if (!state.dashboardOpen) return;
      var rows = getAllRowsWithMain(); // v90：总量与渠道分布包含主记录
      var childRowsOnly = getAllRows(); // v90：标签/阶段统计只算子记录，不算主记录

      function buildBarRows(counts, colorFn, labelFn, total) {
        var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
        return keys.map(function (k) {
          var c = counts[k];
          var pct = total ? Math.round(c / total * 100) : 0;
          return '<div class="bar-item"><div class="bar-label">' + esc(labelFn(k)) + '</div>' +
            '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + colorFn(k) + ';"></div></div>' +
            '<div class="bar-val">' + c + '</div></div>';
        }).join('');
      }

      var platCounts = {};
      rows.forEach(function (r) { platCounts[r.__platform] = (platCounts[r.__platform] || 0) + 1; });
      var tagCounts = {};
      childRowsOnly.forEach(function (r) { var t = r.tag || ''; tagCounts[t] = (tagCounts[t] || 0) + 1; });
      var stageCounts = {};
      childRowsOnly.forEach(function (r) {
        var st = Array.isArray(r.stages) ? r.stages : [];
        if (!st.length) stageCounts['__none'] = (stageCounts['__none'] || 0) + 1;
        st.forEach(function (s) { stageCounts[s] = (stageCounts[s] || 0) + 1; });
      });

      var html = '';
      html += '<div class="dash-row"><div class="dash-title">\u6e20\u9053\u5206\u5e03</div>' +
        buildBarRows(platCounts, function (k) { return getPlatformInfo(k).color; }, function (k) { return getPlatformInfo(k).short; }, rows.length) + '</div>';
      html += '<div class="dash-row"><div class="dash-title">\u6807\u7b7e\u5206\u5e03</div>' +
        buildBarRows(tagCounts, function (k) { var t = TAGS.filter(function (x) { return x.key === k; })[0]; return t ? t.color : '#999'; },
          function (k) { var t = TAGS.filter(function (x) { return x.key === k; })[0]; return t ? t.label : '\u672a\u5206\u7c7b'; }, rows.length) + '</div>';
      html += '<div class="dash-row"><div class="dash-title">\u8ddf\u8fdb\u9636\u6bb5\u5206\u5e03</div>' +
        buildBarRows(stageCounts, function () { return '#00a884'; },
          function (k) { return k === '__none' ? '\u672a\u6807\u8bb0\u9636\u6bb5' : getStageLabel(k); }, rows.length) + '</div>';
      dash.innerHTML = html;
    }

    function upsertCell(id, key, val) {
      upsertFieldSmart(id, {}, key, val);
    }

    function deleteRow(id) {
      if (!id) return;
      if (String(id).indexOf('sync::') === 0) { try { win.alert('🔒 这是其他源汇总数据，不能在当前源删除。请到来源浏览器/Profile 中删除。'); } catch(e) {} return; }
      var syncDeleteIds = [];
      var data = loadData();
      var e = data[id];
      if (e && e.mainKey) { unlinkChannel(id); data = loadData(); }
      if (Object.prototype.hasOwnProperty.call(data, id)) { delete data[id]; syncDeleteIds.push(id); }
      saveData(data);
      if (syncDeleteIds.length) localSyncBatchDelete(syncDeleteIds).then(function(){ if (isLocalSyncAggregateEnabled()) localSyncRefreshAggregate().then(function(){ try { refreshPanelIfOpen(); } catch(e) {} }); });
      try { runLinkScanAndRefreshPanelNow(); } catch (e) { }
    }

    function showCopyToast(msg) {
      try {
        var old = win.document.getElementById('__waCopyToast');
        if (old) old.remove();
        var el = win.document.createElement('div');
        el.id = '__waCopyToast';
        el.textContent = msg || '✅ 复制成功';
        el.style.cssText = 'position:fixed;right:24px;bottom:34px;z-index:999999;background:#00a884;color:#fff;padding:9px 16px;border-radius:8px;font-size:13px;font-weight:700;box-shadow:0 6px 20px rgba(0,0,0,.22);transition:opacity .25s,transform .25s;';
        win.document.body.appendChild(el);
        setTimeout(function(){ el.style.opacity='0'; el.style.transform='translateY(8px)'; }, 1300);
        setTimeout(function(){ if(el && el.parentNode) el.remove(); }, 1700);
      } catch(e) {}
    }

    function getFreshRowForCopy(row) {
      var fresh = Object.assign({}, row || {});
      try {
        var data = loadData();
        var id = row && row.__id;
        if (id && data[id]) {
          fresh = Object.assign({}, row, data[id]);
          fresh.__id = id;
          fresh.__platform = row.__platform || inferPlatform(data[id], id);
          fresh.__mainKey = row.__mainKey || data[id].mainKey || null;
          if (row.__isGroup) {
            fresh.__isGroup = true;
            fresh.__members = row.__members || [];
            fresh.__memberCount = row.__memberCount || (fresh.__members ? fresh.__members.length : 0);
          }
        }
      } catch(e) {}
      return fresh;
    }

    function copyContactText(row) {
      // v72.5：复制前主动让当前输入框失焦，配合 blur 即时保存，避免刚编辑内容仍停留在防抖队列
      try {
        var ae = win.document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) ae.blur();
      } catch(e) {}

      var r = getFreshRowForCopy(row);
      var disp = computeDisplayFields(r);
      var info = getPlatformInfo(r.__platform || inferPlatform(r, r.__id || ''));
      var lines = [];
      lines.push('姓名：' + (disp.nameNote || r.name || ''));
      lines.push('电话：' + (r.manualPhone || disp.displayPhone || ''));
      lines.push('渠道：' + ((info && info.short) || r.__platform || ''));
      lines.push('识别码：' + (r.__id || ''));
      lines.push('标签1：' + (function(){ var arr=getTags1(); for(var i=0;i<arr.length;i++){ if(arr[i].key===(r.tag||'')) return arr[i].label; } return r.tag || ''; })());
      lines.push('标签2：' + (function(){ var t2=Array.isArray(r.tag2)?r.tag2:(r.tag2?[r.tag2]:[]); var defs=getTags2(); return t2.map(function(k){ for(var i=0;i<defs.length;i++){ if(defs[i].key===k) return defs[i].label; } return k; }).filter(Boolean).join(' / '); })());
      lines.push('跟进阶段：' + ((Array.isArray(r.stages) ? r.stages : []).map(function(k){ return getStageLabel(k); }).join(' / ')));
      FIELDS.forEach(function (f) { lines.push(getFieldLabel(f.key) + '：' + (r[f.key] || '')); });
      lines.push('更新时间：' + fmtTime(r.updatedAt));
      var text = lines.join('\n');

      function ok(){ showCopyToast('✅ 复制成功：已复制全部列资料'); }
      function fail(){ try { GM_setClipboard(text); ok(); } catch(e) { showCopyToast('⚠️ 复制失败，请检查浏览器剪贴板权限'); } }
      try {
        if (win.navigator.clipboard && win.navigator.clipboard.writeText) {
          var ret = win.navigator.clipboard.writeText(text);
          if (ret && ret.then) ret.then(ok).catch(fail); else ok();
        } else fail();
      } catch (e) { fail(); }
      try { GM_setClipboard(text); } catch (e) {}
      return text;
    }


    function v74GetMainMemberIds(mainRow) {
      if (!mainRow) return [];
      if (Array.isArray(mainRow.memberIds)) return mainRow.memberIds.slice();
      if (Array.isArray(mainRow.__members)) return mainRow.__members.map(function (m) { return m.__id; }).filter(Boolean);
      var data = loadData();
      var main = data[mainRow.__id] || {};
      return Array.isArray(main.memberIds) ? main.memberIds.slice() : [];
    }
    function v74GetMainSelectionState(mainRow) {
      var ids = v74GetMainMemberIds(mainRow);
      var total = ids.length + 1;
      var checkedCount = state.selected[mainRow.__id] ? 1 : 0;
      ids.forEach(function (id) { if (state.selected[id]) checkedCount++; });
      return { checked: total > 0 && checkedCount === total, indeterminate: checkedCount > 0 && checkedCount < total, count: checkedCount, total: total };
    }
    function v74SetMainSelected(mainRow, checked) {
      state.selected[mainRow.__id] = !!checked;
      v74GetMainMemberIds(mainRow).forEach(function (id) { state.selected[id] = !!checked; });
    }
    function v74SyncMainSelectionByDetail(detailRow) {
      if (!detailRow || !detailRow.__mainKey) return;
      var data = loadData();
      var main = data[detailRow.__mainKey];
      if (!main) return;
      var mids = Array.isArray(main.memberIds) ? main.memberIds : [];
      var all = mids.length && mids.every(function (id) { return !!state.selected[id]; });
      var any = mids.some(function (id) { return !!state.selected[id]; });
      state.selected[detailRow.__mainKey] = !!all;
    }
    function v74GetRowsSelectionState(rows) {
      var total = 0, checked = 0;
      (rows || []).forEach(function (r) {
        if (r.__isGroup || isMainKey(r.__id)) {
          var st = v74GetMainSelectionState(r);
          total += st.total; checked += st.count;
        } else {
          total++; if (state.selected[r.__id]) checked++;
        }
      });
      return { checked: total > 0 && checked === total, indeterminate: checked > 0 && checked < total, count: checked, total: total };
    }
    function v74GetSelectedIds() {
      return Object.keys(state.selected).filter(function (k) { return state.selected[k]; });
    }
    function v74GetSelectedSummary() {
      var ids = v74GetSelectedIds(), g = 0, d = 0;
      ids.forEach(function (id) { if (isMainKey(id)) g++; else d++; });
      return { ids: ids, groupCount: g, detailCount: d };
    }

    function updateBatchBar() {
      var summary = v74GetSelectedSummary();
      var bar = win.document.getElementById('batchBar');
      var total = summary.groupCount + summary.detailCount;
      bar.classList.toggle('show', total > 0);
      win.document.getElementById('batchCount').textContent = '已选 ' + summary.groupCount + '组 / ' + summary.detailCount + '条';
    }

    function autoResizeCell(t) {
      t.style.height = 'auto';
      t.style.height = t.scrollHeight + 'px';
    }

    function renderTable() {
      var widths = getColWidths();
      var displayRows = getDisplayRows();

      var colgroup = win.document.getElementById('tableColgroup');
      colgroup.innerHTML = '';
      var containerEl = win.document.querySelector('.table-container');
      var containerWidth = (containerEl && containerEl.clientWidth) || ((win.innerWidth || 1200) - 60);
      var rowsForWidth = applySort(applyFilters(getDisplayRows()));
      var adaptiveWidths = calcAdaptiveFieldWidths(rowsForWidth, containerWidth, widths);

      COLUMNS.forEach(function (col) {
        var colEl = win.document.createElement('col');
        if (isFlexCol(col.key)) {
          colEl.style.width = (adaptiveWidths[col.key] || col.minWidth || 120) + 'px';
        } else {
          var w = widths[col.key] || col.width;
          colEl.style.width = w + 'px';
        }
        colgroup.appendChild(colEl);
      });

      var head = win.document.getElementById('tableHead');
      var trh = win.document.createElement('tr');
      COLUMNS.forEach(function (col) {
        var th = win.document.createElement('th');
        th.style.position = 'relative';
        if (col.key === '__avatar') th.classList.add('col-sticky-avatar');
        if (col.key === 'name') th.classList.add('col-sticky-name');
        if (isFlexCol(col.key)) {
          if (adaptiveWidths && adaptiveWidths[col.key]) th.style.width = adaptiveWidths[col.key] + 'px';
        } else {
          var initW = widths[col.key] || col.width;
          if (initW) th.style.width = initW + 'px';
        }
        if (col.key === '__chk') {
          var chkWrap = win.document.createElement('div');
          chkWrap.className = 'chk-wrap-th';
          var rowsNow = applySort(applyFilters(getDisplayRows()));
          var allState = v74GetRowsSelectionState(rowsNow);
          var chkAll = createCustomCheckboxDoc(win.document, allState.checked, function (checked) {
            var rows = applySort(applyFilters(getDisplayRows()));
            rows.forEach(function (r) { state.selected[r.__id] = checked; v74SyncMainSelectionByDetail(r); });
            renderAll();
          }, 14);
          if (allState.indeterminate) chkAll.setIndeterminate(true);
          chkWrap.appendChild(chkAll);
          th.appendChild(chkWrap);
        } else {
          var textSpan = win.document.createElement('span');
          textSpan.textContent = col.label;
          th.appendChild(textSpan);
          if (isFlexCol(col.key)) {
            var lockBtn = win.document.createElement('button');
            var lockedMap = getFieldColLocked();
            lockBtn.textContent = lockedMap[col.key] ? '🔒' : '🔓';
            lockBtn.title = lockedMap[col.key] ? '当前固定宽度，点击恢复自适应' : '当前自适应，点击固定当前宽度';
            lockBtn.style.cssText = 'margin-left:4px;border:none;background:transparent;cursor:pointer;font-size:12px;padding:0 2px;';
            lockBtn.addEventListener('click', function(e){ e.stopPropagation(); if (!getFieldColLocked()[col.key]) saveColWidth(col.key, th.offsetWidth || parseInt(th.style.width,10) || 120); toggleFieldColLocked(col.key); renderAll(); });
            th.appendChild(lockBtn);
          }
        }
        if (col.resizable) {
          var handle = win.document.createElement('div');
          handle.className = 'resize-handle';
          var startX, startW;
          handle.addEventListener('mousedown', function (ev) {
            ev.preventDefault();
            startX = ev.clientX;
            startW = th.offsetWidth;
            handle.classList.add('dragging');
            function syncWidth(nw) {
              th.style.width = nw + 'px';
              var idx = COLUMNS.indexOf(col);
              var colEls = colgroup.querySelectorAll('col');
              if (colEls[idx]) colEls[idx].style.width = nw + 'px';
              var mgColgroup = win.document.getElementById('mainGroupColgroup');
              if (mgColgroup) {
                var mgCols = mgColgroup.querySelectorAll('col');
                if (mgCols[idx]) mgCols[idx].style.width = nw + 'px';
              }
              var mgHeadThs = win.document.querySelectorAll('#mainGroupHead th');
              if (mgHeadThs && mgHeadThs[idx]) mgHeadThs[idx].style.width = nw + 'px';
            }
            function onMove(ev2) {
              var minW = col.minWidth || 50;
              var nw = Math.max(minW, startW + (ev2.clientX - startX));
              syncWidth(nw);
            }
            function onUp() {
              win.document.removeEventListener('mousemove', onMove);
              win.document.removeEventListener('mouseup', onUp);
              handle.classList.remove('dragging');
              if (isFlexCol(col.key)) { saveFieldDragAsWeight(col.key, th.offsetWidth); } else { saveColWidth(col.key, th.offsetWidth); }
            }
            win.document.addEventListener('mousemove', onMove);
            win.document.addEventListener('mouseup', onUp);
          });
          th.appendChild(handle);
        }
        trh.appendChild(th);
      });
      head.innerHTML = '';
      head.appendChild(trh);

      var body = win.document.getElementById('tableBody');
      body.innerHTML = '';
      var rows = applySort(applyFilters(displayRows));
      var detailBadge = win.document.getElementById('detailCountBadge');
      if (detailBadge) detailBadge.textContent = rows.length + ' 条';
      var pendingResize = [];

      var groupColorIndexMap = {};
      var colorPaletteCount = 5;
      var curColorIdx = 0;

      rows.forEach(function (row, idx) {
        var disp = computeDisplayFields(row);
        var tr = win.document.createElement('tr');
        tr.className = 'row-' + row.__platform;
          if (isRemoteSyncRecord(row)) { tr.classList.add('wa-remote-readonly-row'); tr.title = getRemoteSyncReadonlyTitle(row); delete state.selected[row.__id]; }
        if (row.__mainKey) {
          tr.setAttribute('data-main-key', row.__mainKey);
          if (groupColorIndexMap[row.__mainKey] === undefined) {
            groupColorIndexMap[row.__mainKey] = curColorIdx % colorPaletteCount;
            curColorIdx++;
          }
          var cIdx = groupColorIndexMap[row.__mainKey];
          tr.classList.add('link-group-bg-' + cIdx);
        }
        COLUMNS.forEach(function (col) {
          var td = win.document.createElement('td');
          if (col.key === '__index') {
            td.style.textAlign = 'center';
            td.style.color = 'var(--sub)';
            td.style.fontSize = '12px';
            td.style.userSelect = 'none';
            td.textContent = (idx + 1);
          } else if (col.key === '__chk') {
            td.style.textAlign = 'center';
            if (isRemoteSyncRecord(row)) {
              var lock = win.document.createElement('span');
              lock.textContent = '🔒';
              lock.title = '其他源数据为只读，不能参与批量修改或删除';
              lock.style.cssText = 'font-size:14px;color:#64748b;cursor:not-allowed;';
              td.appendChild(lock);
            } else {
              var chk = createCustomCheckboxDoc(win.document, !!state.selected[row.__id], function (checked) {
                state.selected[row.__id] = checked;
                v74SyncMainSelectionByDetail(row);
                renderAll();
              }, 14);
              td.appendChild(chk);
            }
          } else if (col.key === '__platform') {
            if (row.__isGroup) {
              td.innerHTML = '<span class="plat-badge" style="background:#6d4c41;">' + String.fromCodePoint(0x1F517) + ' \u7efc\u5408(' + row.__memberCount + ')</span>';
            } else {
              var info = getPlatformInfo(row.__platform);
              td.innerHTML = '<span class="plat-badge" style="background:' + info.color + ';">' + info.short + '</span>';
            }
              } else if (col.key === '__avatar') {
            td.classList.add('col-sticky-avatar');
            td.style.textAlign = 'center';
            td.style.verticalAlign = 'middle';
            td.style.padding = '3px';
            var avSrc = row.avatarData || row.__avatarData || row.__avatar || row.avatar || '';
            if (!avSrc && row.__members && Array.isArray(row.__members)) {
              for (var mi = 0; mi < row.__members.length; mi++) {
                var mAv = row.__members[mi].avatarData || row.__members[mi].__avatarData || row.__members[mi].avatar || row.__members[mi].__avatar;
                if (mAv) { avSrc = mAv; break; }
              }
            }
            if (avSrc) {
              var avImg = win.document.createElement('img');
              avImg.src = avSrc;
              avImg.setAttribute('referrerpolicy', 'no-referrer');
              avImg.style.cssText = 'width:34px;height:34px;border-radius:50%;object-fit:cover;border:1.5px solid var(--border,#d1d7db);display:block;margin:0 auto;cursor:pointer;transition:transform .15s;';
              avImg.title = '点击查看原图';
              (function(srcCopy) {
                avImg.onmouseover = function() { avImg.style.transform = 'scale(1.15)'; };
                avImg.onmouseout = function() { avImg.style.transform = 'scale(1)'; };
                avImg.onclick = function(e) { e.stopPropagation(); win.open(srcCopy, '_blank'); };
              })(avSrc);
              td.appendChild(avImg);
            } else {
              var avPh = win.document.createElement('div');
              avPh.style.cssText = 'width:34px;height:34px;border-radius:50%;background:var(--border,#e0e0e0);color:var(--sub,#888);display:flex;align-items:center;justify-content:center;font-size:14px;margin:0 auto;user-select:none;';
              avPh.title = '暂无头像';
              avPh.textContent = '👤';
              td.appendChild(avPh);
            }
          } else if (col.key === '__link') {
            if (isRemoteSyncRecord(row)) {
              var roBox = win.document.createElement('div');
              roBox.style.cssText = 'display:flex;gap:4px;align-items:center;flex-wrap:wrap;';
              appendRemoteSyncReadonlyBadge(win.document, roBox, row);
              td.appendChild(roBox);
            } else if (row.__mainKey) {
              var linkBox = win.document.createElement('div');
              linkBox.style.cssText = 'display:flex;gap:4px;align-items:center;flex-wrap:wrap;';
              var badge = win.document.createElement('span');
              badge.style.cssText = 'display:inline-block;padding:2px 6px;border-radius:10px;font-size:11px;color:#fff;background:#00a884;white-space:nowrap;';
              badge.textContent = '已关联';
              linkBox.appendChild(badge);

              var unlinkBtn = win.document.createElement('button');
              unlinkBtn.className = 'lg-act-btn lg-act-unlink';
              unlinkBtn.textContent = '解绑';
              unlinkBtn.title = '解除该渠道的关联并恢复为独立联系人';
              unlinkBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                if (!win.confirm('确定解除渠道 [' + (row.name || row.__id) + '] 的关联吗？解除后将恢复为独立联系人。')) return;
                unlinkChannel(row.__id);
                renderAll();
              });
              linkBox.appendChild(unlinkBtn);
              td.appendChild(linkBox);
            } else {
              td.innerHTML = '<span style="color:var(--sub);font-size:11px;">-</span>';
            }
          } else if (col.key === '__id') {
            td.className = 'id-cell';
            td.textContent = row.__isGroup ? ('\u2605 ' + row.__id.replace('MAIN::', '\u4e3b\u8bb0\u5f55:')) : row.__id;
            td.title = row.__id;
          } else if (col.key === 'name') {
            td.classList.add('col-sticky-name');
            td.textContent = disp.displayName;
            if (disp.nameNote) {
              td.title = '\u539f\u59cb\u8bc6\u522b\u540d\u79f0\uff1a' + disp.nameNote;
              td.style.color = 'var(--sub)';
              td.style.fontStyle = 'italic';
            } else {
              td.title = disp.displayName;
            }
          } else if (col.key === 'tag') {
            var sel = win.document.createElement('select');
            sel.className = 'tag-sel-inline';
            var curTagVal = row.tag || '';
            var curTagColor = getTag1Color(curTagVal);
            sel.style.background = (curTagVal ? curTagColor : 'transparent');
            sel.style.color = (curTagVal ? '#fff' : 'inherit');
            sel.style.fontWeight = '600';
            sel.style.border = '1px solid ' + (curTagVal ? curTagColor : 'var(--border)');
            var t1List = getTags1();
            t1List.forEach(function (t) {
              var opt = win.document.createElement('option');
              opt.value = t.key; opt.textContent = t.label;
              opt.style.background = 'var(--card, #fff)';
              opt.style.color = 'var(--text, #111b21)';
              if (curTagVal === t.key) opt.selected = true;
              sel.appendChild(opt);
            });
            if (isRemoteSyncRecord(row)) { sel.disabled = true; sel.title = getRemoteSyncReadonlyTitle(row); sel.style.cursor = 'not-allowed'; sel.style.opacity = '0.75'; }
            sel.addEventListener('change', function () {
              var newCol = getTag1Color(sel.value);
              sel.style.background = (sel.value ? newCol : 'transparent');
              sel.style.color = (sel.value ? '#fff' : 'inherit');
              sel.style.borderColor = (sel.value ? newCol : 'var(--border)');
              if (guardRemoteSyncEdit(row)) { renderAll(); return; }
              upsertTagSmart(row.__id, {}, sel.value);
              renderAll();
            });
            td.appendChild(sel);
          } else if (col.key === 'tag2') {
            // v54 方案B：平时紧凑徽章显示，点击弹出悬浮勾选面板
            var curTags2 = Array.isArray(row.tag2) ? row.tag2 : (row.tag2 ? [row.tag2] : []);
            var t2List = getTags2();
            var badgeWrap = win.document.createElement('div');
            badgeWrap.style.cssText = 'display:flex;gap:3px;flex-wrap:wrap;align-items:center;cursor:pointer;min-height:22px;';
            badgeWrap.title = '点击选择画像(多选)';

            if (!curTags2.length) {
              badgeWrap.innerHTML = '<span style="font-size:11px;color:var(--sub);border:1px dashed var(--border);padding:1px 5px;border-radius:3px;">+画像</span>';
            } else {
              curTags2.forEach(function (tKey) {
                var def = t2List.filter(function(x){ return x.key === tKey; })[0];
                var bg = def ? def.color : '#78909c';
                var lbl = def ? def.label : tKey;
                var badge = win.document.createElement('span');
                badge.style.cssText = 'display:inline-block;padding:1px 5px;border-radius:10px;font-size:10px;color:#fff;background:' + bg + ';white-space:nowrap;line-height:1.2;';
                badge.textContent = lbl;
                badgeWrap.appendChild(badge);
              });
            }

            badgeWrap.addEventListener('click', function (ev) {
              ev.stopPropagation();
              showTag2SelectDropdown(win, ev, row.__id, curTags2, function (newTags) {
                upsertTag2Smart(row.__id, newTags);
                renderAll();
              });
            });
            td.appendChild(badgeWrap);
          } else if (col.key === '__stages') {
            var stArr = Array.isArray(row.stages) ? row.stages : [];
            var wrap = win.document.createElement('div');
            wrap.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
            STAGES.forEach(function (st) {
              var lbl = win.document.createElement('label');
              lbl.style.cssText = 'display:flex;align-items:center;gap:2px;font-size:11px;cursor:pointer;';
              var cb = createCustomCheckboxDoc(win.document, stArr.indexOf(st.key) >= 0, function (checked) {
                toggleStageSmart(row.__id, st.key, checked);
                renderAll();
              }, 13);
              lbl.appendChild(cb);
              var span = win.document.createElement('span');
              span.textContent = getStageLabel(st.key);
              lbl.appendChild(span);
              wrap.appendChild(lbl);
            });
            td.appendChild(wrap);
          } else if (col.key === 'updatedAt') {
            td.textContent = fmtTime(row.updatedAt);
          } else if (col.key === '__actions') {
            var copyBtn = win.document.createElement('button');
            copyBtn.className = 'icon-btn';
            copyBtn.textContent = String.fromCodePoint(0x1F4CB);
            copyBtn.title = '\u590d\u5236\u8d44\u6599';
            copyBtn.addEventListener('click', function () { copyContactText(row); });
            var delBtn = win.document.createElement('button');
            delBtn.className = 'icon-btn';
            delBtn.textContent = String.fromCodePoint(0x1F5D1) + String.fromCodePoint(0xFE0F);
            delBtn.title = row.__isGroup ? '\u89e3\u6563\u5206\u7ec4' : '\u5220\u9664';
            delBtn.addEventListener('click', function () {
              if (guardRemoteSyncEdit(row)) return;
              if (row.__isGroup) {
                if (win.confirm('\u8fd9\u662f\u4e00\u4e2a\u7efc\u5408\u5206\u7ec4\uff08' + row.__memberCount + ' \u4e2a\u6e20\u9053\uff09\uff0c\u786e\u5b9a\u89e3\u6563\u5e76\u5220\u9664\u5417\uff1f\u89e3\u6563\u540e\u5404\u6e20\u9053\u6062\u590d\u72ec\u7acb\u8bb0\u5f55\u3002')) {
                  row.__members.slice().forEach(function (m) { unlinkChannel(m.__id); });
                  var d = loadData();
                  delete d[row.__id];
                  saveData(d);
                  renderAll();
                }
              } else {
                if (win.confirm('\u786e\u5b9a\u5220\u9664 ' + (row.name || row.__id) + ' \u7684\u8bb0\u5f55\uff1f')) {
                  deleteRow(row.__id);
                  delete state.selected[row.__id];
                  renderAll();
                }
              }
            });
            td.appendChild(copyBtn);
            td.appendChild(delBtn);
          } else if (col.key === 'manualPhone') {
            td.className = 'input-td';
            var val = row.manualPhone || '';
            var isAutoFilled = (!val && disp.displayPhone);
            if (isAutoFilled) val = '';
            if (!val && !isAutoFilled) td.classList.add('cell-empty');
            // v73.4：电话栏由 input 改为 textarea，支持自动换行，同时保留失焦保存和 Enter 确认
            var input = win.document.createElement('textarea');
            input.className = 'cell-input';
            input.value = val;
            input.rows = 1;
            input.placeholder = isAutoFilled ? disp.displayPhone + '\uff08\u81ea\u52a8\u8bc6\u522b\uff0c\u70b9\u51fb\u53ef\u7f16\u8f91\u4fdd\u5b58\uff09' : '';
            input.style.background = '#fff';
            input.style.color = '#111b21';
            input.style.colorScheme = 'light';
            input.style.whiteSpace = 'pre-wrap';
            input.style.wordBreak = 'break-word';
            input.style.overflow = 'hidden';
            input.style.minHeight = '32px';
            input.__waDirty = false;
            input.addEventListener('input', function () {
              autoResizeCell(input);
              input.__waDirty = true;
              td.classList.toggle('cell-empty', !input.value);
            });
            input.addEventListener('keydown', function (e) {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                input.blur();
              }
            });
            input.addEventListener('blur', function () {
              autoResizeCell(input);
              if (!input.__waDirty) return;
              input.__waDirty = false;
              upsertCell(row.__id, 'manualPhone', input.value);
              td.classList.toggle('cell-empty', !input.value);
            });
            td.appendChild(input);
            pendingResize.push(input);
          } else if (FIELDS.some(function (f) { return f.key === col.key; })) {
            td.className = 'input-td';
            var val2 = row[col.key] || '';
            if (!val2) td.classList.add('cell-empty');
            var input2;
            if (col.key === 'remark' || col.key === 'f8' || state.wrapMode) {
              input2 = win.document.createElement('textarea');
              input2.className = 'cell-input';
              input2.value = val2;
              input2.rows = 1;
              pendingResize.push(input2);
            } else {
              input2 = win.document.createElement('input');
              input2.type = 'text';
              input2.className = 'cell-input';
              input2.value = val2;
            }
            // v73.2：管理面板文本字段输入过程中只更新本输入框状态，不保存、不聚合、不刷新整表；失焦后再统一保存并刷新 MAIN
            input2.__waDirty = false;
            input2.addEventListener('input', function () {
              autoResizeCell(input2);
              input2.__waDirty = true;
              td.classList.toggle('cell-empty', !input2.value);
            });
            // v73.3：Enter 确认保存，Shift+Enter 保留换行
            input2.addEventListener('keydown', function (e) {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                input2.blur();
              }
            });
            input2.addEventListener('blur', function () {
              autoResizeCell(input2);
              if (!input2.__waDirty) return;
              input2.__waDirty = false;
              upsertCell(row.__id, col.key, input2.value);
              td.classList.toggle('cell-empty', !input2.value);
            });
            td.appendChild(input2);
          }
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
      body.parentElement.parentElement.classList.toggle('wrap-mode', state.wrapMode);

      win.requestAnimationFrame(function () {
        pendingResize.forEach(function (t) { autoResizeCell(t); });
      });

      renderMainGroupTable();
    }
    // ========================================================
    // v48 专属：渲染独立的主记录专区表格（强只读保护）
    // ========================================================
    function renderMainGroupTable() {
      var mainSection = win.document.getElementById('mainGroupSection');
      var container = win.document.getElementById('mainGroupContainer');
      var badge = win.document.getElementById('mainGroupCountBadge');
      var collapseBtn = win.document.getElementById('mainGroupCollapseBtn');

      var mainRows = getMainGroupRows();
      if (!mainRows.length) {
        mainSection.style.display = 'none';
        return;
      }

      mainSection.style.display = 'block';
      badge.textContent = mainRows.length + ' 组';
      collapseBtn.textContent = state.mainGroupCollapsed ? '展开 ▼' : '收起 ▲';
      container.style.display = state.mainGroupCollapsed ? 'none' : 'block';

      var widths = getColWidths();
      var colgroup = win.document.getElementById('mainGroupColgroup');
      colgroup.innerHTML = '';
      var mgContainerWidth = (container && container.clientWidth) || ((win.innerWidth || 1200) - 60);
      var adaptiveWidths = calcAdaptiveFieldWidths(mainRows, mgContainerWidth, widths);
      COLUMNS.forEach(function (col) {
        var colEl = win.document.createElement('col');
        if (isFlexCol(col.key)) {
          colEl.style.width = (adaptiveWidths[col.key] || col.minWidth || 120) + 'px';
        } else {
          var w = widths[col.key] || col.width;
          colEl.style.width = w + 'px';
        }
        colgroup.appendChild(colEl);
      });

      var head = win.document.getElementById('mainGroupHead');
      var trh = win.document.createElement('tr');
      COLUMNS.forEach(function (col) {
        var th = win.document.createElement('th');
        th.style.position = 'relative';
        if (col.key === '__avatar') th.classList.add('col-sticky-avatar');
        if (col.key === 'name') th.classList.add('col-sticky-name');
        if (isFlexCol(col.key)) {
          if (adaptiveWidths && adaptiveWidths[col.key]) th.style.width = adaptiveWidths[col.key] + 'px';
        } else {
          var initW = widths[col.key] || col.width;
          if (initW) th.style.width = initW + 'px';
        }
        if (col.key === '__chk') {
          var chkWrap = win.document.createElement('div');
          chkWrap.className = 'chk-wrap-th';
          var mainState = v74GetRowsSelectionState(mainRows);
          var chkAllMain = createCustomCheckboxDoc(win.document, mainState.checked, function (checked) {
            mainRows.forEach(function (mr) { v74SetMainSelected(mr, checked); });
            renderAll();
          }, 14);
          if (mainState.indeterminate) chkAllMain.setIndeterminate(true);
          chkWrap.appendChild(chkAllMain);
          th.appendChild(chkWrap);
        } else {
          var textSpan = win.document.createElement('span');
          textSpan.textContent = col.label;
          th.appendChild(textSpan);
        }
        if (col.resizable) {
          var handle = win.document.createElement('div');
          handle.className = 'resize-handle';
          var startX, startW;
          handle.addEventListener('mousedown', function (ev) {
            ev.preventDefault();
            startX = ev.clientX;
            startW = th.offsetWidth;
            handle.classList.add('dragging');
            function syncWidth(nw) {
              th.style.width = nw + 'px';
              var idx = COLUMNS.indexOf(col);
              var colEls = colgroup.querySelectorAll('col');
              if (colEls[idx]) colEls[idx].style.width = nw + 'px';
              var mainColgroup = win.document.getElementById('tableColgroup');
              if (mainColgroup) {
                var mainCols = mainColgroup.querySelectorAll('col');
                if (mainCols[idx]) mainCols[idx].style.width = nw + 'px';
              }
              var mainHeadThs = win.document.querySelectorAll('#tableHead th');
              if (mainHeadThs && mainHeadThs[idx]) mainHeadThs[idx].style.width = nw + 'px';
            }
            function onMove(ev2) {
              var minW = col.minWidth || 50;
              var nw = Math.max(minW, startW + (ev2.clientX - startX));
              syncWidth(nw);
            }
            function onUp() {
              win.document.removeEventListener('mousemove', onMove);
              win.document.removeEventListener('mouseup', onUp);
              handle.classList.remove('dragging');
              if (isFlexCol(col.key)) { saveFieldDragAsWeight(col.key, th.offsetWidth); } else { saveColWidth(col.key, th.offsetWidth); }
            }
            win.document.addEventListener('mousemove', onMove);
            win.document.addEventListener('mouseup', onUp);
          });
          th.appendChild(handle);
        }
        trh.appendChild(th);
      });
      head.innerHTML = '';
      head.appendChild(trh);

      var body = win.document.getElementById('mainGroupBody');
      body.innerHTML = '';

      mainRows.forEach(function (row, idx) {
        var disp = computeDisplayFields(row);
        var tr = win.document.createElement('tr');
        tr.className = 'row-multi';

        COLUMNS.forEach(function (col) {
          var td = win.document.createElement('td');
          if (col.key === '__index') {
            td.style.textAlign = 'center';
            td.style.color = '#6d4c41';
            td.style.fontSize = '12px';
            td.style.fontWeight = 'bold';
            td.style.userSelect = 'none';
            td.textContent = (idx + 1);
          } else if (col.key === '__chk') {
            td.style.textAlign = 'center';
            var mainSelState = v74GetMainSelectionState(row);
            var mainChk = createCustomCheckboxDoc(win.document, mainSelState.checked, function (checked) {
              v74SetMainSelected(row, checked);
              renderAll();
            }, 14);
            if (mainSelState.indeterminate) mainChk.setIndeterminate(true);
            td.appendChild(mainChk);
          } else if (col.key === '__platform') {
            td.innerHTML = '<span class="plat-badge" style="background:#6d4c41;">🔗 关联(' + row.__memberCount + ')</span>';
              } else if (col.key === '__avatar') {
            td.classList.add('col-sticky-avatar');
            td.style.textAlign = 'center';
            td.style.verticalAlign = 'middle';
            td.style.padding = '3px';
            var avSrc = row.avatarData || row.__avatarData || row.__avatar || row.avatar || '';
            if (!avSrc && row.__members && Array.isArray(row.__members)) {
              for (var mi = 0; mi < row.__members.length; mi++) {
                var mAv = row.__members[mi].avatarData || row.__members[mi].__avatarData || row.__members[mi].avatar || row.__members[mi].__avatar;
                if (mAv) { avSrc = mAv; break; }
              }
            }
            if (avSrc) {
              var avImg = win.document.createElement('img');
              avImg.src = avSrc;
              avImg.setAttribute('referrerpolicy', 'no-referrer');
              avImg.style.cssText = 'width:34px;height:34px;border-radius:50%;object-fit:cover;border:1.5px solid var(--border,#d1d7db);display:block;margin:0 auto;cursor:pointer;transition:transform .15s;';
              avImg.title = '点击查看原图';
              (function(srcCopy) {
                avImg.onmouseover = function() { avImg.style.transform = 'scale(1.15)'; };
                avImg.onmouseout = function() { avImg.style.transform = 'scale(1)'; };
                avImg.onclick = function(e) { e.stopPropagation(); win.open(srcCopy, '_blank'); };
              })(avSrc);
              td.appendChild(avImg);
            } else {
              var avPh = win.document.createElement('div');
              avPh.style.cssText = 'width:34px;height:34px;border-radius:50%;background:var(--border,#e0e0e0);color:var(--sub,#888);display:flex;align-items:center;justify-content:center;font-size:14px;margin:0 auto;user-select:none;';
              avPh.title = '暂无头像';
              avPh.textContent = '👤';
              td.appendChild(avPh);
            }
          } else if (col.key === '__link') {
            var isExp = !!state.expandedMainKeys[row.__id];
            var btn = win.document.createElement('button');
            btn.className = 'link-btn';
            btn.textContent = isExp ? '收起' : '展开';
            btn.title = isExp ? '收起并隐藏该组下表明细' : '在下方明细列表置顶展开并编辑本组 ' + row.__memberCount + ' 个独立渠道';
            btn.style.whiteSpace = 'normal';
            btn.style.wordBreak = 'break-word';
            btn.style.lineHeight = '1.25';
            btn.style.padding = '4px 6px';
            btn.style.fontSize = '12px';
            btn.style.textAlign = 'center';
            btn.style.display = 'inline-flex';
            btn.style.alignItems = 'center';
            btn.style.justifyContent = 'center';
            btn.style.maxWidth = '100%';
            btn.style.background = isExp ? '#54656f' : '#00a884';
            btn.style.borderColor = isExp ? '#54656f' : '#00a884';
            td.style.textAlign = 'center';
            td.style.verticalAlign = 'middle';
            btn.addEventListener('click', function () {
              if (state.expandedMainKeys[row.__id]) {
                delete state.expandedMainKeys[row.__id];
              } else {
                state.expandedMainKeys[row.__id] = true;
              }
              renderAll();
              if (state.expandedMainKeys[row.__id]) {
                var firstTarget = win.document.querySelector('tr[data-main-key="' + row.__id + '"]');
                if (firstTarget) {
                  firstTarget.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
              }
            });
            td.appendChild(btn);
          } else if (col.key === '__id') {
            td.className = 'id-cell';
            td.textContent = '★ ' + row.__id.replace('MAIN::', '主记录:');
            td.title = row.__id;
          } else if (col.key === 'name') {
            td.classList.add('col-sticky-name');
            td.textContent = disp.displayName;
            td.title = disp.displayName;
          } else if (col.key === 'tag') {
            var t1List = getTags1();
            var matchedTag = null;
            for (var i = 0; i < t1List.length; i++) {
              if (t1List[i].key === row.tag) { matchedTag = t1List[i]; break; }
            }
            var tagBg = matchedTag ? (matchedTag.color || '#cfd8dc') : '#cfd8dc';
            var tagTxt = matchedTag ? matchedTag.label : (row.tag || '无标签');
            td.innerHTML = '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:' + tagBg + ';white-space:nowrap;line-height:1.3;">' + esc(tagTxt) + '</span>';
          } else if (col.key === 'tag2') {
            // 主记录自动汇集的标签2并集徽章展示
            var curTags2 = Array.isArray(row.tag2) ? row.tag2 : (row.tag2 ? [row.tag2] : []);
            var t2List = getTags2();
            var badgeWrap = win.document.createElement('div');
            badgeWrap.style.cssText = 'display:flex;gap:3px;flex-wrap:wrap;align-items:center;';
            badgeWrap.title = '主记录自动汇总所有关联渠道的标签2画像';
            if (!curTags2.length) {
              badgeWrap.innerHTML = '<span style="font-size:11px;color:var(--sub);">-</span>';
            } else {
              curTags2.forEach(function (tKey) {
                var def = t2List.filter(function(x){ return x.key === tKey; })[0];
                var bg = def ? def.color : '#78909c';
                var lbl = def ? def.label : tKey;
                var badge = win.document.createElement('span');
                badge.style.cssText = 'display:inline-block;padding:1px 5px;border-radius:10px;font-size:10px;color:#fff;background:' + bg + ';white-space:nowrap;line-height:1.2;';
                badge.textContent = lbl;
                badgeWrap.appendChild(badge);
              });
            }
            td.appendChild(badgeWrap);
          } else if (col.key === '__stages') {
            var stArr = Array.isArray(row.stages) ? row.stages : [];
            td.textContent = stArr.map(function (k) { return getStageLabel(k); }).join(' / ');
          } else if (col.key === 'updatedAt') {
            td.textContent = fmtTime(row.updatedAt);
          } else if (col.key === '__actions') {
            var copyBtn = win.document.createElement('button');
            copyBtn.className = 'icon-btn';
            copyBtn.textContent = '📋';
            copyBtn.title = '复制主记录资料';
            copyBtn.addEventListener('click', function () { copyContactText(row); });

            var delBtn = win.document.createElement('button');
            delBtn.className = 'icon-btn';
            delBtn.textContent = '🗑️';
            delBtn.title = '解散分组';
            delBtn.addEventListener('click', function () {
              if (win.confirm('这是跨渠道综合分组（' + row.__memberCount + ' 个渠道），确定解散吗？解散后各渠道恢复独立记录。')) {
                row.__members.slice().forEach(function (m) { unlinkChannel(m.__id); });
                var d = loadData();
                delete d[row.__id];
                saveData(d);
                renderAll();
              }
            });
            td.appendChild(copyBtn);
            td.appendChild(delBtn);
          } else if (col.key === 'manualPhone') {
            td.className = 'input-td';
            var inp = win.document.createElement('input');
            inp.type = 'text';
            inp.className = 'cell-input cell-readonly';
            inp.readOnly = true;
            inp.value = row.manualPhone || '';
            inp.title = '主记录电话为聚合信息，禁止直接修改。请点击[📋 查看明细]编辑各渠道独立信息。';
            td.appendChild(inp);
          } else if (FIELDS.some(function (f) { return f.key === col.key; })) {
            td.className = 'input-td';
            var txt = win.document.createElement('textarea');
            txt.className = 'cell-input cell-readonly';
            txt.readOnly = true;
            txt.rows = 1;
            txt.value = row[col.key] || '';
            txt.title = '主记录说明为聚合信息，禁止直接修改。请点击[📋 查看明细]编辑各渠道独立信息。';
            td.appendChild(txt);
            win.requestAnimationFrame(function () { autoResizeCell(txt); });
          }
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
    }


    function renderBanner() {
      var s = getSettings();
      var banner = win.document.getElementById('banner');
      if (!banner) return;
      var last = s.lastBackupAt || 0;
      var allRows = getAllRows();
      var totalCount = allRows.length;
      if (totalCount === 0) {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
      }
      var shouldWarn = false;
      var tipMsg = '';
      if (!last) {
        shouldWarn = true;
        tipMsg = '⚠️ 您尚未导出过备份数据，当前本地共有 ' + totalCount + ' 条联系人记录，建议立即导出备份以防数据丢失！';
      } else {
        var days = Math.floor((Date.now() - last) / 86400000);
        if (days >= 7) {
          shouldWarn = true;
          tipMsg = '⚠️ 您已有 ' + days + ' 天未导出备份数据，当前本地共有 ' + totalCount + ' 条联系人记录，建议定期导出 CSV 保存数据。';
        }
      }
      if (shouldWarn) {
        banner.style.display = 'flex';
        banner.innerHTML = '<span>' + tipMsg + '</span>' +
          '<button class="btn" id="bannerExportBtn" style="margin-left:12px;padding:4px 12px;font-size:12px;">立即导出 CSV</button>';
        var bBtn = win.document.getElementById('bannerExportBtn');
        if (bBtn) bBtn.addEventListener('click', doExport);
      } else {
        banner.style.display = 'none';
        banner.innerHTML = '';
      }
    }

    function doExport() {
      var rows = getAllRows();
      var headers = ['id', 'platform', 'name', 'manualPhone', 'tag', 'stages', 'avatar'].concat(FIELDS.map(function (f) { return f.key; })).concat(['updatedAt']);
      var lines = [headers.join(',')];
      rows.forEach(function (r) {
        var vals = [r.__id, r.__platform, r.name, r.manualPhone, r.tag, (Array.isArray(r.stages) ? r.stages.join(';') : ''), r.avatar || '']
          .concat(FIELDS.map(function (f) { return r[f.key] || ''; }))
          .concat([r.updatedAt || '']);
        lines.push(vals.map(function (v) {
          v = String(v == null ? '' : v).replace(/"/g, '""');
          return '"' + v + '"';
        }).join(','));
      });
      var csv = '\ufeff' + lines.join('\n');
      var blob = new win.Blob([csv], { type: 'text/csv;charset=utf-8;' });
      var url = win.URL.createObjectURL(blob);
      var a = win.document.createElement('a');
      a.href = url;
      a.download = 'contacts_backup_' + (new Date().toISOString().slice(0, 10)) + '.csv';
      win.document.body.appendChild(a);
      a.click();
      a.remove();
      setSettings({ lastBackupAt: Date.now() });
      renderBanner();
    }


    function doExportSelected() {
      var data = loadData();
      var selectedIds = v74GetSelectedIds();
      if (!selectedIds.length) { win.alert('请先勾选要导出的记录。'); return; }
      var exportMap = {};
      selectedIds.forEach(function (id) {
        exportMap[id] = true;
        if (isMainKey(id) && data[id]) {
          (data[id].memberIds || []).forEach(function (mid) { exportMap[mid] = true; });
        } else if (data[id] && data[id].mainKey && data[data[id].mainKey]) {
          exportMap[data[id].mainKey] = true;
        }
      });
      var headers = ['recordType','mainKey','parentMainKey','platform','id','name','manualPhone','avatar','avatarData','tag','tag2','stages'].concat(FIELDS.map(function (f) { return f.key; })).concat(['updatedAt']);
      var lines = [headers.join(',')];
      Object.keys(exportMap).forEach(function (id) {
        var e = data[id]; if (!e) return;
        var isMain = isMainKey(id);
        var vals = [isMain ? 'MAIN' : 'DETAIL', isMain ? id : '', isMain ? '' : (e.mainKey || ''), isMain ? 'MAIN' : inferPlatform(e, id), id, e.name || '', e.manualPhone || '', e.avatar || '', e.avatarData || '', e.tag || '', Array.isArray(e.tag2) ? e.tag2.join(';') : (e.tag2 || ''), Array.isArray(e.stages) ? e.stages.join(';') : (e.stages || '')]
          .concat(FIELDS.map(function (f) { return e[f.key] || ''; })).concat([e.updatedAt || '']);
        lines.push(vals.map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(','));
      });
      var csv = '\ufeff' + lines.join('\n');
      var blob = new win.Blob([csv], { type: 'text/csv;charset=utf-8;' });
      var url = win.URL.createObjectURL(blob);
      var a = win.document.createElement('a');
      a.href = url;
      a.download = 'contacts_selected_MAIN_DETAIL_' + (new Date().toISOString().slice(0, 10)) + '.csv';
      win.document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ try{ win.URL.revokeObjectURL(url); }catch(e){} }, 1000);
    }

    function parseCsv(text) {
      var rows = [];
      var cur = [];
      var field = '';
      var inQ = false;
      for (var i = 0; i < text.length; i++) {
        var c = text[i];
        if (inQ) {
          if (c === '"') {
            if (text[i + 1] === '"') { field += '"'; i++; } else { inQ = false; }
          } else field += c;
        } else {
          if (c === '"') inQ = true;
          else if (c === ',') { cur.push(field); field = ''; }
          else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            cur.push(field); field = '';
            rows.push(cur); cur = [];
          } else field += c;
        }
      }
      if (field.length || cur.length) { cur.push(field); rows.push(cur); }
      return rows.filter(function (r) { return r.length > 1 || (r.length === 1 && r[0] !== ''); });
    }

    function doImport(text) {
      var rows = parseCsv(text.replace(/^\ufeff/, ''));
      if (!rows.length) return;
      var headers = rows[0];
      var data = loadData();
      var count = 0;
      for (var i = 1; i < rows.length; i++) {
        var r = rows[i];
        var obj = {};
        headers.forEach(function (h, idx) { obj[h] = r[idx]; });
        var id = obj.id;
        if (!id) continue;
        var entry = data[id] || {};
        entry.name = obj.name || entry.name;
        entry.platform = obj.platform || entry.platform || inferPlatform(null, id);
        entry.manualPhone = obj.manualPhone || entry.manualPhone;
        entry.avatar = obj.avatar || entry.avatar || '';
        entry.avatarData = obj.avatarData || entry.avatarData || '';
        entry.tag = obj.tag || entry.tag || '';
        entry.stages = obj.stages ? obj.stages.split(';').filter(Boolean) : (entry.stages || []);
        FIELDS.forEach(function (f) { if (obj[f.key] !== undefined) entry[f.key] = obj[f.key]; });
        entry.updatedAt = Date.now();
        data[id] = entry;
        count++;
      }
      saveData(data);
      runLinkScan();
      renderAll();
      win.alert('\u5bfc\u5165\u5b8c\u6210\uff0c\u5171\u5904\u7406 ' + count + ' \u6761\u8bb0\u5f55\u3002');
    }

    function applyDarkMode() {
      win.document.body.classList.toggle('dark', state.dark);
      win.document.getElementById('darkBtn').textContent = state.dark ? (String.fromCodePoint(0x2600) + String.fromCodePoint(0xFE0F) + ' \u6d45\u8272\u6a21\u5f0f') : (String.fromCodePoint(0x1F319) + ' \u6df1\u8272\u6a21\u5f0f');
    }


    function v66GetCfg(){
      return {
        minViewportWidth:getLayoutMinViewportWidth(),
        fieldUnifiedWidthPx:getFieldUnifiedWidthPx(),
        fieldUnifiedWidthAuto:isFieldUnifiedWidthAuto()
      };
    }
    function v66InitCfg(){
      var cfg=v66GetCfg(), a=win.document.getElementById('cfgMinChars'), fw=win.document.getElementById('cfgFieldUnifiedWidth'), fa=win.document.getElementById('cfgFieldUnifiedAuto'), vw=win.document.getElementById('cfgViewportWidth'), wrap=win.document.getElementById('cfgWidthWrap'), autoWrap=win.document.getElementById('cfgAutoWrap'), hint=win.document.getElementById('cfgWidthHint');
      if(vw) vw.textContent='当前 '+((win.innerWidth||0))+'px';
      if(!a) return;
      function syncAutoUi(){
        var auto = !!(fa && fa.checked);
        if(fw){ fw.disabled=auto; fw.style.opacity=auto?'0.45':'1'; fw.style.background=auto?'#eef2f7':''; }
        if(wrap){ wrap.style.opacity=auto?'0.62':'1'; }
        if(autoWrap){ autoWrap.style.background=auto?'rgba(0,168,132,.16)':'rgba(148,163,184,.16)'; autoWrap.style.color=auto?'#008f72':'var(--sub)'; }
        if(hint){ hint.textContent=auto?'当前：自适应':'当前：手动统一9列宽度 · Enter应用'; hint.style.color=auto?'var(--sub)':'#00a884'; }
      }
      function applyWidthCfg(){
        setSettings({
          layoutMinViewportWidth:parseInt(a.value,10)||1280,
          fieldUnifiedWidthAuto:!!(fa && fa.checked),
          fieldUnifiedWidthPx:parseInt(fw && fw.value,10)||220
        });
        renderAll();
      }
      if(!a.__v66Bound){
        a.__v66Bound=true;
        if(fa) fa.addEventListener('change',function(e){ e.stopPropagation(); syncAutoUi(); applyWidthCfg(); });
        [a, fw].forEach(function(inp){
          if(!inp) return;
          inp.addEventListener('keydown',function(e){
            if(e.key==='Enter'){
              e.preventDefault();
              e.stopPropagation();
              applyWidthCfg();
            }
          });
        });
      }
      a.value=cfg.minViewportWidth;
      if(fw) fw.value=cfg.fieldUnifiedWidthPx||220;
      if(fa) fa.checked=!!cfg.fieldUnifiedWidthAuto;
      syncAutoUi();
    }
    function v66SyncTableWidths(){
      var tables=[win.document.getElementById('mainTable'), win.document.getElementById('mainGroupTable')];
      tables.forEach(function(t){
        if(!t) return;
        var total=0;
        var cols=t.querySelectorAll('colgroup col');
        cols.forEach(function(c){ total += parseInt(c.style.width,10) || 0; });
        if(total>0){ t.style.width=total+'px'; t.style.minWidth=total+'px'; }
      });
    }
    function v66BindBottomScrollbar(){
      var bar=win.document.getElementById('waViewportBottomBar'),
          inner=win.document.getElementById('waViewportBottomBarInner'),
          detail=win.document.querySelector('.table-container'),
          main=win.document.getElementById('mainGroupContainer');
      if(!bar||!inner||!detail) return;

      // v69：只保留底部固定横滚，主记录区/明细列表内部横滚条通过 CSS 隐藏，但仍保留 scrollLeft 能力
      var rightSafe=32; // v71：右侧安全缓冲，避免最右操作栏被纵向滚动条/裁切层遮挡
      var full=Math.max(detail.scrollWidth||0, main?main.scrollWidth||0:0) + rightSafe;
      var cw=Math.max(detail.clientWidth||0, main?main.clientWidth||0:0, win.innerWidth||0);
      if(full>cw+8){
        bar.style.display='block';
        inner.style.width=full+'px';
      } else {
        bar.style.display='none';
      }

      function applyLeft(left,src){
        if(src!==bar && bar) bar.scrollLeft=left;
        if(src!==detail && detail) detail.scrollLeft=left;
        if(main && src!==main) main.scrollLeft=left;
      }

      if(bar.__v69Bound){
        applyLeft(bar.scrollLeft || detail.scrollLeft || (main ? main.scrollLeft : 0), null);
        return;
      }
      bar.__v69Bound=true;

      var syncing=false;
      function sync(left,src){
        if(syncing) return;
        syncing=true;
        applyLeft(left,src);
        syncing=false;
      }

      bar.addEventListener('scroll',function(){ sync(bar.scrollLeft,bar); });
      detail.addEventListener('scroll',function(){ sync(detail.scrollLeft,detail); });
      if(main) main.addEventListener('scroll',function(){ sync(main.scrollLeft,main); });

      // 触控板/横向滚轮场景：内部滚动条不可见，但横滑仍同步到底部横滚
      detail.addEventListener('wheel',function(e){
        if(Math.abs(e.deltaX)>Math.abs(e.deltaY)){
          setTimeout(function(){ sync(detail.scrollLeft,detail); },0);
        }
      },{passive:true});
      if(main){
        main.addEventListener('wheel',function(e){
          if(Math.abs(e.deltaX)>Math.abs(e.deltaY)){
            setTimeout(function(){ sync(main.scrollLeft,main); },0);
          }
        },{passive:true});
      }

      win.addEventListener('resize',function(){
        setTimeout(function(){
          v66SyncTableWidths();
          v67UpdateStickyOffsets();
          v66BindBottomScrollbar();
        },80);
      });
    }

    function v67UpdateStickyOffsets(){
      try{
        var saved=getColWidths ? getColWidths() : {};
        var avatarCol=COLUMNS.find(function(c){return c.key==='__avatar';});
        var avatarWidth=parseInt((saved&&saved.__avatar) || (avatarCol&&avatarCol.width) || 56,10) || 56;
        win.document.documentElement.style.setProperty('--v67-avatar-width', avatarWidth+'px');
        ['mainTable','mainGroupTable'].forEach(function(tid){
          var table=win.document.getElementById(tid); if(!table) return;
          var avs=table.querySelectorAll('.col-sticky-avatar'), nms=table.querySelectorAll('.col-sticky-name');
          avs.forEach(function(el){ el.style.left='0px'; });
          nms.forEach(function(el){ el.style.left=avatarWidth+'px'; });
        });
      }catch(e){}
    }

    function v66AfterRender(){ v66InitCfg(); v66SyncTableWidths(); v67UpdateStickyOffsets(); setTimeout(function(){ v67UpdateStickyOffsets(); v66BindBottomScrollbar(); },50); }

    function ensureLocalSyncBarMount() {
      var doc = win.document;
      var wrap = doc.getElementById('wa-local-sync-bar-wrap');
      if (wrap) return wrap;
      wrap = doc.createElement('div');
      wrap.id = 'wa-local-sync-bar-wrap';
      var banner = doc.getElementById('banner');
      if (banner && banner.parentNode) banner.parentNode.insertBefore(wrap, banner.nextSibling);
      else if (doc.body) doc.body.insertBefore(wrap, doc.body.firstChild);
      return wrap;
    }

    function renderAll() {
      var syncWrap = ensureLocalSyncBarMount();
      if (syncWrap) {
        if (!syncWrap.__v895SyncBarInited || !syncWrap.querySelector('#wa-local-sync-bar')) {
          syncWrap.innerHTML = buildLocalSyncBarHtml();
          syncWrap.__v895SyncBarInited = true;
          bindLocalSyncBarEvents(renderAll, win.document);
        } else {
          try {
            v894EnsureTitleSourceBox(win.document);
            v892RenderSyncLights();
          } catch(e) {}
        }
      }

      renderBanner();
      renderPlatformBar();
      renderTagBar();
      renderStats();
      renderDashboard();
      renderTable();
      updateBatchBar();
      v66AfterRender();

      try { v892RenderSyncLights(); } catch(e) {}
    }

    win.__waRefresh = renderAll;
    if(!win.__v72ResizeBound){ win.__v72ResizeBound=true; var __v72rt=null; win.addEventListener('resize', function(){ clearTimeout(__v72rt); __v72rt=setTimeout(function(){ try{ renderAll(); v67UpdateStickyOffsets(); }catch(e){} },120); }); }

    win.document.getElementById('searchBox').addEventListener('input', function (e) {
      state.search = e.target.value;
      renderAll();
    });
    win.document.getElementById('tagFilter').addEventListener('change', function (e) {
      state.tagFilter = e.target.value;
      renderAll();
    });
    win.document.getElementById('sortSelect').addEventListener('change', function (e) {
      state.sort = e.target.value;
      renderTable();
    });
    win.document.getElementById('dashboardBtn').addEventListener('click', function () {
      state.dashboardOpen = !state.dashboardOpen;
      renderDashboard();
    });
    win.document.getElementById('wrapBtn').addEventListener('click', function () {
      state.wrapMode = !state.wrapMode;
      setSettings({ wrapMode: state.wrapMode });
      renderTable();
    });
    win.document.getElementById('resetWidthBtn').addEventListener('click', function () {
      if (win.confirm('\u786e\u5b9a\u8981\u91cd\u7f6e\u6240\u6709\u5217\u5bbd\u4e3a\u9ed8\u8ba4\u503c\u5417\uff1f')) {
        resetColWidths();
        renderTable();
      }
    });
    win.document.getElementById('darkBtn').addEventListener('click', function () {
      state.dark = !state.dark;
      setSettings({ darkMode: state.dark });
      applyDarkMode();
    });
    win.document.getElementById('exportBtn').addEventListener('click', doExport);
    win.document.getElementById('importBtn').addEventListener('click', function () {
      win.document.getElementById('importFile').click();
    });
    win.document.getElementById('importFile').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new win.FileReader();
      reader.onload = function () { doImport(reader.result); };
      reader.readAsText(file, 'UTF-8');
    });
        win.document.getElementById('tagMgrBtn').addEventListener('click', function () {
      showTagManagerModal(win);
    });
    win.document.getElementById('fieldNameBtn').addEventListener('click', function () {
      openFieldNameEditor(win);
    });
    win.document.getElementById('mainGroupToggleBar').addEventListener('click', function () {
      state.mainGroupCollapsed = !state.mainGroupCollapsed;
      renderMainGroupTable();
    });

    win.document.getElementById('rescanBtn').addEventListener('click', function () {
      var r = runLinkScan({ force: true });
      renderAll();
      win.alert('\u91cd\u626b\u5b8c\u6210\uff0c\u5f53\u524d\u5171 ' + r.groupCount + ' \u4e2a\u5173\u8054\u7ec4\u3002');
    });
    win.document.getElementById('batchApplyTagBtn').addEventListener('click', function () {
      var tagVal = win.document.getElementById('batchTagSelect').value;
      Object.keys(state.selected).forEach(function (id) {
        if (state.selected[id]) upsertTagSmart(id, {}, tagVal);
      });
      renderAll();
    });
    var batchExportSelectedBtn = win.document.getElementById('batchExportSelectedBtn');
    if (batchExportSelectedBtn) batchExportSelectedBtn.addEventListener('click', doExportSelected);
    win.document.getElementById('batchDeleteBtn').addEventListener('click', function () {
      var ids = Object.keys(state.selected).filter(function (k) { return state.selected[k]; });
      if (!ids.length) return;
      var localIds = ids.filter(function (id) { return String(id).indexOf('sync::') !== 0; });
      var remoteCount = ids.length - localIds.length;
      if (!localIds.length) { win.alert('选中的都是其他源只读数据，不能在当前源删除。'); return; }
      var msg = '确定删除选中的 ' + localIds.length + ' 条本源记录？';
      if (remoteCount > 0) msg += '\n\n已自动跳过 ' + remoteCount + ' 条其他源只读记录。';
      msg += '\n\n删除后会同步删除 Python 服务 sqlite 中当前源对应记录。';
      if (!win.confirm(msg)) return;
      localIds.forEach(function (id) { deleteRow(id); delete state.selected[id]; });
      ids.forEach(function (id) { delete state.selected[id]; });
      renderAll();
    });
    win.document.getElementById('batchClearBtn').addEventListener('click', function () {
      state.selected = {};
      renderAll();
    });

    var dropZone = win.document.getElementById('dropZone');
    win.document.body.addEventListener('dragover', function (e) { e.preventDefault(); dropZone.style.display = 'flex'; });
    win.document.body.addEventListener('dragleave', function () { dropZone.style.display = 'none'; });
    win.document.body.addEventListener('drop', function (e) {
      e.preventDefault();
      dropZone.style.display = 'none';
      var file = e.dataTransfer.files[0];
      if (!file) return;
      var reader = new win.FileReader();
      reader.onload = function () { doImport(reader.result); };
      reader.readAsText(file, 'UTF-8');
    });

    applyDarkMode();
    renderAll();

    // v89.3：管理面板打开后自动检测连接、刷新统计，并在实时上传开启时补偿上传一次
    setTimeout(function(){
      try { v892InitSyncStatus(renderAll); } catch(e) {}
    }, 300);
  }

  // ============ \u5173\u8054\u7ec4\u8be6\u60c5\u5f39\u7a97\uff08表格完整版：按渠道独立记录显示） ============
  function showLinkGroupPopup(hostWin, groupInfo, onChangeCallback) {
    var doc = hostWin.document;
    var old = doc.getElementById('__linkGroupPopupMask');
    if (old) old.remove();

    var mask = doc.createElement('div');
    mask.id = '__linkGroupPopupMask';
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999999;display:flex;align-items:center;justify-content:center;padding:18px;';

    var box = doc.createElement('div');
    box.style.cssText = 'background:var(--bg,#fff);color:var(--text,#111b21);border-radius:10px;padding:16px 18px;width:calc(100vw - 24px);max-width:calc(100vw - 24px);max-height:88vh;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.3);display:flex;flex-direction:column;';

    function esc(s) {
      s = String(s == null ? '' : s);
      return s.replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
    }
    function fmtTime(ts) {
      if (!ts) return '';
      var d = new Date(ts);
      var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
      return (d.getMonth() + 1) + '/' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    }
    function fieldText(rec, key) {
      var v = rec && rec[key];
      return v == null ? '' : String(v);
    }
    function stageText(rec) {
      var arr = Array.isArray(rec && rec.stages) ? rec.stages : [];
      if (!arr.length) return '';
      return arr.map(function (k) { return getStageLabel(k); }).join(' / ');
    }
    function tagText(rec) {
      var key = (rec && rec.tag) || '';
      for (var i = 0; i < TAGS.length; i++) if (TAGS[i].key === key) return TAGS[i].label;
      return key || '无标签';
    }

    function renderContent() {
      var data = loadData();
      var main = data[groupInfo.mainKey];
      if (!main) { closePopup(); return; }
      var memberIds = Array.isArray(main.memberIds) ? main.memberIds : [];
      var members = memberIds.map(function (id) {
        var e = data[id];
        if (!e) return null;
        // 关键：这里保留并显示各渠道自己的独立记录，不用 resolveDisplayContext，不读 MAIN 主记录字段
        return Object.assign({ __id: id, __platform: inferPlatform(e, id) }, e);
      }).filter(Boolean);

      var cols = [
        { key: '__actions', label: '操作', width: 210 },
        { key: '__platform', label: '渠道', width: 72 },
        { key: '__link', label: '关联', width: 82 },
        { key: '__id', label: '识别码', width: 180 },
        { key: '__avatar', label: '头像', width: 56 },
        { key: 'name', label: '姓名', width: 150 },
        { key: 'manualPhone', label: '电话', width: 135 },
        { key: 'tag', label: '标签', width: 105 },
        { key: '__stages', label: '跟进阶段', width: 120 }
      ].concat(FIELDS.map(function (f) {
        return { key: f.key, label: getFieldLabel(f.key), width: (f.key === 'remark' ? 220 : 150) };
      })).concat([
        { key: 'updatedAt', label: '更新时间', width: 105 },
      ]);

      var html = '';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:12px;flex:0 0 auto;">' +
        '<div><h3 style="margin:0;font-size:16px;">' + String.fromCodePoint(0x1F517) + ' 关联详情（手机号：' + esc(groupInfo.phone || '未识别') + '）</h3>' +
        '<div style="font-size:12px;color:var(--sub,#667781);margin-top:5px;">共 ' + members.length + ' 个渠道已关联；下方按管理面板表格形式显示；电话、1-7、闪光点、说明可直接编辑，并强制保存到对应渠道自己的独立记录。</div></div>' +
        '<button id="__lgClose" style="border:none;background:none;font-size:22px;cursor:pointer;color:inherit;line-height:1;">×</button></div>';

      html += '<div style="overflow:auto;border:1px solid var(--border,#d9dee3);border-radius:8px;background:var(--card,#fff);flex:1 1 auto;">';
      html += '<table style="border-collapse:separate;border-spacing:0;table-layout:auto;min-width:100%;width:max-content;">';
      html += '<colgroup>' + cols.map(function (c) { return '<col style="width:' + c.width + 'px;">'; }).join('') + '</colgroup>';
      html += '<thead><tr>' + cols.map(function (c) {
        return '<th style="position:sticky;top:0;z-index:2;background:var(--headbg,#eef1f4);font-size:12px;font-weight:700;text-align:left;padding:8px;border-bottom:2px solid var(--border,#d9dee3);border-right:1px solid var(--border,#d9dee3);white-space:nowrap;">' + esc(c.label) + '</th>';
      }).join('') + '</tr></thead><tbody>';

      members.forEach(function (m) {
        var pinfo = getPlatformInfo(m.__platform);
        var vm = m.viewMode || 'shared';
        html += '<tr>';
        cols.forEach(function (col) {
          var tdStyle = 'padding:6px 8px;border-bottom:1px solid var(--border,#d9dee3);border-right:1px solid var(--border,#d9dee3);font-size:12px;vertical-align:top;white-space:normal;word-break:break-word;line-height:1.45;';
          var cell = '';
          if (col.key === '__platform') {
            cell = '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;color:#fff;font-weight:600;background:' + pinfo.color + ';">' + esc(pinfo.short) + '</span>';
              } else if (col.key === '__avatar') {
            var mAvSrc = m.avatarData || m.__avatarData || m.__avatar || m.avatar || '';
            if (mAvSrc) {
              cell = '<img src="' + esc(mAvSrc) + '" referrerpolicy="no-referrer" style="width:34px;height:34px;border-radius:50%;object-fit:cover;border:1.5px solid var(--border,#d1d7db);display:block;margin:0 auto;cursor:pointer;" title="点击查看原图" onclick="window.open(\'' + esc(mAvSrc) + '\',\'_blank\')" />';
            } else {
              cell = '<div style="width:34px;height:34px;border-radius:50%;background:var(--border,#e0e0e0);color:var(--sub,#888);display:flex;align-items:center;justify-content:center;font-size:14px;margin:0 auto;user-select:none;" title="暂无头像">👤</div>';
            }
          } else if (col.key === '__link') {
            cell = '<span style="display:inline-block;padding:2px 7px;border-radius:10px;font-size:11px;color:#fff;background:#00a884;">已关联</span><br><span style="font-size:11px;color:var(--sub,#667781);">' + (vm === 'shared' ? '共享视图' : '独立视图') + '</span>';
          } else if (col.key === '__id') {
            cell = '<span title="' + esc(m.__id) + '">' + esc(m.__id) + '</span>';
          } else if (col.key === 'tag') {
            cell = esc(tagText(m));
          } else if (col.key === '__stages') {
            cell = esc(stageText(m));
          } else if (col.key === 'updatedAt') {
            cell = esc(fmtTime(m.updatedAt));
          } else if (col.key === '__actions') {
            cell = '<button class="__lgToggleView btn" data-id="' + esc(m.__id) + '" style="font-size:11px;padding:4px 8px;margin:0 5px 5px 0;">' + String.fromCodePoint(0x1F500) + ' 切换为' + (vm === 'shared' ? '独立' : '共享') + '</button>' +
              '<button class="__lgUnlink btn" data-id="' + esc(m.__id) + '" style="font-size:11px;padding:4px 8px;margin:0 0 5px 0;background:#e53935;color:#fff;">' + String.fromCodePoint(0x274C) + ' 解除关联</button>';
          } else {
            cell = esc(fieldText(m, col.key));
          }
          html += '<td style="' + tdStyle + '">' + cell + '</td>';
        });
        html += '</tr>';
      });

      html += '</tbody></table></div>';
      box.innerHTML = html;

      doc.getElementById('__lgClose').addEventListener('click', closePopup);
      box.querySelectorAll('.__lgToggleView').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-id');
          var d = loadData();
          var cur = (d[id] && d[id].viewMode) || 'shared';
          setChannelViewMode(id, cur === 'shared' ? 'independent' : 'shared');
          renderContent();
          refreshPanelIfOpen();
        });
      });
      box.querySelectorAll('.__lgUnlink').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-id');
          if (!hostWin.confirm('确定解除该渠道与当前分组的关联吗？解除后该渠道将使用自己的独立记录，且不会被自动重新关联。')) return;
          unlinkChannel(id);
          if (onChangeCallback) onChangeCallback();
          var d2 = loadData();
          if (!d2[groupInfo.mainKey]) { closePopup(); return; }
          renderContent();
        });
      });
    }

    function closePopup() { mask.remove(); }
    mask.addEventListener('click', function (e) { if (e.target === mask) closePopup(); });
    mask.appendChild(box);
    doc.body.appendChild(mask);
    renderContent();
  }


  // ============ v54 方案B：轻量弹层多选标签2选择器 ============
  function showTag2SelectDropdown(hostWin, ev, recordId, currentSelected, onSave) {
    var doc = hostWin.document;
    var old = doc.getElementById('__tag2Popover');
    if (old) old.remove();

    var t2List = getTags2();
    var pop = doc.createElement('div');
    pop.id = '__tag2Popover';
    pop.style.cssText = 'position:fixed;z-index:999999;background:var(--card,#fff);border:1px solid var(--border,#d9dee3);border-radius:8px;padding:10px 12px;box-shadow:0 6px 20px rgba(0,0,0,0.18);display:flex;flex-direction:column;gap:8px;min-width:180px;max-width:240px;';

    var r = ev.target.getBoundingClientRect();
    var left = Math.min(r.left, hostWin.innerWidth - 250);
    var top = Math.min(r.bottom + 4, hostWin.innerHeight - 260);
    pop.style.left = Math.max(10, left) + 'px';
    pop.style.top = Math.max(10, top) + 'px';

    var head = doc.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:700;color:var(--text);border-bottom:1px solid var(--border);padding-bottom:5px;';
    head.innerHTML = '<span>选择画像 (多选)</span><span id="__popClose" style="cursor:pointer;font-size:14px;color:var(--sub);">&times;</span>';
    pop.appendChild(head);

    var listWrap = doc.createElement('div');
    listWrap.style.cssText = 'display:flex;flex-direction:column;gap:5px;max-height:180px;overflow-y:auto;';

    var localSel = (currentSelected || []).slice();
    t2List.forEach(function (t) {
      var item = doc.createElement('label');
      item.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;padding:2px 4px;border-radius:4px;';
      item.addEventListener('mouseenter', function(){ item.style.background = 'var(--fieldbg,#f0f2f5)'; });
      item.addEventListener('mouseleave', function(){ item.style.background = 'transparent'; });

      var cb = createCustomCheckboxDoc(doc, localSel.indexOf(t.key) >= 0, function (chk) {
        var idx = localSel.indexOf(t.key);
        if (chk) { if (idx < 0) localSel.push(t.key); }
        else { if (idx >= 0) localSel.splice(idx, 1); }
        // v76：画像多选改为勾选即保存，避免忘记点击“确定”
        if (onSave) onSave(localSel.slice());
      }, 13);

      var badge = doc.createElement('span');
      badge.style.cssText = 'padding:1px 6px;border-radius:8px;font-size:11px;color:#fff;background:' + t.color + ';';
      badge.textContent = t.label;

      item.appendChild(cb);
      item.appendChild(badge);
      listWrap.appendChild(item);
    });
    pop.appendChild(listWrap);

    // v76：取消底部“确定”按钮；画像勾选/取消勾选时已即时保存。

    doc.body.appendChild(pop);
    doc.getElementById('__popClose').addEventListener('click', function(){ pop.remove(); });

    var onDocClick = function (e) {
      if (!pop.contains(e.target)) {
        pop.remove();
        doc.removeEventListener('click', onDocClick, true);
      }
    };
    setTimeout(function(){ doc.addEventListener('click', onDocClick, true); }, 10);
  }

  // ============ v54 可视化标签管理弹窗 (标签1 / 标签2 增删改查及调色) ============
  function showTagManagerModal(hostWin) {
    var doc = hostWin.document;
    var old = doc.getElementById('__tagMgrMask');
    if (old) old.remove();

    var mask = doc.createElement('div');
    mask.id = '__tagMgrMask';
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999999;display:flex;align-items:center;justify-content:center;';

    var box = doc.createElement('div');
    box.style.cssText = 'background:var(--bg,#fff);color:var(--text,#111b21);border-radius:12px;padding:22px;width:520px;max-width:92vw;max-height:85vh;overflow-y:auto;box-shadow:0 12px 36px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:14px;';
    
    // 先把 mask 和 box 挂载入 DOM，保证所有选择器与样式计算正常工作
    mask.appendChild(box);
    doc.body.appendChild(mask);

    var activeTab = 't1';
    var t1Data = JSON.parse(JSON.stringify(getTags1()));
    var t2Data = JSON.parse(JSON.stringify(getTags2()));

    function closeModal() {
      mask.remove();
    }

    function renderModal() {
      box.innerHTML = '';
      
      // 1. 顶部标题栏与关闭按钮
      var head = doc.createElement('div');
      head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
      
      var title = doc.createElement('h3');
      title.style.cssText = 'margin:0;font-size:16px;font-weight:700;';
      title.textContent = '🏷️ 自定义标签与画像管理';
      
      var closeBtn = doc.createElement('button');
      closeBtn.style.cssText = 'border:none;background:none;font-size:22px;cursor:pointer;color:inherit;line-height:1;padding:2px 6px;';
      closeBtn.innerHTML = '&times;';
      closeBtn.onclick = closeModal;

      head.appendChild(title);
      head.appendChild(closeBtn);
      box.appendChild(head);

      // 2. Tab 切换区
      var tabRow = doc.createElement('div');
      tabRow.style.cssText = 'display:flex;gap:8px;border-bottom:1px solid var(--border,#e9edef);padding-bottom:10px;';
      
      var tab1 = doc.createElement('button');
      tab1.className = 'btn ' + (activeTab === 't1' ? '' : 'ghost');
      tab1.textContent = '核心标签 (单选状态)';
      tab1.style.cssText = 'padding:6px 14px;font-size:13px;border-radius:6px;cursor:pointer;';
      tab1.onclick = function(){ activeTab = 't1'; renderModal(); };

      var tab2 = doc.createElement('button');
      tab2.className = 'btn ' + (activeTab === 't2' ? '' : 'ghost');
      tab2.textContent = '画像标签 (多选画像)';
      tab2.style.cssText = 'padding:6px 14px;font-size:13px;border-radius:6px;cursor:pointer;';
      tab2.onclick = function(){ activeTab = 't2'; renderModal(); };

      tabRow.appendChild(tab1);
      tabRow.appendChild(tab2);
      box.appendChild(tabRow);

      // 3. 标签列表
      var list = (activeTab === 't1' ? t1Data : t2Data);
      var itemsWrap = doc.createElement('div');
      itemsWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;max-height:340px;overflow-y:auto;padding-right:4px;';

      if (list.length === 0) {
        var emptyTip = doc.createElement('div');
        emptyTip.style.cssText = 'color:#888;font-size:13px;text-align:center;padding:16px;';
        emptyTip.textContent = '暂无标签，点击下方按钮添加';
        itemsWrap.appendChild(emptyTip);
      } else {
        list.forEach(function (item, idx) {
          var row = doc.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:10px;background:var(--card,#f8fafc);border:1px solid var(--border,#e9edef);padding:6px 12px;border-radius:6px;';

          var colorInp = doc.createElement('input');
          colorInp.type = 'color';
          colorInp.value = item.color || '#00a884';
          colorInp.style.cssText = 'width:32px;height:28px;border:none;border-radius:4px;cursor:pointer;padding:0;background:transparent;flex:0 0 auto;';

          var hexInp = doc.createElement('input');
          hexInp.type = 'text';
          hexInp.value = item.color || '#00a884';
          hexInp.placeholder = '#hex';
          hexInp.title = '十六进制颜色代码 (例如 #e53935)';
          hexInp.style.cssText = 'width:70px;padding:4px 6px;font-size:12px;font-family:monospace;border:1px solid var(--border,#d1d7db);border-radius:4px;background:var(--bg,#fff);color:inherit;text-transform:uppercase;flex:0 0 auto;';

          colorInp.oninput = function(){
            item.color = colorInp.value;
            hexInp.value = colorInp.value.toUpperCase();
          };

          hexInp.oninput = function(){
            var val = hexInp.value.trim();
            if (/^#([0-9a-fA-F]{3}){1,2}$/.test(val)) {
              if (val.length === 4) {
                val = '#' + val[1] + val[1] + val[2] + val[2] + val[3] + val[3];
              }
              item.color = val;
              colorInp.value = val;
              hexInp.style.borderColor = 'var(--border,#d1d7db)';
            } else {
              hexInp.style.borderColor = '#e53935';
            }
          };

          var nameInp = doc.createElement('input');
          nameInp.type = 'text';
          nameInp.value = item.label || '';
          nameInp.placeholder = '标签名称';
          nameInp.style.cssText = 'flex:1;padding:5px 8px;font-size:13px;border:1px solid var(--border,#d1d7db);border-radius:4px;background:var(--bg,#fff);color:inherit;';
          nameInp.oninput = function(){ item.label = nameInp.value; };

          var delBtn = doc.createElement('button');
          delBtn.style.cssText = 'border:none;background:none;color:#e53935;cursor:pointer;font-size:16px;padding:2px 6px;';
          delBtn.textContent = '🗑️';
          delBtn.title = '删除此标签';
          delBtn.onclick = function(){ list.splice(idx, 1); renderModal(); };

          row.appendChild(colorInp);
          row.appendChild(nameInp);
          row.appendChild(delBtn);
          itemsWrap.appendChild(row);
        });
      }
      box.appendChild(itemsWrap);

      // 4. 新增按钮
      var addBtn = doc.createElement('button');
      addBtn.className = 'btn ghost';
      addBtn.style.cssText = 'padding:8px;font-size:13px;border-style:dashed;width:100%;cursor:pointer;margin-top:4px;';
      addBtn.textContent = '+ 新增' + (activeTab === 't1' ? '核心标签' : '画像');
      addBtn.onclick = function(){
        list.push({ key: 'tag_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5), label: '新标签', color: '#00a884' });
        renderModal();
      };
      box.appendChild(addBtn);

      // 5. 底部操作栏
      var foot = doc.createElement('div');
      foot.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:10px;';
      
      var cancelBtn = doc.createElement('button');
      cancelBtn.className = 'btn ghost';
      cancelBtn.style.cssText = 'padding:6px 14px;font-size:13px;cursor:pointer;';
      cancelBtn.textContent = '取消';
      cancelBtn.onclick = closeModal;

      var saveAllBtn = doc.createElement('button');
      saveAllBtn.className = 'btn';
      saveAllBtn.style.cssText = 'padding:6px 18px;font-size:13px;background:#00a884;color:#fff;border-radius:6px;cursor:pointer;border:none;';
      saveAllBtn.textContent = '保存配置';
      saveAllBtn.onclick = function () {
        setTags1(t1Data);
        setTags2(t2Data);
        TAGS = getTags1();
        closeModal();
        if (hostWin && typeof hostWin.__waRefresh === 'function') {
          hostWin.__waRefresh();
        } else if (hostWin && typeof hostWin.renderAll === 'function') {
          hostWin.renderAll();
        } else if (typeof renderAll === 'function') {
          renderAll();
    setTimeout(async function(){ try { await localSyncHealthCheck(); await localSyncFetchSourcesAndStats(); if (isLocalSyncAggregateEnabled()) startLocalSyncAggregatePolling(renderAll); renderAll(); } catch(e){} }, 300);
        }
      };
      
      foot.appendChild(cancelBtn);
      foot.appendChild(saveAllBtn);
      box.appendChild(foot);
    }

    mask.onclick = function(e){ if (e.target === mask) closeModal(); };
    renderModal();
  }

  // ============ 字段名称编辑弹窗 ============
  function openFieldNameEditor(hostWin) {
    var doc = hostWin.document;
    var old = doc.getElementById('__fieldNameEditorMask');
    if (old) old.remove();

    var mask = doc.createElement('div');
    mask.id = '__fieldNameEditorMask';
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999999;display:flex;align-items:center;justify-content:center;';

    var box = doc.createElement('div');
    box.style.cssText = 'background:var(--bg,#fff);color:var(--text,#111b21);border-radius:10px;padding:18px 20px;min-width:340px;box-shadow:0 8px 30px rgba(0,0,0,.3);';

    var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
      '<h3 style="margin:0;font-size:16px;">\u81ea\u5b9a\u4e49\u5b57\u6bb5\u540d\u79f0</h3>' +
      '<button id="__fneClose" style="border:none;background:none;font-size:20px;cursor:pointer;color:inherit;">\u00d7</button></div>';

    FIELDS.forEach(function (f) {
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
        '<span style="width:40px;font-size:12px;color:var(--sub,#667781);">' + f.key + '</span>' +
        '<input type="text" class="__fneInput" data-key="' + f.key + '" value="' + (getFieldLabel(f.key) || '').replace(/"/g, '&quot;') + '" ' +
        'style="flex:1;padding:6px;border:1px solid var(--border,#e9edef);border-radius:6px;background:var(--bg,#fff);color:inherit;font-size:13px;"></div>';
    });

    html += '<div style="margin-top:14px;text-align:right;">' +
      '<button id="__fneSave" class="btn" style="padding:6px 16px;">\u4fdd\u5b58</button></div>';

    box.innerHTML = html;
    mask.appendChild(box);
    doc.body.appendChild(mask);

    doc.getElementById('__fneClose').addEventListener('click', function () { mask.remove(); });
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    doc.getElementById('__fneSave').addEventListener('click', function () {
      var map = {};
      box.querySelectorAll('.__fneInput').forEach(function (inp) {
        map[inp.getAttribute('data-key')] = inp.value.trim();
      });
      setFieldLabels(map);
      mask.remove();
      refreshPanelIfOpen();
    });
  }

  // ========================================================
  // \u542f\u52a8\u903b\u8f91\uff1a\u8def\u7531\u76d1\u542c + \u60ac\u6d6e\u6761\u6302\u8f7d + \u83dc\u5355\u6ce8\u518c
  // ========================================================

  var __lastUrl = location.href;
  var __lastChatSignature = null;
  var __pollTimer = null;

  // \u4fee\u590d\uff1a\u76f4\u63a5\u57fa\u4e8e getContactInfoUnified() \u8bc6\u522b\u5230\u7684\u771f\u5b9e\u8054\u7cfb\u4ebaID\u4f5c\u4e3a\u7b7e\u540d
  // \u800c\u4e0d\u662f\u4f9d\u8d56\u4e0d\u53ef\u9760\u7684\u9875\u9762header\u6587\u672c\uff08\u65e7\u7248WA\u7b7e\u540d\u6c38\u8fdc\u4e0d\u53d8\u7684bug\u6839\u6e90\uff09
  function getChatSignature() {
    try {
      var info = getContactInfoUnified();
      if (info && info.id) {
        // v43：签名加入 name，使同一聊天内联系人名称变化时也能触发 renderNoteBar()
        return location.hostname + '::' + info.id + '::' + (info.name || '');
      }
      return location.hostname + '::' + location.href;
    } catch (e) {
      return location.href;
    }
  }

  function tick() {
    try {
      var sig = getChatSignature();
      var urlChanged = (location.href !== __lastUrl);
      if (urlChanged || sig !== __lastChatSignature) {
        __lastUrl = location.href;
        __lastChatSignature = sig;
        renderNoteBar();
      } else {
        ensureNoteBarMounted();
      }
    } catch (e) { }
  }

  function ensureNoteBarMounted() {
    try {
      if (location.hostname.indexOf('instagram.com') >= 0 && location.pathname.indexOf('/direct/') !== 0) {
        var oldBar = document.getElementById(NOTE_BAR_ID);
        if (oldBar) oldBar.remove();
        currentChatId = null;
        currentChatName = null;
        currentChatPlatform = null;
        return;
      }

      // v43：即使悬浮条已经存在，也定期同步当前聊天最新姓名
      var info = getContactInfoUnified();
      if (info && info.id && info.name) {
        syncCurrentContactName(info);
      }

      var bar = document.getElementById(NOTE_BAR_ID);
      if (!bar || !bar.isConnected) {
        renderNoteBar();
      }
    } catch (e) { }
  }

  function startPolling() {
    if (__pollTimer) return;
    __pollTimer = setInterval(tick, 900);
  }

  function stopPolling() {
    if (__pollTimer) {
      clearInterval(__pollTimer);
      __pollTimer = null;
    }
  }

  function installHistoryHooks() {
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function () {
      var ret = origPush.apply(this, arguments);
      setTimeout(tick, 50);
      return ret;
    };
    history.replaceState = function () {
      var ret = origReplace.apply(this, arguments);
      setTimeout(tick, 50);
      return ret;
    };
    window.addEventListener('popstate', function () { setTimeout(tick, 50); });
  }

  function installDomObserver() {
    try {
      var target = document.body;
      if (!target) return;
      var mo = new MutationObserver(function () {
        ensureNoteBarMounted();
      });
      mo.observe(target, { childList: true, subtree: true });
    } catch (e) { }
  }

  function registerMenuCommands() {
    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('\u6253\u5f00\u8054\u7cfb\u4eba\u5907\u6ce8\u7ba1\u7406\u9762\u677f', function () {
          openManagePanel();
        });
        GM_registerMenuCommand('\u624b\u52a8\u91cd\u626b\u540c\u4eba\u5173\u8054', function () {
          var r = runLinkScan({ force: true });
          alert('\u91cd\u626b\u5b8c\u6210\uff0c\u5f53\u524d\u5171 ' + r.groupCount + ' \u4e2a\u5173\u8054\u7ec4\u3002');
          refreshPanelIfOpen();
        });
        GM_registerMenuCommand('清理 IG 头像缓存并重新抓取', function () {
          try {
            var data = loadData();
            var count = 0;
            Object.keys(data).forEach(function (id) {
              if (id.indexOf('ig:') === 0 && data[id]) {
                delete data[id].avatar;
                delete data[id].avatarData;
                count++;
              }
            });
            saveData(data);
            refreshPanelIfOpen();
            alert('已清理 ' + count + ' 条 IG 头像缓存。请回到 Instagram 私信，逐个打开联系人聊天，让脚本重新抓取正确头像。');
          } catch (e) {
            alert('清理失败：' + e.message);
          }
        });
      }
    } catch (e) { }
  }

  function boot() {
    registerMenuCommands();
    installHistoryHooks();
    installDomObserver();
    startPolling();
    setTimeout(function () {
      try {
        __lastChatSignature = getChatSignature();
        renderNoteBar();
      } catch (e) { }
    }, 800);
    try { runLinkScan(); } catch (e) { }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    boot();
  } else {
    window.addEventListener('DOMContentLoaded', boot);
  }


  // v72.4 更新说明：
  // 1) 默认字段 remark 显示名由“备注”改为“说明”；
  // 2) 面板设置文案改为“1-说明列自适应：每列最小宽度”；
  // 3) 9个自适应字段（f1-f7、闪光点、说明）统一执行最小宽度；
  // 4) 单元格缓冲从24px降为12px，缓解设置4个汉字时过早出现横向滚动条；
  // 5) 自适应宽度算法保留真实可用空间，不足时先将9列压到最小宽度，再由整表自然横滚。


/*
================================================================================
v73.4 更新说明：电话栏自动换行版
================================================================================

1. 本次修复
- 修复管理面板明细列表中“电话”栏不能自动换行的问题。
- 原因是电话栏原来使用 input type=text，浏览器原生只支持单行显示。

2. 本次调整
- 明细列表电话栏 manualPhone 从 input 改为 textarea。
- 电话栏现在支持长号码/多段号码自动换行显示。
- 输入时自动调整高度，避免内容被遮挡。

3. 保留 v73.3 操作习惯
- Enter：确认保存。
- Shift + Enter：保留换行。
- 鼠标点其他地方：失焦保存。

4. 保留 v73.2 核心机制
- 输入过程中不保存、不聚合、不刷新整表。
- 失焦或 Enter 确认后保存。
- 保存后重新扫描关联并刷新 MAIN 主记录。

5. 测试建议
- 在明细列表电话栏输入较长号码，确认单元格可以自动换行。
- 按 Enter 确认保存，确认不会插入换行。
- 按 Shift + Enter，确认可以手动换行。
- 保存后确认 MAIN 主记录和关联关系正常刷新。

================================================================================
*/


  // v74 更新说明：
  // 1. 选择列不显示文字标题，仅保留 checkbox，节省横向空间。
  // 2. 明细列表支持表头全选、取消全选与半选状态。
  // 3. 主记录区 MAIN 增加 checkbox，并支持表头三态全选。
  // 4. MAIN 与 DETAIL 支持联动选择：勾选 MAIN 自动勾选该组全部明细。
  // 5. 勾选部分 DETAIL 时，MAIN 显示半选状态；勾选全部 DETAIL 时 MAIN 自动选中。
  // 6. 批量栏统计升级为“已选 X组 / Y条”。
  // 7. 新增“导出选中”按钮，导出选中的 MAIN 聚合记录与 DETAIL 明细记录。
  // 8. 选中 MAIN 时自动导出该组 MAIN + 全部成员明细；只选中 DETAIL 时自动补充父 MAIN。

})();
;

// v72.4: 默认横滚触发宽度 1280px；说明区9列表头🔒/🔓控制固定或自适应。

/*
================================================================================
v73.2 更新说明：明细编辑失焦聚合刷新版
================================================================================

1. 修复问题
- 修复 v73.1 中管理面板明细区文本字段输入时被自动刷新打断的问题。
- v73.1 为了保证 MAIN 主记录实时聚合，在 input 输入事件中会触发 upsertCell()。
- upsertCell() 会进一步触发 upsertFieldSmart()、runLinkScanAndRefreshPanelNow() 和管理面板刷新。
- 管理面板刷新会重绘表格，导致正在编辑的 input/textarea 被销毁重建，从而出现光标丢失、输入中断。

2. 本次调整
- 管理面板明细区的文本字段改为“输入中只标记 dirty，失焦 blur 后保存”。
- 适用字段包括 f1-f7、闪光点 f8、说明 remark。
- 电话字段 manualPhone 也改为失焦后保存，避免号码输入到一半时触发错误关联扫描。
- 失焦后仍然会执行原有 upsertCell() 链路，从而保存数据、重算 MAIN 主记录并刷新管理面板。

3. 保持即时刷新的操作
- 标签1选择。
- 标签2/画像选择。
- 跟进阶段勾选。
- 删除记录。
- 批量操作。
- 其他非连续输入类操作。

4. 用户体验变化
- 在明细列表连续输入时，表格不会再自动重绘，输入不会被打断。
- 编辑完成后点击页面其他位置，字段自动保存。
- 保存后会自动重新聚合 MAIN 主记录，上方主记录区会显示最新聚合值。

5. 测试建议
- 在明细列表第 7 列连续输入一段长文本，确认输入过程中光标不丢失、不被打断。
- 输入完成后点击空白处，确认上方 MAIN 主记录第 7 列自动聚合更新。
- 修改电话字段后点击空白处，确认关联主记录重新计算。
- 测试标签、画像、阶段操作，确认仍然是点击后立即刷新。

================================================================================
*/


/*
===============================================================================
v77 更新说明：本机多数据源同步版
===============================================================================
1. 新增本机多数据源同步：支持同一台电脑上的 Chrome Default、Profile 1、Profile 2、多开目录、便携版 Chrome 等不同油猴运行环境作为独立数据源。
2. 每个脚本实例自动生成唯一 sourceId，并支持在管理面板顶部手动设置 sourceName。
3. 新增本地同步服务支持，默认连接 http://127.0.0.1:8765。
4. 新增“同步全部”和“拉取汇总”按钮。
5. 同步时上传当前 GM 存储中的完整联系人 JSON，不只上传姓名、电话、标签等少数字段。
6. 本地服务保存完整 contact_json，兼容平台、关联、识别码、头像、姓名、电话、标签、画像、跟进阶段、1-7字段、闪光点、说明、更新时间、MAIN/DETAIL 等现有字段。
7. 汇总数据只用于管理面板显示，不写回当前 Profile 的 GM 存储，避免污染原始数据。
8. 不扫描 Chrome User Data 文件夹，不读取 Tampermonkey / Chrome IndexedDB / LevelDB 数据库。
9. 本地同步服务未启动时，脚本自动降级为 v76 原本地数据模式，原功能不受影响。
10. 保留 v76 原有管理面板、悬浮备注栏、标签、画像、跟进阶段、CSV导入导出、批量操作、列宽即时设置等能力。
===============================================================================
*/

/*
===============================================================================
v85 更新说明：同步栏稳定显示修复版
===============================================================================
1. 以 v77 能正常显示联系人信息的稳定代码为基线，不改动联系人读取、列表渲染、筛选和 MAIN/DETAIL 主体链路。
2. 修复管理面板顶部“本地同步栏”不显示的问题：在面板 HTML 初始化阶段固定加入 wa-local-sync-bar-wrap 容器。
3. 新增 ensureLocalSyncBarMount() 保底函数，renderAll() 每次刷新都会确认同步栏容器存在，避免因为挂载点缺失导致同步栏消失。
4. 移除平台筛选点击事件中错误创建同步栏容器的逻辑，避免只有点击平台筛选后才出现同步栏，也避免重复挂载或作用域异常。
5. 修复 getLocalSyncDisplayData()：本地 wa_remarks_data 永远作为基础数据源；同步服务拉取到的其他来源联系人只追加显示，不再替换本地数据。
6. 当前来源 sourceId 的同步记录如果本地已经存在同 contactId，则优先显示本地版本，避免同步包装数据覆盖当前 Profile 的原始联系人。
7. 本地同步服务未启动、拉取失败或 contacts 为空时，管理面板继续显示本地联系人数据，不再因同步状态影响联系人列表。
===============================================================================
*/


/*
===============================================================================
v86 更新说明：同步连接诊断修复版
===============================================================================
1. 修复管理面板弹窗内“同步全部 / 拉取汇总”点击无反应的问题：事件绑定改为使用弹窗 win.document，而不是主页面 document。
2. 新增“检测连接”按钮，可主动请求 /api/health 并刷新同步栏连接状态。
3. 新增“同步诊断”按钮，输出 URL、当前源、本地记录数、汇总源数、汇总记录数、最近一次请求结果等信息。
4. 管理面板打开后自动执行一次健康检查和源/统计拉取，避免服务已启动但状态仍显示未连接。
5. 保持 v85 的本地数据优先策略：同步汇总只用于管理面板追加显示，不覆盖当前 GM 本地数据。
===============================================================================
*/


/*
===============================================================================
v88 更新说明：实时上传与汇总分离版
===============================================================================
1. 将 v87 的“实时同步”拆分为两个独立开关：
   - 实时上传本源：只负责将当前浏览器/Profile 的 GM 本源数据上传到本地同步服务。
   - 实时汇总显示：只负责当前管理面板拉取并显示其他来源汇总数据。
2. 删除容易混淆的“立即同步”，改为：
   - 上传一次：只执行本源上传，不拉取汇总。
   - 刷新汇总：只执行汇总拉取，不上传本源。
3. saveData() 的自动同步只受“实时上传本源”控制，约 1.2 秒防抖上传。
4. 管理面板显示只受“实时汇总显示”控制：关闭时严格只显示本源，开启时显示本源 + 其他来源。
5. 同步数据仍只作为显示层缓存，不写回当前 GM_storage，避免跨源数据污染。
===============================================================================
*/


/*
===============================================================================
v89.2 本地同步状态呼吸灯增强版 - 修复说明
===============================================================================

1. 新增本地同步状态呼吸灯：
   - 连接状态
   - 上传状态
   - 汇总状态

2. 新增真实同步状态显示：
   - 本地联系人数量
   - 服务端当前源联系人数量
   - 服务端汇总源数量
   - 服务端汇总记录数量
   - 最近上传时间
   - 最近汇总时间
   - 最近错误信息

3. 优化实时上传本源：
   - 页面初始化后自动补偿上传一次
   - 数据变化后仍保留 1.2 秒防抖上传
   - 上传过程显示黄色状态
   - 上传成功显示绿色状态
   - 上传失败显示红色状态并显示错误信息

4. 优化实时汇总显示：
   - 页面初始化后自动刷新汇总
   - 汇总过程显示黄色状态
   - 汇总成功显示绿色状态和真实数量
   - 汇总失败显示红色状态并显示错误信息

5. 优化同步诊断：
   - 增加 v89.2 runtime 状态输出
   - 可查看连接、上传、汇总、本地数量、服务端本源数量、汇总源和汇总记录

6. 优化校准本源：
   - 将原“校准本源”按钮升级显示为“强制重建本源”
   - 执行逻辑改为：先清空服务端当前 sourceId，再全量上传当前浏览器 GM_storage
   - 只影响 Python sqlite 中当前 sourceId 数据，不会清空浏览器 GM_storage

7. 保留 v89.1 跨源只读保护：
   - 其他源汇总数据仍显示为只读
   - 不允许在当前源编辑或删除其他源数据

===============================================================================
*/


/*
===============================================================================
v89.3 本地同步栏精简版 - 修复说明
1. 当前源移动到同步栏最前面；源名称输入框失焦或 Enter 自动保存。
2. 取消保存源名按钮，保存成功提示“修改源名称成功”。
3. 删除重复的本地同步已连接文案，只保留呼吸灯连接状态。
4. 实时上传本源/实时汇总显示精简为实时上传/实时汇总，并和呼吸灯状态合并展示。
5. 基于 v89.2 源码做局部替换，避免继续臃肿追加。
===============================================================================
*/
/*
===============================================================================
v89.4 同步栏修复美化版
1. 当前源与 ID 移到管理面板标题后面。
2. 当前源输入框 8ch 起步，并随输入字符自动变宽。
3. 同步栏尽量一行显示，按钮圆角胶囊化美化。
4. 修复 v89.3 checkbox 被 v892RenderSyncLights 反复 innerHTML 重建，导致实时汇总掉勾、事件丢失的问题。
5. 修复自动实时上传不更新上传状态和上传时间的问题。
6. v892RenderSyncLights 只更新固定状态节点，不再销毁开关 DOM。
===============================================================================
*/
/*
===============================================================================
v89.5 同步栏稳定自适应版
1. 当前源输入框改为真实文字宽度测量，不再仅按字符数估算。
2. 同步栏改为自然换行布局，按钮不再 margin-left:auto 顶右遮挡状态文字。
3. renderAll 不再每次重建同步栏，只在首次或缺失时初始化，解决状态跳动/空白。
4. 汇总轮询更新 runtime 状态和时间，减少显示异常。
===============================================================================
*/
/*
===============================================================================
v89.6 标题按钮与本源重建修复版
1. 上传一次 / 刷新汇总 / 强制重建本源 / 检测连接 / 同步诊断 五个按钮移动到标题行 ID 后面。
2. 同步栏仅保留连接、实时上传、实时汇总、计数和时间状态。
3. 强制重建本源不再发送 contactIds: []。
4. 新增 localSyncForceRebuildCurrentSource()：
   - 读取当前 GM_storage 本地联系人 ID；
   - POST /api/contacts/source-reconcile，传入真实 contactIds；
   - 再执行 localSyncUploadAll() 全量上传；
   - 最后刷新统计和汇总。
===============================================================================
*/

/*
===============================================================================
v89.7 本源重建点击修复版
===============================================================================
1. 修复 bindLocalSyncBarEvents() 内直接使用 win.confirm / win.alert 的问题。
   原因：win 是 openManagePanel() 里的局部变量，bindLocalSyncBarEvents() 访问不到。
2. 新增 panelWin：
   var panelWin = (doc && doc.defaultView) || managePanelWindow || window;
3. 新增 confirmSafe() 和 show()，所有弹窗都优先使用当前管理面板窗口。
4. “强制重建本源”点击后会立即：
   - 按钮变为“重建中...”
   - 上传状态变为 busy
5. 重建成功后弹出“本源重建成功”。
6. 重建失败后弹出“本源重建失败”，并提示点击“同步诊断”查看 lastRequest。
7. 无论成功失败，按钮都会在 finally 中恢复为“强制重建本源”。
===============================================================================
*/
