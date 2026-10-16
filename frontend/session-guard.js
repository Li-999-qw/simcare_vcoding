/* Shared by the portal, training and administration pages. */
(() => {
  if (window.simcareSessionGuard) return;
  window.simcareSessionGuard = true;
  const originalFetch = window.fetch.bind(window);
  const english = location.pathname.startsWith('/en/');
  const portal = /^\/(?:en\/)?(?:portal\.html|index\.html)?$/.test(location.pathname);
  const entry = english ? '/en/portal.html' : '/portal.html';
  let active = false, redirecting = false, checking = false, generation = 0;

  function showNotice(reason) {
    if (!portal || !reason || document.getElementById('session-notice')) return;
    const banner = document.createElement('div');
    banner.id = 'session-notice';
    banner.setAttribute?.('role', 'status');
    banner.textContent = reason === 'replaced'
      ? (english ? 'Your account was signed in on another device. Please sign in again.' : '账号已在其他设备登录，请重新登录。')
      : (english ? 'Your session has expired. Please sign in again.' : '登录已失效，请重新登录。');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:100000;padding:12px;text-align:center;background:#fff3cd;color:#664d03;font-size:15px';
    document.body.prepend(banner);
  }

  function expire(code) {
    const reason = code === 'SESSION_REPLACED' ? 'replaced' : 'expired';
    // A fresh login page may still carry an invalid HttpOnly cookie. Stay here.
    if (portal && !active) { showNotice(reason); return; }
    if (redirecting) return;
    redirecting = true;
    for (const key of ['clinical-portal-login', 'clinical-page']) {
      try { sessionStorage.removeItem(key); } catch (_) {}
    }
    location.replace(entry + '?session=' + reason);
  }

  async function inspect(response, path) {
    if (response.ok && /\/portal\/(login|logout)$/.test(path)) generation++;
    if (response.ok && /\/portal\/(login|state|session)$/.test(path)) {
      active = true;
      document.getElementById('session-notice')?.remove();
    }
    if (response.ok && /\/portal\/logout$/.test(path)) active = false;
    if (response.status !== 401 || /\/(?:portal|auth)\/login$/.test(path)) return;
    let code;
    try { code = (await response.clone().json()).detail?.code; } catch (_) {}
    if (code === 'SESSION_REPLACED' || code === 'SESSION_EXPIRED') expire(code);
  }

  window.fetch = async function(input, options) {
    const started = generation;
    const response = await originalFetch(input, options);
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
    if (url.origin === location.origin && started === generation) await inspect(response, url.pathname);
    return response;
  };

  async function check() {
    if (checking || redirecting) return;
    checking = true;
    const started = generation;
    try {
      const response = await originalFetch('/portal/session', {credentials:'same-origin', cache:'no-store'});
      if (started !== generation) return;
      // Anonymous visitors should see the ordinary login screen without a warning.
      if (portal && !active && response.status === 401) return;
      await inspect(response, '/portal/session');
    } catch (_) {
      // A network outage or unavailable server does not invalidate a login.
    } finally { checking = false; }
  }

  const ready = () => {
    showNotice(new URLSearchParams(location.search).get('session'));
    check();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, {once:true});
  else ready();
  setInterval(check, 15000);
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
})();
