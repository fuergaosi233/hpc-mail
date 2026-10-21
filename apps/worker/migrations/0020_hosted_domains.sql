CREATE TABLE `hosted_domain_members` (
	`domain_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`granted_by` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`domain_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_domain_members_user` ON `hosted_domain_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `hosted_domains` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain` text NOT NULL,
	`user_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`zone_id` text,
	`name_servers` text DEFAULT '[]' NOT NULL,
	`original_name_servers` text DEFAULT '[]' NOT NULL,
	`original_registrar` text DEFAULT '' NOT NULL,
	`zone_status` text DEFAULT '' NOT NULL,
	`routing_status` text DEFAULT '' NOT NULL,
	`catch_all_ready` integer DEFAULT false NOT NULL,
	`sending_status` text DEFAULT '' NOT NULL,
	`sending_tag` text,
	`dnssec` integer DEFAULT false NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`member_limit` integer DEFAULT 0 NOT NULL,
	`checked_at` integer,
	`activated_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hosted_domains_domain_unique` ON `hosted_domains` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_hosted_domains_user` ON `hosted_domains` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_hosted_domains_status` ON `hosted_domains` (`status`,`checked_at`);