/* Loopcom website — progressive enhancement only.
   Every page works with this file blocked; this makes it nicer. */
(function () {
  'use strict';

  /* ---------------- mobile menu ---------------- */
  var burger = document.querySelector('.burger');
  var menu = document.getElementById('mobile-menu');
  if (burger && menu) {
    burger.addEventListener('click', function () {
      var open = menu.getAttribute('data-open') === 'true';
      menu.setAttribute('data-open', open ? 'false' : 'true');
      burger.setAttribute('aria-expanded', open ? 'false' : 'true');
      burger.setAttribute('aria-label', open ? 'Open menu' : 'Close menu');
    });
    // close on Escape, and move focus back to the control
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.getAttribute('data-open') === 'true') {
        menu.setAttribute('data-open', 'false');
        burger.setAttribute('aria-expanded', 'false');
        burger.focus();
      }
    });
  }

  /* ---------------- shared validation ---------------- */
  function isEmail(v) {
    // deliberately permissive: reject the obviously-broken, never a real address
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
  }
  function digits(v) { return (v || '').replace(/\D/g, ''); }
  /**
   * ⛔ A TURNSTILE TOKEN IS SINGLE-USE. Without this, the SECOND attempt at a
   * form always fails — the visitor fixes the field we told them about, presses
   * send, and is refused for a reason that has nothing to do with what they
   * changed. Reset the widget after EVERY refusal, not just Turnstile ones.
   * Scoped to the form's own widget, so refusing a quote does not wipe the
   * token sitting in the chat panel.
   */
  /** The "email us / call us" tail, built as DOM so nothing is ever parsed. */
  function contactFallback() {
    var f = document.createDocumentFragment();
    f.appendChild(document.createTextNode(' Please try again, or email '));
    var a = document.createElement('a');
    a.href = 'mailto:onboarding@loopcom.net'; a.textContent = 'onboarding@loopcom.net';
    f.appendChild(a);
    f.appendChild(document.createTextNode(' or call '));
    var b = document.createElement('a');
    b.href = 'tel:+18457231213'; b.textContent = '(845) 723-1213';
    f.appendChild(b);
    f.appendChild(document.createTextNode('.'));
    return f;
  }

  function resetHumanCheck(form) {
    try {
      if (!window.turnstile || !form) return;
      var w = form.querySelector('.cf-turnstile');
      if (w) window.turnstile.reset(w);
    } catch (e) { /* the widget is optional; it must never break a form */ }
  }

  function isUsPhone(v) {
    var d = digits(v);
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length === 10;
  }
  function setErr(id, msg) {
    var f = document.getElementById(id);
    if (!f) return;
    var wrap = f.closest('.fld');
    var err = document.getElementById(id + '-err');
    if (msg) {
      if (wrap) wrap.classList.add('bad');
      if (err) err.textContent = msg;
      f.setAttribute('aria-invalid', 'true');
      if (err) f.setAttribute('aria-describedby', id + '-err');
    } else {
      if (wrap) wrap.classList.remove('bad');
      if (err) err.textContent = '';
      f.removeAttribute('aria-invalid');
    }
  }

  /* ---------------- quote form ---------------- */
  var qf = document.getElementById('quote-form');
  if (qf) {
    var started = document.getElementById('form_started');
    if (started) started.value = String(Date.now());

    var status = document.getElementById('quote-status');
    var submit = document.getElementById('quote-submit');

    qf.addEventListener('submit', function (e) {
      var bad = [];
      var v = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };

      setErr('business_name', ''); setErr('contact_name', '');
      setErr('email', ''); setErr('phone', ''); setErr('seats', '');

      if (!v('business_name').trim()) { setErr('business_name', 'Enter your business name.'); bad.push('business_name'); }
      if (!v('contact_name').trim()) { setErr('contact_name', 'Enter your name.'); bad.push('contact_name'); }
      if (!isEmail(v('email'))) { setErr('email', 'Enter an email address we can reply to.'); bad.push('email'); }
      if (!isUsPhone(v('phone'))) { setErr('phone', 'Enter a complete 10-digit phone number.'); bad.push('phone'); }

      var consent = document.getElementById('consent_reply');
      var cErr = document.getElementById('consent_reply-err');
      if (consent && !consent.checked) {
        if (cErr) { cErr.textContent = 'We need your agreement in order to reply to you.'; cErr.style.display = 'flex'; }
        bad.push('consent_reply');
      } else if (cErr) { cErr.textContent = ''; cErr.style.display = 'none'; }

      if (bad.length) {
        e.preventDefault();
        if (status) { status.setAttribute('data-state', 'error');
          status.textContent = 'Please check the highlighted fields — ' + bad.length + ' need attention.'; }
        var first = document.getElementById(bad[0]);
        if (first) { first.focus(); first.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        return;
      }

      // JS available → submit in the background so we control the result message
      e.preventDefault();
      if (submit) { submit.disabled = true; submit.textContent = 'Sending…'; }
      if (status) { status.removeAttribute('data-state'); status.textContent = ''; }

      fetch(qf.action, {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: new FormData(qf),
      }).then(function (r) {
        return r.json().catch(function () { return { ok: r.ok }; });
      }).then(function (j) {
        if (j && j.ok) { window.location.href = '/quote/thank-you/'; return; }
        var e = new Error((j && j.message) || 'We could not send your request.');
        // ⛔ Remember WHERE the wording came from. The server's refusals already
        // say what to do next and often already give the phone number; pasting
        // our generic tail on the end produced a run-on telling the visitor to
        // call us twice in one sentence.
        e.fromServer = !!(j && j.message);
        throw e;
      }).catch(function (err) {
        resetHumanCheck(qf);
        if (submit) { submit.disabled = false; submit.textContent = 'Send my request'; }
        if (status) {
          status.setAttribute('data-state', 'error');
          // ⛔ textContent, never innerHTML. The message can originate from the
          // server, and building markup out of it is an XSS sink waiting for
          // the first refusal that quotes something the visitor typed.
          status.textContent = String(err.message || 'We could not send your request.');
          if (!err.fromServer) status.appendChild(contactFallback());
        }
      });
    });
  }

  /* ---------------- chat assistant ---------------- */
  var cBtn = document.getElementById('chat-btn');
  var cPanel = document.getElementById('chat-panel');
  if (cBtn && cPanel) {
    var cLog = document.getElementById('chat-log');
    var cForm = document.getElementById('chat-form');
    var cMsg = document.getElementById('chat-message');
    var cEmail = document.getElementById('chat-email');
    var cNote = document.getElementById('chat-note');
    var cQuick = document.getElementById('chat-quick');

    function openChat(open) {
      cPanel.setAttribute('data-open', open ? 'true' : 'false');
      cBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      cBtn.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
      if (open && cMsg) cMsg.focus();
    }
    cBtn.addEventListener('click', function () {
      openChat(cPanel.getAttribute('data-open') !== 'true');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && cPanel.getAttribute('data-open') === 'true') { openChat(false); cBtn.focus(); }
    });

    if (cQuick) {
      cQuick.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-q]');
        if (!b || !cMsg) return;
        cMsg.value = b.getAttribute('data-q') + ' ';
        cMsg.focus();
        cMsg.setSelectionRange(cMsg.value.length, cMsg.value.length);
      });
    }

    function bubble(text, mine) {
      if (!cLog) return;
      var d = document.createElement('div');
      d.className = 'msg ' + (mine ? 'msg-me' : 'msg-bot');
      d.textContent = text;
      cLog.appendChild(d);
      cLog.scrollTop = cLog.scrollHeight;
    }

    if (cForm) {
      cForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var msg = (cMsg && cMsg.value || '').trim();
        var email = (cEmail && cEmail.value || '').trim();
        if (!msg) { if (cNote) cNote.textContent = 'Type a message first.'; cMsg.focus(); return; }
        if (!isEmail(email)) { if (cNote) cNote.textContent = 'Add an email address so we can reply.'; cEmail.focus(); return; }

        bubble(msg, true);
        if (cMsg) cMsg.value = '';
        if (cNote) cNote.textContent = 'Sending…';
        var btn = cForm.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;

        var fd = new FormData(cForm);
        fd.append('message', msg);
        fd.append('page', window.location.pathname);

        fetch('/api/chat', { method: 'POST', headers: { 'Accept': 'application/json' }, body: fd })
          .then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
          .then(function (j) {
            if (btn) btn.disabled = false;
            if (j && j.ok) {
              bubble('Thanks — that is with our team. We will reply to ' + email + ', usually the same business day.', false);
              if (cNote) cNote.textContent = 'Message sent.';
              if (cQuick) cQuick.style.display = 'none';
            } else {
              var e = new Error((j && j.message) || 'That did not send.');
              e.fromServer = !!(j && j.message);
              throw e;
            }
          })
          .catch(function (err) {
            resetHumanCheck(cForm);
            if (btn) btn.disabled = false;
            bubble(String(err.message || 'That did not send.') +
              (err.fromServer ? '' : ' You can email onboarding@loopcom.net or call (845) 723-1213.'), false);
            if (cNote) cNote.textContent = 'Not sent — please try again.';
          });
      });
    }
  }
})();
