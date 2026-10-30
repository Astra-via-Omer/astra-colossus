export type AccountEvent={id:string;seq:string;product:string;kind:string;resourceId:string;version:string;state:string;occurredAt:string;unread:boolean};
export function mountAccountUpdates(host:HTMLElement,options?:{endpoint?:string;token?:string;onUse?:(event:AccountEvent)=>Promise<void>}):()=>void;
