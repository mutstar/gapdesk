import {sqliteTable,text,integer,real} from 'drizzle-orm/sqlite-core';
export const scanState=sqliteTable('scan_state',{id:text('id').primaryKey(),value:text('value').notNull()});
export const detections=sqliteTable('detections',{id:text('id').primaryKey(),symbol:text('symbol').notNull(),buy:text('buy').notNull(),sell:text('sell').notNull(),gap:real('gap').notNull(),seen:integer('seen').notNull(),kind:text('kind').notNull()});
