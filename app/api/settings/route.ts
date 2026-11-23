import {readState} from '../../../lib/scan-store';
export async function GET(){return Response.json(await readState('settings')||{amount:1000,min:5},{headers:{'Cache-Control':'no-store'}})}