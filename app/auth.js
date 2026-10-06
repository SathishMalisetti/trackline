/* Account authentication is separate from the old shared-device PIN UI. */
window.tracklineAuth = {
  ready: false, user: null, membership: null, client: null, message: '', mode: 'signin',
  async init() {
    this.initialUI = JSON.parse(JSON.stringify(ui));
    try {
      const response = await fetch('/api/auth-config', { cache: 'no-store' });
      if (!response.ok) throw new Error('Account sign-in has not been configured yet.');
      const config = await response.json();
      this.client = window.createTracklineAuthClient(config.url, config.publishableKey, {
        auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      this.client.auth.onAuthStateChange((event) => {
        if (event === 'PASSWORD_RECOVERY') { this.mode = 'reset'; this.renderGate(); }
        if (event === 'SIGNED_OUT') this.clear();
        if (event === 'SIGNED_IN') setTimeout(() => this.loadAccount(), 0);
      });
      await this.loadAccount();
    } catch (error) { this.ready = true; this.message = error.message; this.renderGate(); }
  },
  async fetch(url, options = {}) {
    const { data, error } = await this.client.auth.getSession();
    if (error || !data.session) { this.clear(); throw new Error('Sign in required.'); }
    const headers = new Headers(options.headers || {});
    headers.set('X-Trackline-Authorization', `Bearer ${data.session.access_token}`);
    const response = await fetch(url, { ...options, headers, cache: 'no-store' });
    if (response.status === 401) { await this.signOut(); throw new Error('Your session has expired.'); }
    return response;
  },
  async loadAccount() {
    if (this.loading) return;
    this.loading = true;
    const revision = this.revision || 0;
    try {
      const { data } = await this.client.auth.getSession();
      this.ready = true;
      if (!data.session) { this.clear(); return; }
      const response = await this.fetch('/api/auth-me');
      if (!response.ok) throw new Error('Could not verify your family access.');
      const account = await response.json();
      if (revision !== (this.revision || 0)) return;
      this.user = account;
      const savedId = localStorage.getItem('trackline-family-id');
      this.memberships = account.memberships;
      this.membership = account.memberships.find(m => m.family_id === savedId) || account.memberships[0] || null;
      if (!this.membership || this.mode === 'reset') { this.renderGate(); return; }
      localStorage.setItem('trackline-family-id', this.membership.family_id);
      // Never display a cached family's data while account authorization is checked.
      localStorage.removeItem('trackline-data');
      await loadData();
    } catch (error) { this.membership = null; this.message = error.message; this.renderGate(); }
    finally { this.loading = false; }
  },
  clear() {
    this.revision = (this.revision || 0) + 1;
    this.user = null; this.membership = null; this.ready = true;
    localStorage.removeItem('trackline-data');
    if (typeof ui !== 'undefined' && this.initialUI) ui = JSON.parse(JSON.stringify(this.initialUI));
    if (typeof state !== 'undefined') {
      state = { family: null, members: [], events: [], chores: [], choreLogs: [], choreLibrary: [], shoppingList: [], shoppingTrips: [], shoppingItemLibrary: [], activityLibrary: [], topicProgress: [] };
    }
    this.renderGate();
  },
  async signOut() {
    if (this.client) await this.client.auth.signOut({ scope: 'local' });
    this.mode = 'signin'; this.clear();
  },
  renderGate() {
    const root = document.getElementById('root');
    document.getElementById('account-bar').hidden = true;
    const esc = value => String(value || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    if (this.user && this.mode !== 'reset') {
      root.innerHTML = `<main style="max-width:440px;margin:60px auto;padding:24px;background:#eee9dd;border-radius:12px;color:#181c2a"><h1>Set up your family</h1><p>Starting a new family? Create it here and you will be its first parent.</p><form id="family-form"><label>Family name<input id="family-name" required maxlength="80" style="display:block;width:100%;margin:8px 0 16px"></label><label>Your name<input id="parent-name" autocomplete="name" required maxlength="80" style="display:block;width:100%;margin:8px 0 16px"></label><p role="status">${esc(this.message)}</p><button type="submit">Create family</button></form><p>Already part of a family? Ask a parent or administrator to link your account.</p><button onclick="tracklineAuth.loadAccount()">Check access again</button> <button onclick="tracklineAuth.signOut()">Sign out</button></main>`;
      document.getElementById('family-form').onsubmit = event => { event.preventDefault(); this.createFamily(); };
      return;
    }
    root.innerHTML = `<main style="max-width:440px;margin:60px auto;padding:24px;background:#eee9dd;border-radius:12px;color:#181c2a"><h1>Trackline</h1><h2>${this.mode === 'reset' ? 'Set a new password' : 'Sign in to your family'}</h2><form id="account-form"><label>Email<input id="account-email" type="email" autocomplete="email" required style="display:block;width:100%;margin:8px 0 16px"></label><label>Password<input id="account-password" type="password" autocomplete="${this.mode === 'signin' ? 'current-password' : 'new-password'}" minlength="8" required style="display:block;width:100%;margin:8px 0 16px"></label><p role="status">${esc(this.message)}</p><button type="submit">${this.mode === 'signup' ? 'Create account' : this.mode === 'reset' ? 'Save password' : 'Sign in'}</button></form><p><button id="account-toggle">${this.mode === 'signup' ? 'Already have an account?' : 'Create an account'}</button> <button id="account-recover">Forgot password?</button></p></main>`;
    document.getElementById('account-form').onsubmit = event => { event.preventDefault(); this.submit(); };
    document.getElementById('account-toggle').onclick = () => { this.mode = this.mode === 'signup' ? 'signin' : 'signup'; this.message = ''; this.renderGate(); };
    document.getElementById('account-recover').onclick = () => this.recover();
    if (this.mode === 'reset') document.getElementById('account-email').required = false;
  },
  async createFamily() {
    if (this.creatingFamily) return;
    this.creatingFamily = true;
    const button = document.querySelector('#family-form button');
    button.disabled = true;
    try {
      const response = await this.fetch('/api/create-family', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ familyName: document.getElementById('family-name').value.trim(), parentName: document.getElementById('parent-name').value.trim() }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not create your family. Please try again.');
      this.message = '';
      localStorage.setItem('trackline-family-id', result.family_id);
      await this.loadAccount();
    } catch (error) {
      const status = document.querySelector('#family-form [role="status"]');
      if (status) status.textContent = error.message;
    } finally { this.creatingFamily = false; button.disabled = false; }
  },
  async submit() {
    const email = document.getElementById('account-email').value.trim();
    const password = document.getElementById('account-password').value;
    try {
      if (!this.client) throw new Error('Account sign-in is not configured yet.');
      const result = this.mode === 'signup'
        ? await this.client.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } })
        : this.mode === 'reset'
          ? await this.client.auth.updateUser({ password })
          : await this.client.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      if (this.mode === 'signup' && !result.data.session) { this.message = 'Check your email to confirm your account, then sign in.'; this.renderGate(); return; }
      this.mode = 'signin'; this.message = ''; await this.loadAccount();
    } catch (error) { this.message = error.message; this.renderGate(); }
  },
  async recover() {
    const email = document.getElementById('account-email').value.trim();
    if (!email || !this.client) { this.message = 'Enter your email first.'; this.renderGate(); return; }
    const { error } = await this.client.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
    this.message = error ? error.message : 'If an account exists, a password reset email will be sent.';
    this.renderGate();
  },
};
