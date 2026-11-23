CREATE TABLE `detections` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`buy` text NOT NULL,
	`sell` text NOT NULL,
	`gap` real NOT NULL,
	`seen` integer NOT NULL,
	`kind` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scan_state` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
