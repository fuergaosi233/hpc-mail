CREATE TABLE `claude_address_facts` (
	`address` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`paid` integer DEFAULT false NOT NULL,
	`suspended` integer DEFAULT false NOT NULL,
	`first_seen_at` integer NOT NULL,
	`suspended_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_claude_facts_domain` ON `claude_address_facts` (`domain`);--> statement-breakpoint
-- 一次性回填：口径与 src/services/claude-facts.ts 的 harvestSql 相同（含回收站，排除站内互投）
INSERT INTO claude_address_facts (address, domain, paid, suspended, first_seen_at, suspended_at)
  SELECT address, domain,
    MAX(subject LIKE 'Your receipt from Anthropic%' OR subject LIKE '%subscription is confirmed%'),
    MAX(subject LIKE 'Your account has been suspended%'),
    MIN(created_at),
    MIN(CASE WHEN subject LIKE 'Your account has been suspended%' THEN created_at END)
  FROM messages
  WHERE 1 = 1 AND direction = 'inbound' AND send_channel <> 'internal'
    AND (lower(from_address) LIKE '%@email.claude.com' OR lower(from_address) LIKE '%@mail.anthropic.com'
      OR lower(from_address) LIKE '%@research.anthropic.com' OR lower(from_address) LIKE '%anthropic-safeguards%')
  GROUP BY address
  HAVING MAX(subject LIKE 'Your account has been suspended%'
    OR subject LIKE 'Your receipt from Anthropic%' OR subject LIKE '%subscription is confirmed%'
    OR subject LIKE 'Welcome to Claude%' OR lower(from_address) LIKE '%@email.claude.com') = 1
  ON CONFLICT(address) DO NOTHING;
