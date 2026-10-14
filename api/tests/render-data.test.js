const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateRenderData} = require('../shared/render-data');
test('existing UUIDs, generated IDs, colors and free-form names remain valid', () => {
  validateRenderData({members:[{id:'kid1',name:"O'Brien <test>",color:'#4C8577'}],events:[{id:'a-b:c.d',memberId:'kid1',color:'var(--amber)'}]});
});
test('reject persisted attribute and inline-handler injection, including nested trip items', () => {
  for (const data of [
    {members:[{id:"kid');alert(1);//"}]},
    {members:[{id:'kid1',color:'#fff" onclick="alert(1)'}]},
    {items:[{id:'x" onfocus="alert(1)'}]},
    {events:[{driverId:"x'"}]}
  ]) assert.throws(()=>validateRenderData(data), {status:400});
});
