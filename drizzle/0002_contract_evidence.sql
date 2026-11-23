DROP INDEX `gap_open_route`;--> statement-breakpoint
ALTER TABLE `gap_episodes` ADD `contract_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `gap_open_contract_route` ON `gap_episodes` (`route_id`,`contract_key`) WHERE "gap_episodes"."closed_at" IS NULL;--> statement-breakpoint
ALTER TABLE `detections` ADD `contract_key` text;