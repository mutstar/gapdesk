CREATE TABLE `gap_episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`route_id` text NOT NULL,
	`entry_cycle` integer NOT NULL,
	`symbol` text NOT NULL,
	`buy` text NOT NULL,
	`sell` text NOT NULL,
	`opened_at` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`closed_at` integer,
	`state` text NOT NULL,
	`entry_gap` real NOT NULL,
	`latest_gap` real NOT NULL,
	`entry_ask` real NOT NULL,
	`entry_bid` real NOT NULL,
	`latest_ask` real NOT NULL,
	`latest_bid` real NOT NULL,
	`budget` real NOT NULL,
	`floor` real NOT NULL,
	`max_impact` real NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`profit` real,
	`checked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gap_open_route` ON `gap_episodes` (`route_id`) WHERE "gap_episodes"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `gap_recent` ON `gap_episodes` (`opened_at`,`id`);--> statement-breakpoint
CREATE INDEX `gap_symbol_recent` ON `gap_episodes` (`symbol`,`opened_at`,`id`);--> statement-breakpoint
CREATE INDEX `gap_expiry` ON `gap_episodes` (`last_seen`);--> statement-breakpoint
CREATE TABLE `signal_stream` (
	`id` integer PRIMARY KEY NOT NULL,
	`cycle` integer NOT NULL,
	`seen` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `venue_spikes` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`venue` text NOT NULL,
	`market_id` text NOT NULL,
	`side` text NOT NULL,
	`window_sec` integer NOT NULL,
	`at` integer NOT NULL,
	`baseline_at` integer NOT NULL,
	`baseline_price` real NOT NULL,
	`price` real NOT NULL,
	`change_pct` real NOT NULL,
	`threshold_pct` real NOT NULL,
	`corroborated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `spike_recent` ON `venue_spikes` (`at`,`id`);--> statement-breakpoint
CREATE INDEX `spike_symbol_recent` ON `venue_spikes` (`symbol`,`at`,`id`);