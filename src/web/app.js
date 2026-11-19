/* 定稿阅读器：纯静态，数据来自构建期注入的 #book-data */
(function () {
  'use strict';

  var data;
  try {
    data = JSON.parse(document.getElementById('book-data').textContent);
  } catch (e) {
    document.body.innerHTML = '<p style="padding:24px;font:16px sans-serif">数据注入失败：' + e.message + '</p>';
    return;
  }

  var chapters = (data.chapters || []).slice().sort(function (a, b) { return a.no - b.no; });
  var title = data.title || '未命名之书';
  var spec = data.spec || {};

  var $ = function (id) { return document.getElementById(id); };
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  var ns = 'novel:' + (spec.projectId || title) + ':';

  /* ---------- 设置 ---------- */
  var settings = LS.get(ns + 'settings', { theme: 'paper', fs: 19, lh: 1.8 });
  function applySettings() {
    document.documentElement.setAttribute('data-theme', settings.theme);
    document.documentElement.style.setProperty('--fs', settings.fs + 'px');
    document.documentElement.style.setProperty('--lh', settings.lh);
    $('fs-val').textContent = settings.fs;
    $('lh-val').textContent = settings.lh;
    document.querySelectorAll('.theme-dot').forEach(function (b) {
      b.classList.toggle('sel', b.getAttribute('data-theme') === settings.theme);
    });
    var themeIcon = $('btn-theme').querySelector('use');
    themeIcon.setAttribute('href', settings.theme === 'night' ? '#i-sun' : '#i-moon');
  }
  function saveSettings() { LS.set(ns + 'settings', settings); applySettings(); }

  /* ---------- 章节渲染 ---------- */
  var current = 0;
  function textToHtml(text) {
    return String(text || '').split(/\n+/).map(function (p) {
      return '<p>' + escapeHtml(p.trim()) + '</p>';
    }).filter(function (p) { return p !== '<p></p>'; }).join('');
  }
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function verdictOf(ch) { return ch.verdict || '未知'; }
  function isPass(ch) { return !/打回|禁止|失败|reject/i.test(verdictOf(ch)); }

  function renderChapter(idx, keepScroll) {
    if (!chapters.length) return;
    current = Math.max(0, Math.min(idx, chapters.length - 1));
    var ch = chapters[current];
    $('ch-title').textContent = ch.title || ('第' + ch.no + '章');
    $('ch-body').innerHTML = textToHtml(ch.text);
    $('ch-index').textContent = (current + 1) + ' / ' + chapters.length;
    $('ch-verdict').textContent = verdictOf(ch) + (ch.attempts > 1 ? ' · 重写' + (ch.attempts - 1) + '次' : '');
    $('ch-slider').max = chapters.length;
    $('ch-slider').value = current + 1;
    if (!keepScroll) $('reader').scrollTop = 0;
    markActiveDrawer();
    LS.set(ns + 'lastChapter', current);
  }

  /* ---------- 抽屉 ---------- */
  function buildDrawer() {
    var meta = '平台：' + (spec['平台'] || spec.platform || '—') + ' ｜ 调性：' + (spec.tone || '通用') +
      '<br>爽点：' + (spec['爽点类型'] || '—') + ' ｜ 反派：' + (spec['反派类型'] || '—');
    $('drawer-meta').innerHTML = meta;
    var html = '';
    chapters.forEach(function (ch, i) {
      var badge = ch.attempts > 1
        ? '<span class="ch-badge rewrite">重写' + (ch.attempts - 1) + '</span>'
        : (isPass(ch) ? '<span class="ch-badge">通过</span>' : '<span class="ch-badge rewrite">待修</span>');
      html += '<div class="ch-item" data-idx="' + i + '"><span class="ch-no">' + ch.no + '</span>' +
        '<span class="ch-name">' + escapeHtml(ch.title || ('第' + ch.no + '章')) + '</span>' + badge + '</div>';
    });
    $('drawer-list').innerHTML = html;
    $('drawer-list').querySelectorAll('.ch-item').forEach(function (el) {
      el.addEventListener('click', function () {
        renderChapter(Number(el.getAttribute('data-idx')));
        toggleDrawer(false);
      });
    });
  }
  function markActiveDrawer() {
    $('drawer-list').querySelectorAll('.ch-item').forEach(function (el) {
      el.classList.toggle('active', Number(el.getAttribute('data-idx')) === current);
    });
  }
  function toggleDrawer(show) {
    $('drawer').classList.toggle('show', show);
    $('scrim').classList.toggle('show', show);
  }
  function toggleFont(show) {
    $('font-panel').classList.toggle('show', show);
    $('font-scrim').classList.toggle('show', show);
  }

  /* ---------- 编审报告 ---------- */
  function buildReview() {
    var passed = chapters.filter(isPass).length;
    var intro = '<div class="review-intro"><h2>编审概览</h2><p>共 ' + chapters.length + ' 章 · 一次通过 ' + passed +
      ' 章 · 重写 ' + (chapters.length - passed) + ' 章。数据来自流水线定稿时的真实评审记录。</p></div>';
    var html = intro;
    chapters.forEach(function (ch) {
      var rv = ch.review || {};
      var problems = rv.problems || [];
      var pass = isPass(ch);
      var stats = '<div class="rv-stats">' +
        '<span>尝试 <b>' + (ch.attempts || 1) + '</b> 次</span>' +
        '<span>硬否决 <b>' + (rv.hard_reject_short_circuit ? '是' : '否') + '</b></span>' +
        '<span>L1 <b>' + ((rv.l1_hits || []).length) + '</b></span>' +
        '<span>L2 <b>' + ((rv.l2_hits || []).length) + '</b></span>' +
        '<span>AI味 <b>' + (rv.aiFlavor || '—') + '</b></span></div>';
      var probHtml = (problems.length
        ? '<ul class="rv-problems">' + problems.map(function (p) {
            return '<li>' + escapeHtml(typeof p === 'string' ? p : (p.detail || p.suggestion || JSON.stringify(p))) + '</li>';
          }).join('') + '</ul>'
        : '<div class="rv-empty"><svg><use href="#i-check"/></svg>无问题项</div>');
      html += '<div class="rv-card"><div class="rv-head"><span class="rv-no">第' + ch.no + '章</span>' +
        '<span class="rv-title">' + escapeHtml(ch.title || '') + '</span>' +
        '<span class="verdict ' + (pass ? 'pass' : 'reject') + '">' + escapeHtml(verdictOf(ch)) + '</span></div>' +
        stats + probHtml + '</div>';
    });
    $('review-list').innerHTML = html;
  }

  /* ---------- 视图切换 ---------- */
  function showView(name) {
    $('view-read').classList.toggle('active', name === 'read');
    $('view-review').classList.toggle('active', name === 'review');
    if (name === 'review') $('review-list').scrollTop = 0;
  }

  /* ---------- 事件绑定 ---------- */
  $('btn-menu').addEventListener('click', function () { toggleDrawer(true); });
  $('btn-drawer-close').addEventListener('click', function () { toggleDrawer(false); });
  $('scrim').addEventListener('click', function () { toggleDrawer(false); });
  $('btn-theme').addEventListener('click', function () {
    settings.theme = settings.theme === 'night' ? 'paper' : 'night';
    saveSettings();
  });
  $('btn-font').addEventListener('click', function () { toggleFont(true); });
  $('font-scrim').addEventListener('click', function () { toggleFont(false); });
  $('fs-minus').addEventListener('click', function () { settings.fs = Math.max(14, settings.fs - 1); saveSettings(); });
  $('fs-plus').addEventListener('click', function () { settings.fs = Math.min(30, settings.fs + 1); saveSettings(); });
  $('lh-minus').addEventListener('click', function () { settings.lh = Math.max(1.3, +(settings.lh - 0.1).toFixed(1)); saveSettings(); });
  $('lh-plus').addEventListener('click', function () { settings.lh = Math.min(2.6, +(settings.lh + 0.1).toFixed(1)); saveSettings(); });
  document.querySelectorAll('.theme-dot').forEach(function (b) {
    b.addEventListener('click', function () { settings.theme = b.getAttribute('data-theme'); saveSettings(); });
  });
  $('btn-goto-review').addEventListener('click', function () { toggleFont(false); showView('review'); });
  $('btn-review-back').addEventListener('click', function () { showView('read'); });
  $('btn-prev').addEventListener('click', function () { renderChapter(current - 1); });
  $('btn-next').addEventListener('click', function () { renderChapter(current + 1); });
  $('ch-slider').addEventListener('input', function (e) { renderChapter(Number(e.target.value) - 1); });

  /* ---------- 初始化 ---------- */
  document.title = title;
  $('book-title').textContent = title;
  applySettings();
  buildDrawer();
  buildReview();
  renderChapter(LS.get(ns + 'lastChapter', 0));

  /* ---------- Service Worker ---------- */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }
})();
