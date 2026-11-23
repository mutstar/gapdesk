import {candles} from '../../../lib/market.mjs';
export async function GET(){try{return Response.json(await candles())}catch{return Response.json([],{status:503})}}