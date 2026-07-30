export namespace main {
	
	export class ProbeResult {
	    ok: boolean;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new ProbeResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.message = source["message"];
	    }
	}
	export class appConfig {
	    server: string;
	    web: string;
	    hideIP: boolean;
	    reportStats: boolean;
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
	        this.migrated = source["migrated"];
	    }
	}

}

