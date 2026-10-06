/* Family credentials are the default; email-account sign-in remains optional. */
(() => {
  const auth = window.tracklineAuth;
  const emailInit = auth.init.bind(auth), emailLoad = auth.loadAccount.bind(auth);
  const emailFetch = auth.fetch.bind(auth), emailGate = auth.renderGate.bind(auth);
  const emailSignOut = auth.signOut.bind(auth), emailLock = auth.lock.bind(auth);
  const esc = value => String(value || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  auth.sessionMode = 'family';
  auth.init = async function() {
    this.initialUI = JSON.parse(JSON.stringify(ui));
    if (localStorage.getItem('trackline-signin-method') === 'email' || new URLSearchParams(location.search).has('code') || /access_token|type=recovery/.test(location.hash)) return this.useEmail();
    await this.loadAccount();
  };
  auth.useEmail = async function() { localStorage.setItem('trackline-signin-method', 'email'); this.sessionMode = 'email'; this.message = ''; await emailInit(); };
  auth.useFamily = async function() {
    this.sessionMode = 'family'; localStorage.removeItem('trackline-signin-method');
    if (this.client) await this.client.auth.signOut({ scope: 'local' });
    this.mode = 'signin'; this.clear(); await this.loadAccount();
  };
  auth.fetch = async function(url, options = {}) {
    if (this.sessionMode !== 'family') return emailFetch(url, options);
    const headers = new Headers(options.headers || {}); headers.set('X-Trackline-Session', 'family');
    const response = await fetch(url, { ...options, headers, cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 401) { await this.signOut(); throw new Error('Your family session expired. Sign in again.'); }
    return response;
  };
  auth.loadAccount = async function() {
    if (this.sessionMode !== 'family') return emailLoad();
    if (this.loading) return;
    this.loading = true;
    try {
      const response = await fetch('/api/family-session', { cache: 'no-store', credentials: 'same-origin' });
      const account = await response.json();
      this.ready = true;
      if (!response.ok || !account.signedIn) { this.user = null; this.membership = null; this.renderGate(); return; }
      // Reopening always clears the previous profile authorization server-side.
      const locked = await this.fetch('/api/family-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'lock' }) });
      if (!locked.ok) throw new Error('Could not lock your family session. Try again.');
      const data = await locked.json();
      this.user = { id: `family:${data.familyId}` }; this.familyMembers = data.members;
      this.familyName = data.familyName;
      this.needsFamilySetup = !!data.needsSetup;
      this.membership = { family_id: data.familyId, member_id: null, role: null };
      localStorage.setItem('trackline-family-id', data.familyId); localStorage.removeItem('trackline-data');
      ui.authenticated = false;
      this.selectedMemberId = this.selectedMemberId || localStorage.getItem('trackline-family-profile-id');
      this.selectedMemberId = this.familyMembers.some(member => member.id === this.selectedMemberId) ? this.selectedMemberId : this.familyMembers[0]?.id;
      if (data.needsSetup) this.renderFamilySetup(); else this.renderPinGate();
    } catch (error) { this.user = null; this.membership = null; this.message = error.message; this.ready = true; this.renderGate(); }
    finally { this.loading = false; }
  };
  auth.renderGate = function() {
    if (this.sessionMode !== 'family') { emailGate(); return; }
    document.getElementById('account-bar').hidden = true;
    const registering = this.mode === 'family-register';
    const joining = this.mode === 'family-join';
    const signingIn = this.mode === 'family-login';
    const root = document.getElementById('root');
    if (!registering && !joining && !signingIn) {
      root.innerHTML = `<main style="max-width:440px;margin:60px auto;padding:24px;background:#eee9dd;border-radius:12px;color:#181c2a"><h1>Trackline</h1><p>Your family, organised together.</p><p role="status">${esc(this.message)}</p><p><button id="create-family-entry">Create family</button> <button id="join-family-entry">Join family</button></p><p><button id="username-entry">Sign in with username</button> <button id="email-entry-option">Use email instead</button></p></main>`;
      const open = mode => { this.mode = mode; this.message = ''; this.renderGate(); };
      document.getElementById('create-family-entry').onclick = () => open('family-register');
      document.getElementById('join-family-entry').onclick = () => open('family-join');
      document.getElementById('username-entry').onclick = () => open('family-login');
      document.getElementById('email-entry-option').onclick = () => this.useEmail();
      return;
    }
    const field = (id, label, attributes = '') => `<label>${label}<input id="${id}" ${attributes} style="display:block;width:100%;margin:8px 0 16px"></label>`;
    root.innerHTML = `<main style="max-width:440px;margin:60px auto;padding:24px;background:#eee9dd;border-radius:12px;color:#181c2a"><h1>${registering ? 'Create family' : joining ? 'Join family' : 'Sign in'}</h1><form id="family-entry-form">${registering ? field('entry-family-name','Family name','required maxlength="80"') + field('entry-username','Username','required pattern="[a-zA-Z][a-zA-Z0-9_-]{2,31}" maxlength="32" autocomplete="username"') : field('entry-identity',joining ? 'Family ID' : 'Username','required maxlength="64" autocomplete="username"')}${field('entry-password',registering ? 'Password' : 'Family password',`type="password" required ${registering ? 'minlength="8"' : ''} maxlength="128" autocomplete="${registering ? 'new-password' : 'current-password'}"`)}${registering ? '<p>This is the family password used to join from another device.</p>' : ''}<p role="status">${esc(this.message)}</p><button type="submit">${registering ? 'Create family' : joining ? 'Join family' : 'Sign in'}</button></form><p><button id="family-entry-back">Back</button> <button id="email-entry-option">Use email instead</button></p></main>`;
    document.getElementById('family-entry-form').onsubmit = event => { event.preventDefault(); this.submitFamilyEntry(); };
    document.getElementById('family-entry-back').onclick = () => { this.mode = 'signin'; this.message = ''; this.renderGate(); };
    document.getElementById('email-entry-option').onclick = () => this.useEmail();
  };
  auth.submitFamilyEntry = async function() {
    if (this.submittingFamilyEntry) return;
    this.submittingFamilyEntry = true;
    const button = document.querySelector('#family-entry-form button'); button.disabled = true;
    const registering = this.mode === 'family-register';
    try {
      const body = { action: registering ? 'register' : 'login', password: document.getElementById('entry-password').value };
      if (registering) Object.assign(body, { username: document.getElementById('entry-username').value.trim(), familyName: document.getElementById('entry-family-name').value.trim() });
      else body.identity = document.getElementById('entry-identity').value.trim();
      const response = await this.fetch('/api/family-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not sign in.');
      this.message = registering ? `Family created. Your family ID is ${result.familyId}. Keep this ID and family password for other devices.` : '';
      if (registering) this.selectedMemberId = result.memberId;
      await this.loadAccount();
    } catch (error) { const status = document.querySelector('#family-entry-form [role="status"]'); if (status) status.textContent = error.message; }
    finally { this.submittingFamilyEntry = false; button.disabled = false; }
  };
  auth.renderFamilySetup = function() {
    document.getElementById('account-bar').hidden = true;
    document.getElementById('root').innerHTML = `<main style="max-width:520px;margin:40px auto;padding:24px;background:#eee9dd;border-radius:12px;color:#181c2a"><h1>Set up your family</h1><p>Family ID: <strong>${esc(this.membership.family_id)}</strong></p><p>Share this ID and your family password with family members.</p><form id="initial-family-setup"><label>Your name<input id="setup-parent-name" value="${esc(this.familyMembers[0]?.name)}" required maxlength="80" style="display:block;width:100%;margin:8px 0 16px"></label><p>Add adults and children. Each person will set their own PIN when they join.</p><div id="setup-members"></div><p><button id="setup-add-member" type="button">Add family member</button></p><p role="status"></p><button type="submit">Continue to PIN setup</button></form><p><button onclick="tracklineAuth.signOut()">Sign out</button></p></main>`;
    document.getElementById('setup-add-member').onclick = () => {
      if (document.querySelectorAll('.setup-member-row').length >= 20) return;
      const row = document.createElement('div'); row.className = 'setup-member-row'; row.style.cssText = 'display:flex;gap:8px;margin:8px 0';
      row.innerHTML = '<input class="setup-member-name" placeholder="Name" aria-label="Member name" maxlength="80"><select class="setup-member-role" aria-label="Member role"><option value="kid">Child</option><option value="parent">Adult</option></select><button type="button">Remove</button>';
      row.querySelector('button').onclick = () => row.remove(); document.getElementById('setup-members').appendChild(row);
    };
    document.getElementById('initial-family-setup').onsubmit = async event => {
      event.preventDefault(); if (this.savingFamilySetup) return;
      const form = event.target, button = form.querySelector('button[type="submit"]');
      this.savingFamilySetup = true; button.disabled = true;
      try {
        const members = Array.from(form.querySelectorAll('.setup-member-row')).map(row => ({ name: row.querySelector('input').value.trim(), role: row.querySelector('select').value })).filter(member => member.name);
        const response = await this.fetch('/api/family-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setup', parentName: document.getElementById('setup-parent-name').value.trim(), members }) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not save your family.');
        this.message = ''; await this.loadAccount();
      } catch (error) { form.querySelector('[role="status"]').textContent = error.message; }
      finally { this.savingFamilySetup = false; button.disabled = false; }
    };
  };
  const emailPinGate = auth.renderPinGate.bind(auth);
  auth.renderPinGate = function() {
    if (this.sessionMode !== 'family') return emailPinGate();
    if (this.needsFamilySetup) {
      if (!document.getElementById('initial-family-setup')) this.renderFamilySetup();
      return;
    }
    const member = this.familyMembers?.find(value => value.id === this.selectedMemberId);
    this.hasPin = !!member?.hasPin;
    emailPinGate();
    const form = document.getElementById('profile-pin-form');
    form.insertAdjacentHTML('afterbegin', `<label>Family member<select id="family-member-choice" style="display:block;width:100%;margin:8px 0 16px">${(this.familyMembers || []).map(value => `<option value="${esc(value.id)}" ${value.id === this.selectedMemberId ? 'selected' : ''}>${esc(value.name)} (${value.role === 'parent' ? 'Adult' : 'Child'})</option>`).join('')}</select></label>`);
    document.getElementById('family-member-choice').onchange = event => { this.selectedMemberId = event.target.value; this.message = ''; this.renderPinGate(); };
    if (member && !member.hasPin && !member.canSetPin) {
      form.querySelector('button').disabled = true;
      form.querySelector('[role="status"]').textContent = 'This parent needs to set up their PIN from their original account or registration device.';
    }
  };
  const emailSubmitPin = auth.submitPin.bind(auth);
  auth.submitPin = async function() {
    if (this.sessionMode !== 'family') return emailSubmitPin();
    if (this.submittingPin) return;
    const pin = document.getElementById('profile-pin').value;
    const confirm = document.getElementById('profile-pin-confirm');
    const status = document.querySelector('#profile-pin-form [role="status"]');
    if (confirm && confirm.value !== pin) { status.textContent = 'PINs do not match. Try again.'; return; }
    const revision = this.revision || 0;
    this.submittingPin = true;
    const button = document.querySelector('#profile-pin-form button'); button.disabled = true;
    try {
      const response = await this.fetch('/api/profile-pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ familyId: this.membership.family_id, memberId: this.selectedMemberId, pin }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not unlock.');
      if (revision !== (this.revision || 0)) return;
      const me = await this.fetch('/api/auth-me'); if (!me.ok) throw new Error('Could not verify your profile.');
      const account = await me.json(); this.memberships = account.memberships; this.membership = account.memberships[0];
      if (!this.membership) throw new Error('Could not verify your profile.');
      this.user = account; this.hasPin = true; this.message = ''; ui.authenticated = true;
      localStorage.setItem('trackline-family-profile-id', this.selectedMemberId);
      await loadData();
    } catch (error) { if (revision === (this.revision || 0)) status.textContent = error.message; }
    finally { this.submittingPin = false; button.disabled = false; }
  };
  auth.lock = async function() {
    if (this.sessionMode !== 'family') return emailLock();
    this.clear();
    this.message = ''; await this.loadAccount();
  };
  auth.signOut = async function() {
    if (this.sessionMode !== 'family') {
      await emailSignOut(); localStorage.removeItem('trackline-signin-method'); this.sessionMode = 'family'; this.renderGate(); return;
    }
    await fetch('/api/family-session', { method: 'DELETE', credentials: 'same-origin' });
    this.selectedMemberId = null; this.familyMembers = []; this.mode = 'signin'; this.clear();
  };
})();
