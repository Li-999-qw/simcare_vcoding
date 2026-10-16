-- Run against simcare. IDs are assigned by the application (Snowflake), not AUTO_INCREMENT.
CREATE TABLE IF NOT EXISTS `user_login_sessions` (
  `id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `session_token_hash` VARCHAR(64) NOT NULL,
  `login_time` DATETIME NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `create_time` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_login_sessions_user_id` (`user_id`),
  CONSTRAINT `fk_user_login_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
