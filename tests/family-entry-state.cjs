// State transitions with isolated UI/network doubles; no real account or database.
const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const stores=new Map(),requests=[];
const auth={init(){},loadAccount(){},fetch(){},renderGate(){},signOut(){},lock(){},renderPinGate(){},submitPin(){},
 clear(){this.revision=(this.revision||0)+1;this.user=null;this.membership=null;context.ui={...this.initialUI};this.renderGate();}};
const context={window:{tracklineAuth:auth},ui:{dayMode:true,authenticated:true},state:{},localStorage:{getItem:k=>stores.get(k),setItem:(k,v)=>stores.set(k,v),removeItem:k=>stores.delete(k)},Headers,location:{search:'',hash:''},URLSearchParams,
 fetch:async(url,options)=>{requests.push({url,options});return{ok:true,status:200,json:async()=>({memberships:[{family_id:'F1',member_id:'p1',role:'parent'}]})};},
 document:{getElementById:()=>({hidden:false,innerHTML:''}),querySelector:()=>null},uiIcon:()=>'',showConfirm:(message,callback)=>{context.confirm=callback;},showAlert:()=>{},render(){},loadData:async()=>{},
 doLoadExampleData(){context.state={family:{id:'DEMO'},members:[{id:'dad',role:'parent'},{id:'kid1',role:'kid'}]};},memberById:id=>context.state.members.find(m=>m.id===id)};
vm.createContext(context);vm.runInContext(fs.readFileSync('app/family-auth.js','utf8'),context);
(async()=>{
 auth.initialUI={dayMode:false,authenticated:false};auth.rememberedFamily={id:'F1',name:'Family'};auth.user={id:'family:F1'};auth.membership={family_id:'F1',member_id:'p1',role:'parent'};
 auth.renderGate=()=>{};
 auth.goHome();assert.equal(typeof context.confirm,'function');assert.equal(requests.length,0);
 await context.confirm();assert.equal(auth.homeVisible,true);assert.equal(auth.rememberedFamily.id,'F1');assert.equal(context.ui.dayMode,true);assert.equal(context.ui.authenticated,false);
 assert.equal(JSON.parse(requests[0].options.body).action,'lock');
 auth.demo=true;const previousRequests=requests.length;
 await assert.rejects(auth.fetch('/api/family-data'),/Demo mode/);assert.equal(requests.length,previousRequests);
 auth.demo=false;auth.homeVisible=false;
 await auth.openDemo();assert.equal(auth.demo,true);assert.equal(auth.membership.family_id,'DEMO');
 auth.selectDemoMember('kid1');assert.equal(auth.membership.role,'kid');assert.equal(context.ui.profileId,'kid1');
 await auth.confirmHome();assert.equal(requests.length,previousRequests);assert.equal(auth.rememberedFamily.id,'F1');
 // A late profile response cannot unlock a screen after its auth revision changes.
 auth.homeVisible=true;auth.fetch=async()=>{auth.revision++;return{ok:true,json:async()=>({memberships:[{family_id:'F1',member_id:'p1',role:'parent'}]})};};
 await auth.finishUnlock();assert.equal(context.ui.authenticated,false);assert.equal(auth.homeVisible,true);
 console.log('Entry state checks passed: Home confirmation, remembered family, theme preservation, demo isolation, member switching and stale unlock protection.');
})().catch(e=>{console.error(e);process.exitCode=1;});
