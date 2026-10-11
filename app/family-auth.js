/* Family access connects a device; a personal PIN/password unlocks a profile. */
(() => {
  const auth = window.tracklineAuth;
  const emailInit = auth.init.bind(auth), emailLoad = auth.loadAccount.bind(auth);
  const emailFetch = auth.fetch.bind(auth), emailGate = auth.renderGate.bind(auth);
  const emailSignOut = auth.signOut.bind(auth), emailLock = auth.lock.bind(auth);
  const emailPinGate = auth.renderPinGate.bind(auth), emailSubmitPin = auth.submitPin.bind(auth);
  const esc = value => String(value || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const field = (id, label, attrs = '', help = '') => `<label class="entry-field" for="${id}">${label}<input id="${id}" ${attrs}>${help ? `<small>${help}</small>` : ''}</label>`;
  const pinAttrs = 'type="password" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" required autocomplete="off"';
  const secretAttrs = 'type="password" required minlength="8" maxlength="128" autocomplete="new-password"';
  const artwork = `<svg class="entry-art" viewBox="0 0 500 230" fill="none" aria-hidden="true"><rect x="10" y="25" width="245" height="190" rx="12" stroke="currentColor"/><path d="M10 70h245M30 25V10m35 15V10M10 110h245M10 150h245M10 190h245M90 70v145m80-145v145" stroke="currentColor" opacity=".28"/><rect x="32" y="87" width="68" height="17" rx="5" fill="var(--entry-sage)"/><rect x="153" y="127" width="73" height="17" rx="5" fill="var(--amber)"/><rect x="65" y="167" width="85" height="17" rx="5" fill="var(--entry-sage)"/><path d="M255 80h30v-30h30m-60 70h60m-60 50h30v25h30" stroke="currentColor"/><rect x="315" y="30" width="40" height="40" rx="8" stroke="currentColor"/><rect x="315" y="100" width="40" height="40" rx="8" stroke="currentColor"/><rect x="315" y="175" width="40" height="40" rx="8" stroke="currentColor"/><path d="M325 44h20v16h-20zM329 40v7m12-7v7m-16 6h20m-20 66 7 7 13-15" stroke="currentColor" stroke-width="2"/><path d="M325 203v-10m10 10v-17m10 17v-24" stroke="var(--entry-sage)" stroke-width="5"/><text x="370" y="55" fill="currentColor">Schedules</text><text x="370" y="125" fill="currentColor">Tasks</text><text x="370" y="200" fill="currentColor">Progress</text></svg>`;
  auth.sessionMode = 'family';
  auth.mode = 'home';
  auth.init = async function() {
    this.initialUI = JSON.parse(JSON.stringify(ui));
    if (localStorage.getItem('trackline-signin-method') === 'email' || new URLSearchParams(location.search).has('code') || /access_token|type=recovery/.test(location.hash)) return this.useEmail();
    await this.loadAccount();
  };
  auth.useEmail = async function() {
    this.homeVisible = false; this.demo = false; this.mode = 'signin';
    localStorage.setItem('trackline-signin-method', 'email'); this.sessionMode = 'email'; this.message = ''; await emailInit();
  };
  auth.useFamily = async function() {
    this.sessionMode = 'family'; localStorage.removeItem('trackline-signin-method');
    if (this.client) await this.client.auth.signOut({ scope: 'local' });
    this.homeVisible = false; this.mode = 'home'; this.clear(); await this.loadAccount();
  };
  auth.fetch = async function(url, options = {}) {
    if (this.demo) throw new Error('Demo mode does not access your family database.');
    if (this.sessionMode !== 'family') return emailFetch(url, options);
    const headers = new Headers(options.headers || {}); headers.set('X-Trackline-Session', 'family');
    const response = await fetch(url, { ...options, headers, cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 401) { await this.signOut(); throw new Error('Your family session expired. Access your family again.'); }
    return response;
  };
  auth.applyFamilyAccount = function(data) {
    this.user = { id: `family:${data.familyId}` }; this.familyMembers = data.members;
    this.familyName = data.familyName; this.rememberedFamily = { id:data.familyId, name:data.familyName };
    this.needsFamilySetup = !!data.needsSetup;
    this.membership = { family_id:data.familyId, member_id:null, role:null };
    localStorage.setItem('trackline-family-id', data.familyId); localStorage.removeItem('trackline-data');
    this.selectedMemberId = this.selectedMemberId || localStorage.getItem('trackline-family-profile-id');
    this.selectedMemberId = this.familyMembers.some(member=>member.id===this.selectedMemberId) ? this.selectedMemberId : this.familyMembers[0]?.id;
  };
  auth.loadAccount = async function() {
    if (this.demo) return;
    if (this.sessionMode !== 'family') return emailLoad();
    if (this.loading) return;
    this.loading = true;
    const revision = this.revision || 0;
    try {
      const response = await fetch('/api/family-session', { cache:'no-store', credentials:'same-origin' });
      const account = await response.json(); this.ready = true;
      if (revision !== (this.revision || 0)) return;
      if (!response.ok || !account.signedIn) {
        this.rememberedFamily = null; this.user = null; this.membership = null;
        if (!response.ok) this.message = account.error || 'Could not check family access.';
        this.renderGate(); return;
      }
      const locked = await this.fetch('/api/family-session', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'lock'}) });
      if (!locked.ok) throw new Error('Could not lock your family session. Try again.');
      const data = await locked.json();
      if (revision !== (this.revision || 0)) return;
      this.applyFamilyAccount(data); ui.authenticated = false; this.homeVisible = false;
      if (data.needsSetup) this.renderFamilySetup(); else this.renderPinGate();
    } catch(error) { if(revision === (this.revision || 0)) { this.user=null; this.membership=null; this.message=error.message; this.ready=true; this.renderGate(); } }
    finally { this.loading=false; }
  };
  auth.entryShell = function(content, home = false) {
    document.getElementById('account-bar').hidden = true;
    document.getElementById('root').innerHTML = `<div class="entry-shell"><header class="entry-header"><button class="entry-brand" onclick="tracklineAuth.goHome()" aria-label="Trackline home">Trackline</button><button class="btn ghost entry-theme" onclick="tracklineAuth.toggleEntryTheme()" aria-label="Switch colour theme">${uiIcon(ui.dayMode?'moon':'sun')}</button></header><main class="entry-layout ${home?'':'entry-layout-form'}"><section class="entry-intro"><h1>Your family,<br>organised together.</h1><p>One place for everyday family life.</p>${artwork}</section><section class="entry-panel" aria-label="Family access">${content}</section></main>${this.homeConfirm?`<div class="overlay"><div class="modal entry-home-confirm" role="dialog" aria-modal="true" aria-labelledby="home-confirm-title"><h2 id="home-confirm-title">Return to Trackline home?</h2><p>Your profile will lock. You can continue with this family or create or access another family.</p><div class="modal-actions"><button class="btn ghost" onclick="tracklineAuth.cancelHome()">Stay here</button><button class="btn primary" onclick="tracklineAuth.confirmHome()">Go home</button></div></div></div>`:''}</div>`;
    if(this.homeConfirm) document.querySelector('.entry-home-confirm button')?.focus();
  };
  auth.toggleEntryTheme = function(){
    ui.dayMode=!ui.dayMode;applyDayModeClass();
    localStorage.setItem('trackline-day-mode',ui.dayMode?'1':'0');this.initialUI.dayMode=ui.dayMode;this.redrawEntry();
  };
  auth.redrawEntry = function() {
    if (this.homeVisible || !this.user || !this.membership) return this.renderGate();
    if (this.needsFamilySetup) return this.renderFamilySetup();
    this.renderPinGate();
  };
  auth.renderGate = function() {
    if (this.sessionMode !== 'family' && !this.homeVisible) {
      emailGate();
      const main = document.querySelector('#root main');
      if(main) main.insertAdjacentHTML('beforeend','<p><button class="btn ghost" onclick="tracklineAuth.goHome()">Back to home</button></p>');
      return;
    }
    const registering=this.mode==='family-register', joining=this.mode==='family-join';
    if(!registering && !joining) {
      this.entryShell(`<h2>${this.rememberedFamily?'Welcome back':'Welcome to Trackline'}</h2><p class="entry-description">Your family life, all in one place.</p>${this.rememberedFamily?`<button class="btn primary entry-action" id="continue-family-entry">Continue to ${esc(this.rememberedFamily.name)}</button>`:''}<button class="btn ${this.rememberedFamily?'ghost':'primary'} entry-action" id="create-family-entry">${uiIcon('people')}<span>Create family</span><span aria-hidden="true">→</span></button><button class="btn ghost entry-action" id="join-family-entry">${uiIcon('lock')}<span>Access existing family</span><span aria-hidden="true">→</span></button><p class="entry-status" role="status">${esc(this.message)}</p><div class="entry-demo"><button class="entry-link" id="demo-family-entry">Explore demo family <span aria-hidden="true">→</span></button></div>`,true);
      document.getElementById('create-family-entry').onclick=()=>this.openEntry('family-register');
      document.getElementById('join-family-entry').onclick=()=>this.openEntry('family-join');
      document.getElementById('demo-family-entry').onclick=()=>this.openDemo();
      const continueButton=document.getElementById('continue-family-entry'); if(continueButton) continueButton.onclick=()=>this.continueFamily();
      return;
    }
    this.entryShell(`<button class="entry-link entry-back" id="family-entry-back">← Back to home</button><h2>${registering?'Create your family':'Access your family'}</h2><p class="entry-description">${registering?'Set up your family and your personal parent access.':'Enter the family details, then choose your profile.'}</p><form id="family-entry-form">${registering?`<div class="entry-fields">${field('entry-family-name','Family name','required maxlength="80" autocomplete="off"')}${field('entry-parent-name','Your name','required maxlength="80" autocomplete="name"')}${field('entry-username','Parent username','required pattern="[a-zA-Z][a-zA-Z0-9_-]{2,31}" maxlength="32" autocomplete="username"')}${field('entry-parent-password','Your parent password',secretAttrs,'Only for your parent profile.')}${field('entry-password','Family password',secretAttrs,'Share this with your family to connect another device.')}${field('entry-pin','Your 4-digit PIN',pinAttrs)}${field('entry-pin-confirm','Confirm your PIN',pinAttrs)}</div>`:field('entry-identity','Family ID','required maxlength="64" autocomplete="off" autocapitalize="characters" spellcheck="false"')+field('entry-password','Family password','type="password" required maxlength="128" autocomplete="current-password"')}<p class="entry-status" role="status">${esc(this.message)}</p><button type="submit" class="btn primary entry-action">${registering?'Create family':'Continue'}</button></form><p class="entry-email"><button class="entry-link" id="email-entry-option">Use email instead</button></p>`);
    document.getElementById('family-entry-form').onsubmit=event=>{event.preventDefault();this.submitFamilyEntry();};
    document.getElementById('family-entry-back').onclick=()=>{this.mode='home';this.message='';this.renderGate();};
    document.getElementById('email-entry-option').onclick=()=>this.useEmail();
  };
  auth.openEntry = function(mode) { this.homeVisible=true; this.mode=mode; this.message=''; this.renderGate(); };
  auth.continueFamily = async function() {
    this.homeVisible=false; this.demo=false; this.mode='home';
    if(this.sessionMode==='email') return emailLoad();
    this.sessionMode='family'; await this.loadAccount();
  };
  auth.submitFamilyEntry = async function() {
    if(this.submittingFamilyEntry) return;
    const form=document.getElementById('family-entry-form'),button=form.querySelector('button[type="submit"]'),status=form.querySelector('[role="status"]');
    const registering=this.mode==='family-register';
    this.submittingFamilyEntry=true;button.disabled=true;button.textContent=registering?'Creating…':'Connecting…';
    try {
      const body={action:registering?'register-v2':'login',password:document.getElementById('entry-password').value};
      if(registering){
        const pin=document.getElementById('entry-pin').value;
        if(pin!==document.getElementById('entry-pin-confirm').value) throw new Error('PINs do not match.');
        const parentPassword=document.getElementById('entry-parent-password').value;
        if(parentPassword===body.password) throw new Error('Use different passwords for your parent profile and family access.');
        Object.assign(body,{username:document.getElementById('entry-username').value.trim(),familyName:document.getElementById('entry-family-name').value.trim(),parentName:document.getElementById('entry-parent-name').value.trim(),parentPassword,pin});
      } else body.identity=document.getElementById('entry-identity').value.trim();
      // Family entry always uses the family cookie even when leaving optional email mode.
      const response=await fetch('/api/family-session',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not access your family.');
      this.sessionMode='family';this.demo=false;this.homeVisible=false;localStorage.removeItem('trackline-signin-method');this.message='';
      if(registering){
        this.selectedMemberId=result.memberId;
        const response=await this.fetch('/api/family-session');
        if(!response.ok)throw new Error('Family created, but could not load access. Return home and access your family.');
        this.applyFamilyAccount(await response.json());
        await this.finishUnlock();
        showAlert(`Family created. Your Family ID is ${result.familyId}. Share this ID and the family password to connect other devices. Add children and other parents in Settings.`);
      } else { this.selectedMemberId=null; this.clear(); await this.loadAccount(); }
    }catch(error){if(form.isConnected)status.textContent=error.message;else{this.message=error.message;this.homeVisible=true;this.mode='home';this.renderGate();}}
    finally{this.submittingFamilyEntry=false;button.disabled=false;button.textContent=registering?'Create family':'Continue';}
  };
  // Keep the existing unfinished-registration member setup for legacy families.
  auth.renderFamilySetup = function() {
    this.entryShell(`<button class="entry-link entry-back" onclick="tracklineAuth.goHome()">← Home</button><h2>Set up your family</h2><p>Family ID: <strong>${esc(this.membership.family_id)}</strong></p><form id="initial-family-setup">${field('setup-parent-name','Your name',`value="${esc(this.familyMembers[0]?.name)}" required maxlength="80"`)}<p>Add adults and children. Children choose their own PIN.</p><div id="setup-members"></div><button id="setup-add-member" class="btn ghost" type="button">Add family member</button><p class="entry-status" role="status"></p><button type="submit" class="btn primary entry-action">Continue to PIN setup</button></form>`);
    document.getElementById('setup-add-member').onclick=()=>{
      if(document.querySelectorAll('.setup-member-row').length>=20)return;
      const row=document.createElement('div');row.className='setup-member-row';
      row.innerHTML='<input placeholder="Name" aria-label="Member name" maxlength="80"><select aria-label="Member role"><option value="kid">Child</option><option value="parent">Adult</option></select><button class="btn ghost" type="button">Remove</button>';
      row.querySelector('button').onclick=()=>row.remove();document.getElementById('setup-members').appendChild(row);
    };
    document.getElementById('initial-family-setup').onsubmit=async event=>{
      event.preventDefault();if(this.savingFamilySetup)return;
      const form=event.target,button=form.querySelector('button[type="submit"]');this.savingFamilySetup=true;button.disabled=true;
      try{
        const members=Array.from(form.querySelectorAll('.setup-member-row')).map(row=>({name:row.querySelector('input').value.trim(),role:row.querySelector('select').value})).filter(member=>member.name);
        const response=await this.fetch('/api/family-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'setup',parentName:document.getElementById('setup-parent-name').value.trim(),members})});
        const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not save your family.');this.message='';await this.loadAccount();
      }catch(error){form.querySelector('[role="status"]').textContent=error.message;}
      finally{this.savingFamilySetup=false;button.disabled=false;}
    };
  };
  auth.renderPinGate = function() {
    if(this.sessionMode!=='family')return emailPinGate();
    if(this.homeVisible)return this.renderGate();
    if(this.needsFamilySetup)return this.renderFamilySetup();
    const member=this.familyMembers?.find(value=>value.id===this.selectedMemberId);
    this.hasPin=!!member?.hasPin;
    const passwordMode=this.parentPasswordMode && member?.role==='parent';
    this.entryShell(`<button class="entry-link entry-back" onclick="tracklineAuth.goHome()">← Home</button><p class="entry-family-label">${esc(this.familyName)}</p><h2>${passwordMode?'Parent sign-in':this.hasPin?'Choose your profile':'Set up your PIN'}</h2><p class="entry-description">${passwordMode?'Enter this parent’s personal password.':this.hasPin?'Unlock your profile with your 4-digit PIN.':'Choose a personal 4-digit PIN.'}</p><form id="profile-pin-form"><label class="entry-field" for="family-member-choice">Family member<select id="family-member-choice">${(this.familyMembers||[]).map(value=>`<option value="${esc(value.id)}" ${value.id===this.selectedMemberId?'selected':''}>${esc(value.name)} (${value.role==='parent'?'Parent':'Child'})</option>`).join('')}</select></label>${passwordMode?field('profile-parent-password','Parent password','type="password" required maxlength="128" autocomplete="current-password"'):field('profile-pin',this.hasPin?'PIN':'New PIN',pinAttrs)+(this.hasPin?'':field('profile-pin-confirm','Confirm PIN',pinAttrs))}<p class="entry-status" role="status">${esc(this.message)}</p><button type="submit" class="btn primary entry-action">${passwordMode?'Sign in':this.hasPin?'Unlock':'Save PIN & continue'}</button></form>${member?.role==='parent'?`<p><button class="entry-link" id="parent-password-toggle">${passwordMode?'Use my PIN instead':'Use my password instead'}</button></p>`:''}`);
    document.getElementById('family-member-choice').onchange=event=>{this.selectedMemberId=event.target.value;this.parentPasswordMode=false;this.message='';this.renderPinGate();};
    document.getElementById('profile-pin-form').onsubmit=event=>{event.preventDefault();this.submitPin();};
    const toggle=document.getElementById('parent-password-toggle');if(toggle)toggle.onclick=()=>{this.parentPasswordMode=!passwordMode;this.message='';this.renderPinGate();};
    if(member&&!member.hasPin&&!member.canSetPin&&!passwordMode){document.querySelector('#profile-pin-form button').disabled=true;document.querySelector('#profile-pin-form [role="status"]').textContent='A parent must verify this profile before its first PIN can be set. Use its parent password, or ask an existing parent to set one in Settings.';}
  };
  auth.finishUnlock = async function() {
    const revision=this.revision||0;
    const me=await this.fetch('/api/auth-me');if(!me.ok)throw new Error('Could not verify your profile.');
    const account=await me.json();if(revision!==(this.revision||0))return;this.memberships=account.memberships;this.membership=account.memberships[0];
    if(!this.membership)throw new Error('Could not verify your profile.');
    this.user=account;this.hasPin=true;this.message='';this.homeVisible=false;ui.authenticated=true;
    localStorage.setItem('trackline-family-profile-id',this.selectedMemberId);await loadData();
  };
  auth.submitPin = async function() {
    if(this.sessionMode!=='family')return emailSubmitPin();
    if(this.submittingPin)return;
    const passwordMode=this.parentPasswordMode;
    const confirmation=document.getElementById('profile-pin-confirm'),pin=document.getElementById('profile-pin')?.value;
    const status=document.querySelector('#profile-pin-form [role="status"]');
    if(confirmation&&confirmation.value!==pin){status.textContent='PINs do not match. Try again.';return;}
    const revision=this.revision||0,button=document.querySelector('#profile-pin-form button');this.submittingPin=true;button.disabled=true;
    try{
      const response=await this.fetch(passwordMode?'/api/parent-password':'/api/profile-pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({familyId:this.membership.family_id,memberId:this.selectedMemberId,...(passwordMode?{password:document.getElementById('profile-parent-password').value}:{pin})})});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not unlock.');
      if(revision!==(this.revision||0))return;
      if(result.needsPin){this.parentPasswordMode=false;await this.loadAccount();return;}
      await this.finishUnlock();
    }catch(error){if(revision===(this.revision||0))status.textContent=error.message;}
    finally{this.submittingPin=false;button.disabled=false;}
  };
  auth.lock = async function() {
    if(this.demo){ui.profileMenuOpen=false;return this.renderDemoMembers();}
    if(this.sessionMode!=='family')return emailLock();
    this.homeVisible=false;this.parentPasswordMode=false;this.clear();this.message='';await this.loadAccount();
  };
  auth.goHome = function() {
    if(this.homeVisible || (!this.membership&&!this.demo)){this.mode='home';this.homeVisible=true;return this.renderGate();}
    if(ui.authenticated){showConfirm('Return to Trackline home? Your profile will lock. You can continue with this family or create or access another family.',()=>this.confirmHome());return;}
    this.homeConfirm=true;this.redrawEntry();
  };
  auth.cancelHome = function(){this.homeConfirm=false;this.redrawEntry();};
  auth.confirmHome = async function() {
    this.homeConfirm=false;
    try{
      if(!this.demo&&this.sessionMode==='family'){
        const response=await this.fetch('/api/family-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'lock'})});
        if(!response.ok)throw new Error('Could not lock your profile. Please try again.');
      }else if(!this.demo&&this.sessionMode==='email'){emailLock();}
      this.initialUI.dayMode=ui.dayMode;this.demo=false;this.homeVisible=true;this.parentPasswordMode=false;this.mode='home';this.message='';this.clear();
    }catch(error){this.message=error.message;if(ui.authenticated)showAlert(error.message);else this.redrawEntry();}
  };
  auth.openDemo = async function() {
    // Lock a remembered real profile, but retain its family cookie for Continue.
    if(this.user&&!this.demo&&this.sessionMode==='family'){
      try{const r=await this.fetch('/api/family-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'lock'})});if(!r.ok)throw new Error();}
      catch{this.message='Could not lock your current profile. Please try again.';this.renderGate();return;}
    }
    this.clear();this.demo=true;this.homeVisible=false;
    this.sessionMode='family';this.ready=true;this.user={id:'demo'};
    this.selectedMemberId='dad';this.membership={family_id:'demo',member_id:'dad',role:'parent'};
    ui.authenticated=true;ui.loaded=true;ui.profileId='dad';ui.tab='parent';ui.kidId='kid1';
    doLoadExampleData();
    this.membership.family_id=state.family.id;render();
  };
  auth.renderDemoMembers = function(){
    this.entryShell(`<h2>Explore as a family member</h2><p>Demo only. No PIN needed.</p>${state.members.map(m=>`<button class="btn ghost entry-action" onclick="tracklineAuth.selectDemoMember('${esc(m.id)}')">${esc(m.name)} · ${m.role==='parent'?'Parent':'Child'}</button>`).join('')}<button class="entry-link" onclick="tracklineAuth.confirmHome()">Back to home</button>`);
  };
  auth.selectDemoMember = function(id){
    const member=memberById(id);if(!member)return;
    this.membership={family_id:state.family.id,member_id:id,role:member.role};ui.profileId=id;ui.profileMenuOpen=false;ui.kidId=member.role==='kid'?id:'kid1';ui.tab=member.role==='parent'?'parent':'kid';render();
  };
  auth.signOut = async function() {
    if(this.demo)return this.confirmHome();
    if(this.sessionMode!=='family'){await emailSignOut();localStorage.removeItem('trackline-signin-method');this.sessionMode='family';this.mode='home';this.homeVisible=true;this.renderGate();return;}
    const response=await fetch('/api/family-session',{method:'DELETE',credentials:'same-origin'});
    if(!response.ok){this.message='Could not sign out. Please try again.';return this.redrawEntry();}
    this.rememberedFamily=null;this.selectedMemberId=null;this.familyMembers=[];this.mode='home';this.homeVisible=true;this.clear();
  };
})();
