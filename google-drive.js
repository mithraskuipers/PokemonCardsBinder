'use strict';

/**
 * google-drive.js
 * ───────────────
 * Google Sign-In + Drive sync for Pokédex Binder.
 *
 * How it works for visitors:
 *   1. Page loads → "Sign in with Google" button appears in the nav
 *   2. Visitor clicks it → Google's consent popup → they're signed in
 *   3. Their collection is loaded from their own Google Drive (appDataFolder)
 *   4. Every change auto-saves back to their Drive (1.5 s debounce)
 *   5. Sign out → Drive sync pauses, local data stays intact
 *
 * Each user's collection is stored in their own Google Drive, in a
 * hidden app-specific folder (appDataFolder). It never appears in
 * their normal Drive UI and only this app can read it.
 *
 * Requires: window.GOOGLE_CLIENT_ID set in index.html
 * Exposes:  window.GDrive (used by app.js)
 */

(function () {

  const DRIVE_FILE_NAME = 'pokedex-collection.json';
  const SCOPES          = 'https://www.googleapis.com/auth/drive.appdata';

  // ── State ─────────────────────────────────────────────────────
  let _accessToken = null;
  let _driveFileId = null;
  let _syncTimer   = null;
  let _user        = null;
  let _onSignIn    = null;
  let _onSignOut   = null;
  let _tokenClient = null;

  // ── DOM ───────────────────────────────────────────────────────
  const driveStatus = document.getElementById('drive-status');
  const userPill    = document.getElementById('google-user-pill');
  const avatarImg   = document.getElementById('google-avatar');
  const nameSpan    = document.getElementById('google-name');
  const signoutBtn  = document.getElementById('btn-google-signout');
  const gSigninBtn  = document.getElementById('g-signin-btn');

  // ── Sync status dot ───────────────────────────────────────────
  function setStatus(state) {
    if (!driveStatus) return;
    driveStatus.style.display  = _accessToken ? 'block' : 'none';
    driveStatus.dataset.state  = state;
    driveStatus.title = {
      idle:    'Google Drive: connected',
      syncing: 'Google Drive: saving…',
      ok:      'Google Drive: saved ✓',
      error:   'Google Drive: sync failed — will retry on next change',
    }[state] || '';
  }

  // ── Token client (requests Drive access tokens) ───────────────
  function ensureTokenClient() {
    if (_tokenClient) return;
    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: window.GOOGLE_CLIENT_ID,
      scope:     SCOPES,
      callback:  onTokenResponse,
    });
  }

  function onTokenResponse(resp) {
    if (resp.error) {
      console.error('[GDrive] Token error:', resp.error);
      setStatus('error');
      return;
    }
    _accessToken = resp.access_token;
    loadFromDrive();
  }

  // ── GSI initialisation ────────────────────────────────────────
  function initGSI() {
    const clientId = window.GOOGLE_CLIENT_ID;

    // Not configured yet — show a greyed-out placeholder so the
    // nav area doesn't look broken during development.
    if (!clientId || clientId.startsWith('PASTE_')) {
      if (gSigninBtn) {
        gSigninBtn.innerHTML =
          '<div class="gsignin-placeholder" title="Add your Google Client ID to index.html">Sign in with Google</div>';
      }
      return;
    }

    // Initialise the ID-token flow (gives us user info + triggers Drive auth)
    google.accounts.id.initialize({
      client_id:   clientId,
      callback:    onIdToken,
      auto_select: true,   // silent re-login if already consented
    });

    // Render Google's own branded button
    google.accounts.id.renderButton(gSigninBtn, {
      theme:          'filled_black',
      size:           'medium',
      shape:          'pill',
      text:           'signin_with',
      logo_alignment: 'left',
    });

    // Show One Tap prompt (users who already consented sign in automatically)
    google.accounts.id.prompt();
  }

  function onIdToken(response) {
    // Decode the JWT — safe client-side because Google signed it
    const payload = JSON.parse(atob(response.credential.split('.')[1]));
    _user = { name: payload.name, email: payload.email, picture: payload.picture };
    showUserPill();

    // Request a Drive access token (silent if already consented)
    ensureTokenClient();
    _tokenClient.requestAccessToken({ prompt: '' });
  }

  // ── UI helpers ────────────────────────────────────────────────
  function showUserPill() {
    if (!_user) return;
    gSigninBtn.style.display  = 'none';
    userPill.style.display    = 'flex';
    avatarImg.src             = _user.picture || '';
    nameSpan.textContent      = _user.name || _user.email || '';
    setStatus('idle');
  }

  function hideUserPill() {
    gSigninBtn.style.display  = '';
    userPill.style.display    = 'none';
    setStatus('idle');   // hides dot because _accessToken is null at this point
  }

  // ── Sign-out ──────────────────────────────────────────────────
  function signOut() {
    if (_accessToken) google.accounts.oauth2.revoke(_accessToken, () => {});
    google.accounts.id.disableAutoSelect();
    _accessToken = null;
    _driveFileId = null;
    _user        = null;
    hideUserPill();
    if (_onSignOut) _onSignOut();
  }

  // ── Drive REST helpers ────────────────────────────────────────
  async function driveRequest(url, options = {}) {
    const resp = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${_accessToken}`,
        ...(options.headers || {}),
      },
    });
    if (resp.status === 401) {
      // Token expired — request silently and let the next save retry
      _accessToken = null;
      ensureTokenClient();
      _tokenClient.requestAccessToken({ prompt: '' });
      throw new Error('token-expired');
    }
    return resp;
  }

  async function findDriveFile() {
    const resp = await driveRequest(
      `https://www.googleapis.com/drive/v3/files` +
      `?spaces=appDataFolder&q=name='${DRIVE_FILE_NAME}'&fields=files(id)`
    );
    const data = await resp.json();
    return data.files?.length ? data.files[0].id : null;
  }

  async function readDriveFile(fileId) {
    const resp = await driveRequest(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
    );
    return resp.json();
  }

  async function createDriveFile(content) {
    const meta = JSON.stringify({ name: DRIVE_FILE_NAME, parents: ['appDataFolder'] });
    const body = new FormData();
    body.append('metadata', new Blob([meta], { type: 'application/json' }));
    body.append('file',     new Blob([JSON.stringify(content)], { type: 'application/json' }));
    const resp = await driveRequest(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: 'POST', body }
    );
    const data = await resp.json();
    return data.id;
  }

  async function updateDriveFile(fileId, content) {
    await driveRequest(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(content),
      }
    );
  }

  // ── Load from Drive ───────────────────────────────────────────
  async function loadFromDrive() {
    if (!_accessToken) return;
    setStatus('syncing');
    try {
      _driveFileId = await findDriveFile();
      const data   = _driveFileId ? await readDriveFile(_driveFileId) : {};
      setStatus('ok');
      if (_onSignIn) _onSignIn(data);
    } catch (err) {
      console.error('[GDrive] Load failed:', err);
      setStatus('error');
      if (_onSignIn) _onSignIn({});   // still let the app work offline
    }
  }

  // ── Save to Drive (debounced) ─────────────────────────────────
  function scheduleSave(collection) {
    if (!_accessToken) return;
    clearTimeout(_syncTimer);
    setStatus('syncing');
    _syncTimer = setTimeout(() => saveToDrive(collection), 1500);
  }

  async function saveToDrive(collection) {
    if (!_accessToken) return;
    setStatus('syncing');
    try {
      if (_driveFileId) {
        await updateDriveFile(_driveFileId, collection);
      } else {
        _driveFileId = await createDriveFile(collection);
      }
      setStatus('ok');
    } catch (err) {
      console.error('[GDrive] Save failed:', err);
      setStatus('error');
    }
  }

  // ── Boot ──────────────────────────────────────────────────────
  if (signoutBtn) signoutBtn.addEventListener('click', signOut);

  // Wait for the GSI library script to finish loading
  function tryInit() {
    if (window.google?.accounts) { initGSI(); }
    else { setTimeout(tryInit, 100); }
  }
  tryInit();

  // ── Public API (used by app.js) ───────────────────────────────
  window.GDrive = {
    onSignIn(cb)  { _onSignIn  = cb; },
    onSignOut(cb) { _onSignOut = cb; },
    save: scheduleSave,
    get isSignedIn() { return !!_accessToken; },
  };

})();
