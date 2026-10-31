export class AccountEventsError extends Error { status:number; constructor(message:string,status?:number); }
export type EventConfig={url:string|undefined;anonKey:string|undefined;token:string|undefined;product?:string};
export function eventRpc(config:EventConfig,name:string,body:unknown,fetcher?:typeof fetch):Promise<any>;
export function boundedEventJson(response:Response|Request,limit?:number):Promise<any>;
export function accountUpdates(config:EventConfig&{product:string},input?:unknown,fetcher?:typeof fetch):Promise<any>;
export function accountUpdateBody(request:Request):Promise<unknown>;
export const accountUpdateHeaders:Record<string,string>;
