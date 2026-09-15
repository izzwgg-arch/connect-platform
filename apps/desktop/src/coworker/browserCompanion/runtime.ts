import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { SafeStorage } from "electron";
import { BrowserCompanionBridge } from "./bridge";
import { DEFAULT_PORT, type CommandName } from "./protocol";
import { resolveUserPath, type FsEnv } from "../runtime/fs";
import type { Journal } from "../runtime/journal";

export const COMPANION_EXTENSION_ID = "alogeebhboibbnncnkchchogajlejnpp";
export class ChromeRuntime {
  private bridge: BrowserCompanionBridge | null = null;
  private error: string | null = null;
  private secret: string | null = null;
  constructor(private deps:{userData:string;safeStorage:SafeStorage;env:()=>FsEnv;journal:Journal;onStop:()=>void}) {}
  async start() {
    try {
      if(!this.deps.safeStorage.isEncryptionAvailable()) throw Error("secure_storage_unavailable");
      const file=path.join(this.deps.userData,"coworker","browser-pairing.bin");
      await fs.mkdir(path.dirname(file),{recursive:true});
      try { this.secret=this.deps.safeStorage.decryptString(await fs.readFile(file)); }
      catch(e:any) { if(e.code!=="ENOENT") throw Error("pairing_storage_unreadable"); this.secret=randomBytes(32).toString("hex"); await fs.writeFile(file,this.deps.safeStorage.encryptString(this.secret),{flag:"wx"}); }
      this.bridge=new BrowserCompanionBridge({secret:this.secret,extensionId:COMPANION_EXTENSION_ID,onControl:()=>this.deps.onStop()});
      await this.bridge.start();
    } catch(e:any) { this.error=String(e.message).slice(0,100); }
  }
  /** ONLY exposed to the packaged local settings document, never the hosted portal or model. */
  pairing() { if(this.error || !this.secret) return {ok:false,error:this.error || "bridge_not_ready"}; return {ok:true,code:this.secret,port:DEFAULT_PORT,extensionId:COMPANION_EXTENSION_ID}; }
  status() { return { ...(this.bridge?.status() ?? {connected:false}),error:this.error,extensionId:COMPANION_EXTENSION_ID }; }
  cancel(taskId:string|null) { this.bridge?.cancel(taskId); }
  stop() { return this.bridge?.stop(); }
  async prepare(command:CommandName,args:Record<string,unknown>,taskId:string,signal:AbortSignal,scopeId=taskId) {
    if(this.error || !this.bridge) return {ok:false,error:this.error || "bridge_not_ready"};
    const result=await this.bridge.execute(command,args,taskId,signal,scopeId,"prepare");
    if(result.ok!==true || typeof result.authorization!=="string" || !result.description) return {...result,ok:false};
    return result;
  }
  async execute(command:CommandName,args:Record<string,unknown>,taskId:string,signal:AbortSignal,scopeId=taskId,authorization?:string) {
    if(this.error || !this.bridge) return {ok:false,error:this.error || "bridge_not_ready"};
    const env=this.deps.env();
    if(command==="upload") {
      const file=await resolveUserPath(args.path,env,{mustExist:true}); if(!file.ok)return file;
      const stat=await fs.stat(file.abs); if(!stat.isFile() || stat.size>25*1024*1024)return {ok:false,error:"upload_requires_file_under_25MB"};
      // The exact caller path is part of the approval. Canonical resolution is checked
      // locally; the extension never receives permission to browse other files.
      if(path.resolve(file.abs)!==path.resolve(String(args.path)))return {ok:false,error:"upload_requires_absolute_path"};
    }
    const result=await this.bridge.execute(command,args,taskId,signal,scopeId,"execute",authorization);
    if(result.ok!==true)return result;
    if(command==="download" || command==="screenshot") {
      const folder=await resolveUserPath(command==="download"?"downloads":"artifacts",env); if(!folder.ok)return folder;
      await fs.mkdir(folder.abs,{recursive:true});
      let data:Buffer, name:string;
      if(command==="download") {
        const file=await resolveUserPath(result.path,env,{mustExist:true}); if(!file.ok)return file;
        // Download reports can only name a file under Chrome's dedicated task download folder.
        const parts=file.abs.replace(/\\/g,"/").toLowerCase().split("/");
        if(!parts.includes("loopcomcoworker"))return {ok:false,error:"download_path_not_task_scoped"};
        const stat=await fs.stat(file.abs); if(!stat.isFile() || stat.size>25*1024*1024)return {ok:false,error:"download_too_large"};
        data=await fs.readFile(file.abs); name=`${randomUUID()}-${path.basename(file.abs)}`;
      } else {
        if(typeof result.png!=="string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.png) || result.png.length>1300000)return {ok:false,error:"invalid_screenshot"};
        data=Buffer.from(result.png,"base64"); if(data.subarray(0,8).toString("hex")!=="89504e470d0a1a0a")return {ok:false,error:"invalid_png"}; name=`chrome-${randomUUID()}.png`;
      }
      const destination=await resolveUserPath(path.join(folder.abs,name),env); if(!destination.ok)return destination;
      await fs.writeFile(destination.abs,data,{flag:"wx"});
      await this.deps.journal.append({ts:new Date().toISOString(),kind:"artifact",taskId,artifact:{path:destination.abs,label:command==="download"?"Chrome download":"Chrome screenshot",sizeBytes:data.length}});
      return {ok:true,path:destination.abs,bytes:data.length,verified: (await fs.stat(destination.abs)).size===data.length,tabId:args.tabId};
    }
    return result;
  }
}
