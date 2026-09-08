// ==UserScript==
// @name         WhatsApp / Instagram / Messenger / Telegram 联系人备注助手
// @namespace    wa-remark-helper
// @version      42
// @description  多分项备注+标签分组+跟进阶段+字段自定义命名+唯一识别码+表格化管理面板+列宽拖拽+一键重置列宽+数据看板+渠道区分+备份提醒+一键复制+CSV导入导出+深色模式+可折叠面板+同人跨渠道关联(32位置保留+Messenger窄宽度修复版)
// @match        https://web.whatsapp.com/*
// @match        https://www.instagram.com/direct/*
// @match        https://www.messenger.com/*
// @match        https://web.telegram.org/k/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  var STORAGE_KEY = "wa_remarks_data";
  var SETTINGS_KEY = "wa_remarks_settings";
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
    { key: "remark", label: "备注" }
  ];

  var STAGES = [
    { key: "s1", label: "一切" },
    { key: "s2", label: "二切" },
    { key: "s3", label: "三切" }
  ];

  var TAGS = [
    { key: "hot", label: "HOT高意向", color: "#e53935" },
    { key: "watch", label: "观察中", color: "#fb8c00" },
    { key: "done", label: "已成交", color: "#43a047" },
    { key: "lost", label: "已流失", color: "#9e9e9e" },
    { key: "other", label: "其他", color: "#5c6bc0" },
    { key: "", label: "无标签", color: "#cfd8dc" }
  ];

  var PLATFORM_INFO = {
    wa: { key: "wa", label: "WhatsApp", short: "WA", color: "#25D366" },
    ig: { key: "ig", label: "Instagram", short: "IG", color: "#E1306C" },
    fb: { key: "fb", label: "Messenger", short: "FB", color: "#0084FF" },
    tg: { key: "tg", label: "Telegram", short: "TG", color: "#26A5E4" }
  };
  function getPlatformInfo(p) {
    return PLATFORM_INFO[p] || PLATFORM_INFO.wa;
  }
  function inferPlatform(entry, id) {
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
  function saveData(data) { GM_setValue(STORAGE_KEY, JSON.stringify(data)); }

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
    data[id] = Object.assign({}, data[id] || {}, baseInfo, { updatedAt: Date.now() });
    data[id][key] = value;
    saveData(data);
  }
  function toggleStage(id, stageKey, checked) {
    var data = loadData();
    if (!data[id]) data[id] = {};
    var arr = Array.isArray(data[id].stages) ? data[id].stages.slice() : [];
    var idx = arr.indexOf(stageKey);
    if (checked) { if (idx < 0) arr.push(stageKey); }
    else { if (idx >= 0) arr.splice(idx, 1); }
    data[id].stages = arr;
    data[id].updatedAt = Date.now();
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
      paint();
      if (typeof onChange === 'function') onChange(wrap.__checked);
    });
    wrap.setChecked = function (v) { wrap.__checked = !!v; paint(); };
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

  function getWaHeaderInfo() {
    var header = document.querySelector('#main header');
    if (!header) return null;
    var name = getContactName(header) || '';
    if (!name) return null;
    var id = extractJidViaFiber(header);
    if (!id) id = getFallbackIdFromAvatar(header);
    if (!id) id = 'name:' + name;
    return { id: id, name: name, platform: 'wa', headerEl: header };
  }

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
    var node = usernameLink;
    var hops = 0;
    var best = null;
    while (node && hops < 12) {
      var rect = node.getBoundingClientRect();
      if (rect.top < 140 && rect.width > 280 && rect.height >= 30 && rect.height <= 140) {
        best = node;
      }
      node = node.parentElement;
      hops++;
    }
    return best;
  }

  function getIgHeaderInfo() {
    // IG 只在私信页面显示备注：/direct/ 及其子路径；其他 Instagram 页面一律不显示
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
    return { id: 'ig:' + threadId, name: displayName, username: username, platform: 'ig', headerEl: headerEl };
  }

  function findFbMessagePane() {
    // v38：保留32版整体显示/定位方式，但放宽“必须可滚动”的限制。
    // 32版在聊天内容少时失败的核心原因是：el.scrollHeight > el.clientHeight + 40。
    // 消息少时聊天区不可滚动，于是 pane 找不到，备注栏不显示。
    var all = document.querySelectorAll('div');
    var best = null, bestScore = -1;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var cs = window.getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      if (rect.top < 80 || rect.top > window.innerHeight - 120) continue;
      if (el.clientHeight < 220 || el.clientWidth < 280) continue;
      if (rect.left < 60 && rect.width < window.innerWidth * 0.35) continue; // 排除左侧会话列表
      if (rect.left > window.innerWidth * 0.88) continue; // 排除右侧资料栏

      var isScrollable = (cs.overflowY === 'auto' || cs.overflowY === 'scroll');
      var hasConversationAria = false;
      var node = el, hops = 0;
      while (node && hops < 8) {
        var aria = node.getAttribute && node.getAttribute('aria-label');
        if (aria && (/对话|Conversation/i).test(aria)) { hasConversationAria = true; break; }
        node = node.parentElement;
        hops++;
      }

      var score = 0;
      if (isScrollable) score += 1000;
      if (el.scrollHeight > el.clientHeight + 40) score += 800;
      if (hasConversationAria) score += 1200;
      score += Math.min(rect.width * rect.height / 1000, 1000);
      // 更偏向中间聊天列
      var center = rect.left + rect.width / 2;
      score -= Math.abs(center - window.innerWidth / 2) / 3;

      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function getFbNameFromPaneAria(pane) {
    var node = pane;
    var hops = 0;
    while (node && hops < 12) {
      var aria = node.getAttribute && node.getAttribute('aria-label');
      if (aria) {
        var m = aria.match(/^与(.+?)的对话/) ||
                aria.match(/^(.+?)\s*的对话/) ||
                aria.match(/^Conversation\s+with\s+(.+)$/i) ||
                aria.match(/with\s+(.+?)\s*$/i);
        if (m && m[1]) return m[1].trim();
      }
      node = node.parentElement;
      hops++;
    }
    return '';
  }

  function isFbBadHeaderText(t) {
    if (!t) return true;
    t = String(t).trim();
    if (!t) return true;
    if (t.length > 80) return true;
    return /^(Messenger|Facebook|Chats|聊天|收件箱|搜索|Search|语音通话|视频通话|通话详情|聊天室详情)$/i.test(t);
  }

  function findFbHeaderDirectly() {
    // v38兜底：直接从顶部标题区找联系人/群名，不改变32版显示位置逻辑。
    var candidates = [];
    document.querySelectorAll('h1, h2, h3, div[role="heading"], span[dir="auto"]').forEach(function(el) {
      if (!el || el.closest('#wa-remark-bar')) return;
      var rect = el.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      if (rect.top < 0 || rect.top > 150) return;
      if (rect.left < 180) return; // 排除左侧列表/导航
      if (rect.left > window.innerWidth * 0.88) return; // 排除右侧栏
      var t = (el.textContent || el.getAttribute('aria-label') || '').trim();
      if (isFbBadHeaderText(t)) return;
      candidates.push(el);
    });
    candidates.sort(function(a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      // 优先更靠上、文本容器更小的真实标题节点
      return (ra.top - rb.top) || ((ra.width * ra.height) - (rb.width * rb.height));
    });
    var target = candidates[0];
    if (!target) return null;
    var node = target, hops = 0, best = null;
    while (node && hops < 12) {
      var r = node.getBoundingClientRect();
      if (r.top >= 0 && r.top < 150 && r.width > 150 && r.height >= 25 && r.height <= 170) {
        best = node;
      }
      node = node.parentElement;
      hops++;
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
    var node = target;
    var hops = 0;
    var best = null;
    while (node && hops < 12) {
      var rect = node.getBoundingClientRect();
      if (rect.top < 150 && rect.width > 150 && rect.height >= 25 && rect.height <= 160) {
        best = node;
      }
      node = node.parentElement;
      hops++;
    }
    return best;
  }

  function getFbHeaderInfo() {
    var threadMatch = location.pathname.match(/\/t\/([^\/?]+)\/?/);
    var threadId = threadMatch ? threadMatch[1] : null;
    if (!threadId) return null;

    // 第一优先：沿用32版路径，保证显示位置和原来一致。
    var pane = findFbMessagePane();
    var name = pane ? getFbNameFromPaneAria(pane) : '';
    var headerEl = name ? findFbHeaderByName(name) : null;

    // 第二兜底：消息少时 pane/aria 可能失败，直接找顶部标题栏。
    if (!headerEl) {
      headerEl = findFbHeaderDirectly();
      if (headerEl && !name) name = getFbHeaderText(headerEl);
    }

    if (!headerEl) return null;
    if (!name) name = getFbHeaderText(headerEl);
    if (!name) name = 'Messenger 联系人';
    return { id: 'fb:' + threadId, name: name, platform: 'fb', headerEl: headerEl };
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
    var node = peerTitleEl;
    var hops = 0;
    var best = null;
    while (node && hops < 10) {
      if (node.classList && node.classList.contains('sidebar-header') && node.classList.contains('topbar')) {
        best = node;
        break;
      }
      node = node.parentElement;
      hops++;
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
    return { id: uniqueId, name: name, platform: 'tg', headerEl: headerEl };
  }

  function getContactInfoUnified() {
    if (location.hostname.indexOf('instagram.com') >= 0) {
      return getIgHeaderInfo();
    }
    if (location.hostname.indexOf('messenger.com') >= 0) {
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

    if (!main.tag) {
      for (var i = 0; i < members.length; i++) {
        if (members[i].tag) { main.tag = members[i].tag; break; }
      }
    }
    if (!Array.isArray(main.stages) || !main.stages.length) {
      var stageSet = {};
      members.forEach(function (m) {
        (Array.isArray(m.stages) ? m.stages : []).forEach(function (s) { stageSet[s] = true; });
      });
      main.stages = Object.keys(stageSet);
    }
    var latest = members.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })[0];
    if (!main.name) main.name = latest ? latest.name : '';
    if (!main.manualPhone) main.manualPhone = (members[0] && (members[0].manualPhone || '')) || '';
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

    if (changed) saveData(data);

    var groupCount = Object.keys(loadData()).filter(isMainKey).length;
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
      var mdata = loadData();
      if (!mdata[channelId]) mdata[channelId] = {};
      mdata[channelId][key] = value;
      mdata[channelId].updatedAt = Date.now();
      saveData(mdata);
      return;
    }

    var data = loadData();
    if (!data[channelId]) data[channelId] = {};
    data[channelId] = Object.assign({}, data[channelId], baseInfo);
    saveData(data);

    var data2 = loadData();
    if (!data2[channelId]) data2[channelId] = {};
    data2[channelId] = Object.assign({}, data2[channelId], baseInfo || {});
    data2[channelId][key] = value;
    data2[channelId].updatedAt = Date.now();
    saveData(data2);
    try { runLinkScan(); } catch (e) { }
  }

  function toggleStageSmart(channelId, stageKey, checked) {
    var effectiveId = resolveTagStageRecordId(channelId);
    toggleStage(effectiveId, stageKey, checked);
  }
  function upsertTagSmart(channelId, baseInfo, value) {
    if (isMainKey(channelId)) {
      upsertField(channelId, {}, 'tag', value);
      return;
    }
    var data = loadData();
    if (!data[channelId]) data[channelId] = {};
    data[channelId] = Object.assign({}, data[channelId], baseInfo || {});
    saveData(data);
    var effectiveId = resolveTagStageRecordId(channelId);
    upsertField(effectiveId, (effectiveId === channelId ? (baseInfo || {}) : {}), 'tag', value);
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

  function findMessengerSafeHeaderRect(headerEl) {
    var r = headerEl && headerEl.getBoundingClientRect ? headerEl.getBoundingClientRect() : null;
    if (!r) return null;

    // 正常情况：32版识别到的 header 宽度足够，直接使用，保持32版位置。
    if (r.width >= 280 && r.height >= 25) return r;

    // v39修复：38版在 e2ee 少消息场景可能把 headerEl 识别成 24px 宽的小按钮/小文字，
    // 导致备注栏只剩一条竖向下拉条。这里不改整体显示方式，只在 Messenger 且宽度异常时重算聊天列区域。
    if (location.hostname.indexOf('messenger.com') < 0) return r;

    var best = null, bestScore = -1;
    document.querySelectorAll('div[aria-label], div[role="main"], div').forEach(function (el) {
      if (!el || el.id === NOTE_BAR_ID || el.closest('#' + NOTE_BAR_ID)) return;
      var rr = el.getBoundingClientRect();
      if (!rr || rr.width <= 0 || rr.height <= 0) return;
      // Messenger 中间聊天列/顶部区域一般在左侧列表右边，不能太窄
      if (rr.width < 360 || rr.height < 40) return;
      if (rr.left < 300) return;
      if (rr.top < 0 || rr.top > 120) return;
      if (rr.left > window.innerWidth * 0.90) return;
      var aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
      var score = 0;
      if (/对话|Conversation|conversation/i.test(aria)) score += 1500;
      if (rr.top < 80) score += 500;
      // 宽度优先接近聊天主列，不要选 24px 小元素，也不要选整页最大容器
      score += Math.min(rr.width, 900);
      score -= Math.abs((rr.left + rr.width / 2) - (window.innerWidth / 2)) / 4;
      if (score > bestScore) { bestScore = score; best = rr; }
    });

    if (best) {
      return {
        top: best.top,
        bottom: Math.max(best.bottom, 64),
        left: best.left,
        right: best.right,
        width: best.width,
        height: best.height
      };
    }

    // 最后兜底：根据 Messenger 常见布局给一个可用宽度，避免只显示竖条。
    var left = Math.max(320, r.left - 220);
    var rightPadding = 16;
    return {
      top: 0,
      bottom: Math.max(64, r.bottom || 64),
      left: left,
      right: window.innerWidth - rightPadding,
      width: Math.max(420, window.innerWidth - left - rightPadding),
      height: 64
    };
  }

  function findMessengerChatColumnRect(headerEl) {
    // v42：Messenger 稳定定位。以顶部联系人标题栏所在聊天列为锚点，避免 41 版随机选到右侧资料栏/整列容器。
    if (location.hostname.indexOf('messenger.com') < 0) return null;
    var hr = headerEl && headerEl.getBoundingClientRect ? headerEl.getBoundingClientRect() : null;
    var headerCenter = hr ? (hr.left + hr.width / 2) : (window.innerWidth / 2);
    var best = null;

    Array.prototype.slice.call(document.querySelectorAll('div[role="main"], div[aria-label], div')).forEach(function (el) {
      if (!el || el.id === NOTE_BAR_ID || (el.closest && el.closest('#' + NOTE_BAR_ID))) return;
      var r = el.getBoundingClientRect && el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return;
      if (r.left < 240) return;                         // 排除左侧会话列表
      if (r.left > window.innerWidth * 0.82) return;     // 排除最右侧区域
      if (r.width < 320 || r.width > window.innerWidth * 0.72) return;
      if (r.height < 300) return;

      var cs = window.getComputedStyle(el);
      var text = (el.textContent || '').trim();
      var aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
      var scrollable = cs.overflowY === 'auto' || cs.overflowY === 'scroll' || el.scrollHeight > el.clientHeight + 20;
      var hasConversation = /对话|Conversation|conversation/i.test(aria + ' ' + text);
      var hasRightPanelWords = /个人主页|关闭通知|搜索聊天信息|影音内容和文件|隐私设置与支持/.test(text);

      var center = r.left + r.width / 2;
      var score = 0;
      if (scrollable) score += 1400;
      if (hasConversation) score += 1200;
      if (el.getAttribute('role') === 'main') score += 800;
      if (r.top > 40 && r.top < window.innerHeight * 0.55) score += 300;
      if (r.height > window.innerHeight * 0.35) score += 300;
      if (hasRightPanelWords) score -= 1200;
      score -= Math.abs(center - headerCenter) * 2.2;    // 关键：必须贴近联系人标题栏中心
      score -= Math.abs(r.width - (hr && hr.width > 320 ? hr.width : 520)) / 3;

      if (score > 0 && (!best || score > best.score)) best = { el: el, rect: r, score: score };
    });

    if (best) {
      var br = best.rect;
      return { left: br.left, top: br.top, width: br.width, height: br.height, bottom: br.bottom };
    }

    if (hr && hr.width >= 320) {
      return { left: hr.left, top: hr.bottom, width: hr.width, height: window.innerHeight - hr.bottom, bottom: window.innerHeight };
    }
    return null;
  }

  function embedMessengerBar(bar, headerEl) {
    // v42：放弃直接 insert 到 Messenger 内部 DOM。
    // 原因：Messenger 会动态重排/虚拟列表，41 版在不同会话会随机插到聊天区或右侧资料栏。
    // 这里改为“聊天列锚定 fixed”，视觉上固定在红框聊天页面顶部，不参与 Messenger 内部重排。
    var col = findMessengerChatColumnRect(headerEl);
    var hr = headerEl && headerEl.getBoundingClientRect ? headerEl.getBoundingClientRect() : null;
    if (!col && !hr) return false;

    if (bar.parentElement !== document.body) document.body.appendChild(bar);

    var left = col ? col.left : hr.left;
    var width = col ? col.width : hr.width;
    var top = hr && hr.bottom > 0 ? hr.bottom : (col ? col.top : 64);

    // 避免选到包含右侧资料栏的大容器：宽度过大时优先回退到 header 宽度。
    if (hr && hr.width >= 320 && (width > hr.width * 1.35 || width > 760)) {
      left = hr.left;
      width = hr.width;
    }

    bar.style.position = 'fixed';
    bar.style.top = Math.round(top) + 'px';
    bar.style.left = Math.round(left) + 'px';
    bar.style.right = 'auto';
    bar.style.bottom = 'auto';
    bar.style.width = Math.max(320, Math.round(width)) + 'px';
    bar.style.minWidth = '320px';
    bar.style.maxWidth = '760px';
    bar.style.margin = '0';
    bar.style.boxSizing = 'border-box';
    bar.style.zIndex = '99999';
    bar.style.flex = 'none';
    bar.style.alignSelf = 'auto';
    return true;
  }

  function setupBarPhysicalIsolation(bar, headerEl) {
    function reposition() {
      if (!document.body.contains(headerEl)) return;

      if (location.hostname.indexOf('messenger.com') >= 0) {
        if (embedMessengerBar(bar, headerEl)) return;
      }

      // 其他平台继续沿用原来的 fixed 定位方式。
      if (bar.parentElement !== document.body) {
        document.body.appendChild(bar);
      }
      var hRect = (typeof findMessengerSafeHeaderRect === 'function') ? findMessengerSafeHeaderRect(headerEl) : headerEl.getBoundingClientRect();
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
    __barMutationObserver = new MutationObserver(function(){ reposition(); });
    __barMutationObserver.observe(document.body, { childList: true, attributes: true, subtree: true });

    if (!bar.__eventIsolated) {
      bar.__eventIsolated = true;
      ['keydown', 'keyup', 'keypress', 'input'].forEach(function (type) {
        bar.addEventListener(type, function (e) { e.stopPropagation(); });
      });
    }
  }

  
// ============ 悬浮条渲染（已接入合并视图/双轨制，修复关联徽标显示） ============
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

    var bar = document.getElementById(NOTE_BAR_ID);

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
    var linkInfo = ctx.linkInfo;
    var linkedEditMode = !!__linkedFieldEditModeByChat[info.id];
    var effRecord = (linkInfo && linkInfo.isLinked && !linkedEditMode) ? getMergedReadonlyRecord(info.id) : (loadData()[info.id] || {});
    var tagStageRecord = ctx.tagStageRecord;
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
      linkBadge.textContent = '\uD83D\uDD17 \u5df2\u5173\u8054' + linkInfo.memberCount + '\u6e20\u9053';
      linkBadge.title = '\u8be5\u53f7\u7801\u5df2\u5173\u8054\u5230 ' + linkInfo.memberCount + ' \u4e2a\u6e20\u9053\uff0c\u6807\u7b7e/\u9636\u6bb5\u7edf\u4e00\u7ba1\u7406';
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
    tagSelect.style.cssText = 'border:1px solid #d1d7db;border-radius:4px;padding:2px 2px;font-size:12px;width:88px;';
    TAGS.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.key;
      opt.textContent = t.label;
      if ((tagStageRecord.tag || '') === t.key) opt.selected = true;
      tagSelect.appendChild(opt);
    });
    tagSelect.addEventListener('change', function () {
      upsertTagSmart(info.id, baseInfoForSave, tagSelect.value);
      refreshPanelIfOpen();
    });
    secondRow.appendChild(tagSelect);

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
  var COLUMNS = [
    { key: '__chk', label: '', width: 34, minWidth: 34, resizable: false },
    { key: '__platform', label: '\u6e20\u9053', width: 74, minWidth: 50, resizable: true },
    { key: '__link', label: '\u5173\u8054', width: 80, minWidth: 50, resizable: true },
    { key: '__id', label: '\u8bc6\u522b\u7801', width: 130, minWidth: 80, resizable: true },
    { key: 'name', label: '\u59d3\u540d', width: 120, minWidth: 70, resizable: true },
    { key: 'manualPhone', label: '\u7535\u8bdd', width: 140, minWidth: 80, resizable: true },
    { key: 'tag', label: '\u6807\u7b7e', width: 110, minWidth: 80, resizable: true },
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
  function resetColWidths() {
    setSettings({ tableColWidths: {} });
  }

  function refreshPanelIfOpen() {
    if (managePanelWindow && !managePanelWindow.closed && managePanelWindow.__waRefresh) {
      try { managePanelWindow.__waRefresh(); } catch (e) { }
    }
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
    html += '.platpill.active,.tagpill.active{border-color:#111b21;box-shadow:0 0 0 2px rgba(0,0,0,0.15) inset;}\n';
    html += '.batchbar{display:none;align-items:center;gap:8px;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:13px;}\n';
    html += '.batchbar.show{display:flex;}\n';
    html += '.dashboard{background:var(--card);border-radius:10px;padding:16px 20px;margin-bottom:14px;border:1px solid var(--border);display:none;}\n';
    html += '.dashboard.show{display:block;}\n.dash-row{margin-bottom:12px;}\n.dash-title{font-weight:700;font-size:13px;margin-bottom:6px;}\n';
    html += '.bar-item{display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px;}\n';
    html += '.bar-label{flex:0 0 110px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}\n';
    html += '.bar-track{flex:1;height:14px;background:var(--fieldbg);border-radius:7px;overflow:hidden;}\n';
    html += '.bar-fill{height:100%;border-radius:7px;}\n.bar-val{flex:0 0 40px;text-align:right;color:var(--sub);}\n';
    html += '.table-container{background:var(--card);border:1px solid var(--border);border-radius:8px;overflow:auto;max-height:72vh;position:relative;}\n';
    html += 'table{border-collapse:separate;border-spacing:0;table-layout:fixed;}\n';
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
    html += '</style>\n</head>\n<body>\n';
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
    html += '<button class="btn ghost" id="fieldNameBtn">' + String.fromCodePoint(0x270F) + String.fromCodePoint(0xFE0F) + ' \u5b57\u6bb5\u547d\u540d</button>\n';
    html += '<button class="btn ghost" id="rescanBtn">' + String.fromCodePoint(0x1F517) + ' \u91cd\u626b\u5173\u8054</button>\n';
    html += '</div>\n';
    html += '<div id="banner"></div>\n';
    html += '<div class="stats" id="statsBar"></div>\n';
    html += '<div class="platformbar" id="platformBar"></div>\n';
    html += '<div class="tagbar" id="tagBar"></div>\n';
    html += '<div class="batchbar" id="batchBar">\n<span id="batchCount">\u5df2\u9009\u4e2d 0 \u9879</span>\n';
    html += '<select id="batchTagSelect"></select>\n<button class="btn" id="batchApplyTagBtn">\u5e94\u7528\u6807\u7b7e</button>\n';
    html += '<button class="btn danger" id="batchDeleteBtn">\u5220\u9664\u9009\u4e2d</button>\n<button class="btn ghost" id="batchClearBtn">\u53d6\u6d88\u9009\u62e9</button>\n</div>\n';
    html += '<div class="dashboard" id="dashboard"></div>\n';
    html += '<div class="table-container"><table id="mainTable"><colgroup id="tableColgroup"></colgroup><thead id="tableHead"></thead><tbody id="tableBody"></tbody></table></div>\n';
    html += '</body>\n</html>';
    return html;
  }

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

    var state = {
      search: '',
      tagFilter: '',
      platformFilter: '',
      sort: 'updatedAt_desc',
      selected: {},
      wrapMode: (function () {
        var s = getSettings();
        return (typeof s.wrapMode === 'undefined') ? true : !!s.wrapMode;
      })(),
      dark: !!getSettings().darkMode,
      dashboardOpen: false
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
    function getAllRows() {
      var data = loadData();
      var rows = [];
      Object.keys(data).forEach(function (id) {
        if (isMainKey(id)) return;
        var e = data[id];
        if (!e) return;
        var platform = inferPlatform(e, id);
        var merged = Object.assign({ __id: id, __platform: platform }, e);
        var ctx = resolveDisplayContext(id);
        FIELDS.forEach(function (f) {
          if (ctx.linkInfo && ctx.linkInfo.isLinked) {
            var mr = getMergedReadonlyRecord(id);
            merged[f.key] = mr[f.key] || '';
          } else {
            merged[f.key] = e[f.key] || '';
          }
        });
        merged.tag = ctx.tagStageRecord ? (ctx.tagStageRecord.tag || '') : (e.tag || '');
        merged.stages = ctx.tagStageRecord ? (ctx.tagStageRecord.stages || []) : (e.stages || []);
        merged.__mainKey = (ctx.linkInfo && ctx.linkInfo.mainKey) || null;
        merged.__viewMode = (ctx.linkInfo && ctx.linkInfo.viewMode) || 'shared';
        rows.push(merged);
      });
      return rows;
    }

    // \u65b0\u589e\uff1a\u6839\u636e\u65b9\u6848C\u9700\u6c42\uff0c\u5c06\u5df2\u5173\u8054\u7684\u6e20\u9053\u5408\u5e76\u4e3a\u5355\u4e00\u7684\u201c\u7efc\u5408\u8bb0\u5f55\u884c\u201d\u8fdb\u884c\u5c55\u793a
    // \u672a\u5173\u8054\u7684\u6e20\u9053\u4ecd\u7136\u5355\u884c\u5c55\u793a\u3002\u70b9\u51fb\u5173\u8054\u5f7d\u6807\u5f39\u51fa\u5404\u6e20\u9053\u660e\u7ec6
    function getDisplayRows() {
      var channelRows = getAllRows();
      var data = loadData();
      var groupMap = {};
      var singleRows = [];
      channelRows.forEach(function (r) {
        if (r.__mainKey && data[r.__mainKey]) {
          if (!groupMap[r.__mainKey]) groupMap[r.__mainKey] = [];
          groupMap[r.__mainKey].push(r);
        } else {
          singleRows.push(r);
        }
      });
      var displayRows = singleRows.slice();
      Object.keys(groupMap).forEach(function (mk) {
        var main = data[mk];
        var members = groupMap[mk];
        var groupRow = Object.assign({}, main, {
          __id: mk,
          __platform: 'multi',
          __isGroup: true,
          __members: members,
          __memberCount: members.length,
          tag: main.tag || '',
          stages: main.stages || []
        });
        displayRows.push(groupRow);
      });
      return displayRows;
    }

    function applyFilters(rows) {
      var kw = state.search.trim().toLowerCase();
      return rows.filter(function (r) {
        if (state.platformFilter && r.__platform !== state.platformFilter) return false;
        if (state.tagFilter && (r.tag || '') !== state.tagFilter) return false;
        if (kw) {
          var hay = [r.name, r.manualPhone, r.remark, r.f1, r.f2, r.f3, r.f4, r.f5, r.f6, r.f7, r.f8]
            .map(function (v) { return (v || '').toString().toLowerCase(); }).join(' ');
          if (hay.indexOf(kw) < 0) return false;
        }
        return true;
      });
    }

    function applySort(rows) {
      var arr = rows.slice();
      arr.sort(function (a, b) {
        if (state.sort === 'name_asc') return (a.name || '').localeCompare(b.name || '');
        if (state.sort === 'name_desc') return (b.name || '').localeCompare(a.name || '');
        if (state.sort === 'updatedAt_asc') return (a.updatedAt || 0) - (b.updatedAt || 0);
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      return arr;
    }

    function renderPlatformBar() {
      var bar = win.document.getElementById('platformBar');
      var rows = getAllRows();
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
          state.platformFilter = el.getAttribute('data-plat');
          renderAll();
        });
      });
    }

    function renderTagBar() {
      var bar = win.document.getElementById('tagBar');
      var rows = getAllRows();
      var counts = {};
      rows.forEach(function (r) { var t = r.tag || ''; counts[t] = (counts[t] || 0) + 1; });
      var html = '';
      TAGS.forEach(function (t) {
        var c = counts[t.key] || 0;
        html += '<span class="tagpill" data-tag="' + t.key + '" style="background:' + t.color + ';">' +
          t.label + ' (' + c + ')</span>';
      });
      bar.innerHTML = html;
      bar.querySelectorAll('.tagpill').forEach(function (el) {
        if (el.getAttribute('data-tag') === state.tagFilter) el.classList.add('active');
        el.addEventListener('click', function () {
          var v = el.getAttribute('data-tag');
          state.tagFilter = (state.tagFilter === v) ? '' : v;
          renderAll();
        });
      });

      var sel = win.document.getElementById('tagFilter');
      sel.innerHTML = '<option value="">\u5168\u90e8\u6807\u7b7e</option>' + TAGS.map(function (t) {
        return '<option value="' + t.key + '">' + t.label + '</option>';
      }).join('');
      sel.value = state.tagFilter;
      var batchSel = win.document.getElementById('batchTagSelect');
      batchSel.innerHTML = TAGS.map(function (t) { return '<option value="' + t.key + '">' + t.label + '</option>'; }).join('');
    }

    function renderStats() {
      var rows = getAllRows();
      var filtered = applyFilters(rows);
      win.document.getElementById('statsBar').innerHTML =
        '\u5171 <b>' + rows.length + '</b> \u6761\u8bb0\u5f55\uff0c\u5f53\u524d\u7b5b\u9009\u51fa <b>' + filtered.length + '</b> \u6761';
    }

    function renderDashboard() {
      var dash = win.document.getElementById('dashboard');
      dash.classList.toggle('show', state.dashboardOpen);
      if (!state.dashboardOpen) return;
      var rows = getAllRows();

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
      rows.forEach(function (r) { var t = r.tag || ''; tagCounts[t] = (tagCounts[t] || 0) + 1; });
      var stageCounts = {};
      rows.forEach(function (r) {
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
      var data = loadData();
      var e = data[id];
      if (e && e.mainKey) {
        unlinkChannel(id);
        data = loadData();
      }
      delete data[id];
      saveData(data);
    }

    function copyContactText(row) {
      var disp = computeDisplayFields(row);
      var lines = [];
      lines.push('\u59d3\u540d\uff1a' + (disp.nameNote || row.name || ''));
      if (disp.displayPhone) lines.push('\u7535\u8bdd\uff1a' + disp.displayPhone);
      FIELDS.forEach(function (f) {
        if (row[f.key]) lines.push(getFieldLabel(f.key) + '\uff1a' + row[f.key]);
      });
      var text = lines.join('\n');
      if (win.navigator.clipboard && win.navigator.clipboard.writeText) {
        win.navigator.clipboard.writeText(text);
      }
      try { GM_setClipboard(text); } catch (e) {}
      return text;
    }

    function updateBatchBar() {
      var ids = Object.keys(state.selected).filter(function (k) { return state.selected[k]; });
      var bar = win.document.getElementById('batchBar');
      bar.classList.toggle('show', ids.length > 0);
      win.document.getElementById('batchCount').textContent = '\u5df2\u9009\u4e2d ' + ids.length + ' \u9879';
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
      COLUMNS.forEach(function (col) {
        var colEl = win.document.createElement('col');
        var w = widths[col.key] || col.width;
        colEl.style.width = w + 'px';
        colgroup.appendChild(colEl);
      });

      var head = win.document.getElementById('tableHead');
      var trh = win.document.createElement('tr');
      COLUMNS.forEach(function (col) {
        var th = win.document.createElement('th');
        th.style.position = 'relative';
        if (col.key === '__chk') {
          var chkWrap = win.document.createElement('div');
          chkWrap.className = 'chk-wrap-th';
          var chkAll = createCustomCheckboxDoc(win.document, false, function (checked) {
            var rows = applySort(applyFilters(getDisplayRows()));
            rows.forEach(function (r) { state.selected[r.__id] = checked; });
            renderTable();
            updateBatchBar();
          }, 14);
          chkWrap.appendChild(chkAll);
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
            function onMove(ev2) {
              var minW = col.minWidth || 50;
              var nw = Math.max(minW, startW + (ev2.clientX - startX));
              th.style.width = nw + 'px';
              var idx = COLUMNS.indexOf(col);
              var colEls = colgroup.querySelectorAll('col');
              if (colEls[idx]) colEls[idx].style.width = nw + 'px';
            }
            function onUp() {
              win.document.removeEventListener('mousemove', onMove);
              win.document.removeEventListener('mouseup', onUp);
              handle.classList.remove('dragging');
              saveColWidth(col.key, th.offsetWidth);
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
      var pendingResize = [];

      rows.forEach(function (row) {
        var disp = computeDisplayFields(row);
        var tr = win.document.createElement('tr');
        tr.className = 'row-' + row.__platform;
        COLUMNS.forEach(function (col) {
          var td = win.document.createElement('td');
          if (col.key === '__chk') {
            var chk = createCustomCheckboxDoc(win.document, !!state.selected[row.__id], function (checked) {
              state.selected[row.__id] = checked;
              updateBatchBar();
            }, 14);
            td.style.textAlign = 'center';
            td.appendChild(chk);
          } else if (col.key === '__platform') {
            if (row.__isGroup) {
              td.innerHTML = '<span class="plat-badge" style="background:#6d4c41;">' + String.fromCodePoint(0x1F517) + ' \u7efc\u5408(' + row.__memberCount + ')</span>';
            } else {
              var info = getPlatformInfo(row.__platform);
              td.innerHTML = '<span class="plat-badge" style="background:' + info.color + ';">' + info.short + '</span>';
            }
          } else if (col.key === '__link') {
            if (row.__isGroup) {
              var btn = win.document.createElement('button');
              btn.className = 'link-btn';
              btn.textContent = String.fromCodePoint(0x1F4CB) + ' \u67e5\u770b\u660e\u7ec6';
              btn.title = '\u67e5\u770b/\u7ba1\u7406\u8be5\u5206\u7ec4\u4e0b ' + row.__memberCount + ' \u4e2a\u6e20\u9053';
              btn.addEventListener('click', function () {
                var groupInfo = {
                  mainKey: row.__id,
                  phone: row.manualPhone || row.__id.replace('MAIN::', ''),
                  members: row.__members
                };
                showLinkGroupPopup(win, groupInfo, renderAll);
              });
              td.appendChild(btn);
            }
          } else if (col.key === '__id') {
            td.className = 'id-cell';
            td.textContent = row.__isGroup ? ('\u2605 ' + row.__id.replace('MAIN::', '\u4e3b\u8bb0\u5f55:')) : row.__id;
            td.title = row.__id;
          } else if (col.key === 'name') {
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
            TAGS.forEach(function (t) {
              var opt = win.document.createElement('option');
              opt.value = t.key; opt.textContent = t.label;
              if ((row.tag || '') === t.key) opt.selected = true;
              sel.appendChild(opt);
            });
            sel.addEventListener('change', function () {
              upsertTagSmart(row.__id, {}, sel.value);
              renderAll();
            });
            td.appendChild(sel);
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
            var input = win.document.createElement('input');
            input.type = 'text';
            input.className = 'cell-input';
            input.value = val;
            input.placeholder = isAutoFilled ? disp.displayPhone + '\uff08\u81ea\u52a8\u8bc6\u522b\uff0c\u70b9\u51fb\u53ef\u7f16\u8f91\u4fdd\u5b58\uff09' : '';
            input.style.background = '#fff';
            input.style.color = '#111b21';
            input.style.colorScheme = 'light';
            var timer = null;
            input.addEventListener('input', function () {
              clearTimeout(timer);
              timer = setTimeout(function () {
                upsertCell(row.__id, 'manualPhone', input.value);
                td.classList.toggle('cell-empty', !input.value);
              }, 400);
            });
            td.appendChild(input);
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
            var timer2 = null;
            input2.addEventListener('input', function () {
              autoResizeCell(input2);
              clearTimeout(timer2);
              timer2 = setTimeout(function () {
                upsertCell(row.__id, col.key, input2.value);
                td.classList.toggle('cell-empty', !input2.value);
              }, 400);
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
    }

    function renderBanner() {
      var s = getSettings();
      var banner = win.document.getElementById('banner');
      var last = s.lastBackupAt || 0;
      var days = (Date.now() - last) / 86400000;
      if (!last || days > 7) {
        banner.innerHTML = '<span>' + String.fromCodePoint(0x26A0) + String.fromCodePoint(0xFE0F) + ' \u60a8\u5df2\u7ecf ' + Math.floor(days) + ' \u5929\u672a\u5bfc\u51fa\u5907\u4efd\uff0c\u5efa\u8bae\u5b9a\u671f\u5bfc\u51faCSV\u4fdd\u5b58\u6570\u636e\u3002</span>' +
          '<button class="btn" id="bannerExportBtn">\u7acb\u5373\u5bfc\u51fa</button>';
        win.document.getElementById('bannerExportBtn').addEventListener('click', doExport);
      } else {
        banner.innerHTML = '';
      }
    }

    function doExport() {
      var rows = getAllRows();
      var headers = ['id', 'platform', 'name', 'manualPhone', 'tag', 'stages'].concat(FIELDS.map(function (f) { return f.key; })).concat(['updatedAt']);
      var lines = [headers.join(',')];
      rows.forEach(function (r) {
        var vals = [r.__id, r.__platform, r.name, r.manualPhone, r.tag, (Array.isArray(r.stages) ? r.stages.join(';') : '')]
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

    function renderAll() {
      renderBanner();
      renderPlatformBar();
      renderTagBar();
      renderStats();
      renderDashboard();
      renderTable();
      updateBatchBar();
    }

    win.__waRefresh = renderAll;

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
    win.document.getElementById('fieldNameBtn').addEventListener('click', function () {
      openFieldNameEditor(win);
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
    win.document.getElementById('batchDeleteBtn').addEventListener('click', function () {
      var ids = Object.keys(state.selected).filter(function (k) { return state.selected[k]; });
      if (!ids.length) return;
      if (!win.confirm('\u786e\u5b9a\u5220\u9664\u9009\u4e2d\u7684 ' + ids.length + ' \u6761\u8bb0\u5f55\uff1f')) return;
      ids.forEach(function (id) { deleteRow(id); delete state.selected[id]; });
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
        '<div style="font-size:12px;color:var(--sub,#667781);margin-top:5px;">共 ' + members.length + ' 个渠道已关联；下方按管理面板表格形式显示；电话、1-7、闪光点、备注可直接编辑，并强制保存到对应渠道自己的独立记录。</div></div>' +
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

  // ============ \u5b57\u6bb5\u540d\u79f0\u7f16\u8f91\u5f39\u7a97 ============
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
      if (info && info.id) return location.hostname + '::' + info.id;
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

})();
