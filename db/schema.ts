import {sqliteTable,text,integer,real} from 'drizzle-orm/sqlite-core';
export const scanState=sqliteTable('scan_state',{id:text('id').primaryKey(),value:text('value').notNull()});
export const detections=sqliteTable('detections',{id:text('id').primaryKey(),symbol:text('symbol').notNull(),buy:text('buy').notNull(),sell:text('sell').notNull(),gap:real('gap').notNull(),seen:integer('seen').notNull(),kind:text('kind').notNull(),contractKey:text('contract_key')});

import {index,uniqueIndex} from 'drizzle-orm/sqlite-core';
import {sql} from 'drizzle-orm';

export const signalStream=sqliteTable('signal_stream',{
  id:integer('id').primaryKey(),
  cycle:integer('cycle').notNull(),
  seen:integer('seen').notNull(),
});

export const gapEpisodes=sqliteTable('gap_episodes',{
  id:text('id').primaryKey(),
  routeId:text('route_id').notNull(),
  contractKey:text('contract_key'),
  entryCycle:integer('entry_cycle').notNull(),
  symbol:text('symbol').notNull(),
  buy:text('buy').notNull(),
  sell:text('sell').notNull(),
  openedAt:integer('opened_at').notNull(),
  lastSeen:integer('last_seen').notNull(),
  closedAt:integer('closed_at'),
  state:text('state').notNull(),
  entryGap:real('entry_gap').notNull(),
  latestGap:real('latest_gap').notNull(),
  entryAsk:real('entry_ask').notNull(),
  entryBid:real('entry_bid').notNull(),
  latestAsk:real('latest_ask').notNull(),
  latestBid:real('latest_bid').notNull(),
  budget:real('budget').notNull(),
  floor:real('floor').notNull(),
  maxImpact:real('max_impact').notNull(),
  status:text('status').notNull(),
  reason:text('reason'),
  profit:real('profit'),
  checkedAt:integer('checked_at'),
},t=>[
  uniqueIndex('gap_open_contract_route').on(t.routeId,t.contractKey).where(sql`${t.closedAt} IS NULL`),
  index('gap_recent').on(t.openedAt,t.id),
  index('gap_symbol_recent').on(t.symbol,t.openedAt,t.id),
  index('gap_expiry').on(t.lastSeen),
]);

export const venueSpikes=sqliteTable('venue_spikes',{
  id:text('id').primaryKey(),
  symbol:text('symbol').notNull(),
  venue:text('venue').notNull(),
  marketId:text('market_id').notNull(),
  side:text('side').notNull(),
  windowSec:integer('window_sec').notNull(),
  at:integer('at').notNull(),
  baselineAt:integer('baseline_at').notNull(),
  baselinePrice:real('baseline_price').notNull(),
  price:real('price').notNull(),
  changePct:real('change_pct').notNull(),
  thresholdPct:real('threshold_pct').notNull(),
  corroborated:integer('corroborated',{mode:'boolean'}).notNull(),
},t=>[
  index('spike_recent').on(t.at,t.id),
  index('spike_symbol_recent').on(t.symbol,t.at,t.id),
]);
