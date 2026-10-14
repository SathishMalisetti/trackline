// Run locally; generates SQL containing hashes, never plaintext credentials.
const {createInterface}=require('node:readline/promises');
const {hashSecret}=require('../api/shared/credentials');
const fs=require('node:fs');
(async()=>{
 const rl=createInterface({input:process.stdin,output:process.stdout});
 const username=(await rl.question('Admin username: ')).trim().toLowerCase();
 async function secret(prompt){process.stdout.write(prompt);const original=rl._writeToOutput;rl._writeToOutput=()=>{};try{return await rl.question('');}finally{rl._writeToOutput=original;process.stdout.write('\n');}}
 const password=await secret('Admin password (12+ characters, hidden): ');
 const pin=await secret('Admin PIN (4 digits, hidden): ');rl.close();
 if(!/^[a-z][a-z0-9_-]{2,31}$/.test(username)||password.length<12||password.length>128||!/^\d{4}$/.test(pin))throw Error('Use a valid username, 12–128 character password and 4-digit PIN.');
 const hash=await hashSecret(password),pinHash=await hashSecret(pin);
 const sql=`-- Execute in the Supabase SQL editor after installing admin/schema.sql.\ninsert into public.platform_admins(username,password_hash,pin_hash) values('${username}','${hash}','${pinHash}');\n`;
 const path=process.argv[2]||'first-admin.sql';fs.writeFileSync(path,sql,{mode:0o600});console.log('Created '+path+'. Keep it private; run it in Supabase, then remove the local file.');
})().catch(e=>{console.error(e.message);process.exitCode=1});
