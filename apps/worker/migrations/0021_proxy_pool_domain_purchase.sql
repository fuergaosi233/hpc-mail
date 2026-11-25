CREATE TABLE `address_proxy_bindings` (
	`address` text PRIMARY KEY NOT NULL,
	`proxy_id` integer NOT NULL,
	`domain` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`bound_by` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_address_proxy_bindings_proxy` ON `address_proxy_bindings` (`proxy_id`);--> statement-breakpoint
CREATE INDEX `idx_address_proxy_bindings_domain` ON `address_proxy_bindings` (`domain`,`address`);--> statement-breakpoint
CREATE TABLE `domain_purchase_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text DEFAULT 'quoted' NOT NULL,
	`years` integer DEFAULT 1 NOT NULL,
	`auto_renew` integer DEFAULT false NOT NULL,
	`privacy_level` text DEFAULT 'high' NOT NULL,
	`quote_total_cents` integer DEFAULT 0 NOT NULL,
	`confirmed_total_cents` integer DEFAULT 0 NOT NULL,
	`quote_expires_at` integer NOT NULL,
	`lease_until` integer,
	`last_error` text DEFAULT '' NOT NULL,
	`created_by` integer NOT NULL,
	`confirmed_by` integer,
	`confirmed_at` integer,
	`completed_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_domain_purchase_batches_status` ON `domain_purchase_batches` (`status`,`id`);--> statement-breakpoint
CREATE TABLE `domain_purchase_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`domain` text NOT NULL,
	`status` text DEFAULT 'quoted' NOT NULL,
	`availability` text DEFAULT '' NOT NULL,
	`skip_reason` text DEFAULT '' NOT NULL,
	`price_class` text DEFAULT '' NOT NULL,
	`final_cents` integer,
	`regular_cents` integer,
	`cap_basis_cents` integer,
	`operation_id` text,
	`op_status` text DEFAULT '' NOT NULL,
	`cf_zone_id` text,
	`name_servers` text DEFAULT '[]' NOT NULL,
	`zone_status` text DEFAULT '' NOT NULL,
	`routing_status` text DEFAULT '' NOT NULL,
	`lifecycle_status` text DEFAULT '' NOT NULL,
	`verification_status` text DEFAULT '' NOT NULL,
	`suspensions` text DEFAULT '[]' NOT NULL,
	`failed_step` text DEFAULT '' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`error_code` text DEFAULT '' NOT NULL,
	`vendor_operation_id` text DEFAULT '' NOT NULL,
	`step_attempts` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`next_check_at` integer,
	`zone_create_attempted_at` integer,
	`register_attempted_at` integer,
	`registered_at` integer,
	`ns_set_at` integer,
	`ready_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_domain_purchase_items_batch` ON `domain_purchase_items` (`batch_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_domain_purchase_items_status` ON `domain_purchase_items` (`status`,`next_check_at`);--> statement-breakpoint
CREATE INDEX `idx_domain_purchase_items_domain` ON `domain_purchase_items` (`domain`);--> statement-breakpoint
CREATE TABLE `integration_status` (
	`provider` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'unknown' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`balance_cents` integer,
	`checked_at` integer
);
--> statement-breakpoint
CREATE TABLE `proxies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`provider` text DEFAULT 'manual' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`protocol` text DEFAULT 'http' NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`username` text DEFAULT '' NOT NULL,
	`password_enc` text DEFAULT '' NOT NULL,
	`product` text DEFAULT '' NOT NULL,
	`country` text DEFAULT '' NOT NULL,
	`region` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`provider_ref` text,
	`order_id` integer,
	`expires_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`max_bindings` integer DEFAULT 1 NOT NULL,
	`health_status` text DEFAULT 'unknown' NOT NULL,
	`health_checked_at` integer,
	`health_latency_ms` integer,
	`health_error` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_by` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_proxies_endpoint` ON `proxies` (`host`,`port`,`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_proxies_provider_ref` ON `proxies` (`provider`,`provider_ref`);--> statement-breakpoint
CREATE INDEX `idx_proxies_status` ON `proxies` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_proxies_order` ON `proxies` (`order_id`);--> statement-breakpoint
CREATE INDEX `idx_proxies_expires` ON `proxies` (`expires_at`);--> statement-breakpoint
CREATE TABLE `proxy_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text DEFAULT 'quoted' NOT NULL,
	`product` text NOT NULL,
	`sku` text DEFAULT '' NOT NULL,
	`quantity` integer NOT NULL,
	`order_spec` text DEFAULT '' NOT NULL,
	`estimate_cents` integer NOT NULL,
	`cap_basis_cents` integer NOT NULL,
	`actual_cents` integer,
	`balance_cents_at_quote` integer,
	`quote_expires_at` integer NOT NULL,
	`order_no` text,
	`checkout_url_enc` text DEFAULT '' NOT NULL,
	`lease_until` integer,
	`last_error` text DEFAULT '' NOT NULL,
	`materialized_count` integer DEFAULT 0 NOT NULL,
	`created_by` integer NOT NULL,
	`confirmed_by` integer,
	`confirmed_at` integer,
	`ordered_at` integer,
	`paid_at` integer,
	`checked_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_proxy_orders_order_no` ON `proxy_orders` (`order_no`);--> statement-breakpoint
CREATE INDEX `idx_proxy_orders_status` ON `proxy_orders` (`status`,`checked_at`);--> statement-breakpoint
CREATE INDEX `idx_proxy_orders_confirmed` ON `proxy_orders` (`confirmed_at`);