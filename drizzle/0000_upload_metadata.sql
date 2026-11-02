CREATE TABLE `sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `photos` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`),
  `status` text NOT NULL,
  `created_at` integer NOT NULL,
  `message_id` integer
);
--> statement-breakpoint
CREATE INDEX `photos_session_status_idx` ON `photos` (`session_id`, `status`);
--> statement-breakpoint
CREATE INDEX `photos_status_created_idx` ON `photos` (`status`, `created_at`);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
  `key` text PRIMARY KEY NOT NULL,
  `count` integer NOT NULL,
  `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_limits_expires_idx` ON `rate_limits` (`expires_at`);
