-- SimCare MySQL schema exported from the verified simcare database.

CREATE DATABASE IF NOT EXISTS `simcare` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE `simcare`;

SET FOREIGN_KEY_CHECKS=0;

CREATE TABLE IF NOT EXISTS `application_settings` (
  `id` bigint NOT NULL,
  `setting_key` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` json NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_application_settings_natural` (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `assignments` (
  `id` bigint NOT NULL,
  `title` varchar(160) COLLATE utf8mb4_unicode_ci NOT NULL,
  `case_id` bigint NOT NULL,
  `student_id` bigint NOT NULL,
  `teacher_id` bigint NOT NULL,
  `case_version` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `due_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `assignments_ibfk_1` (`case_id`),
  KEY `assignments_ibfk_2` (`student_id`),
  KEY `assignments_ibfk_3` (`teacher_id`),
  CONSTRAINT `assignments_ibfk_1` FOREIGN KEY (`case_id`) REFERENCES `cases` (`id`),
  CONSTRAINT `assignments_ibfk_2` FOREIGN KEY (`student_id`) REFERENCES `users` (`id`),
  CONSTRAINT `assignments_ibfk_3` FOREIGN KEY (`teacher_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `attempt_language` (
  `id` bigint NOT NULL,
  `attempt_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `language` varchar(8) COLLATE utf8mb4_unicode_ci NOT NULL,
  `case_version` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `case_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `english_package` json DEFAULT NULL,
  `provenance` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_attempt_language_natural` (`attempt_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `audit_events` (
  `id` bigint NOT NULL,
  `actor_id` bigint DEFAULT NULL,
  `action` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `target` varchar(160) COLLATE utf8mb4_unicode_ci NOT NULL,
  `detail` json NOT NULL,
  `created_at` datetime NOT NULL,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `audit_events_ibfk_1` (`actor_id`),
  CONSTRAINT `audit_events_ibfk_1` FOREIGN KEY (`actor_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `case_content` (
  `id` bigint NOT NULL,
  `engine_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `case_id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `revision` int NOT NULL DEFAULT '1',
  `registration` json NOT NULL,
  `facts` json NOT NULL,
  `reports` json NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_case_content_natural` (`engine_key`),
  KEY `ix_case_content_id` (`case_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `case_patients` (
  `id` bigint NOT NULL,
  `case_content_id` bigint NOT NULL,
  `name` varchar(160) NOT NULL,
  `sex` varchar(32) NOT NULL,
  `age` varchar(32) NOT NULL,
  `marital_status` varchar(64) DEFAULT NULL,
  `occupation` varchar(255) DEFAULT NULL,
  `ethnicity` varchar(160) DEFAULT NULL,
  `birthplace` varchar(255) DEFAULT NULL,
  `address` varchar(512) DEFAULT NULL,
  `history_source` varchar(255) DEFAULT NULL,
  `admission_status` varchar(255) DEFAULT NULL,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `case_content_id` (`case_content_id`),
  CONSTRAINT `fk_case_patient_content` FOREIGN KEY (`case_content_id`) REFERENCES `case_content` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `case_presentations` (
  `id` bigint NOT NULL,
  `case_content_id` bigint NOT NULL,
  `portal_case_id` int NOT NULL,
  `locale` varchar(8) NOT NULL,
  `service_url` varchar(255) NOT NULL,
  `ui_variant` varchar(32) NOT NULL,
  `title` varchar(160) NOT NULL,
  `subtitle` varchar(255) NOT NULL,
  `stage_names` json NOT NULL,
  `ui_stage_names` json NOT NULL,
  `scene_names` json NOT NULL,
  `note_titles` json NOT NULL,
  `stage_times` json NOT NULL,
  `intro_quote` text,
  `scene_image_path` varchar(512) NOT NULL,
  `intervention_image_path` varchar(512) DEFAULT NULL,
  `cover_image_path` varchar(512) NOT NULL,
  `options` json NOT NULL,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `case_content_id` (`case_content_id`),
  UNIQUE KEY `uq_case_presentation_portal_locale` (`portal_case_id`,`locale`),
  CONSTRAINT `fk_case_presentation_content` FOREIGN KEY (`case_content_id`) REFERENCES `case_content` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `cases` (
  `id` bigint NOT NULL,
  `title` varchar(160) COLLATE utf8mb4_unicode_ci NOT NULL,
  `version` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `engine_key` varchar(48) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payload` json NOT NULL,
  `created_by` bigint NOT NULL,
  `created_at` datetime NOT NULL,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `cases_ibfk_1` (`created_by`),
  CONSTRAINT `cases_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `engine_attempt_links` (
  `id` bigint NOT NULL,
  `engine_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `student_task` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `session_id` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_engine_attempt_links_natural` (`engine_key`,`student_task`),
  KEY `ix_engine_attempt_session` (`engine_key`,`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `engine_imports` (
  `id` bigint NOT NULL,
  `engine_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `imported_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_engine_imports_natural` (`engine_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `engine_sessions` (
  `id` bigint NOT NULL,
  `engine_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `session_id` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `state` json NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_engine_sessions_natural` (`engine_key`,`session_id`),
  KEY `ix_engine_sessions_updated` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `knowledge_items` (
  `id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` bigint NOT NULL,
  `attempt_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `content` json NOT NULL,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `item_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_knowledge_items_item_key` (`item_key`),
  KEY `ix_knowledge_items_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `language_unification` (
  `id` bigint NOT NULL,
  `attempt_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `engine_id` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `engine_url` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_language_unification_natural` (`attempt_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `portal_attempts` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` bigint NOT NULL,
  `task_key` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `case_id` int NOT NULL,
  `engine_id` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `state` json NOT NULL,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_portal_attempts_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `portal_documents` (
  `id` bigint NOT NULL,
  `revision` int NOT NULL,
  `data` json NOT NULL,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `training_sessions` (
  `id` bigint NOT NULL,
  `assignment_id` bigint NOT NULL,
  `student_id` bigint NOT NULL,
  `stage` int NOT NULL,
  `engine_session_id` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `state` json NOT NULL,
  `updated_at` datetime NOT NULL,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_assignment_student` (`assignment_id`,`student_id`),
  KEY `training_sessions_ibfk_2` (`student_id`),
  CONSTRAINT `training_sessions_ibfk_1` FOREIGN KEY (`assignment_id`) REFERENCES `assignments` (`id`),
  CONSTRAINT `training_sessions_ibfk_2` FOREIGN KEY (`student_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `users` (
  `id` bigint NOT NULL,
  `username` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `display_name` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_hash` varchar(256) COLLATE utf8mb4_unicode_ci NOT NULL,
  `role` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `requested_role` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `profile` json NOT NULL,
  `status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime NOT NULL,
  `create_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `update_time` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ix_users_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS=1;
