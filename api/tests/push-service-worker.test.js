const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function harness(){
 const events={},settings=new Map(),notifications=[],fetches=[];let valid=true;
 const database={createObjectStore(){},close(){},transaction(){const tx={objectStore:()=>({put(value,key){settings.set(key,value);return{result:key};},get(key){return{result:settings.get(key)};}})};queueMicrotask(()=>tx.oncomplete?.());return tx;}};
 const indexedDB={open(){const request={result:database};queueMicrotask(()=>request.onsuccess());return request;}};
 const context={URL,Date,Promise,indexedDB,self:{location:{origin:'https://trackline.test'},clients:{claim:async()=>{},matchAll:async()=>[],openWindow:async()=>{}},skipWaiting:()=>{},addEventListener:(type,fn)=>events[type]=fn,registration:{showNotification:async(...args)=>notifications.push(args)}},fetch:async(url,options)=>{fetches.push(JSON.parse(options.body));return{ok:true,json:async()=>({valid})};}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../../app/push-sw.js'),'utf8'),context);
 const dispatch=async(type,event)=>{let promise;events[type]({...event,waitUntil:value=>promise=value});await promise;};
 return{settings,notifications,fetches,setValid:v=>valid=v,dispatch};
}
test('push displays without an open page, after verifying the latest saved reminder',async()=>{
 const h=harness();await h.dispatch('message',{data:{type:'push-binding',id:'sub1',key:'capability'}});
 const payload={title:'Task reminder',body:'Swimming — Kid1',binding:'sub1',key:'delivery',kind:'task',itemId:'task1',start:Date.now()+600000,expiresAt:Date.now()+600000};
 await h.dispatch('push',{data:{json:()=>payload}});assert.equal(h.notifications.length,1);assert.equal(h.notifications[0][1].body,payload.body);assert.equal(h.fetches[0].action,'verify');assert.equal(h.fetches[0].deviceKey,'capability');
});
test('cancelled, expired, wrong-profile and signed-out pushes do not display',async()=>{
 const h=harness();await h.dispatch('message',{data:{type:'push-binding',id:'sub1',key:'capability'}});
 const payload={body:'Swimming',binding:'sub1',key:'delivery',kind:'event',itemId:'event1',start:Date.now()+600000,expiresAt:Date.now()+600000};
 h.setValid(false);await h.dispatch('push',{data:{json:()=>payload}});assert.equal(h.notifications.length,0);
 h.setValid(true);await h.dispatch('push',{data:{json:()=>({...payload,binding:'old-profile'})}});await h.dispatch('push',{data:{json:()=>({...payload,expiresAt:Date.now()-1})}});assert.equal(h.notifications.length,0);
 await h.dispatch('message',{data:{type:'push-binding',id:null}});await h.dispatch('push',{data:{json:()=>payload}});assert.equal(h.notifications.length,0);
});
