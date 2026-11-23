import type {Metadata} from 'next';
import './globals.css';
export const metadata:Metadata={title:'Gapdesk · 아비트라지 스캐너',description:'이동 경로와 거래 비용을 확인하는 ETH/USDC 아비트라지 스캐너',icons:{icon:'/favicon.svg'}};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="ko"><body>{children}</body></html>}