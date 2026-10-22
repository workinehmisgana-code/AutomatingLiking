package com.repostearn.bubble

/**
 * Zefoy's page, as seen from Kotlin.
 *
 * EVERY SELECTOR THE PHONE USES IS IN HERE, once, mirroring the block at the top
 * of `2_comment_automation/automate.py`. Zefoy's markup is not ours and it moves;
 * when it does, one file changes on each side rather than a dozen call sites.
 *
 * Injected into the WebView and called through [ZefoyWeb]. It is written as a
 * plain object of small functions that each return a JSON-encodable value,
 * because that is all `evaluateJavascript` can hand back — no DOM handle
 * survives the trip, so a row is addressed by its index within the list as it
 * stands at that moment, and the engine re-reads the list before it acts.
 *
 * Kept to ES5 and free of `$`: this is a Kotlin raw string, and a dollar sign in
 * one is a template expression.
 */
object ZefoyScript {

    const val HOME = "https://zefoy.com/"

    val JS: String = """
window.__Z = (function () {
  var S = {
    captchaImg: '#captcha-img',
    captchaInput: '.captcha-login-input',
    captchaSubmit: '.submit-captcha',
    chBtn: 'button.t-chearts-button',
    urlInput: ".t-chearts-menu input[placeholder='Enter Video URL']",
    searchBtn: '.t-chearts-menu .input-group-append button',
    countBtn: '.t-chearts-menu button.wbutton.btn-dark',
    row: '.t-chearts-menu .list-group-item',
    pager: '.t-chearts-menu button.page-link',
    qty: "select[name='select_lmt']",
    submit: "button[type='submit']"
  };

  function q(s) { return document.querySelector(s); }
  function all(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function txt(el) { return el ? String(el.innerText || el.textContent || '').trim() : ''; }
  function vis(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }
  function toInt(s) {
    var m = String(s).replace(/[,\s]/g, '').match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }
  function body() { return String(document.body ? (document.body.innerText || '') : '').toLowerCase(); }
  /* norm() in automate.py and LikerRules.fold() in Kotlin: a-z0-9 only, so all
     three agree on whether two renderings are the same comment. */
  function fold(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  function rowObj(el, i) {
    return {
      i: i,
      text: txt(el.querySelector('span.text-dark.font-weight-bold')),
      hearts: toInt(txt(el.querySelector('span.text-green.font-weight-bold'))),
      user: txt(el.querySelector('.kadi-rengi')),
      date: txt(el.querySelector('span.text-muted')),
      qty: !!el.querySelector(S.qty)
    };
  }

  return {
    /* Which of the four places we are standing in. The engine branches on this
       rather than on "is element X there", because "no URL box" has three
       different causes and only one of them is worth retrying. */
    where: function () {
      if (vis(q(S.captchaImg)) || vis(q(S.captchaInput))) return 'captcha';
      if (vis(q(S.urlInput))) return 'panel';
      if (q(S.chBtn)) return 'dash';
      return 'none';
    },

    expired: function () {
      var b = body();
      return b.indexOf('session expired') >= 0 || b.indexOf('please re-login') >= 0;
    },

    /* The Comments Hearts button on the service menu. The panel shuts by itself
       and the URL box simply stops being on the page; this is the fix for that. */
    openPanel: function () {
      var b = q(S.chBtn);
      if (!b) return false;
      b.scrollIntoView({ block: 'center' });
      b.click();
      return true;
    },

    hasUrl: function () { return vis(q(S.urlInput)); },

    fillUrl: function (u) {
      var el = q(S.urlInput);
      if (!el) return false;
      el.focus();
      el.value = u;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },

    search: function () {
      var b = q(S.searchBtn);
      if (!b) return false;
      b.click();
      return true;
    },

    /* Seconds Zefoy wants us to wait, or 0. Both wordings it uses. */
    cooldown: function () {
      var b = body();
      var m = b.match(/wait\s+(\d+)\s+minute[^\d]*(\d+)\s+second/);
      if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + 5;
      var s = b.match(/wait\s+(\d+)\s+second/);
      if (s) return parseInt(s[1], 10) + 5;
      return 0;
    },

    hasCount: function () { return vis(q(S.countBtn)); },

    /* Clicks the dark comment-count button and returns the count on its face,
       or 0 when it was not there. */
    clickCount: function () {
      var b = q(S.countBtn);
      if (!b) return 0;
      var n = toInt(txt(b));
      b.scrollIntoView({ block: 'center' });
      b.click();
      return n || -1;
    },

    rows: function () { return JSON.stringify(all(S.row).map(rowObj)); },

    /* What the pagination actually offers, for a failure that can be diagnosed
       rather than guessed at. */
    pager: function () {
      return JSON.stringify({
        scoped: all(S.pager).map(txt),
        loose: all('button.page-link').map(txt)
      });
    },

    /* Exact text, so "2" does not also hit "12" or "20". */
    clickPage: function (n) {
      var want = String(n), hit = null;
      all(S.pager).forEach(function (b) { if (txt(b) === want) hit = b; });
      if (!hit) return false;
      hit.scrollIntoView({ block: 'center' });
      hit.click();
      return true;
    },

    /* ENABLED options only. The first <option> is a disabled placeholder that
       also carries value="25", so selecting by value hits the wrong element —
       the same trap the Python runner documents. */
    qtyOptions: function (i) {
      var r = all(S.row)[i];
      var sel = r && r.querySelector(S.qty);
      if (!sel) return JSON.stringify([]);
      return JSON.stringify(Array.prototype.slice.call(sel.options)
        .filter(function (o) { return !o.disabled; })
        .map(function (o) { return parseInt(o.value, 10); })
        .filter(function (v) { return !isNaN(v); }));
    },

    /* Selected by visible LABEL, for the same reason. */
    setQty: function (i, v) {
      var r = all(S.row)[i];
      var sel = r && r.querySelector(S.qty);
      if (!sel) return false;
      var want = String(v), done = false;
      Array.prototype.slice.call(sel.options).forEach(function (o, idx) {
        if (done || o.disabled) return;
        if (String(o.text || o.value || '').trim() === want) { sel.selectedIndex = idx; done = true; }
      });
      if (!done) return false;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },

    /* AN INDEX IS NOT AN IDENTITY. The engine reads the rows, decides which
       one is ours, then clicks by position - and one comment arriving in
       between shifts every row down by one, so the batch lands on a stranger
       and pushes them up the section we are paying to win. The PC runner was
       doing exactly that; `want` is the folded head of our comment's text, and
       the click does not happen unless the row still carries it. */
    submitRow: function (i, want) {
      var r = all(S.row)[i];
      var b = r && r.querySelector(S.submit);
      if (!b) return false;
      if (want) {
        var here = fold(txt(r.querySelector('span.text-dark.font-weight-bold')));
        if (here.slice(0, 60) !== String(want).slice(0, 60)) return 'moved';
      }
      b.scrollIntoView({ block: 'center' });
      b.click();
      return true;
    },

    body: function () { return body().slice(0, 4000); }
  };
})();
'ready'
"""
}
