export namespace main {
	
	export class FeatureResult {
	    reachable: boolean;
	    requestLinks: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FeatureResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.reachable = source["reachable"];
	        this.requestLinks = source["requestLinks"];
	    }
	}
	export class ProbeResult {
	    ok: boolean;
	    message: string;
	    relayAvailable: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ProbeResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.message = source["message"];
	        this.relayAvailable = source["relayAvailable"];
	    }
	}
	export class RequestResult {
	    files: number;
	    saved: number;
	    bytes: number;
	    verified: number;
	    renamed: number;
	    folder: string;
	    names: string[];
	
	    static createFrom(source: any = {}) {
	        return new RequestResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.files = source["files"];
	        this.saved = source["saved"];
	        this.bytes = source["bytes"];
	        this.verified = source["verified"];
	        this.renamed = source["renamed"];
	        this.folder = source["folder"];
	        this.names = source["names"];
	    }
	}
	export class RequestPrompt {
	    files: number;
	    totalBytes: number;
	    folder: string;
	    freeBytes: number;
	    warnings: string[];
	    answerBy: number;
	
	    static createFrom(source: any = {}) {
	        return new RequestPrompt(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.files = source["files"];
	        this.totalBytes = source["totalBytes"];
	        this.folder = source["folder"];
	        this.freeBytes = source["freeBytes"];
	        this.warnings = source["warnings"];
	        this.answerBy = source["answerBy"];
	    }
	}
	export class RequestLinkSnapshot {
	    state: string;
	    code: string;
	    gen: number;
	    promptGen: number;
	    link: string;
	    label: string;
	    saveDir: string;
	    expiresAt: number;
	    route: string;
	    reconnectUntil?: number;
	    missedAt?: number;
	    suggestClose: boolean;
	    prompt?: RequestPrompt;
	    result?: RequestResult;
	
	    static createFrom(source: any = {}) {
	        return new RequestLinkSnapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.state = source["state"];
	        this.code = source["code"];
	        this.gen = source["gen"];
	        this.promptGen = source["promptGen"];
	        this.link = source["link"];
	        this.label = source["label"];
	        this.saveDir = source["saveDir"];
	        this.expiresAt = source["expiresAt"];
	        this.route = source["route"];
	        this.reconnectUntil = source["reconnectUntil"];
	        this.missedAt = source["missedAt"];
	        this.suggestClose = source["suggestClose"];
	        this.prompt = this.convertValues(source["prompt"], RequestPrompt);
	        this.result = this.convertValues(source["result"], RequestResult);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class UpdateInfo {
	    version: string;
	
	    static createFrom(source: any = {}) {
	        return new UpdateInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	    }
	}
	export class appConfig {
	    server: string;
	    web: string;
	    hideIP: boolean;
	    reportStats: boolean;
	    noUpdateCheck: boolean;
	    migrated: boolean;
	
	    static createFrom(source: any = {}) {
	        return new appConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.server = source["server"];
	        this.web = source["web"];
	        this.hideIP = source["hideIP"];
	        this.reportStats = source["reportStats"];
	        this.noUpdateCheck = source["noUpdateCheck"];
	        this.migrated = source["migrated"];
	    }
	}

}

