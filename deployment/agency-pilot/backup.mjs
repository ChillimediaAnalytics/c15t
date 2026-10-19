import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
const source=path.resolve(process.env.DATA_DIR||'/data');
const destination=path.resolve(process.argv[2]||'/backups',new Date().toISOString().replaceAll(':','-'));
await fs.mkdir(destination,{recursive:true,mode:0o700});
for(const name of await fs.readdir(source)){if(!name.endsWith('.sqlite'))continue;const db=new DatabaseSync(path.join(source,name),{readOnly:true});try{await backup(db,path.join(destination,name));}finally{db.close();}}
console.log('SQLite backups completed:',destination);
