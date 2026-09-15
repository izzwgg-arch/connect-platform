/** Clean package staging: exclude the monorepo dependency tree and all test data. */
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
const desktop=fileURLToPath(new URL("../../",import.meta.url));
const repo=path.resolve(desktop,"../..");
const require=createRequire(path.join(desktop,"package.json"));
const stamp=new Date().toISOString().replace(/[-:TZ.]/g,"");
const stage=path.join(repo,"scratchpad",`browser-companion-package-${stamp}`);
await fs.mkdir(stage,{recursive:false});
for(const name of ["dist","assets","browser-companion"]) await fs.cp(path.join(desktop,name),path.join(stage,name),{recursive:true});
const pkg=JSON.parse(await fs.readFile(path.join(desktop,"package.json"),"utf8"));
delete pkg.devDependencies;delete pkg.scripts;
pkg.dependencies={"electron-updater":require("electron-updater/package.json").version};
await fs.writeFile(path.join(stage,"package.json"),JSON.stringify(pkg,null,2)+"\n");
await fs.copyFile(path.join(desktop,"electron-builder.yml"),path.join(stage,"electron-builder.yml"));
await fs.writeFile(path.join(repo,"scratchpad","browser-companion-package-path.txt"),stage);
console.log(stage);
