-- MySQL dump 10.13  Distrib 8.0.36, for Win64 (x86_64)
--
-- Host: localhost    Database: beamos
-- ------------------------------------------------------
-- Server version	8.0.36

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!50014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!50014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `activity_log`
--

DROP TABLE IF EXISTS `activity_log`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `activity_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` varchar(64) DEFAULT NULL,
  `device_id` varchar(64) DEFAULT NULL,
  `workspace_id` varchar(64) DEFAULT NULL,
  `organization_id` varchar(64) DEFAULT NULL,
  `acting_user_id` varchar(64) DEFAULT NULL,
  `was_acting_as` tinyint(1) DEFAULT '0',
  `action` varchar(255) NOT NULL,
  `details` text,
  `ip_address` varchar(45) DEFAULT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `workspace_id` (`workspace_id`),
  KEY `organization_id` (`organization_id`),
  KEY `acting_user_id` (`acting_user_id`),
  KEY `idx_activity_log_time` (`created_at` DESC),
  KEY `idx_activity_log_user` (`user_id`,`created_at` DESC),
  CONSTRAINT `activity_log_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `activity_log_ibfk_2` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE SET NULL,
  CONSTRAINT `activity_log_ibfk_3` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE SET NULL,
  CONSTRAINT `activity_log_ibfk_4` FOREIGN KEY (`acting_user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `activity_log`
--

LOCK TABLES `activity_log` WRITE;
/*!40000 ALTER TABLE `activity_log` DISABLE KEYS */;
/*!40000 ALTER TABLE `activity_log` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `agency_notifications`
--

DROP TABLE IF EXISTS `agency_notifications`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `agency_notifications` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` varchar(64) NOT NULL,
  `token_id` varchar(64) NOT NULL,
  `playlist_id` varchar(64) NOT NULL,
  `action` varchar(50) NOT NULL,
  `content_id` varchar(64) DEFAULT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `sent_at` bigint DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_agency_notifications_unsent` (`sent_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `agency_notifications`
--

LOCK TABLES `agency_notifications` WRITE;
/*!40000 ALTER TABLE `agency_notifications` DISABLE KEYS */;
/*!40000 ALTER TABLE `agency_notifications` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `ai_settings`
--

DROP TABLE IF EXISTS `ai_settings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ai_settings` (
  `workspace_id` varchar(64) NOT NULL,
  `base_url` varchar(500) DEFAULT NULL,
  `api_key_enc` text,
  `model` varchar(255) DEFAULT NULL,
  `image_base_url` varchar(500) DEFAULT NULL,
  `image_model` varchar(255) DEFAULT NULL,
  `image_provider` varchar(50) DEFAULT NULL,
  `image_api_key_enc` text,
  `updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`workspace_id`),
  CONSTRAINT `ai_settings_ibfk_1` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `ai_settings`
--

LOCK TABLES `ai_settings` WRITE;
/*!40000 ALTER TABLE `ai_settings` DISABLE KEYS */;
/*!40000 ALTER TABLE `ai_settings` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `alert_configs`
--

DROP TABLE IF EXISTS `alert_configs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `alert_configs` (
  `id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `workspace_id` varchar(64) DEFAULT NULL,
  `alert_type` varchar(50) NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `config` text NOT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `workspace_id` (`workspace_id`),
  CONSTRAINT `alert_configs_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `alert_configs_ibfk_2` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `alert_configs`
--

LOCK TABLES `alert_configs` WRITE;
/*!40000 ALTER TABLE `alert_configs` DISABLE KEYS */;
/*!40000 ALTER TABLE `alert_configs` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `api_token_targets`
--

DROP TABLE IF EXISTS `api_token_targets`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `api_token_targets` (
  `token_id` varchar(64) NOT NULL,
  `playlist_id` varchar(64) NOT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`token_id`,`playlist_id`),
  KEY `playlist_id` (`playlist_id`),
  CONSTRAINT `api_token_targets_ibfk_1` FOREIGN KEY (`token_id`) REFERENCES `api_tokens` (`id`) ON DELETE CASCADE,
  CONSTRAINT `api_token_targets_ibfk_2` FOREIGN KEY (`playlist_id`) REFERENCES `playlists` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `api_token_targets`
--

LOCK TABLES `api_token_targets` WRITE;
/*!40000 ALTER TABLE `api_token_targets` DISABLE KEYS */;
/*!40000 ALTER TABLE `api_token_targets` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `api_tokens`
--

DROP TABLE IF EXISTS `api_tokens`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `api_tokens` (
  `id` varchar(64) NOT NULL,
  `token_hash` varchar(64) NOT NULL,
  `prefix` varchar(50) NOT NULL,
  `name` varchar(255) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `workspace_id` varchar(64) NOT NULL,
  `scope` varchar(50) NOT NULL DEFAULT 'read',
  `auto_publish` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `last_used_at` bigint DEFAULT NULL,
  `revoked_at` bigint DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `token_hash` (`token_hash`),
  KEY `workspace_id` (`workspace_id`),
  KEY `idx_api_tokens_hash` (`token_hash`),
  KEY `idx_api_tokens_user` (`user_id`),
  CONSTRAINT `api_tokens_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `api_tokens_ibfk_2` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `api_tokens`
--

LOCK TABLES `api_tokens` WRITE;
/*!40000 ALTER TABLE `api_tokens` DISABLE KEYS */;
/*!40000 ALTER TABLE `api_tokens` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `app_settings`
--

DROP TABLE IF EXISTS `app_settings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `app_settings` (
  `key` varchar(255) NOT NULL,
  `value` text NOT NULL,
  `updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `app_settings`
--

LOCK TABLES `app_settings` WRITE;
/*!40000 ALTER TABLE `app_settings` DISABLE KEYS */;
/*!40000 ALTER TABLE `app_settings` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `assignments`
--

DROP TABLE IF EXISTS `assignments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `assignments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `device_id` varchar(64) NOT NULL,
  `content_id` varchar(64) DEFAULT NULL,
  `widget_id` varchar(64) DEFAULT NULL,
  `zone_id` varchar(64) DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `duration_sec` int NOT NULL DEFAULT '10',
  `schedule_start` varchar(20) DEFAULT NULL,
  `schedule_end` varchar(20) DEFAULT NULL,
  `schedule_days` varchar(50) DEFAULT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `muted` tinyint(1) DEFAULT '0',
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `device_id` (`device_id`),
  KEY `content_id` (`content_id`),
  KEY `widget_id` (`widget_id`),
  CONSTRAINT `assignments_ibfk_1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `assignments_ibfk_2` FOREIGN KEY (`content_id`) REFERENCES `content` (`id`) ON DELETE CASCADE,
  CONSTRAINT `assignments_ibfk_3` FOREIGN KEY (`widget_id`) REFERENCES `widgets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `assignments`
--

LOCK TABLES `assignments` WRITE;
/*!40000 ALTER TABLE `assignments` DISABLE KEYS */;
/*!40000 ALTER TABLE `assignments` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `content`
--

DROP TABLE IF EXISTS `content`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `content` (
  `id` varchar(64) NOT NULL,
  `user_id` varchar(64) DEFAULT NULL,
  `workspace_id` varchar(64) DEFAULT NULL,
  `team_id` varchar(64) DEFAULT NULL,
  `filename` varchar(500) NOT NULL,
  `filepath` varchar(500) NOT NULL DEFAULT '',
  `mime_type` varchar(100) NOT NULL,
  `file_size` bigint NOT NULL DEFAULT '0',
  `duration_sec` double DEFAULT NULL,
  `thumbnail_path` varchar(500) DEFAULT NULL,
  `width` int DEFAULT NULL,
  `height` int DEFAULT NULL,
  `remote_url` varchar(1000) DEFAULT NULL,
  `folder` varchar(255) DEFAULT NULL,
  `folder_id` varchar(64) DEFAULT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `idx_content_workspace` (`workspace_id`),
  KEY `idx_content_folder` (`folder_id`),
  CONSTRAINT `content_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `content_ibfk_2` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `content_ibfk_3` FOREIGN KEY (`folder_id`) REFERENCES `content_folders` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `content`
--

LOCK TABLES `content` WRITE;
/*!40000 ALTER TABLE `content` DISABLE KEYS */;
/*!40000 ALTER TABLE `content` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `content_folders`
--

DROP TABLE IF EXISTS `content_folders`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `content_folders` (
  `id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `workspace_id` varchar(64) DEFAULT NULL,
  `parent_id` varchar(64) DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `parent_id` (`parent_id`),
  KEY `idx_content_folders_user` (`user_id`,`parent_id`),
  KEY `idx_content_folders_workspace` (`workspace_id`),
  CONSTRAINT `content_folders_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `content_folders_ibfk_2` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `content_folders_ibfk_3` FOREIGN KEY (`parent_id`) REFERENCES `content_folders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `content_folders`
--

LOCK TABLES `content_folders` WRITE;
/*!40000 ALTER TABLE `content_folders` DISABLE KEYS */;
/*!40000 ALTER TABLE `content_folders` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `device_fingerprints`
--

DROP TABLE IF EXISTS `device_fingerprints`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `device_fingerprints` (
  `fingerprint` varchar(255) NOT NULL,
  `device_id` varchar(64) DEFAULT NULL,
  `user_id` varchar(64) DEFAULT NULL,
  `first_seen` bigint NOT NULL DEFAULT (unix_timestamp()),
  `last_seen` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`fingerprint`),
  KEY `device_id` (`device_id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `device_fingerprints_ibfk_1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE SET NULL,
  CONSTRAINT `device_fingerprints_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `device_fingerprints`
--

LOCK TABLES `device_fingerprints` WRITE;
/*!40000 ALTER TABLE `device_fingerprints` DISABLE KEYS */;
/*!40000 ALTER TABLE `device_fingerprints` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `device_group_members`
--

DROP TABLE IF EXISTS `device_group_members`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `device_group_members` (
  `device_id` varchar(64) NOT NULL,
  `group_id` varchar(64) NOT NULL,
  PRIMARY KEY (`device_id`,`group_id`),
  KEY `group_id` (`group_id`),
  CONSTRAINT `device_group_members_ibfk_1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `device_group_members_ibfk_2` FOREIGN KEY (`group_id`) REFERENCES `device_groups` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `device_group_members`
--

LOCK TABLES `device_group_members` WRITE;
/*!40000 ALTER TABLE `device_group_members` DISABLE KEYS */;
/*!40000 ALTER TABLE `device_group_members` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `device_groups`
--

DROP TABLE IF EXISTS `device_groups`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `device_groups` (
  `id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `workspace_id` varchar(64) DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `color` varchar(20) DEFAULT '#3B82F6',
  `playlist_id` varchar(64) DEFAULT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `playlist_id` (`playlist_id`),
  KEY `idx_device_groups_workspace` (`workspace_id`),
  CONSTRAINT `device_groups_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `device_groups_ibfk_2` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `device_groups_ibfk_3` FOREIGN KEY (`playlist_id`) REFERENCES `playlists` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `device_groups`
--

LOCK TABLES `device_groups` WRITE;
/*!40000 ALTER TABLE `device_groups` DISABLE KEYS */;
/*!40000 ALTER TABLE `device_groups` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `device_status_log`
--

DROP TABLE IF EXISTS `device_status_log`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `device_status_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `device_id` varchar(64) NOT NULL,
  `status` varchar(50) NOT NULL,
  `timestamp` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_device_status_log_device_ts` (`device_id`,`timestamp`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `device_status_log`
--

LOCK TABLES `device_status_log` WRITE;
/*!40000 ALTER TABLE `device_status_log` DISABLE KEYS */;
/*!40000 ALTER TABLE `device_status_log` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `device_telemetry`
--

DROP TABLE IF EXISTS `device_telemetry`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `device_telemetry` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `device_id` varchar(64) NOT NULL,
  `battery_level` int DEFAULT NULL,
  `battery_charging` tinyint(1) NOT NULL DEFAULT '0',
  `storage_free_mb` int DEFAULT NULL,
  `storage_total_mb` int DEFAULT NULL,
  `ram_free_mb` int DEFAULT NULL,
  `ram_total_mb` int DEFAULT NULL,
  `cpu_usage` double DEFAULT NULL,
  `wifi_ssid` varchar(255) DEFAULT NULL,
  `wifi_rssi` int DEFAULT NULL,
  `uptime_seconds` bigint DEFAULT NULL,
  `reported_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_telemetry_device` (`device_id`,`reported_at` DESC),
  CONSTRAINT `device_telemetry_ibfk_1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `device_telemetry`
--

LOCK TABLES `device_telemetry` WRITE;
/*!40000 ALTER TABLE `device_telemetry` DISABLE KEYS */;
/*!40000 ALTER TABLE `device_telemetry` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `device_usage_daily`
--

DROP TABLE IF EXISTS `device_usage_daily`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `device_usage_daily` (
  `device_id` varchar(64) NOT NULL,
  `day` varchar(10) NOT NULL,
  `online_seconds` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`device_id`,`day`),
  KEY `idx_usage_daily_day` (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `device_usage_daily`
--

LOCK TABLES `device_usage_daily` WRITE;
/*!40000 ALTER TABLE `device_usage_daily` DISABLE KEYS */;
/*!40000 ALTER TABLE `device_usage_daily` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `devices`
--

DROP TABLE IF EXISTS `devices`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `devices` (
  `id` varchar(64) NOT NULL,
  `user_id` varchar(64) DEFAULT NULL,
  `workspace_id` varchar(64) DEFAULT NULL,
  `name` varchar(255) NOT NULL DEFAULT 'Unnamed Display',
  `pairing_code` varchar(50) DEFAULT NULL,
  `status` varchar(50) NOT NULL DEFAULT 'offline',
  `blocked` tinyint(1) NOT NULL DEFAULT '0',
  `last_heartbeat` bigint DEFAULT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `android_version` varchar(50) DEFAULT NULL,
  `app_version` varchar(50) DEFAULT NULL,
  `screen_width` int DEFAULT NULL,
  `screen_height` int DEFAULT NULL,
  `render_width` int DEFAULT NULL,
  `render_height` int DEFAULT NULL,
  `playlist_id` varchar(64) DEFAULT NULL,
  `layout_id` varchar(64) DEFAULT NULL,
  `timezone` varchar(100) DEFAULT 'UTC',
  `reported_timezone` varchar(100) DEFAULT NULL,
  `reported_utc` bigint DEFAULT NULL,
  `reported_at` bigint DEFAULT NULL,
  `wall_id` varchar(64) DEFAULT NULL,
  `team_id` varchar(64) DEFAULT NULL,
  `notes` text,
  `orientation` varchar(50) DEFAULT 'landscape',
  `default_content_id` varchar(64) DEFAULT NULL,
  `device_token` varchar(255) DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `ota_status` varchar(50) DEFAULT 'none',
  `ota_target_version` varchar(100) DEFAULT NULL,
  `ota_attempts` int DEFAULT '0',
  `ota_updated_at` bigint DEFAULT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `pairing_code` (`pairing_code`),
  KEY `user_id` (`user_id`),
  KEY `playlist_id` (`playlist_id`),
  KEY `idx_devices_workspace` (`workspace_id`),
  KEY `idx_devices_provisioning` (`status`,`created_at`),
  CONSTRAINT `devices_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `devices_ibfk_2` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `devices_ibfk_3` FOREIGN KEY (`playlist_id`) REFERENCES `playlists` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `devices`
--

LOCK TABLES `devices` WRITE;
/*!40000 ALTER TABLE `devices` DISABLE KEYS */;
/*!40000 ALTER TABLE `devices` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `event_loop_lag`
--

DROP TABLE IF EXISTS `event_loop_lag`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `event_loop_lag` (
  `id` int NOT NULL AUTO_INCREMENT,
  `sampled_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `mean_ms` double NOT NULL,
  `p50_ms` double NOT NULL,
  `p99_ms` double NOT NULL,
  `max_ms` double NOT NULL,
  `band` varchar(50) NOT NULL DEFAULT 'normal',
  PRIMARY KEY (`id`),
  KEY `idx_event_loop_lag_sampled` (`sampled_at`)
) ENGINE=InnoDB AUTO_INCREMENT=2478 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `event_loop_lag`
--

LOCK TABLES `event_loop_lag` WRITE;
/*!40000 ALTER TABLE `event_loop_lag` DISABLE KEYS */;
INSERT INTO `event_loop_lag` VALUES (1,1784614908,31.14,31.05,33.21,33.21,'normal'),(2,1784614909,31.24,31.39,32.37,32.37,'normal'),(3,1784614910,31.15,31.16,36.27,36.27,'normal'),(4,1784614911,35.23,31.36,137.63,137.63,'elevated'),(5,1784614912,31.2,31.13,33.03,33.03,'elevated'),(6,1784614913,34.09,31.2,117.96,117.96,'elevated'),(7,1784614914,31.15,31.24,36.21,36.21,'elevated'),(8,1784614915,34.53,30.74,85.2,85.2,'elevated'),(9,1784614916,30.58,31,36.31,36.31,'elevated'),(10,1784614917,30.77,31.18,33.13,33.13,'elevated'),(11,1784614918,31.22,31.26,32.72,32.72,'elevated'),(12,1784614919,31.12,31.05,34.11,34.11,'elevated'),(13,1784614920,31.17,31.29,33.24,33.24,'normal'),(14,1784614921,31.21,31.26,33.05,33.05,'normal'),(15,1784614922,31.31,31.15,36.44,36.44,'normal'),(16,1784614923,30.97,31.06,33.28,33.28,'normal'),(17,1784614924,37.99,31.33,131.66,131.66,'elevated'),(18,1784614925,31.01,31.15,32.77,32.77,'elevated'),(19,1784614926,31.3,31.31,34.87,34.87,'elevated'),(20,1784614927,30.61,31.1,36.24,36.24,'elevated'),(21,1784614928,31.11,31,34.21,34.21,'elevated'),(22,1784614930,31.15,31.28,35.29,35.29,'normal'),(23,1784614931,31.28,31.24,33.11,33.11,'normal'),(24,1784614932,31.27,31.51,36.01,36.01,'normal'),(25,1784614933,31.19,31.34,33.88,33.88,'normal'),(26,1784614934,31.14,31.28,34.5,34.5,'normal'),(27,1784614935,38.56,31.23,157.81,157.81,'elevated'),(28,1784614936,30.87,30.85,32.82,32.82,'elevated'),(29,1784614937,31.01,31.03,32.54,32.54,'elevated'),(30,1784614938,43.12,31.6,120.98,120.98,'elevated'),(31,1784614939,31.25,31.31,41.48,41.48,'elevated'),(32,1784614940,31.57,30.85,54.49,54.49,'elevated'),(33,1784614941,31.05,31.29,32.11,32.11,'elevated'),(34,1784614942,41.07,31.65,195.43,195.43,'elevated'),(35,1784614943,32.18,31.18,54.69,54.69,'elevated'),(36,1784614944,31.15,31.13,33.98,33.98,'elevated'),(37,1784614945,33.21,30.85,100.79,100.79,'elevated'),(38,1784614946,36.05,31.36,128.06,128.06,'elevated'),(39,1784614947,31.13,31.01,33.78,33.78,'elevated'),(40,1784614948,31.27,31.38,35.36,35.36,'elevated'),(41,1784614949,31.1,31.33,34.28,34.28,'elevated'),(42,1784614950,34.57,31.16,89.13,89.13,'elevated'),(43,1784614951,31.01,31.11,38.11,38.11,'elevated'),(44,1784614952,37.76,31.08,204.08,204.08,'elevated'),(45,1784614953,31.63,31.06,58.2,58.2,'elevated'),(46,1784614954,31.13,31.11,34.34,34.34,'elevated'),(47,1784614955,31.08,31.2,33.62,33.62,'elevated'),(48,1784614956,31.13,31.31,36.01,36.01,'elevated'),(49,1784614957,30.99,31,35.62,35.62,'elevated'),(50,1784614958,30.1,30.85,35.95,35.95,'normal'),(51,1784614959,31.13,31.11,34.18,34.18,'normal'),(52,1784614960,31.25,31.29,32.64,32.64,'normal'),(53,1784614961,35.13,30.9,152.83,152.83,'elevated'),(54,1784614962,32.49,31.05,71.96,71.96,'elevated'),(55,1784614963,31.06,31.2,32.15,32.15,'elevated'),(56,1784614964,31.15,31.16,32.28,32.28,'elevated'),(57,1784614965,31.28,31.34,32.47,32.47,'elevated'),(58,1784614966,33.81,31.59,70.84,70.84,'elevated'),(59,1784614967,35.72,31.15,162.14,162.14,'elevated'),(60,1784614968,30.68,31,40.21,40.21,'elevated'),(61,1784614969,32.12,31.33,68.03,68.03,'elevated'),(62,1784614970,32.28,31.24,62.29,62.29,'elevated'),(63,1784614971,46.79,31.34,222.56,222.56,'elevated'),(64,1784614972,34.7,31.28,134.48,134.48,'elevated'),(65,1784614973,62.14,31.49,154.27,154.27,'elevated'),(66,1784614974,49.26,31.26,235.27,235.27,'elevated'),(67,1784614975,31.22,31.18,34.44,34.44,'elevated'),(68,1784614976,31.18,31.11,33.82,33.82,'elevated'),(69,1784614977,31.18,31.26,34.01,34.01,'elevated'),(70,1784614978,31.98,30.83,59.41,59.41,'elevated'),(71,1784614979,31.14,31.15,32.83,32.83,'elevated'),(72,1784614980,30.99,31.01,33.29,33.29,'elevated'),(73,1784614981,31.13,31.15,32.93,32.93,'elevated'),(74,1784614982,31.16,31.03,33.44,33.44,'elevated'),(75,1784614983,31.19,31,35.91,35.91,'normal'),(76,1784614984,31.03,31,37.58,37.58,'normal'),(77,1784614985,33.72,31.74,67.31,67.31,'normal'),(78,1784614986,32.25,31.13,66.49,66.49,'normal'),(79,1784614987,38.57,31.36,217.32,217.32,'elevated'),(80,1784614988,30.69,31.21,33.01,33.01,'elevated'),(81,1784614989,31.33,31.36,35.78,35.78,'elevated'),(82,1784614990,32.56,31.44,61.96,61.96,'elevated'),(83,1784614991,38.91,31.57,187.56,187.56,'elevated'),(84,1784614992,31.07,31.18,33.08,33.08,'elevated'),(85,1784614993,31.05,30.9,33.19,33.19,'elevated'),(86,1784614994,31.03,30.97,32.8,32.8,'elevated'),(87,1784614995,31.17,31.28,37.09,37.09,'elevated'),(88,1784614996,31.07,31.03,34.05,34.05,'normal'),(89,1784614997,34.06,31.13,117.31,117.31,'elevated'),(90,1784614998,31.13,31.31,39.68,39.68,'elevated'),(91,1784614999,33.29,31.11,103.94,103.94,'elevated'),(92,1784615000,52.52,31.83,457.97,457.97,'critical'),(93,1784615001,30.24,31,35.39,35.39,'critical'),(94,1784615002,29.96,30.8,39.68,39.68,'critical'),(95,1784615003,30.99,30.8,37.42,37.42,'critical'),(96,1784615004,31.07,30.9,34.24,34.24,'critical'),(97,1784615005,31.12,31.15,34.08,34.08,'elevated'),(98,1784615006,31.3,31.13,35.68,35.68,'elevated'),(99,1784615007,33.83,30.9,140.64,140.64,'elevated'),(100,1784615008,31.25,31.36,33.05,33.05,'elevated'),(101,1784615009,31.26,31.21,32.67,32.67,'elevated'),(102,1784615010,31.23,31.34,32.08,32.08,'elevated'),(103,1784615011,31.27,31.29,32.18,32.18,'elevated'),(104,1784615013,31.07,30.98,32.93,32.93,'normal'),(105,1784615014,31.08,31,31.97,31.97,'normal'),(106,1784615015,31.21,31.18,32.93,32.93,'normal'),(107,1784615016,31.14,31.2,37.78,37.78,'normal'),(108,1784615017,31.73,31.33,56.66,56.66,'normal'),(109,1784615018,30.45,31.01,32.77,32.77,'normal'),(110,1784615019,31.13,31.05,36.21,36.21,'normal'),(111,1784615020,31.17,31.23,32.47,32.47,'normal'),(112,1784615021,31.17,31.24,33.24,33.24,'normal'),(113,1784615022,31.04,30.93,33.36,33.36,'normal'),(114,1784615023,33.79,31.52,118.16,118.16,'elevated'),(115,1784615024,31.15,31.2,32.31,32.31,'elevated'),(116,1784615025,32.55,30.92,59.7,59.7,'elevated'),(117,1784615026,31.29,31.24,35.06,35.06,'elevated'),(118,1784615027,31.13,31.13,36.83,36.83,'elevated'),(119,1784615028,33.29,31.05,108.92,108.92,'elevated'),(120,1784615029,31.22,31.15,41.39,41.39,'elevated'),(121,1784615030,31.07,31.1,32.34,32.34,'elevated'),(122,1784615031,31.13,31.15,33.33,33.33,'elevated'),(123,1784615032,33.23,31.2,67.17,67.17,'elevated'),(124,1784615033,31.23,31.34,32.57,32.57,'elevated'),(125,1784615034,31.12,31.03,32.87,32.87,'elevated'),(126,1784615035,31.08,30.93,35.39,35.39,'elevated'),(127,1784615036,31.06,31.01,33.34,33.34,'elevated'),(128,1784615037,31.2,31.2,35.19,35.19,'normal'),(129,1784615038,33.92,31.49,96.21,96.21,'normal'),(130,1784615039,31.14,31.2,32.59,32.59,'normal'),(131,1784615040,35.06,31.26,137.23,137.23,'elevated'),(132,1784615041,31.28,31.24,38.5,38.5,'elevated'),(133,1784615042,34.36,31.23,90.51,90.51,'elevated'),(134,1784615043,31.83,31.1,55.54,55.54,'elevated'),(135,1784615044,31.25,31.11,32.51,32.51,'elevated'),(136,1784615045,31.12,31.15,32.56,32.56,'elevated'),(137,1784615046,31.19,31.26,34.37,34.37,'elevated'),(138,1784615047,31.19,31.01,39.16,39.16,'elevated'),(139,1784615048,31.22,31.46,40.3,40.3,'normal'),(140,1784615049,37.8,31.64,173.93,173.93,'elevated'),(141,1784615050,31.03,31.03,32.33,32.33,'elevated'),(142,1784615051,31.26,31.36,34.37,34.37,'elevated'),(143,1784615052,31.23,31.31,33.75,33.75,'elevated'),(144,1784615053,33.4,31.13,98.76,98.76,'elevated'),(145,1784615054,32.49,31.06,71.76,71.76,'elevated'),(146,1784615055,31.1,31.15,32.8,32.8,'elevated'),(147,1784615056,31.39,31.13,38.21,38.21,'elevated'),(148,1784615057,33.92,31.18,90.77,90.77,'elevated'),(149,1784615058,30.6,30.87,35.62,35.62,'elevated'),(150,1784615059,31.32,31.38,34.96,34.96,'elevated'),(151,1784615060,31.35,31.28,33.26,33.26,'elevated'),(152,1784615061,31.14,31.11,32.13,32.13,'elevated'),(153,1784615062,31.03,31,32.57,32.57,'normal'),(154,1784615063,31.05,31.03,34.8,34.8,'normal'),(155,1784615064,31.07,31.06,33.28,33.28,'normal'),(156,1784615065,31.17,30.98,32.34,32.34,'normal'),(157,1784615066,31.1,31.24,32.95,32.95,'normal'),(158,1784615067,31.28,31.38,32.6,32.6,'normal'),(159,1784615068,30.34,31.11,33.37,33.37,'normal'),(160,1784615069,31.44,31.52,32.87,32.87,'normal'),(161,1784615070,31.23,31.18,32.74,32.74,'normal'),(162,1784615071,31.15,31.05,37.06,37.06,'normal'),(163,1784615072,32.36,30.85,85.39,85.39,'normal'),(164,1784615073,31.12,31,34.87,34.87,'normal'),(165,1784615074,31.11,31.28,33.39,33.39,'normal'),(166,1784615075,33.66,31.16,107.54,107.54,'elevated'),(167,1784615076,31.34,31.2,35.78,35.78,'elevated'),(168,1784615077,31.17,31.24,32.64,32.64,'elevated'),(169,1784615078,30.65,31,33.65,33.65,'elevated'),(170,1784615079,36.34,31.51,75.04,75.04,'elevated'),(171,1784615080,31.18,31.08,35,35,'elevated'),(172,1784615081,31.72,31.51,55.31,55.31,'elevated'),(173,1784615082,30.94,31,33.52,33.52,'elevated'),(174,1784615083,31.33,31.46,32.34,32.34,'elevated'),(175,1784615084,36.73,31.8,138.94,138.94,'elevated'),(176,1784615085,32.23,31.38,59.77,59.77,'elevated'),(177,1784615086,31.3,31.34,32.6,32.6,'elevated'),(178,1784615087,31.28,31.38,32.83,32.83,'elevated'),(179,1784615088,31.12,31.13,33.47,33.47,'elevated'),(180,1784615089,33.5,31.21,101.65,101.65,'elevated'),(181,1784615090,53.63,31.56,238.03,238.03,'elevated'),(182,1784615091,33.28,31.39,89.13,89.13,'elevated'),(183,1784615092,33.95,31.33,114.49,114.49,'elevated'),(184,1784615093,32.69,31.18,81.53,81.53,'elevated'),(185,1784615094,32.05,31.15,64.91,64.91,'elevated'),(186,1784615095,31.1,31.05,32.96,32.96,'elevated'),(187,1784615096,31.12,31.28,34.57,34.57,'elevated'),(188,1784615097,31.24,31.15,34.37,34.37,'elevated'),(189,1784615098,31.19,31.33,36.6,36.6,'elevated'),(190,1784615099,31.03,31.06,33.78,33.78,'normal'),(191,1784615100,32.59,31.03,64.26,64.26,'normal'),(192,1784615101,32.74,31.06,67.96,67.96,'normal'),(193,1784615102,31.05,31.11,33.44,33.44,'normal'),(194,1784615103,31.66,31.28,42.93,42.93,'normal'),(195,1784615104,33.8,31.06,119.21,119.21,'elevated'),(196,1784615105,31.13,31.03,35.32,35.32,'elevated'),(197,1784615106,44.69,31.54,161.74,161.74,'elevated'),(198,1784615107,33.99,31.13,112.98,112.98,'elevated'),(199,1784615108,34.7,31.47,92.27,92.27,'elevated'),(200,1784615110,35.87,31.77,103.81,103.81,'elevated'),(201,1784615111,39.48,31.78,147.85,147.85,'elevated'),(202,1784615112,32.17,31.42,57.28,57.28,'elevated'),(203,1784615113,31.15,30.97,38.4,38.4,'elevated'),(204,1784615114,35.24,31.31,141.43,141.43,'elevated'),(205,1784615115,31.16,31.28,33.49,33.49,'elevated'),(206,1784615116,30.9,31,33.51,33.51,'elevated'),(207,1784615117,31.09,31.1,33.18,33.18,'elevated'),(208,1784615118,39.51,31.15,285.21,285.21,'critical'),(209,1784615119,44.09,33.91,108.46,108.46,'critical'),(210,1784615120,42.22,31.59,230.16,230.16,'critical'),(211,1784615121,31.27,31.24,33.1,33.1,'critical'),(212,1784615122,31.18,31.05,34.77,34.77,'critical'),(213,1784615123,31.02,30.95,36.24,36.24,'critical'),(214,1784615124,31.02,31.2,32.77,32.77,'critical'),(215,1784615125,31.21,31.34,33.55,33.55,'elevated'),(216,1784615126,31.07,30.98,37.42,37.42,'elevated'),(217,1784615127,31.16,31.2,34.31,34.31,'elevated'),(218,1784615128,33.25,30.95,120.52,120.52,'elevated'),(219,1784615129,31.23,31.26,33.88,33.88,'elevated'),(220,1784615130,31.13,31.05,33.46,33.46,'elevated'),(221,1784615131,31.26,31.28,33.85,33.85,'elevated'),(222,1784615132,33.32,31.29,99.22,99.22,'elevated'),(223,1784615133,31.26,31.23,34.31,34.31,'elevated'),(224,1784615134,31.06,31.1,32.85,32.85,'elevated'),(225,1784615135,31.2,31.26,33.37,33.37,'elevated'),(226,1784615136,30.93,30.83,32.77,32.77,'elevated'),(227,1784615137,33.39,31.39,90.9,90.9,'elevated'),(228,1784615138,30.67,31.01,34.9,34.9,'elevated'),(229,1784615139,31.13,31.16,32.96,32.96,'elevated'),(230,1784615140,31.28,31.11,36.7,36.7,'elevated'),(231,1784615141,31.81,31.2,47.97,47.97,'elevated'),(232,1784615142,31.06,31.01,34.73,34.73,'normal'),(233,1784615143,31.15,31.21,32.52,32.52,'normal'),(234,1784615144,31.23,31.38,34.77,34.77,'normal'),(235,1784615145,32.88,31.52,71.7,71.7,'normal'),(236,1784615146,32.27,31.21,67.7,67.7,'normal'),(237,1784615147,31.03,31.06,33.88,33.88,'normal'),(238,1784615148,30.72,31.39,33.88,33.88,'normal'),(239,1784615149,31.08,31.06,34.24,34.24,'normal'),(240,1784615150,31.17,31.1,38.93,38.93,'normal'),(241,1784615151,31.34,31.28,32.59,32.59,'normal'),(242,1784615152,31.02,31.05,33.72,33.72,'normal'),(243,1784615153,31.08,31.06,36.5,36.5,'normal'),(244,1784615154,31.04,31.08,32.49,32.49,'normal'),(245,1784615155,31.24,31.23,32.59,32.59,'normal'),(246,1784615156,31.12,31.03,34.11,34.11,'normal'),(247,1784615157,31.01,30.92,32.39,32.39,'normal'),(248,1784615158,30.75,31.18,33.26,33.26,'normal'),(249,1784615159,31,31.01,33.13,33.13,'normal'),(250,1784615160,31.27,31.24,34.7,34.7,'normal'),(251,1784615161,31.2,31.13,33.88,33.88,'normal'),(252,1784615162,33.88,31.16,112.79,112.79,'elevated'),(253,1784615163,31.1,30.9,33.16,33.16,'elevated'),(254,1784615164,35.56,31.16,163.32,163.32,'elevated'),(255,1784615165,31.06,31.31,33.44,33.44,'elevated'),(256,1784615166,31.15,31.13,32.92,32.92,'elevated'),(257,1784615167,31.28,31.11,32.64,32.64,'elevated'),(258,1784615168,30.93,31.2,34.73,34.73,'elevated'),(259,1784615169,30.99,31.05,33.82,33.82,'normal'),(260,1784615170,31.18,31,36.18,36.18,'normal'),(261,1784615171,32.18,30.98,58.39,58.39,'normal'),(262,1784615172,32.28,31.01,57.41,57.41,'normal'),(263,1784615173,31.43,31.23,43.71,43.71,'normal'),(264,1784615174,31.12,31.23,33.75,33.75,'normal'),(265,1784615175,33.37,31.36,90.37,90.37,'normal'),(266,1784615176,32.35,31.46,57.77,57.77,'normal'),(267,1784615177,32.06,30.9,54,54,'normal'),(268,1784615178,31.07,31.26,36.47,36.47,'normal'),(269,1784615179,36.09,31.47,157.16,157.16,'elevated'),(270,1784615180,31.17,31.16,33.01,33.01,'elevated'),(271,1784615181,31.27,31.11,33.23,33.23,'elevated'),(272,1784615182,31.05,31.08,32.83,32.83,'elevated'),(273,1784615183,31.18,31.05,33.44,33.44,'elevated'),(274,1784615185,31.39,31.05,45.02,45.02,'normal'),(275,1784615186,32.31,31.11,62.75,62.75,'normal'),(276,1784615187,32.47,30.95,61.44,61.44,'normal'),(277,1784615188,30.76,31.08,32.85,32.85,'normal'),(278,1784615189,31.34,31.33,32.34,32.34,'normal'),(279,1784615190,31.23,31.23,32.33,32.33,'normal'),(280,1784615191,31.11,31.23,32.88,32.88,'normal'),(281,1784615192,31.68,31.15,45.74,45.74,'normal'),(282,1784615193,31.24,31.26,36.18,36.18,'normal'),(283,1784615194,30.94,30.95,33.11,33.11,'normal'),(284,1784615195,31.1,31.18,32.28,32.28,'normal'),(285,1784615196,31.15,31.31,32.93,32.93,'normal'),(286,1784615197,31.26,31.29,32.87,32.87,'normal'),(287,1784615198,30.87,31.03,38.63,38.63,'normal'),(288,1784615199,31.31,31.21,39.06,39.06,'normal'),(289,1784615200,31.07,31.1,35.26,35.26,'normal'),(290,1784615201,31.23,31.2,34.41,34.41,'normal'),(291,1784615202,31.03,31.13,39.45,39.45,'normal'),(292,1784615203,31.21,31.06,37.65,37.65,'normal'),(293,1784615204,31.19,31.29,32.72,32.72,'normal'),(294,1784615205,31.11,31.23,33.51,33.51,'normal'),(295,1784615206,31.15,31.15,35.62,35.62,'normal'),(296,1784615207,31.09,31.01,32.96,32.96,'normal'),(297,1784615208,30.15,31.01,33.21,33.21,'normal'),(298,1784615209,31.43,31.18,33.37,33.37,'normal'),(299,1784615210,31.28,31.23,34.77,34.77,'normal'),(300,1784615211,32.56,31.41,52.1,52.1,'normal'),(301,1784615212,31.04,31.1,33.82,33.82,'normal'),(302,1784615213,31.27,31.2,33.65,33.65,'normal'),(303,1784615214,32.56,31.36,58.56,58.56,'normal'),(304,1784615215,31.17,31.28,33.08,33.08,'normal'),(305,1784615216,31.13,31.01,33.03,33.03,'normal'),(306,1784615217,33.3,31.2,86.84,86.84,'normal'),(307,1784615218,31.18,31.16,43.88,43.88,'normal'),(308,1784615219,34.47,31.2,123.34,123.34,'elevated'),(309,1784615220,33.66,31.38,97.91,97.91,'elevated'),(310,1784615221,31.23,31.1,32.83,32.83,'elevated'),(311,1784615222,31.26,31.18,34.28,34.28,'elevated'),(312,1784615223,31.55,31.15,46.07,46.07,'elevated'),(313,1784615224,31.07,31.1,33.06,33.06,'elevated'),(314,1784615225,30.94,30.87,32.37,32.37,'normal'),(315,1784615226,31.05,30.98,33.11,33.11,'normal'),(316,1784615227,31.19,31.2,34.24,34.24,'normal'),(317,1784615228,30.75,31.16,35.59,35.59,'normal'),(318,1784615229,31.05,31.21,33.59,33.59,'normal'),(319,1784615230,31.24,31.1,33.62,33.62,'normal'),(320,1784615231,31.27,31.24,33.95,33.95,'normal'),(321,1784615232,31.18,31.08,33.37,33.37,'normal'),(322,1784615233,31.07,31,34.64,34.64,'normal'),(323,1784615234,31.2,31.29,33.52,33.52,'normal'),(324,1784615235,31.04,31,32.59,32.59,'normal'),(325,1784615236,31.09,31.15,32.18,32.18,'normal'),(326,1784615237,33.05,31.26,85.72,85.72,'normal'),(327,1784615238,30.45,31.15,34.57,34.57,'normal'),(328,1784615239,35.63,31.18,165.94,165.94,'elevated'),(329,1784615240,31.21,31.15,34.47,34.47,'elevated'),(330,1784615241,31.17,31.42,34.83,34.83,'elevated'),(331,1784615242,31.21,31.33,34.67,34.67,'elevated'),(332,1784615243,31.13,31.13,35.06,35.06,'elevated'),(333,1784615244,31.08,31.16,34.87,34.87,'normal'),(334,1784615245,31.1,30.97,34.93,34.93,'normal'),(335,1784615246,31.02,31.03,34.67,34.67,'normal'),(336,1784615247,31.12,31.26,34.21,34.21,'normal'),(337,1784615248,31.14,31.39,34.31,34.31,'normal'),(338,1784615249,31.16,31.46,35,35,'normal'),(339,1784615250,31.58,31.23,51.9,51.9,'normal'),(340,1784615251,31.15,31.03,33.26,33.26,'normal'),(341,1784615252,31.1,31.06,34.24,34.24,'normal'),(342,1784615253,31.19,31.23,33.06,33.06,'normal'),(343,1784615254,30.96,31,32.72,32.72,'normal'),(344,1784615255,31.2,31.06,35.39,35.39,'normal'),(345,1784615256,31.21,31.18,33.62,33.62,'normal'),(346,1784615257,41.67,31.08,150.34,150.34,'elevated'),(347,1784615258,30.48,31,34.05,34.05,'elevated'),(348,1784615259,31.1,31.13,34.21,34.21,'elevated'),(349,1784615260,31.27,31.28,33.18,33.18,'elevated'),(350,1784615261,31.22,31.24,33.82,33.82,'elevated'),(351,1784615262,37.79,31.06,138.67,138.67,'elevated'),(352,1784615263,31.16,31.03,33.85,33.85,'elevated'),(353,1784615264,31.12,31.15,33.1,33.1,'elevated'),(354,1784615265,31.1,31.1,34.9,34.9,'elevated'),(355,1784615266,33.03,31.39,77.4,77.4,'elevated'),(356,1784615267,30.55,31,37.49,37.49,'elevated'),(357,1784615268,30.92,31.46,32.33,32.33,'elevated'),(358,1784615269,33.42,31.38,93.72,93.72,'elevated'),(359,1784615270,31.25,31.15,37.88,37.88,'elevated'),(360,1784615271,31.33,31.42,35.91,35.91,'elevated'),(361,1784615272,31.13,31.11,35.09,35.09,'elevated'),(362,1784615273,31.11,31.26,33.37,33.37,'elevated'),(363,1784615274,31.22,31.26,35.26,35.26,'normal'),(364,1784615275,31.46,31.51,33.65,33.65,'normal'),(365,1784615276,39.2,31.41,134.48,134.48,'elevated'),(366,1784615277,31.17,31.13,33.91,33.91,'elevated'),(367,1784615278,31.27,31.2,33.98,33.98,'elevated'),(368,1784615279,30.97,31.05,32.7,32.7,'elevated'),(369,1784615280,35.88,31.39,97.26,97.26,'elevated'),(370,1784615282,31.09,31.2,33.88,33.88,'elevated'),(371,1784615283,32.23,31.26,52.63,52.63,'elevated'),(372,1784615284,31.16,31.05,33.11,33.11,'elevated'),(373,1784615285,31.05,30.79,37.03,37.03,'elevated'),(374,1784615286,31.12,31.11,33.46,33.46,'elevated'),(375,1784615287,31.35,31.41,33.69,33.69,'elevated'),(376,1784615288,31.23,31.28,32.54,32.54,'normal'),(377,1784615289,31.24,31.2,33.34,33.34,'normal'),(378,1784615290,31.15,31.2,32.8,32.8,'normal'),(379,1784615291,52.45,31.52,199.75,199.75,'elevated'),(380,1784615292,31.24,31.41,40.47,40.47,'elevated'),(381,1784615293,31.05,31.03,32.26,32.26,'elevated'),(382,1784615294,33.98,31.33,75.63,75.63,'elevated'),(383,1784615295,31,30.98,33.59,33.59,'elevated'),(384,1784615296,33.97,31.28,71.3,71.3,'elevated'),(385,1784615297,34.49,31.52,63.41,63.41,'elevated'),(386,1784615298,30.74,31.16,36.04,36.04,'elevated'),(387,1784615299,31.4,31.6,35.23,35.23,'elevated'),(388,1784615300,31.2,30.92,34.37,34.37,'elevated'),(389,1784615301,32.13,31.18,49.94,49.94,'elevated'),(390,1784615302,31.23,31.06,35.62,35.62,'normal'),(391,1784615303,33.01,31.33,60.26,60.26,'normal'),(392,1784615304,31.11,31.16,32.54,32.54,'normal'),(393,1784615305,35.78,31.1,146.93,146.93,'elevated'),(394,1784615306,31.09,31.16,33.34,33.34,'elevated'),(395,1784615307,31.16,31.06,33.59,33.59,'elevated'),(396,1784615308,30.56,30.8,35.55,35.55,'elevated'),(397,1784615309,31.24,31.31,33.33,33.33,'elevated'),(398,1784615310,31.21,31.49,32.57,32.57,'normal'),(399,1784615311,31.23,31.1,34.44,34.44,'normal'),(400,1784615312,31.09,31.05,33.36,33.36,'normal'),(401,1784615313,34.95,31.41,81.79,81.79,'normal'),(402,1784615314,31.16,31.11,33.34,33.34,'normal'),(403,1784615315,31.02,31.05,37.45,37.45,'normal'),(404,1784615316,31.25,31.08,33.65,33.65,'normal'),(405,1784615317,31.07,31.28,36.08,36.08,'normal'),(406,1784615318,31.14,31.13,35.16,35.16,'normal'),(407,1784615319,31.16,31.23,33.49,33.49,'normal'),(408,1784615320,37.12,31.01,193.2,193.2,'elevated'),(409,1784615321,30.98,30.77,32.24,32.24,'elevated'),(410,1784615322,32.81,31.21,79.76,79.76,'elevated'),(411,1784615323,33.78,30.69,80.02,80.02,'elevated'),(412,1784615324,30.92,30.8,32.83,32.83,'elevated'),(413,1784615325,31.03,31.1,32.44,32.44,'elevated'),(414,1784615326,31.17,31.38,35.68,35.68,'elevated'),(415,1784615327,32.14,31.18,66.36,66.36,'elevated'),(416,1784615328,31.21,31.03,34.18,34.18,'elevated'),(417,1784615329,32.13,31.08,49.74,49.74,'elevated'),(418,1784615330,35.99,31.2,106.56,106.56,'elevated'),(419,1784615331,35.04,31.1,144.83,144.83,'elevated'),(420,1784615332,31.18,31.23,33.85,33.85,'elevated'),(421,1784615333,31.5,31.11,45.22,45.22,'elevated'),(422,1784615334,31.26,31.2,39.98,39.98,'elevated'),(423,1784615335,31.07,30.95,33.44,33.44,'elevated'),(424,1784615336,31.16,31.11,38.63,38.63,'normal'),(425,1784615337,31.31,31.21,34.14,34.14,'normal'),(426,1784615338,30.78,31.52,34.47,34.47,'normal'),(427,1784615339,31.19,31.24,39.39,39.39,'normal'),(428,1784615340,31.47,31.42,37.32,37.32,'normal'),(429,1784615341,31.96,31.21,57.51,57.51,'normal'),(430,1784615342,31.35,31.38,36.8,36.8,'normal'),(431,1784615343,31.19,31.49,36.67,36.67,'normal'),(432,1784615344,34.08,31.39,89.33,89.33,'normal'),(433,1784615345,31.13,31.18,40.8,40.8,'normal'),(434,1784615346,33.44,31.08,104.33,104.33,'elevated'),(435,1784615347,31.16,31.05,33.75,33.75,'elevated'),(436,1784615348,30.7,31.01,40.6,40.6,'elevated'),(437,1784615349,31.3,31.28,37.98,37.98,'elevated'),(438,1784615350,31.14,31.13,34.5,34.5,'elevated'),(439,1784615351,31.19,31.39,37.36,37.36,'normal'),(440,1784615352,31.74,30.93,58.03,58.03,'normal'),(441,1784615353,31.08,31.24,33.62,33.62,'normal'),(442,1784615354,31.12,31.21,42.07,42.07,'normal'),(443,1784615355,31.27,31.11,37.16,37.16,'normal'),(444,1784615356,35.33,31.33,131.6,131.6,'elevated'),(445,1784615357,31.34,31.11,51.15,51.15,'elevated'),(446,1784615358,30.36,31.2,33.82,33.82,'elevated'),(447,1784615359,31.16,31.16,32.59,32.59,'elevated'),(448,1784615360,31.25,31.38,33.65,33.65,'elevated'),(449,1784615361,31.11,30.88,33.36,33.36,'elevated'),(450,1784615362,31.25,31.29,36.77,36.77,'normal'),(451,1784615363,32.25,31.28,61.9,61.9,'normal'),(452,1784615364,31.09,31.16,32.65,32.65,'normal'),(453,1784615365,30.96,30.88,34.5,34.5,'normal'),(454,1784615366,31.18,31.2,34.28,34.28,'normal'),(455,1784615367,30.98,30.93,33.26,33.26,'normal'),(456,1784615368,30.7,31.08,33.88,33.88,'normal'),(457,1784615369,31.21,31.31,33,33,'normal'),(458,1784615370,31.8,31.23,57.18,57.18,'normal'),(459,1784615371,31.1,31.1,32.8,32.8,'normal'),(460,1784615373,31.16,31.13,33.95,33.95,'normal'),(461,1784615374,31.83,31.31,43.02,43.02,'normal'),(462,1784615375,30.94,30.85,33.13,33.13,'normal'),(463,1784615376,31.24,31.36,33.46,33.46,'normal'),(464,1784615377,31.21,31.13,34.7,34.7,'normal'),(465,1784615378,31.51,31.13,48.04,48.04,'normal'),(466,1784615379,30.26,31.08,32.59,32.59,'normal'),(467,1784615380,31.36,31.31,34.41,34.41,'normal'),(468,1784615381,31.3,31.36,32.65,32.65,'normal'),(469,1784615382,32.39,31.29,69.8,69.8,'normal'),(470,1784615383,32.92,31.36,85.66,85.66,'normal'),(471,1784615384,31.07,31.15,34.67,34.67,'normal'),(472,1784615385,31.11,31.03,35.42,35.42,'normal'),(473,1784615386,33.16,30.93,104.99,104.99,'elevated'),(474,1784615387,33.7,31.11,79.89,79.89,'elevated'),(475,1784615388,31.79,31.18,73.73,73.73,'elevated'),(476,1784615389,33.85,31.77,86.18,86.18,'elevated'),(477,1784615390,31.16,31.05,34.24,34.24,'elevated'),(478,1784615391,33.86,31.44,106.89,106.89,'elevated'),(479,1784615392,44.39,31.51,150.6,150.6,'elevated'),(480,1784615393,32.7,31.16,77.59,77.59,'elevated'),(481,1784615394,31.15,31.11,33.16,33.16,'elevated'),(482,1784615395,33.19,31.05,101.32,101.32,'elevated'),(483,1784615396,34.91,31.16,111.67,111.67,'elevated'),(484,1784615397,31.24,31.41,34.14,34.14,'elevated'),(485,1784615398,31.63,31.01,55.18,55.18,'elevated'),(486,1784615399,33.38,31.11,87.43,87.43,'elevated'),(487,1784615400,31.37,31.51,32.92,32.92,'elevated'),(488,1784615401,31.2,31.31,35.88,35.88,'elevated'),(489,1784615402,31.45,31.6,36.73,36.73,'elevated'),(490,1784615403,31.32,31.39,34.31,34.31,'elevated'),(491,1784615404,31.15,30.9,33.34,33.34,'normal'),(492,1784615405,31.05,31.1,36.83,36.83,'normal'),(493,1784615406,31.11,31.18,32.64,32.64,'normal'),(494,1784615407,31.28,31.13,41.22,41.22,'normal'),(495,1784615408,31.23,31.28,34.01,34.01,'normal'),(496,1784615409,33.36,30.9,100.73,100.73,'elevated'),(497,1784615410,31.17,31.23,34.93,34.93,'elevated'),(498,1784615411,31.64,31.11,46.96,46.96,'elevated'),(499,1784615412,31.16,31.29,41.45,41.45,'elevated'),(500,1784615413,31.05,31.08,32.92,32.92,'elevated'),(501,1784615414,31.19,31.28,39.88,39.88,'normal'),(502,1784615415,30.97,31.08,34.8,34.8,'normal'),(503,1784615416,30.97,31.15,34.28,34.28,'normal'),(504,1784615417,31.14,31.21,38.11,38.11,'normal'),(505,1784615418,31.74,31.11,53.74,53.74,'normal'),(506,1784615419,31.15,31.26,34.77,34.77,'normal'),(507,1784615420,32.19,31.39,58.92,58.92,'normal'),(508,1784615421,31.12,31.18,33.03,33.03,'normal'),(509,1784615422,31.32,31.18,32.95,32.95,'normal'),(510,1784615423,31.39,30.93,51.81,51.81,'normal'),(511,1784615424,31.18,31.16,32.6,32.6,'normal'),(512,1784615425,31.04,31,37.55,37.55,'normal'),(513,1784615426,31.23,31.05,35.26,35.26,'normal'),(514,1784615427,31.13,31.05,33.59,33.59,'normal'),(515,1784615428,31.98,31.46,45.29,45.29,'normal'),(516,1784615429,31.13,31.21,40.24,40.24,'normal'),(517,1784615430,33.91,31.29,114.69,114.69,'elevated'),(518,1784615431,31.15,31.16,34.01,34.01,'elevated'),(519,1784615432,31.05,31.06,33.65,33.65,'elevated'),(520,1784615433,35.73,30.83,170,170,'elevated'),(521,1784615434,31.05,31.33,35.68,35.68,'elevated'),(522,1784615435,31.15,31.2,35.19,35.19,'elevated'),(523,1784615436,31.27,31.36,35.75,35.75,'elevated'),(524,1784615437,31.18,31.15,33.95,33.95,'elevated'),(525,1784615438,30.68,31.05,34.73,34.73,'normal'),(526,1784615439,31.21,31.34,42.27,42.27,'normal'),(527,1784615440,31.03,31.03,38.34,38.34,'normal'),(528,1784615441,31.52,31.31,36.31,36.31,'normal'),(529,1784615442,31.52,31.03,38.86,38.86,'normal'),(530,1784615443,30.99,30.97,35.29,35.29,'normal'),(531,1784615444,31.12,31.1,37.39,37.39,'normal'),(532,1784615445,31.02,31.29,35.68,35.68,'normal'),(533,1784615446,31.53,31.31,54.1,54.1,'normal'),(534,1784615447,31.21,31.01,41.25,41.25,'normal'),(535,1784615448,30.94,31,35.29,35.29,'normal'),(536,1784615449,31.32,31.28,35.52,35.52,'normal'),(537,1784615450,31.12,31.16,35.13,35.13,'normal'),(538,1784615451,31.08,31.21,37.45,37.45,'normal'),(539,1784615452,32.22,31.28,46.66,46.66,'normal'),(540,1784615453,31.71,31.38,57.08,57.08,'normal'),(541,1784615454,31.24,31.2,34.67,34.67,'normal'),(542,1784615455,31.43,31.21,38.08,38.08,'normal'),(543,1784615456,30.91,31.15,33.85,33.85,'normal'),(544,1784615457,31.16,31.21,40.21,40.21,'normal'),(545,1784615458,30.24,31.11,35.75,35.75,'normal'),(546,1784615459,31.36,31.51,36.01,36.01,'normal'),(547,1784615460,31.04,30.93,36.67,36.67,'normal'),(548,1784615461,31.18,31.2,33.72,33.72,'normal'),(549,1784615462,31.32,31.16,35,35,'normal'),(550,1784615463,31.32,31.24,35.36,35.36,'normal'),(551,1784615464,31.03,31,36.04,36.04,'normal'),(552,1784615465,31.12,31.06,33.51,33.51,'normal'),(553,1784615466,31.38,31.31,33,33,'normal'),(554,1784615468,31.16,31,33.34,33.34,'normal'),(555,1784615469,30.63,31.01,32.29,32.29,'normal'),(556,1784615470,31.18,31.2,32.16,32.16,'normal'),(557,1784615471,31.42,31.41,32.65,32.65,'normal'),(558,1784615472,31.38,31.49,32.31,32.31,'normal'),(559,1784615473,31.09,30.95,39.81,39.81,'normal'),(560,1784615474,31.11,31.11,32.52,32.52,'normal'),(561,1784615475,31.08,31.16,32.57,32.57,'normal'),(562,1784615476,31.21,31.15,32.23,32.23,'normal'),(563,1784615477,31.25,31.33,32.21,32.21,'normal'),(564,1784615478,31.24,31.23,32.37,32.37,'normal'),(565,1784615479,31.08,31.65,33.01,33.01,'normal'),(566,1784615480,31.45,31.56,32.05,32.05,'normal'),(567,1784615481,31.27,31.18,32.28,32.28,'normal'),(568,1784615482,31.45,31.57,32.19,32.19,'normal'),(569,1784615483,31.37,31.46,32.51,32.51,'normal'),(570,1784615484,31.23,31.26,32.51,32.51,'normal'),(571,1784615485,31.24,31.06,32.26,32.26,'normal'),(572,1784615486,31.37,31.41,32.64,32.64,'normal'),(573,1784615487,31.2,31.33,32.13,32.13,'normal'),(574,1784615488,31.33,31.46,32.24,32.24,'normal'),(575,1784615489,30.63,31.01,32.87,32.87,'normal'),(576,1784615490,31.34,31.47,32.16,32.16,'normal'),(577,1784615491,31.42,31.54,33.46,33.46,'normal'),(578,1784615492,31.31,31.21,32.54,32.54,'normal'),(579,1784615493,31.27,31.23,32.21,32.21,'normal'),(580,1784615494,31.1,31.16,32.01,32.01,'normal'),(581,1784615495,31.05,30.95,32.06,32.06,'normal'),(582,1784615496,31.21,31.01,32.37,32.37,'normal'),(583,1784615497,31.25,31.05,32.41,32.41,'normal'),(584,1784615498,30.81,31,32.28,32.28,'normal'),(585,1784615499,31.31,31.46,32.06,32.06,'normal'),(586,1784615500,31.38,31.38,32.42,32.42,'normal'),(587,1784615501,30.49,30.26,32.08,32.08,'normal'),(588,1784615502,31.45,31.44,32.82,32.82,'normal'),(589,1784615503,31.17,31.08,32.13,32.13,'normal'),(590,1784615504,31.23,31.21,32.16,32.16,'normal'),(591,1784615505,31.14,30.92,32.39,32.39,'normal'),(592,1784615506,31.24,31.2,32.39,32.39,'normal'),(593,1784615507,31.16,31.16,32.24,32.24,'normal'),(594,1784615508,30.76,31.1,32.59,32.59,'normal'),(595,1784615509,31.26,31.42,32.64,32.64,'normal'),(596,1784615510,31.21,31.24,32.18,32.18,'normal'),(597,1784615511,31.34,31.29,32.19,32.19,'normal'),(598,1784615512,31.16,31.13,32.92,32.92,'normal'),(599,1784615513,31.36,31.28,32.85,32.85,'normal'),(600,1784615514,31.06,31.08,31.95,31.95,'normal'),(601,1784615515,31.26,31.1,33.59,33.59,'normal'),(602,1784615516,31.12,31.11,32.28,32.28,'normal'),(603,1784615517,31.38,31.33,32.18,32.18,'normal'),(604,1784615518,31.19,31.08,32.33,32.33,'normal'),(605,1784615519,31.15,31.13,32.28,32.28,'normal'),(606,1784615520,31.31,31.28,34.54,34.54,'normal'),(607,1784615521,31.32,31.24,32.9,32.9,'normal'),(608,1784615522,31.56,31.69,32.44,32.44,'normal'),(609,1784615523,31.25,31.28,32.23,32.23,'normal'),(610,1784615524,31.05,31.01,33.54,33.54,'normal'),(611,1784615525,30.91,30.77,35.03,35.03,'normal'),(612,1784615526,31.2,31.26,32.21,32.21,'normal'),(613,1784615527,31.2,31.28,34.14,34.14,'normal'),(614,1784615528,30.77,31.11,32.33,32.33,'normal'),(615,1784615529,31.11,31.13,32.03,32.03,'normal'),(616,1784615530,31.2,31.23,32.65,32.65,'normal'),(617,1784615531,31.39,31.44,32.72,32.72,'normal'),(618,1784615532,31.25,31.18,32.19,32.19,'normal'),(619,1784615533,31.21,31.28,32.16,32.16,'normal'),(620,1784615534,31.3,31.28,33.95,33.95,'normal'),(621,1784615535,31.26,31.24,32.46,32.46,'normal'),(622,1784615536,31.12,31.03,32.36,32.36,'normal'),(623,1784615537,31.14,31.21,32.26,32.26,'normal'),(624,1784615538,30.64,30.95,37.85,37.85,'normal'),(625,1784615539,31.18,31.1,32.18,32.18,'normal'),(626,1784615540,31.32,31.13,32.33,32.33,'normal'),(627,1784615541,31.16,31.31,37.49,37.49,'normal'),(628,1784615542,31.48,31.64,33.69,33.69,'normal'),(629,1784615543,31.35,31.36,32.77,32.77,'normal'),(630,1784615544,31.03,30.93,32.74,32.74,'normal'),(631,1784615545,31.2,31.16,35.39,35.39,'normal'),(632,1784615546,31.15,31.06,34.34,34.34,'normal'),(633,1784615547,31.28,31.33,32.6,32.6,'normal'),(634,1784615548,30.55,30.92,37,37,'normal'),(635,1784615549,31.05,30.74,34.14,34.14,'normal'),(636,1784615550,31.25,31.29,32.37,32.37,'normal'),(637,1784615551,31.13,31.16,33.59,33.59,'normal'),(638,1784615552,31.77,31.34,47.91,47.91,'normal'),(639,1784615553,31.56,31.2,46.99,46.99,'normal'),(640,1784615554,31.15,31.15,33.72,33.72,'normal'),(641,1784615555,31.21,31.06,34.24,34.24,'normal'),(642,1784615556,31.28,31.2,32.18,32.18,'normal'),(643,1784615557,31.24,31.21,32.26,32.26,'normal'),(644,1784615558,30.67,31.24,33.78,33.78,'normal'),(645,1784615559,31.21,31.24,33.59,33.59,'normal'),(646,1784615560,31.31,31.36,32.77,32.77,'normal'),(647,1784615561,31.38,31.24,32.72,32.72,'normal'),(648,1784615562,31.42,31.67,36.8,36.8,'normal'),(649,1784615563,31.26,31.42,33.34,33.34,'normal'),(650,1784615564,31.2,31.15,32.39,32.39,'normal'),(651,1784615565,31.2,31.13,36.08,36.08,'normal'),(652,1784615566,31.2,31.2,32.42,32.42,'normal'),(653,1784615567,30.78,31.24,32.31,32.31,'normal'),(654,1784615568,30.79,31.44,34.54,34.54,'normal'),(655,1784615569,31.56,31.8,32.64,32.64,'normal'),(656,1784615570,31.5,31.75,32.26,32.26,'normal'),(657,1784615571,31.49,31.56,32.26,32.26,'normal'),(658,1784615572,31.51,31.67,32.65,32.65,'normal'),(659,1784615573,31.39,31.31,32.62,32.62,'normal'),(660,1784615574,31.07,30.98,34.18,34.18,'normal'),(661,1784615575,31.3,31.1,34.6,34.6,'normal'),(662,1784615576,31.32,31.38,33.82,33.82,'normal'),(663,1784615577,31.36,31.31,32.41,32.41,'normal'),(664,1784615578,30.49,31.49,35.26,35.26,'normal'),(665,1784615579,31.15,31.11,34.96,34.96,'normal'),(666,1784615580,31.17,31.28,36.8,36.8,'normal'),(667,1784615581,31.48,31.54,32.59,32.59,'normal'),(668,1784615582,31.34,31.36,36.93,36.93,'normal'),(669,1784615583,31.39,31.51,36.73,36.73,'normal'),(670,1784615584,31.2,31.11,32.78,32.78,'normal'),(671,1784615585,31.17,31.24,32.26,32.26,'normal'),(672,1784615586,31.21,31.11,32.95,32.95,'normal'),(673,1784615587,31.15,31,33.75,33.75,'normal'),(674,1784615588,30.85,31.28,40.73,40.73,'normal'),(675,1784615589,31.1,31.13,32.93,32.93,'normal'),(676,1784615590,31.28,31.29,32.7,32.7,'normal'),(677,1784615591,31.35,31.39,33.41,33.41,'normal'),(678,1784615592,31.25,31.2,35.42,35.42,'normal'),(679,1784615593,31.14,31.21,31.97,31.97,'normal'),(680,1784615595,31.14,31.24,32.26,32.26,'normal'),(681,1784615596,31.05,31.18,34.05,34.05,'normal'),(682,1784615597,31.18,31.15,33,33,'normal'),(683,1784615598,31.27,31.11,34.44,34.44,'normal'),(684,1784615599,31.06,30.98,35.39,35.39,'normal'),(685,1784615600,31.19,31.18,33.91,33.91,'normal'),(686,1784615601,31.03,31.08,32.21,32.21,'normal'),(687,1784615602,31.29,31.26,41.19,41.19,'normal'),(688,1784615603,31.23,31.18,32.92,32.92,'normal'),(689,1784615604,31.05,31.13,32.34,32.34,'normal'),(690,1784615605,31.11,31.06,32.15,32.15,'normal'),(691,1784615606,31.12,30.95,32.49,32.49,'normal'),(692,1784615607,31.07,31,32.46,32.46,'normal'),(693,1784615608,31.1,31.08,33.85,33.85,'normal'),(694,1784615609,30.69,31.18,33.26,33.26,'normal'),(695,1784615610,31.31,31.2,32.7,32.7,'normal'),(696,1784615611,31.19,31.21,32.98,32.98,'normal'),(697,1784615612,31.21,31.1,32.39,32.39,'normal'),(698,1784615613,31.21,31.23,33.18,33.18,'normal'),(699,1784615614,31.05,30.92,31.88,31.88,'normal'),(700,1784615615,33.39,31.42,94.57,94.57,'normal'),(701,1784615616,31.26,31.26,38.11,38.11,'normal'),(702,1784615617,30.83,31.16,32.7,32.7,'normal'),(703,1784615618,31.4,31.41,33.46,33.46,'normal'),(704,1784615619,31,31.74,37.09,37.09,'normal'),(705,1784615620,31.23,31.24,33.36,33.36,'normal'),(706,1784615621,31.28,31.21,33.59,33.59,'normal'),(707,1784615622,31.13,31.16,35.98,35.98,'normal'),(708,1784615623,31.14,31.23,32.39,32.39,'normal'),(709,1784615624,31.17,31.01,34.18,34.18,'normal'),(710,1784615625,31.18,31.28,35.75,35.75,'normal'),(711,1784615626,31.18,31.46,35.65,35.65,'normal'),(712,1784615627,31.27,31.28,33.03,33.03,'normal'),(713,1784615628,29.82,30.85,34.08,34.08,'normal'),(714,1784615629,36.87,30.93,117.77,117.77,'elevated'),(715,1784615630,31.15,31.18,33.37,33.37,'elevated'),(716,1784615631,31.17,31.39,32.64,32.64,'elevated'),(717,1784615632,31.7,31.21,38.11,38.11,'elevated'),(718,1784615633,31.24,31.41,34.24,34.24,'elevated'),(719,1784615634,31.08,31.38,32.95,32.95,'normal'),(720,1784615635,31.14,31.06,33.88,33.88,'normal'),(721,1784615636,32.12,31.38,61.44,61.44,'normal'),(722,1784615637,31.07,31.31,34.24,34.24,'normal'),(723,1784615638,30.48,30.87,34.11,34.11,'normal'),(724,1784615639,31.06,30.92,33.52,33.52,'normal'),(725,1784615640,31.29,31.23,32.39,32.39,'normal'),(726,1784615641,31.05,31.05,32.51,32.51,'normal'),(727,1784615642,31.13,31.03,33.42,33.42,'normal'),(728,1784615643,31.28,31.18,32.64,32.64,'normal'),(729,1784615644,31.21,31.23,32.78,32.78,'normal'),(730,1784615645,31.01,30.97,37.39,37.39,'normal'),(731,1784615646,31.17,31.16,32.03,32.03,'normal'),(732,1784615647,31.2,31.15,36.11,36.11,'normal'),(733,1784615648,30.8,31.18,36.41,36.41,'normal'),(734,1784615649,35.19,31.11,143.13,143.13,'elevated'),(735,1784615650,31.2,31.28,32,32,'elevated'),(736,1784615651,31.21,31.24,35.65,35.65,'elevated'),(737,1784615652,31.15,31.08,33.98,33.98,'elevated'),(738,1784615653,31.57,31.05,54.62,54.62,'elevated'),(739,1784615654,31.16,31.05,32.8,32.8,'elevated'),(740,1784615655,31.66,31.36,48.89,48.89,'elevated'),(741,1784615656,32,31.21,69.8,69.8,'elevated'),(742,1784615657,31.02,31.16,38.7,38.7,'elevated'),(743,1784615658,31.22,31.28,34.96,34.96,'elevated'),(744,1784615659,31.27,31.23,33.65,33.65,'elevated'),(745,1784615660,31.15,31.01,33.21,33.21,'elevated'),(746,1784615661,31.73,31.41,58.43,58.43,'elevated'),(747,1784615662,31.35,31.46,37.19,37.19,'elevated'),(748,1784615663,31.14,31.16,34.05,34.05,'elevated'),(749,1784615664,32.84,31.44,74.78,74.78,'elevated'),(750,1784615665,31.17,31.15,35.88,35.88,'elevated'),(751,1784615666,31.25,31.29,35.39,35.39,'elevated'),(752,1784615667,32.09,31.28,62,62,'elevated'),(753,1784615668,31.14,31.11,33.51,33.51,'elevated'),(754,1784615669,31.18,31.15,33.62,33.62,'elevated'),(755,1784615670,31.08,31.29,33.05,33.05,'elevated'),(756,1784615671,31.18,31.23,32.47,32.47,'elevated'),(757,1784615672,30.99,30.97,34.73,34.73,'normal'),(758,1784615673,31.08,31.08,34.57,34.57,'normal'),(759,1784615674,31.75,31.21,52.17,52.17,'normal'),(760,1784615675,31.16,31.33,35.36,35.36,'normal'),(761,1784615676,38.62,31.6,120.65,120.65,'elevated'),(762,1784615677,33.04,31.44,61.93,61.93,'elevated'),(763,1784615678,39.67,31.23,242.22,242.22,'elevated'),(764,1784615680,31.15,31.13,33.29,33.29,'elevated'),(765,1784615681,31.6,31.13,42.6,42.6,'elevated'),(766,1784615682,31.15,31.15,34.6,34.6,'elevated'),(767,1784615683,31.18,31.26,35.95,35.95,'elevated'),(768,1784615684,31.08,31.21,33.44,33.44,'normal'),(769,1784615685,31.02,30.83,33.11,33.11,'normal'),(770,1784615686,31.04,31.11,33.21,33.21,'normal'),(771,1784615687,31.1,30.95,33.19,33.19,'normal'),(772,1784615688,31.06,30.98,36.27,36.27,'normal'),(773,1784615689,37.96,31.21,190.58,190.58,'elevated'),(774,1784615690,31.14,31,33.41,33.41,'elevated'),(775,1784615691,36.3,31.15,144.31,144.31,'elevated'),(776,1784615692,31.17,30.97,33.08,33.08,'elevated'),(777,1784615693,31.25,31.08,35.29,35.29,'elevated'),(778,1784615694,32.77,31.24,76.94,76.94,'elevated'),(779,1784615695,31.01,31.11,32.51,32.51,'elevated'),(780,1784615696,31.32,31.38,36.24,36.24,'elevated'),(781,1784615697,31.06,31,34.8,34.8,'elevated'),(782,1784615698,31.12,31.03,33.91,33.91,'elevated'),(783,1784615699,30.16,31.1,39.52,39.52,'normal'),(784,1784615700,33.92,31.29,108.2,108.2,'elevated'),(785,1784615701,31.11,31,34.14,34.14,'elevated'),(786,1784615702,31.21,31.24,33.42,33.42,'elevated'),(787,1784615703,31.16,31.06,32.83,32.83,'elevated'),(788,1784615704,33.87,31.2,94.04,94.04,'elevated'),(789,1784615705,31.2,31.44,34.7,34.7,'elevated'),(790,1784615706,31.02,31.18,36.11,36.11,'elevated'),(791,1784615707,31.17,31.13,33.51,33.51,'elevated'),(792,1784615708,31.03,31.16,35.91,35.91,'elevated'),(793,1784615709,33.34,31.44,52.33,52.33,'elevated'),(794,1784615710,37.1,31.41,71.17,71.17,'elevated'),(795,1784615711,31.21,31.26,34.73,34.73,'elevated'),(796,1784615712,30.99,31.11,34.01,34.01,'elevated'),(797,1784615713,31.2,31.16,34.21,34.21,'elevated'),(798,1784615714,30.99,31.11,34.18,34.18,'elevated'),(799,1784615715,31.15,31.23,33.85,33.85,'normal'),(800,1784615716,31.14,31.31,34.5,34.5,'normal'),(801,1784615717,31.02,30.95,36.44,36.44,'normal'),(802,1784615718,30.66,31.15,33.31,33.31,'normal'),(803,1784615719,31.1,31,33.03,33.03,'normal'),(804,1784615720,31.08,31.01,34.01,34.01,'normal'),(805,1784615721,31.16,31.08,36.7,36.7,'normal'),(806,1784615722,37.68,31.24,199.23,199.23,'elevated'),(807,1784615723,31,31.01,33.72,33.72,'elevated'),(808,1784615724,31.19,31.13,38.14,38.14,'elevated'),(809,1784615725,31.14,30.88,35.09,35.09,'elevated'),(810,1784615726,31.1,31,34.28,34.28,'elevated'),(811,1784615727,31.13,31.08,34.77,34.77,'normal'),(812,1784615728,30.64,31.24,33.72,33.72,'normal'),(813,1784615729,31.24,31.2,34.08,34.08,'normal'),(814,1784615730,31.21,31.2,34.34,34.34,'normal'),(815,1784615731,31.21,31.18,35.68,35.68,'normal'),(816,1784615732,31.25,31.16,38.08,38.08,'normal'),(817,1784615733,31.27,31.44,33.82,33.82,'normal'),(818,1784615734,31.21,31.46,33.52,33.52,'normal'),(819,1784615735,31.12,31.26,33.18,33.18,'normal'),(820,1784615736,31.8,31.24,41.35,41.35,'normal'),(821,1784615737,31.01,31.03,34.44,34.44,'normal'),(822,1784615738,30.58,31.03,32.74,32.74,'normal'),(823,1784615739,47.97,31.51,118.29,118.29,'elevated'),(824,1784615740,84.33,103.55,124.72,124.72,'elevated'),(825,1784615741,30.91,31.29,33.82,33.82,'elevated'),(826,1784615742,31.02,31.01,33.98,33.98,'elevated'),(827,1784615743,31.04,30.97,36.14,36.14,'elevated'),(828,1784615744,31.06,31.08,33.95,33.95,'elevated'),(829,1784615745,31.22,31.18,33.42,33.42,'normal'),(830,1784615746,31.3,31.18,32.65,32.65,'normal'),(831,1784615747,31,31.03,38.44,38.44,'normal'),(832,1784615748,30.55,30.92,39.71,39.71,'normal'),(833,1784615749,31.2,31.23,33.62,33.62,'normal'),(834,1784615750,47.41,31.16,199.62,199.62,'elevated'),(835,1784615751,31.03,31.39,33.05,33.05,'elevated'),(836,1784615752,32.88,31.15,82.05,82.05,'elevated'),(837,1784615753,30.96,31.16,32.06,32.06,'elevated'),(838,1784615754,31.07,31.1,32.62,32.62,'elevated'),(839,1784615755,31.17,31.23,33.34,33.34,'elevated'),(840,1784615756,30.97,30.79,35.88,35.88,'elevated'),(841,1784615757,34.14,31.41,103.61,103.61,'elevated'),(842,1784615758,31.22,31.21,37.22,37.22,'elevated'),(843,1784615759,31.27,31.2,33.95,33.95,'elevated'),(844,1784615760,31.25,31.39,34.41,34.41,'elevated'),(845,1784615761,31.18,31.21,33.05,33.05,'elevated'),(846,1784615762,31.48,30.93,49.15,49.15,'normal'),(847,1784615763,31.34,31.36,34.24,34.24,'normal'),(848,1784615764,34.44,31.18,85.66,85.66,'normal'),(849,1784615765,31.14,31.24,34.93,34.93,'normal'),(850,1784615766,32.32,31.39,57.38,57.38,'normal'),(851,1784615767,31.38,31.33,34.08,34.08,'normal'),(852,1784615768,30.64,30.79,33.91,33.91,'normal'),(853,1784615769,31.27,31.54,35.39,35.39,'normal'),(854,1784615770,31.21,31.33,33.52,33.52,'normal'),(855,1784615771,50.59,31.28,175.64,175.64,'elevated'),(856,1784615773,102.93,113.12,312.21,312.21,'critical'),(857,1784615774,31.13,31.24,34.05,34.05,'critical'),(858,1784615775,31.27,31.31,37.88,37.88,'critical'),(859,1784615776,32.46,30.97,76.81,76.81,'critical'),(860,1784615777,32.8,31.26,85,85,'critical'),(861,1784615778,32.62,30.95,88.93,88.93,'elevated'),(862,1784615779,32.43,31.36,65.47,65.47,'elevated'),(863,1784615780,31.13,31.16,32.77,32.77,'elevated'),(864,1784615781,31.23,31.24,32.65,32.65,'elevated'),(865,1784615782,31.31,31.67,37.03,37.03,'elevated'),(866,1784615783,31.2,31.41,36.04,36.04,'elevated'),(867,1784615784,31.52,31.08,45.71,45.71,'normal'),(868,1784615785,32.24,31.16,62.39,62.39,'normal'),(869,1784615786,31.16,31.11,34.47,34.47,'normal'),(870,1784615787,31.09,31,33.14,33.14,'normal'),(871,1784615788,31.2,31,34.54,34.54,'normal'),(872,1784615789,30.76,31.39,37.55,37.55,'normal'),(873,1784615790,31.06,31.08,33.59,33.59,'normal'),(874,1784615791,31.19,31.31,35.45,35.45,'normal'),(875,1784615792,31.16,31.41,37.62,37.62,'normal'),(876,1784615793,31.25,31.23,37.78,37.78,'normal'),(877,1784615794,31.09,31.23,33.55,33.55,'normal'),(878,1784615795,32.29,31.18,61.51,61.51,'normal'),(879,1784615796,31.02,31.03,36.18,36.18,'normal'),(880,1784615797,32.25,31.24,53.74,53.74,'normal'),(881,1784615798,33.85,31.41,111.35,111.35,'elevated'),(882,1784615799,30.17,31.08,34.5,34.5,'elevated'),(883,1784615800,31.21,31.24,33.59,33.59,'elevated'),(884,1784615801,31.09,31.23,32.74,32.74,'elevated'),(885,1784615802,31.25,31.26,33.59,33.59,'elevated'),(886,1784615803,33.78,31.26,114.43,114.43,'elevated'),(887,1784615804,31.04,31.24,32.75,32.75,'elevated'),(888,1784615805,31.09,31.21,32.98,32.98,'elevated'),(889,1784615806,32.48,31.01,74.65,74.65,'elevated'),(890,1784615807,31.24,31.23,32.52,32.52,'elevated'),(891,1784615808,34.48,31.13,104.73,104.73,'elevated'),(892,1784615809,31.18,30.98,32.92,32.92,'elevated'),(893,1784615810,31.15,31.29,37.06,37.06,'elevated'),(894,1784615811,31.16,31.18,33.36,33.36,'elevated'),(895,1784615812,31.21,31.31,34.54,34.54,'elevated'),(896,1784615813,31.14,31.28,35.19,35.19,'normal'),(897,1784615814,33.28,31.11,93.72,93.72,'normal'),(898,1784615815,31.67,31.42,47.35,47.35,'normal'),(899,1784615816,31.51,31.34,42.37,42.37,'normal'),(900,1784615817,32.22,31.33,54.39,54.39,'normal'),(901,1784615818,30.1,30.82,33.28,33.28,'normal'),(902,1784615819,31.21,31.26,34.01,34.01,'normal'),(903,1784615820,31.27,31.15,34.5,34.5,'normal'),(904,1784615821,31.07,31.08,32.52,32.52,'normal'),(905,1784615822,31.09,31.03,35.91,35.91,'normal'),(906,1784615823,31.09,31.05,35.09,35.09,'normal'),(907,1784615824,31.02,31.03,33.05,33.05,'normal'),(908,1784615825,32.05,31.13,59.8,59.8,'normal'),(909,1784615826,31.11,31.16,34.5,34.5,'normal'),(910,1784615827,33.48,31.1,77.86,77.86,'normal'),(911,1784615828,31.67,31.23,44.14,44.14,'normal'),(912,1784615829,31.35,31.33,34.54,34.54,'normal'),(913,1784615830,31.15,31.01,34.44,34.44,'normal'),(914,1784615831,31.2,31.26,34.01,34.01,'normal'),(915,1784615832,30.99,31.24,35.88,35.88,'normal'),(916,1784615833,31.15,31.24,35.72,35.72,'normal'),(917,1784615834,31.05,30.98,33.59,33.59,'normal'),(918,1784615835,31.01,31.01,33.29,33.29,'normal'),(919,1784615836,31.22,31.39,33.98,33.98,'normal'),(920,1784615837,30.63,31.15,33.85,33.85,'normal'),(921,1784615838,30.53,30.95,37.58,37.58,'normal'),(922,1784615839,39,31.03,231.21,231.21,'elevated'),(923,1784615840,31.22,31.21,33.33,33.33,'elevated'),(924,1784615841,31.09,31.08,32.9,32.9,'elevated'),(925,1784615842,32.98,31.36,82.58,82.58,'elevated'),(926,1784615843,31.13,31.08,34.37,34.37,'elevated'),(927,1784615844,31.73,31.06,58.16,58.16,'elevated'),(928,1784615845,31.08,31.26,34.67,34.67,'elevated'),(929,1784615846,31.23,31.24,37.62,37.62,'elevated'),(930,1784615847,33.98,31.33,106.17,106.17,'elevated'),(931,1784615848,30.55,31.05,34.7,34.7,'elevated'),(932,1784615849,31.23,31.36,33.85,33.85,'elevated'),(933,1784615850,31.2,31.23,36.77,36.77,'elevated'),(934,1784615851,36.53,31.31,145.23,145.23,'elevated'),(935,1784615852,34.56,31.29,119.28,119.28,'elevated'),(936,1784615853,31.14,31,34.64,34.64,'elevated'),(937,1784615854,31.07,31.03,33.33,33.33,'elevated'),(938,1784615855,31.22,31.23,33.59,33.59,'elevated'),(939,1784615856,31.01,31.1,35.06,35.06,'elevated'),(940,1784615857,31.03,31.08,32.23,32.23,'normal'),(941,1784615858,30.52,30.83,33,33,'normal'),(942,1784615860,31.25,31.46,32.72,32.72,'normal'),(943,1784615861,31.15,31.38,32.65,32.65,'normal'),(944,1784615862,31.27,31.23,33.88,33.88,'normal'),(945,1784615863,36.93,31.42,178.52,178.52,'elevated'),(946,1784615864,31.11,31.21,35.26,35.26,'elevated'),(947,1784615865,31.01,31.01,34.08,34.08,'elevated'),(948,1784615866,31.09,31.06,33.59,33.59,'elevated'),(949,1784615867,30.92,31.13,32.23,32.23,'elevated'),(950,1784615868,31.04,31,33.18,33.18,'normal'),(951,1784615869,29.95,31.03,32.9,32.9,'normal'),(952,1784615870,31.12,30.92,34.57,34.57,'normal'),(953,1784615871,31.09,31.03,33.75,33.75,'normal'),(954,1784615872,51.2,31.33,145.49,145.49,'elevated'),(955,1784615873,31.3,31.28,34.77,34.77,'elevated'),(956,1784615874,31.21,31.41,33.85,33.85,'elevated'),(957,1784615875,31.14,31.26,33.08,33.08,'elevated'),(958,1784615876,31.16,31.2,35.06,35.06,'elevated'),(959,1784615877,31.17,31,37.75,37.75,'normal'),(960,1784615878,31.16,31.39,32.54,32.54,'normal'),(961,1784615879,31.2,31.11,33.1,33.1,'normal'),(962,1784615880,31.33,31.29,33.31,33.31,'normal'),(963,1784615881,39.66,31.2,194.25,194.25,'elevated'),(964,1784615882,33.93,31.15,114.49,114.49,'elevated'),(965,1784615883,31.23,31.26,32.93,32.93,'elevated'),(966,1784615884,32.29,31.18,66.06,66.06,'elevated'),(967,1784615885,30.95,31,36.83,36.83,'elevated'),(968,1784615886,30.96,30.98,31.95,31.95,'elevated'),(969,1784615887,31.22,31.28,33.01,33.01,'elevated'),(970,1784615888,31.11,31.18,34.21,34.21,'elevated'),(971,1784615889,32.76,31.38,60.1,60.1,'elevated'),(972,1784615890,31.3,31.08,36.9,36.9,'elevated'),(973,1784615891,30.98,31.2,32.36,32.36,'elevated'),(974,1784615892,31.35,31.42,32.16,32.16,'elevated'),(975,1784615893,31.15,31.18,33.69,33.69,'elevated'),(976,1784615894,31.13,31.23,32.29,32.29,'normal'),(977,1784615895,31.12,31.15,34.64,34.64,'normal'),(978,1784615896,31.25,31.23,33.13,33.13,'normal'),(979,1784615897,31.14,31.16,32.52,32.52,'normal'),(980,1784615898,31.16,31.2,33.49,33.49,'normal'),(981,1784615899,31.06,31.28,36.67,36.67,'normal'),(982,1784615900,31.2,31.2,32.28,32.28,'normal'),(983,1784615901,33.83,31.08,87.62,87.62,'normal'),(984,1784615902,31.03,31.2,32.41,32.41,'normal'),(985,1784615903,32.8,31,82.38,82.38,'normal'),(986,1784615904,35.64,31.2,156.5,156.5,'elevated'),(987,1784615905,31.06,30.97,32.92,32.92,'elevated'),(988,1784615906,31.19,31.16,33.65,33.65,'elevated'),(989,1784615907,31.18,31.33,32.39,32.39,'elevated'),(990,1784615908,30.61,30.87,33.29,33.29,'elevated'),(991,1784615909,30.97,30.98,32,32,'normal'),(992,1784615910,36.16,31.54,109.25,109.25,'elevated'),(993,1784615911,31.28,31.33,38.01,38.01,'elevated'),(994,1784615912,31.2,31.23,33.78,33.78,'elevated'),(995,1784615913,31.04,30.93,33.33,33.33,'elevated'),(996,1784615914,33.74,31.28,64.65,64.65,'elevated'),(997,1784615915,31.06,31.06,38.54,38.54,'elevated'),(998,1784615916,37.01,31.2,171.7,171.7,'elevated'),(999,1784615917,31.06,30.9,34.64,34.64,'elevated'),(1000,1784615918,30.99,30.93,34.44,34.44,'elevated'),(1001,1784615919,31.92,31.1,55.12,55.12,'elevated'),(1002,1784615920,31.23,31.2,32.56,32.56,'elevated'),(1003,1784615921,32.93,31.05,66.65,66.65,'elevated'),(1004,1784615922,31.14,30.9,40.11,40.11,'elevated'),(1005,1784615923,31.09,31.15,32.75,32.75,'elevated'),(1006,1784615924,31.16,31.34,34.93,34.93,'elevated'),(1007,1784615925,31.07,31,38.24,38.24,'elevated'),(1008,1784615926,31.22,31.26,37.95,37.95,'normal'),(1009,1784615927,31.13,31.21,38.83,38.83,'normal'),(1010,1784615928,31.24,31.36,35.45,35.45,'normal'),(1011,1784615929,31.27,31.28,37.52,37.52,'normal'),(1012,1784615930,30.86,30.93,35.26,35.26,'normal'),(1013,1784615931,31.32,31.34,37.22,37.22,'normal'),(1014,1784615932,31.91,31.44,45.45,45.45,'normal'),(1015,1784615933,31.15,31.36,35,35,'normal'),(1016,1784615934,31.03,31.18,35.45,35.45,'normal'),(1017,1784615935,31.18,31.29,35.13,35.13,'normal'),(1018,1784615936,31.09,31.1,38.47,38.47,'normal'),(1019,1784615937,33.32,31.06,95.03,95.03,'normal'),(1020,1784615938,30.66,31.16,33.88,33.88,'normal'),(1021,1784615939,31.16,30.98,34.37,34.37,'normal'),(1022,1784615940,30.9,30.49,35.13,35.13,'normal'),(1023,1784615941,30.69,30.82,32.64,32.64,'normal'),(1024,1784615942,30.42,30.26,32.69,32.69,'normal'),(1025,1784615943,31.04,31,34.7,34.7,'normal'),(1026,1784615944,31.17,31.29,36.18,36.18,'normal'),(1027,1784615945,31.17,31.05,35.88,35.88,'normal'),(1028,1784615946,31.28,31.15,35.26,35.26,'normal'),(1029,1784615947,31.01,31.01,32.93,32.93,'normal'),(1030,1784615948,31.15,31.08,35.95,35.95,'normal'),(1031,1784615949,33.84,31.24,95.81,95.81,'normal'),(1032,1784615950,33.14,30.9,88.87,88.87,'normal'),(1033,1784615951,31.13,31.36,32.36,32.36,'normal'),(1034,1784615952,31.08,31.1,34.31,34.31,'normal'),(1035,1784615953,31.1,31,34.28,34.28,'normal'),(1036,1784615954,31.07,31.01,32.78,32.78,'normal'),(1037,1784615955,31.18,31.03,34.44,34.44,'normal'),(1038,1784615956,31.24,31.38,35.19,35.19,'normal'),(1039,1784615958,31.19,30.93,38.01,38.01,'normal'),(1040,1784615959,30.68,30.93,34.41,34.41,'normal'),(1041,1784615960,31.19,31.16,34.11,34.11,'normal'),(1042,1784615961,31.36,31.34,33.36,33.36,'normal'),(1043,1784615962,31.24,31.01,33.1,33.1,'normal'),(1044,1784615963,31.15,31.06,32.6,32.6,'normal'),(1045,1784615964,31.24,31.23,33.21,33.21,'normal'),(1046,1784615965,31.08,31.08,33.37,33.37,'normal'),(1047,1784615966,31.08,31.06,32.78,32.78,'normal'),(1048,1784615967,31.18,31.34,32.72,32.72,'normal'),(1049,1784615968,31.08,30.92,33.23,33.23,'normal'),(1050,1784615969,30.61,31.01,34.18,34.18,'normal'),(1051,1784615970,31.18,31.11,33.13,33.13,'normal'),(1052,1784615971,31.22,31.29,33.65,33.65,'normal'),(1053,1784615972,31.15,31.18,32.6,32.6,'normal'),(1054,1784615973,31.43,31.29,34.01,34.01,'normal'),(1055,1784615974,31.13,31,33.59,33.59,'normal'),(1056,1784615975,31.1,31.16,32.85,32.85,'normal'),(1057,1784615976,31.42,31.28,37.36,37.36,'normal'),(1058,1784615977,31.36,31.36,34.64,34.64,'normal'),(1059,1784615978,31.08,30.97,34.6,34.6,'normal'),(1060,1784615979,30.71,31.21,35.59,35.59,'normal'),(1061,1784615980,33.19,31.15,89.59,89.59,'normal'),(1062,1784615981,31.22,31.15,36.24,36.24,'normal'),(1063,1784615982,31.32,31.21,33.29,33.29,'normal'),(1064,1784615983,31.14,31.11,35,35,'normal'),(1065,1784615984,31,30.97,32.96,32.96,'normal'),(1066,1784615985,31.06,30.93,39.98,39.98,'normal'),(1067,1784615986,31.22,31.46,34.87,34.87,'normal'),(1068,1784615987,31.21,31.34,34.83,34.83,'normal'),(1069,1784615988,30.81,31.26,34.67,34.67,'normal'),(1070,1784615989,34.02,31.01,95.42,95.42,'normal'),(1071,1784615990,31.14,31.15,33.26,33.26,'normal'),(1072,1784615991,31.08,31.15,33.34,33.34,'normal'),(1073,1784615992,31.25,31.28,33.95,33.95,'normal'),(1074,1784615993,31.74,31.13,48.14,48.14,'normal'),(1075,1784615994,31.15,31.13,32.34,32.34,'normal'),(1076,1784615995,31.1,31.23,32.42,32.42,'normal'),(1077,1784615996,31.08,31.23,39.29,39.29,'normal'),(1078,1784615997,31.21,31.29,32.51,32.51,'normal'),(1079,1784615998,31.07,31.18,32.88,32.88,'normal'),(1080,1784615999,30.24,31.2,38.47,38.47,'normal'),(1081,1784616000,31.16,31.11,36.31,36.31,'normal'),(1082,1784616001,32.24,31.28,60.52,60.52,'normal'),(1083,1784616002,31.57,31.13,51.02,51.02,'normal'),(1084,1784616003,31.29,31.21,33.51,33.51,'normal'),(1085,1784616004,31.19,31.23,33.05,33.05,'normal'),(1086,1784616005,46.6,31.31,123.99,123.99,'elevated'),(1087,1784616006,30.97,31,37.36,37.36,'elevated'),(1088,1784616007,31.03,31.1,32.77,32.77,'elevated'),(1089,1784616008,30.98,31.15,34.37,34.37,'elevated'),(1090,1784616009,31.19,31.16,32.98,32.98,'elevated'),(1091,1784616010,31.15,31.13,32.34,32.34,'normal'),(1092,1784616011,31.29,31.51,33.82,33.82,'normal'),(1093,1784616012,30.94,30.8,38.6,38.6,'normal'),(1094,1784616013,31.05,31.34,32.29,32.29,'normal'),(1095,1784616014,31.1,31.03,32.37,32.37,'normal'),(1096,1784616015,31.13,31.2,33.31,33.31,'normal'),(1097,1784616016,32.1,31.05,47.42,47.42,'normal'),(1098,1784616017,34.67,31.41,111.48,111.48,'elevated'),(1099,1784616018,40.5,31.41,219.81,219.81,'elevated'),(1100,1784616019,32.65,31.08,98.3,98.3,'elevated'),(1101,1784616020,31.14,31.23,41.25,41.25,'elevated'),(1102,1784616021,31.21,31.16,35.82,35.82,'elevated'),(1103,1784616022,31.24,31.46,35.32,35.32,'elevated'),(1104,1784616023,31.17,31.08,33.47,33.47,'elevated'),(1105,1784616024,31.14,31.15,36.5,36.5,'normal'),(1106,1784616025,30.98,30.87,35.68,35.68,'normal'),(1107,1784616026,31.35,31.29,36.04,36.04,'normal'),(1108,1784616027,31.23,31.47,38.96,38.96,'normal'),(1109,1784616028,30.99,31.59,37.55,37.55,'normal'),(1110,1784616029,31.22,31.36,38.17,38.17,'normal'),(1111,1784616030,31.83,31.31,47.19,47.19,'normal'),(1112,1784616031,31.29,31.08,35.98,35.98,'normal'),(1113,1784616032,31.55,30.93,47.87,47.87,'normal'),(1114,1784616033,31.26,31.18,34.7,34.7,'normal'),(1115,1784616034,30.98,30.88,35.03,35.03,'normal'),(1116,1784616035,31.09,31.06,37.91,37.91,'normal'),(1117,1784616036,30.98,31.1,33.62,33.62,'normal'),(1118,1784616037,31.21,31.15,41.65,41.65,'normal'),(1119,1784616038,31.2,31.18,33.41,33.41,'normal'),(1120,1784616039,31.34,31.2,34.18,34.18,'normal'),(1121,1784616040,31.25,31.21,34.21,34.21,'normal'),(1122,1784616041,31.14,31.06,36.47,36.47,'normal'),(1123,1784616042,31.25,31.36,38.31,38.31,'normal'),(1124,1784616043,31.62,30.93,57.54,57.54,'normal'),(1125,1784616044,31.15,31.06,33.31,33.31,'normal'),(1126,1784616045,30.94,31.15,38.08,38.08,'normal'),(1127,1784616046,31.14,31.21,35.62,35.62,'normal'),(1128,1784616047,30.64,31.1,35.85,35.85,'normal'),(1129,1784616048,34.6,31.33,95.22,95.22,'normal'),(1130,1784616049,31.28,31.56,33.39,33.39,'normal'),(1131,1784616050,31.19,31.01,35.19,35.19,'normal'),(1132,1784616051,32.27,31.15,51.71,51.71,'normal'),(1133,1784616052,34.5,31.49,120.26,120.26,'elevated'),(1134,1784616053,31.4,31.15,36.73,36.73,'elevated'),(1135,1784616054,31.1,30.97,33.72,33.72,'elevated'),(1136,1784616055,31.02,31.06,37.78,37.78,'elevated'),(1137,1784616056,31.44,30.82,55.31,55.31,'elevated'),(1138,1784616057,31.3,31.31,42.34,42.34,'elevated'),(1139,1784616058,31.42,31.52,39.94,39.94,'elevated'),(1140,1784616059,33.39,31.72,73.86,73.86,'elevated'),(1141,1784616060,33.36,31.26,102.37,102.37,'elevated'),(1142,1784616061,31.12,31,33.82,33.82,'elevated'),(1143,1784616063,32.82,31.15,68.03,68.03,'elevated'),(1144,1784616064,31.03,30.93,32.72,32.72,'elevated'),(1145,1784616065,30.99,30.9,34.24,34.24,'elevated'),(1146,1784616066,33.33,31.36,92.21,92.21,'elevated'),(1147,1784616067,31.27,31.33,36.01,36.01,'elevated'),(1148,1784616068,31.09,31.11,32.26,32.26,'elevated'),(1149,1784616069,30.7,31.11,34.8,34.8,'elevated'),(1150,1784616070,31.2,31.23,35.49,35.49,'elevated'),(1151,1784616071,31.03,31.11,33.62,33.62,'normal'),(1152,1784616072,31.02,31.08,32.6,32.6,'normal'),(1153,1784616073,31.29,31.33,34.18,34.18,'normal'),(1154,1784616074,31.27,31.2,36.24,36.24,'normal'),(1155,1784616075,32.16,31.01,65.54,65.54,'normal'),(1156,1784616076,31.9,31.46,43.02,43.02,'normal'),(1157,1784616077,31.26,31,37.39,37.39,'normal'),(1158,1784616078,33.69,31.08,113.51,113.51,'elevated'),(1159,1784616079,31.16,31.13,32.88,32.88,'elevated'),(1160,1784616080,31.16,31.18,37.68,37.68,'elevated'),(1161,1784616081,31.1,31.18,34.01,34.01,'elevated'),(1162,1784616082,31.63,31.2,56.69,56.69,'elevated'),(1163,1784616083,31.05,30.92,34.31,34.31,'elevated'),(1164,1784616084,31.01,31.01,32.49,32.49,'elevated'),(1165,1784616085,31.28,31.26,32.65,32.65,'elevated'),(1166,1784616086,31.24,31.15,33.08,33.08,'elevated'),(1167,1784616087,31.48,31.44,38.27,38.27,'normal'),(1168,1784616088,35.55,31.26,161.61,161.61,'elevated'),(1169,1784616089,30.74,31.05,36.41,36.41,'elevated'),(1170,1784616090,31.18,31.26,32.9,32.9,'elevated'),(1171,1784616091,30.85,30.98,33.51,33.51,'elevated'),(1172,1784616092,31.38,31.33,35.88,35.88,'elevated'),(1173,1784616093,31.01,31.28,35.98,35.98,'normal'),(1174,1784616094,31.08,31.28,39.81,39.81,'normal'),(1175,1784616095,31.08,31.08,36.34,36.34,'normal'),(1176,1784616096,31.71,31.41,42.47,42.47,'normal'),(1177,1784616097,31.2,31.24,34.7,34.7,'normal'),(1178,1784616098,31.09,30.93,34.87,34.87,'normal'),(1179,1784616099,30.21,31.15,41.68,41.68,'normal'),(1180,1784616100,32.81,31.47,54.46,54.46,'normal'),(1181,1784616101,31.38,31.44,33.51,33.51,'normal'),(1182,1784616102,31.24,31.39,37.95,37.95,'normal'),(1183,1784616103,32.73,31.01,65.08,65.08,'normal'),(1184,1784616104,31.25,31.15,34.44,34.44,'normal'),(1185,1784616105,31.1,31,33.08,33.08,'normal'),(1186,1784616106,31.19,31.13,34.37,34.37,'normal'),(1187,1784616107,31.25,31.13,34.96,34.96,'normal'),(1188,1784616108,31.28,31.2,53.81,53.81,'normal'),(1189,1784616109,30.71,31.05,34.21,34.21,'normal'),(1190,1784616110,32.97,31.42,61.18,61.18,'normal'),(1191,1784616111,33.37,31.16,95.16,95.16,'normal'),(1192,1784616112,31.29,31.41,42.83,42.83,'normal'),(1193,1784616113,31.32,31.47,38.24,38.24,'normal'),(1194,1784616114,31.17,31.15,34.05,34.05,'normal'),(1195,1784616115,31.69,31.16,56.95,56.95,'normal'),(1196,1784616116,31.19,31.24,38.24,38.24,'normal'),(1197,1784616117,31.26,31.26,32.98,32.98,'normal'),(1198,1784616118,31.3,31.33,41.16,41.16,'normal'),(1199,1784616119,30.18,30.87,36.27,36.27,'normal'),(1200,1784616120,31.42,31.44,41.19,41.19,'normal'),(1201,1784616121,33.44,31.24,111.94,111.94,'elevated'),(1202,1784616122,31.12,31.06,33.85,33.85,'elevated'),(1203,1784616123,31.16,31.15,39.78,39.78,'elevated'),(1204,1784616124,31.18,31.29,33.59,33.59,'elevated'),(1205,1784616125,31.07,31.29,34.87,34.87,'elevated'),(1206,1784616126,31.18,31.38,32.39,32.39,'normal'),(1207,1784616127,31.21,31.1,33.65,33.65,'normal'),(1208,1784616128,30.81,31.1,32.33,32.33,'normal'),(1209,1784616129,31.42,31.44,34.31,34.31,'normal'),(1210,1784616130,31.07,31.13,33.59,33.59,'normal'),(1211,1784616131,31.11,31.13,34.18,34.18,'normal'),(1212,1784616132,31.15,31.05,34.57,34.57,'normal'),(1213,1784616133,31.05,31.06,32.67,32.67,'normal'),(1214,1784616134,31.04,30.97,35.26,35.26,'normal'),(1215,1784616135,32.68,31.18,74.45,74.45,'normal'),(1216,1784616136,31.01,31.23,36.83,36.83,'normal'),(1217,1784616137,30.63,31.1,40.47,40.47,'normal'),(1218,1784616138,30.85,31.16,33.62,33.62,'normal'),(1219,1784616139,31.13,31.05,33.24,33.24,'normal'),(1220,1784616140,31.16,31.28,43.38,43.38,'normal'),(1221,1784616141,31.4,31.39,32.82,32.82,'normal'),(1222,1784616142,31.21,31.16,32.78,32.78,'normal'),(1223,1784616143,31.21,31.31,33.62,33.62,'normal'),(1224,1784616144,31.08,30.88,39.98,39.98,'normal'),(1225,1784616146,31.14,31.15,34.21,34.21,'normal'),(1226,1784616147,31.19,31.1,32.49,32.49,'normal'),(1227,1784616148,31.21,31.1,35.42,35.42,'normal'),(1228,1784616149,37.06,31.26,136.45,136.45,'elevated'),(1229,1784616150,31.19,31.23,34.73,34.73,'elevated'),(1230,1784616151,33.89,31.11,108.92,108.92,'elevated'),(1231,1784616152,31.13,31.21,32.33,32.33,'elevated'),(1232,1784616153,31.09,31.06,32.1,32.1,'elevated'),(1233,1784616154,31.11,31.1,33.31,33.31,'elevated'),(1234,1784616155,31.07,31.16,33.88,33.88,'elevated'),(1235,1784616156,31.03,31.11,33.29,33.29,'normal'),(1236,1784616157,31.27,31.36,33.54,33.54,'normal'),(1237,1784616158,31.14,31.03,33.23,33.23,'normal'),(1238,1784616159,30.68,31.16,33.05,33.05,'normal'),(1239,1784616160,31.79,31.18,57.28,57.28,'normal'),(1240,1784616161,31.42,31.2,36.9,36.9,'normal'),(1241,1784616162,32.12,31.28,61.51,61.51,'normal'),(1242,1784616163,32.35,31.2,69.27,69.27,'normal'),(1243,1784616164,31.12,31.08,32.9,32.9,'normal'),(1244,1784616165,31.14,31.18,33.72,33.72,'normal'),(1245,1784616166,31.2,31.26,33.85,33.85,'normal'),(1246,1784616167,31.04,31.06,33.55,33.55,'normal'),(1247,1784616168,31.22,31.28,33.13,33.13,'normal'),(1248,1784616169,30.73,31.28,32.37,32.37,'normal'),(1249,1784616170,35.03,31.28,101.06,101.06,'elevated'),(1250,1784616171,31.09,31.11,34.11,34.11,'elevated'),(1251,1784616172,31.06,31.05,34.47,34.47,'elevated'),(1252,1784616173,31.18,31.21,32.41,32.41,'elevated'),(1253,1784616174,31.13,31.03,34.34,34.34,'elevated'),(1254,1784616175,31.11,31.1,33.78,33.78,'normal'),(1255,1784616176,31.04,30.93,34.14,34.14,'normal'),(1256,1784616177,31.08,31.18,32.74,32.74,'normal'),(1257,1784616178,31.31,31.46,35.82,35.82,'normal'),(1258,1784616179,30.78,31.51,35.36,35.36,'normal'),(1259,1784616180,31.12,31.18,34.64,34.64,'normal'),(1260,1784616181,31.18,31.26,36.31,36.31,'normal'),(1261,1784616182,31.16,31.23,33.75,33.75,'normal'),(1262,1784616183,31.17,31.34,34.9,34.9,'normal'),(1263,1784616184,33.29,31.31,85.92,85.92,'normal'),(1264,1784616185,31.09,30.95,32.85,32.85,'normal'),(1265,1784616186,34.06,31.03,93.91,93.91,'normal'),(1266,1784616187,31.4,31.33,34.24,34.24,'normal'),(1267,1784616188,31.32,31.03,34.7,34.7,'normal'),(1268,1784616189,32.2,31.24,50.3,50.3,'normal'),(1269,1784616190,31.04,31.08,33.75,33.75,'normal'),(1270,1784616191,31.12,31.01,40.47,40.47,'normal'),(1271,1784616192,31.19,31.29,32.28,32.28,'normal'),(1272,1784616193,31.14,31.2,36.86,36.86,'normal'),(1273,1784616194,31.37,31.38,33.37,33.37,'normal'),(1274,1784616195,31.1,30.98,37.22,37.22,'normal'),(1275,1784616196,31.12,30.92,33.75,33.75,'normal'),(1276,1784616197,31.25,31.24,38.17,38.17,'normal'),(1277,1784616198,30.87,31.1,33.78,33.78,'normal'),(1278,1784616199,31.21,31.16,33.03,33.03,'normal'),(1279,1784616200,31.17,31.05,34.73,34.73,'normal'),(1280,1784616201,31.26,30.98,34.7,34.7,'normal'),(1281,1784616202,31.18,31.03,36.7,36.7,'normal'),(1282,1784616203,31.74,31.44,43.58,43.58,'normal'),(1283,1784616204,31.15,31.06,33.54,33.54,'normal'),(1284,1784616205,31.15,31.31,32.59,32.59,'normal'),(1285,1784616206,32.38,31.28,56.16,56.16,'normal'),(1286,1784616207,31.21,31.23,33.54,33.54,'normal'),(1287,1784616208,32.24,31.2,70.45,70.45,'normal'),(1288,1784616209,30.68,31.11,33.75,33.75,'normal'),(1289,1784616210,31.21,31.34,38.93,38.93,'normal'),(1290,1784616211,31.73,31.36,42.34,42.34,'normal'),(1291,1784616212,31.09,31.08,38.31,38.31,'normal'),(1292,1784616213,31.22,31.38,34.31,34.31,'normal'),(1293,1784616214,31.12,31.28,37.88,37.88,'normal'),(1294,1784616215,31.18,31.11,42.01,42.01,'normal'),(1295,1784616216,31.18,31.18,37.91,37.91,'normal'),(1296,1784616217,31.21,31.11,36.9,36.9,'normal'),(1297,1784616218,31.2,31.31,34.05,34.05,'normal'),(1298,1784616219,31.26,30.82,39.58,39.58,'normal'),(1299,1784616220,31.24,31.34,36.73,36.73,'normal'),(1300,1784616221,31.25,31.2,35.45,35.45,'normal'),(1301,1784616222,31.14,31.11,39.71,39.71,'normal'),(1302,1784616223,31.05,31.24,35.72,35.72,'normal'),(1303,1784616224,31.4,31.52,33.33,33.33,'normal'),(1304,1784616225,31.07,31.03,32.75,32.75,'normal'),(1305,1784616226,31.17,31.23,33.95,33.95,'normal'),(1306,1784616227,31.32,31.23,34.96,34.96,'normal'),(1307,1784616228,30.65,30.97,34.11,34.11,'normal'),(1308,1784616229,30.6,31.05,33.59,33.59,'normal'),(1309,1784616230,31.4,31.38,36.96,36.96,'normal'),(1310,1784616231,31.24,31.29,36.47,36.47,'normal'),(1311,1784616232,31.19,31.11,34.44,34.44,'normal'),(1312,1784616233,32.21,31.11,57.67,57.67,'normal'),(1313,1784616234,31.37,31.18,40.37,40.37,'normal'),(1314,1784616235,31.22,31.24,37.06,37.06,'normal'),(1315,1784616236,31.17,31.2,33.88,33.88,'normal'),(1316,1784616237,31.15,31.03,32.96,32.96,'normal'),(1317,1784616238,30.62,30.98,36.86,36.86,'normal'),(1318,1784616239,30.86,31.05,35.59,35.59,'normal'),(1319,1784616240,31.25,31.26,34.34,34.34,'normal'),(1320,1784616241,31.21,30.95,39.22,39.22,'normal'),(1321,1784616242,31.25,31.28,41.29,41.29,'normal'),(1322,1784616243,31.52,31.46,35.06,35.06,'normal'),(1323,1784616244,31.15,31.18,32.59,32.59,'normal'),(1324,1784616245,31.28,31.34,35.75,35.75,'normal'),(1325,1784616246,31.05,30.98,39.35,39.35,'normal'),(1326,1784616247,31.26,31.24,36.86,36.86,'normal'),(1327,1784616248,30.31,30.85,34.41,34.41,'normal'),(1328,1784616249,31.22,31.21,37.78,37.78,'normal'),(1329,1784616250,31.26,31.31,35.65,35.65,'normal'),(1330,1784616251,31.32,31.23,35.09,35.09,'normal'),(1331,1784616253,31.03,31,33.08,33.08,'normal'),(1332,1784616254,31.18,31.13,33.88,33.88,'normal'),(1333,1784616255,31.21,31.1,33.08,33.08,'normal'),(1334,1784616256,31.02,31.23,33.98,33.98,'normal'),(1335,1784616257,37.33,31.18,143.79,143.79,'elevated'),(1336,1784616258,31.25,31.21,37.72,37.72,'elevated'),(1337,1784616259,30.99,30.77,36.37,36.37,'elevated'),(1338,1784616260,31.05,31.03,34.64,34.64,'elevated'),(1339,1784616261,31.13,31.06,36.57,36.57,'elevated'),(1340,1784616262,32.73,30.95,66.52,66.52,'elevated'),(1341,1784616263,32.13,31.1,55.18,55.18,'elevated'),(1342,1784616264,31.13,31.18,34.5,34.5,'elevated'),(1343,1784616265,32.21,31.08,67.24,67.24,'elevated'),(1344,1784616266,31.12,30.93,33,33,'elevated'),(1345,1784616267,31.22,31.34,32.41,32.41,'elevated'),(1346,1784616268,31.19,31.21,33.52,33.52,'elevated'),(1347,1784616269,30.8,31.36,33.01,33.01,'elevated'),(1348,1784616270,31.18,31.34,35.95,35.95,'normal'),(1349,1784616271,31.18,31.21,35.09,35.09,'normal'),(1350,1784616272,31.19,31.24,36.77,36.77,'normal'),(1351,1784616273,31.27,31.33,35.06,35.06,'normal'),(1352,1784616274,31.07,30.9,34.87,34.87,'normal'),(1353,1784616275,33.35,31.2,102.04,102.04,'elevated'),(1354,1784616276,31.08,31.08,35.91,35.91,'elevated'),(1355,1784616277,31.2,31.26,33.51,33.51,'elevated'),(1356,1784616278,31.11,31.1,35.85,35.85,'elevated'),(1357,1784616279,30.67,31.1,33.37,33.37,'elevated'),(1358,1784616280,31.06,30.95,35.78,35.78,'normal'),(1359,1784616281,31.03,31.01,32.28,32.28,'normal'),(1360,1784616282,31.22,31.18,38.27,38.27,'normal'),(1361,1784616283,31.2,31.2,33.91,33.91,'normal'),(1362,1784616284,31.16,31.1,33.72,33.72,'normal'),(1363,1784616285,31.11,31,33.28,33.28,'normal'),(1364,1784616286,31.1,31.21,36.18,36.18,'normal'),(1365,1784616287,31.05,31.24,34.21,34.21,'normal'),(1366,1784616288,37.24,31.01,125.44,125.44,'elevated'),(1367,1784616289,30.34,31.16,32.77,32.77,'elevated'),(1368,1784616290,61.51,32.65,196.48,196.48,'elevated'),(1369,1784616291,75.2,38.73,150.99,150.99,'elevated'),(1370,1784616292,40.57,31.29,118.42,118.42,'elevated'),(1371,1784616293,31.27,31.38,33.28,33.28,'elevated'),(1372,1784616294,31.17,31.38,36.18,36.18,'elevated'),(1373,1784616295,31.07,31.13,35.75,35.75,'elevated'),(1374,1784616296,31.05,30.97,34.24,34.24,'elevated'),(1375,1784616297,31.1,31.16,32.24,32.24,'normal'),(1376,1784616298,31.13,31.08,35.23,35.23,'normal'),(1377,1784616299,30.56,31.06,36.8,36.8,'normal'),(1378,1784616300,32.56,31.29,58.26,58.26,'normal'),(1379,1784616301,31.01,31.05,32.96,32.96,'normal'),(1380,1784616302,31.12,31.15,34.05,34.05,'normal'),(1381,1784616303,31.04,30.92,33.01,33.01,'normal'),(1382,1784616304,31.07,31.16,37.39,37.39,'normal'),(1383,1784616305,31.15,31.24,32.42,32.42,'normal'),(1384,1784616306,31.12,31.03,33.59,33.59,'normal'),(1385,1784616307,31.14,31.01,32,32,'normal'),(1386,1784616308,31.2,31.21,32.56,32.56,'normal'),(1387,1784616309,30.14,30.93,32.96,32.96,'normal'),(1388,1784616310,38.31,31.29,156.5,156.5,'elevated'),(1389,1784616311,31.39,31.42,33.88,33.88,'elevated'),(1390,1784616312,31.26,31.51,41.35,41.35,'elevated'),(1391,1784616313,31.67,31.29,42.5,42.5,'elevated'),(1392,1784616314,31.14,30.93,32.98,32.98,'elevated'),(1393,1784616315,31.04,31.05,34.37,34.37,'normal'),(1394,1784616316,31.21,31.28,32.28,32.28,'normal'),(1395,1784616317,31.19,31.29,32.34,32.34,'normal'),(1396,1784616318,31.19,31.08,33.82,33.82,'normal'),(1397,1784616319,31.65,31.36,46.27,46.27,'normal'),(1398,1784616320,31.45,31.42,36.47,36.47,'normal'),(1399,1784616321,31.03,30.75,36.44,36.44,'normal'),(1400,1784616322,35.88,31.13,114.75,114.75,'elevated'),(1401,1784616323,31.19,31.03,36.21,36.21,'elevated'),(1402,1784616324,33.31,31.11,96.53,96.53,'elevated'),(1403,1784616325,31.27,31.24,36.41,36.41,'elevated'),(1404,1784616326,31.18,31.05,37.16,37.16,'elevated'),(1405,1784616327,30.99,31.03,34.01,34.01,'elevated'),(1406,1784616329,38.91,31.52,146.93,146.93,'elevated'),(1407,1784616330,31.29,31.31,34.77,34.77,'elevated'),(1408,1784616331,31.23,31.33,32.52,32.52,'elevated'),(1409,1784616332,31.11,31.44,35.52,35.52,'elevated'),(1410,1784616333,31.11,31.1,32.26,32.26,'elevated'),(1411,1784616334,31.19,31.29,35.91,35.91,'normal'),(1412,1784616335,31.11,31.01,34.6,34.6,'normal'),(1413,1784616336,32.97,31.11,87.16,87.16,'normal'),(1414,1784616337,31.11,31.06,33.95,33.95,'normal'),(1415,1784616338,31.2,31.13,33.95,33.95,'normal'),(1416,1784616339,31.01,31.28,38.04,38.04,'normal'),(1417,1784616340,34.04,31.42,73.33,73.33,'normal'),(1418,1784616341,31.19,31.33,33.41,33.41,'normal'),(1419,1784616342,31.3,31.34,32.88,32.88,'normal'),(1420,1784616343,31,31.13,33.88,33.88,'normal'),(1421,1784616344,34.83,31.08,132.06,132.06,'elevated'),(1422,1784616345,31.05,30.87,33.29,33.29,'elevated'),(1423,1784616346,31.15,31.2,33.98,33.98,'elevated'),(1424,1784616347,31.76,31.16,44.07,44.07,'elevated'),(1425,1784616348,31.4,31.41,52.46,52.46,'elevated'),(1426,1784616349,30.21,31.16,34.21,34.21,'elevated'),(1427,1784616350,33.35,31.18,66.58,66.58,'elevated'),(1428,1784616351,34.62,31.29,92.41,92.41,'elevated'),(1429,1784616352,31.1,31.11,32.52,32.52,'elevated'),(1430,1784616353,31.11,31.06,31.95,31.95,'elevated'),(1431,1784616354,31.08,31.08,36.77,36.77,'elevated'),(1432,1784616355,32.8,31.21,79.82,79.82,'elevated'),(1433,1784616356,31.4,31.42,32.62,32.62,'elevated'),(1434,1784616357,31.13,31.29,33.82,33.82,'elevated'),(1435,1784616358,31.19,31.28,34.05,34.05,'elevated'),(1436,1784616359,30.63,31.08,38.31,38.31,'elevated'),(1437,1784616360,31.1,31.21,36.24,36.24,'normal'),(1438,1784616361,31.41,31.33,34.47,34.47,'normal'),(1439,1784616362,30.99,30.9,33.46,33.46,'normal'),(1440,1784616363,31.28,31.42,36.14,36.14,'normal'),(1441,1784616364,31.13,31.36,39.55,39.55,'normal'),(1442,1784616365,31.17,31.13,37.85,37.85,'normal'),(1443,1784616366,31.01,31,32.34,32.34,'normal'),(1444,1784616367,33.3,31.1,98.44,98.44,'normal'),(1445,1784616368,33.37,31.2,94.77,94.77,'normal'),(1446,1784616369,30.82,31.29,34.21,34.21,'normal'),(1447,1784616370,31.18,31.16,35.59,35.59,'normal'),(1448,1784616371,31.15,31.28,33.69,33.69,'normal'),(1449,1784616372,31.17,31.08,33.13,33.13,'normal'),(1450,1784616373,31.32,31.31,37.45,37.45,'normal'),(1451,1784616374,31.09,31.15,32.29,32.29,'normal'),(1452,1784616375,31.09,31.1,33.51,33.51,'normal'),(1453,1784616376,33.22,31.15,71.37,71.37,'normal'),(1454,1784616377,30.94,31,33.82,33.82,'normal'),(1455,1784616378,34.67,30.95,139.33,139.33,'elevated'),(1456,1784616379,36.62,31.46,174.98,174.98,'elevated'),(1457,1784616380,31.05,31.1,33.82,33.82,'elevated'),(1458,1784616381,31.15,31.13,32.88,32.88,'elevated'),(1459,1784616382,31.25,31.28,34.08,34.08,'elevated'),(1460,1784616383,31.1,31.2,31.93,31.93,'elevated'),(1461,1784616384,31.18,31.15,32.59,32.59,'normal'),(1462,1784616385,31.15,31.05,33.18,33.18,'normal'),(1463,1784616386,30.9,30.93,33.11,33.11,'normal'),(1464,1784616387,31.11,31.11,33.78,33.78,'normal'),(1465,1784616388,31.06,30.88,34.8,34.8,'normal'),(1466,1784616389,30.25,31.26,34.83,34.83,'normal'),(1467,1784616390,31.18,31.1,34.31,34.31,'normal'),(1468,1784616391,31.26,31.26,37.72,37.72,'normal'),(1469,1784616392,35.92,31.33,167.9,167.9,'elevated'),(1470,1784616393,31.03,31.08,34.24,34.24,'elevated'),(1471,1784616394,42.61,31.7,161.48,161.48,'elevated'),(1472,1784616395,31.15,31.11,36.77,36.77,'elevated'),(1473,1784616396,31.18,31.15,34.73,34.73,'elevated'),(1474,1784616397,31.07,31.08,36.93,36.93,'elevated'),(1475,1784616398,31.05,31.23,34.31,34.31,'elevated'),(1476,1784616399,31.22,31.28,34.7,34.7,'normal'),(1477,1784616400,36.79,31.05,187.43,187.43,'elevated'),(1478,1784616401,43,31.03,124.72,124.72,'elevated'),(1479,1784616402,31.12,31.28,34.54,34.54,'elevated'),(1480,1784616403,31.23,31.29,33.31,33.31,'elevated'),(1481,1784616404,31.18,31.18,34.41,34.41,'elevated'),(1482,1784616405,30.88,30.9,34.8,34.8,'elevated'),(1483,1784616406,31.15,31.23,34.9,34.9,'normal'),(1484,1784616407,30.65,30.93,40.21,40.21,'normal'),(1485,1784616408,30.9,30.88,33.18,33.18,'normal'),(1486,1784616409,30.76,31.13,33.44,33.44,'normal'),(1487,1784616410,31.12,31.23,35.88,35.88,'normal'),(1488,1784616411,31.83,31.18,59.51,59.51,'normal'),(1489,1784616412,31.05,30.92,35.65,35.65,'normal'),(1490,1784616413,31.2,31.08,33.19,33.19,'normal'),(1491,1784616414,31.19,31.1,35.75,35.75,'normal'),(1492,1784616415,31.09,30.97,35.49,35.49,'normal'),(1493,1784616416,34.57,31.21,121.37,121.37,'elevated'),(1494,1784616417,32.67,31.1,88.15,88.15,'elevated'),(1495,1784616419,30.97,31.05,33.82,33.82,'elevated'),(1496,1784616420,31.1,30.98,36.47,36.47,'elevated'),(1497,1784616421,31.04,31.41,33.82,33.82,'elevated'),(1498,1784616422,31.1,31.15,38.44,38.44,'elevated'),(1499,1784616423,31.09,31.39,33.34,33.34,'normal'),(1500,1784616424,31.32,31.33,36.01,36.01,'normal'),(1501,1784616425,31.37,31.34,35.65,35.65,'normal'),(1502,1784616426,31.11,31.01,38.11,38.11,'normal'),(1503,1784616427,31.14,31.06,36.57,36.57,'normal'),(1504,1784616428,31.92,31.57,49.94,49.94,'normal'),(1505,1784616429,30.69,31.28,37.26,37.26,'normal'),(1506,1784616430,31.18,31.11,35.09,35.09,'normal'),(1507,1784616431,32.78,30.83,83.23,83.23,'normal'),(1508,1784616432,31.26,31.24,33.65,33.65,'normal'),(1509,1784616433,32.24,31.62,56.79,56.79,'normal'),(1510,1784616434,31.27,31.2,33.06,33.06,'normal'),(1511,1784616435,31.06,31.23,33.72,33.72,'normal'),(1512,1784616436,31.23,31.33,33.13,33.13,'normal'),(1513,1784616437,31.17,30.88,35.26,35.26,'normal'),(1514,1784616438,31.08,31.01,34.64,34.64,'normal'),(1515,1784616439,30.29,31.2,33.59,33.59,'normal'),(1516,1784616440,31.18,31.16,35,35,'normal'),(1517,1784616441,31.08,31.15,34.08,34.08,'normal'),(1518,1784616442,31.31,31.36,32.69,32.69,'normal'),(1519,1784616443,31.27,31.16,33.1,33.1,'normal'),(1520,1784616444,31.15,31.15,34.7,34.7,'normal'),(1521,1784616445,31.18,31.28,34.44,34.44,'normal'),(1522,1784616446,31.07,30.98,34.47,34.47,'normal'),(1523,1784616447,31.17,31.2,33.55,33.55,'normal'),(1524,1784616448,31.24,31.49,37.42,37.42,'normal'),(1525,1784616449,30.62,30.85,39.75,39.75,'normal'),(1526,1784616450,31.26,31.38,32.57,32.57,'normal'),(1527,1784616451,31.67,31.69,34.47,34.47,'normal'),(1528,1784616452,31.18,31.24,31.92,31.92,'normal'),(1529,1784616453,31.18,31.05,37.22,37.22,'normal'),(1530,1784616454,31.25,31.24,33.11,33.11,'normal'),(1531,1784616455,31.1,31.08,33.31,33.31,'normal'),(1532,1784616456,31.25,31.13,39.32,39.32,'normal'),(1533,1784616457,31.18,31.15,36.73,36.73,'normal'),(1534,1784616458,31.16,30.98,34.6,34.6,'normal'),(1535,1784616459,30.61,31.23,36.27,36.27,'normal'),(1536,1784616460,30.97,31.23,37,37,'normal'),(1537,1784616461,31.35,31.36,35.59,35.59,'normal'),(1538,1784616462,31.21,31.29,33.19,33.19,'normal'),(1539,1784616463,31.08,31.05,33.55,33.55,'normal'),(1540,1784616464,31.17,31.01,40.08,40.08,'normal'),(1541,1784616465,31.04,30.97,34.54,34.54,'normal'),(1542,1784616466,31.3,31.47,41.25,41.25,'normal'),(1543,1784616467,31.19,30.92,34.41,34.41,'normal'),(1544,1784616468,30.76,30.95,33.08,33.08,'normal'),(1545,1784616469,32.3,31.36,49.91,49.91,'normal'),(1546,1784616470,31.17,31.05,40.27,40.27,'normal'),(1547,1784616471,32.2,31.05,67.57,67.57,'normal'),(1548,1784616472,31.81,31.28,51.15,51.15,'normal'),(1549,1784616473,31.13,31.16,35.36,35.36,'normal'),(1550,1784616474,31.15,31.21,33.23,33.23,'normal'),(1551,1784616475,31.27,31.39,39.19,39.19,'normal'),(1552,1784616476,31.23,31.18,36.24,36.24,'normal'),(1553,1784616477,31.19,31.18,32.18,32.18,'normal'),(1554,1784616478,31.21,31.13,35.78,35.78,'normal'),(1555,1784616479,30.8,31.34,35.78,35.78,'normal'),(1556,1784616480,31.36,31.21,35.68,35.68,'normal'),(1557,1784616481,31.8,31.21,58.06,58.06,'normal'),(1558,1784616482,31.29,31.11,35.49,35.49,'normal'),(1559,1784616483,31.34,31.54,34.11,34.11,'normal'),(1560,1784616484,31.53,31.05,43.81,43.81,'normal'),(1561,1784616485,31.14,31.11,35.59,35.59,'normal'),(1562,1784616486,31.22,31.2,33.26,33.26,'normal'),(1563,1784616487,31.41,31.34,33.28,33.28,'normal'),(1564,1784616488,31.33,31.33,37.88,37.88,'normal'),(1565,1784616489,30.3,31.1,32.51,32.51,'normal'),(1566,1784616490,31.29,31.24,42.47,42.47,'normal'),(1567,1784616491,31.49,31.57,38.08,38.08,'normal'),(1568,1784616492,31.4,31.2,42.07,42.07,'normal'),(1569,1784616493,31.02,31.23,33.65,33.65,'normal'),(1570,1784616494,32.1,31.08,55.44,55.44,'normal'),(1571,1784616495,31.18,31.28,34.7,34.7,'normal'),(1572,1784616496,31.14,31.16,32.11,32.11,'normal'),(1573,1784616497,31.45,31.38,33.78,33.78,'normal'),(1574,1784616498,31.15,31.2,33.98,33.98,'normal'),(1575,1784616499,31.32,31.44,32.56,32.56,'normal'),(1576,1784616500,31.14,31.01,34.14,34.14,'normal'),(1577,1784616501,31.13,31.01,32.98,32.98,'normal'),(1578,1784616502,31.11,31.1,37.91,37.91,'normal'),(1579,1784616503,31.46,31.39,36.37,36.37,'normal'),(1580,1784616504,32.24,31.31,59.77,59.77,'normal'),(1581,1784616505,31.13,31.24,33,33,'normal'),(1582,1784616506,31.15,31,37.42,37.42,'normal'),(1583,1784616507,31.3,31.44,36.27,36.27,'normal'),(1584,1784616508,31.09,31.21,33.78,33.78,'normal'),(1585,1784616509,30.6,31.36,34.8,34.8,'normal'),(1586,1784616510,31.21,30.95,35.59,35.59,'normal'),(1587,1784616511,31.19,31.31,32.83,32.83,'normal'),(1588,1784616512,31.28,31.44,33.24,33.24,'normal'),(1589,1784616513,30.98,31.26,33.39,33.39,'normal'),(1590,1784616514,31.06,31.06,33.62,33.62,'normal'),(1591,1784616515,31.27,31.34,32.67,32.67,'normal'),(1592,1784616516,31.14,31.06,32.85,32.85,'normal'),(1593,1784616517,31.18,31.2,32.96,32.96,'normal'),(1594,1784616518,31.07,31.18,32.88,32.88,'normal'),(1595,1784616519,31.11,31,33.55,33.55,'normal'),(1596,1784616520,31.84,31.33,42.17,42.17,'normal'),(1597,1784616521,31.15,31.24,32.08,32.08,'normal'),(1598,1784616522,31.2,31.11,36.6,36.6,'normal'),(1599,1784616523,31.18,31.15,34.14,34.14,'normal'),(1600,1784616524,31.09,31.01,32.39,32.39,'normal'),(1601,1784616525,31.11,31.13,33.06,33.06,'normal'),(1602,1784616526,31.06,30.95,32.24,32.24,'normal'),(1603,1784616527,30.8,31.06,34.24,34.24,'normal'),(1604,1784616528,31.6,31.15,45.55,45.55,'normal'),(1605,1784616529,30.7,31.13,35.36,35.36,'normal'),(1606,1784616531,31.14,31.18,36.24,36.24,'normal'),(1607,1784616532,31.31,31.46,37.98,37.98,'normal'),(1608,1784616533,30.88,30.8,34.08,34.08,'normal'),(1609,1784616534,30.85,30.97,31.69,31.69,'normal'),(1610,1784616535,30.75,30.67,31.75,31.75,'normal'),(1611,1784616536,30.76,30.74,32.39,32.39,'normal'),(1612,1784616537,30.83,30.98,37.68,37.68,'normal'),(1613,1784616538,30.3,30.13,32.31,32.31,'normal'),(1614,1784616539,30.27,30.13,31.97,31.97,'normal'),(1615,1784616540,29.81,30.05,33.37,33.37,'normal'),(1616,1784616541,30.73,30.85,32.06,32.06,'normal'),(1617,1784616542,30.75,30.9,31.8,31.8,'normal'),(1618,1784616543,30.29,30.29,32.06,32.06,'normal'),(1619,1784616544,30.37,30.11,39.39,39.39,'normal'),(1620,1784616545,30.78,30.65,32.57,32.57,'normal'),(1621,1784616546,30.74,30.65,33.88,33.88,'normal'),(1622,1784616547,30.87,30.85,34.28,34.28,'normal'),(1623,1784616548,31.04,31.18,34.44,34.44,'normal'),(1624,1784616549,31.06,31.08,32.46,32.46,'normal'),(1625,1784616550,31.44,31.15,48.5,48.5,'normal'),(1626,1784616551,31.25,31.31,32.9,32.9,'normal'),(1627,1784616552,31.45,31.56,36.08,36.08,'normal'),(1628,1784616553,31.32,31.29,33.21,33.21,'normal'),(1629,1784616554,31.26,31.08,33.82,33.82,'normal'),(1630,1784616555,31.2,31.06,35.68,35.68,'normal'),(1631,1784616556,31.07,31.03,34.21,34.21,'normal'),(1632,1784616557,34.61,31.05,131.79,131.79,'elevated'),(1633,1784616558,31.34,31.54,34.5,34.5,'elevated'),(1634,1784616559,31.04,31.41,32.74,32.74,'elevated'),(1635,1784616560,31.21,31.21,33.11,33.11,'elevated'),(1636,1784616561,31.14,31.11,37.91,37.91,'elevated'),(1637,1784616562,31.43,31.57,33.24,33.24,'normal'),(1638,1784616563,31.05,31.18,36.63,36.63,'normal'),(1639,1784616564,31.35,31.56,33.95,33.95,'normal'),(1640,1784616565,31.3,31.46,34.37,34.37,'normal'),(1641,1784616566,31,31.26,33.21,33.21,'normal'),(1642,1784616567,31.13,31.29,38.83,38.83,'normal'),(1643,1784616568,31.39,31.46,34.14,34.14,'normal'),(1644,1784616569,30.67,31,35.49,35.49,'normal'),(1645,1784616570,31.28,31.18,34.7,34.7,'normal'),(1646,1784616571,31.44,31.54,38.24,38.24,'normal'),(1647,1784616572,31.17,31.23,33.42,33.42,'normal'),(1648,1784616573,31.25,31.31,32.65,32.65,'normal'),(1649,1784616574,32.76,31.18,85.07,85.07,'normal'),(1650,1784616575,31.27,31.16,33.41,33.41,'normal'),(1651,1784616576,31.17,31.13,32.15,32.15,'normal'),(1652,1784616577,31.22,31.33,34.64,34.64,'normal'),(1653,1784616578,31.18,31.13,33.19,33.19,'normal'),(1654,1784616579,31.42,31.42,33.1,33.1,'normal'),(1655,1784616580,31.58,31.7,33.72,33.72,'normal'),(1656,1784616581,31.46,31.38,34.64,34.64,'normal'),(1657,1784616582,31.49,31.6,35.59,35.59,'normal'),(1658,1784616583,31.3,31.21,35.19,35.19,'normal'),(1659,1784616584,31.23,31.23,33.24,33.24,'normal'),(1660,1784616585,30.97,31.1,32.77,32.77,'normal'),(1661,1784616586,31.12,31.1,35.52,35.52,'normal'),(1662,1784616587,31.09,31.08,34.01,34.01,'normal'),(1663,1784616588,31.14,31.06,36.04,36.04,'normal'),(1664,1784616589,31.25,31.36,34.44,34.44,'normal'),(1665,1784616590,31.21,31.26,33.11,33.11,'normal'),(1666,1784616591,31.13,31.2,33.75,33.75,'normal'),(1667,1784616592,31.15,31.08,32.39,32.39,'normal'),(1668,1784616593,31.25,31.15,34.21,34.21,'normal'),(1669,1784616594,31.27,31.21,33.31,33.31,'normal'),(1670,1784616595,31.27,31.2,34.6,34.6,'normal'),(1671,1784616596,31.2,31.13,64.45,64.45,'normal'),(1672,1784616597,31.22,31.24,33.23,33.23,'normal'),(1673,1784616598,31.15,31.13,33.98,33.98,'normal'),(1674,1784616599,31.1,31.06,35.36,35.36,'normal'),(1675,1784616600,31.22,31.34,38.17,38.17,'normal'),(1676,1784616601,31.12,31.18,33.14,33.14,'normal'),(1677,1784616602,31.08,30.97,33.98,33.98,'normal'),(1678,1784616603,31.19,31.24,34.83,34.83,'normal'),(1679,1784616604,31.07,31.08,32.93,32.93,'normal'),(1680,1784616605,31.53,31.05,44.73,44.73,'normal'),(1681,1784616606,31.22,31.24,32.21,32.21,'normal'),(1682,1784616607,31.08,31.13,32.37,32.37,'normal'),(1683,1784616608,31.35,31.24,32.72,32.72,'normal'),(1684,1784616609,30.83,31.39,32.8,32.8,'normal'),(1685,1784616610,31.31,31.36,35.06,35.06,'normal'),(1686,1784616611,31.32,31.38,35.95,35.95,'normal'),(1687,1784616612,31.34,31.36,33.72,33.72,'normal'),(1688,1784616613,31.15,31.21,34.96,34.96,'normal'),(1689,1784616614,31.28,31.2,32.9,32.9,'normal'),(1690,1784616615,31.11,31.18,32.51,32.51,'normal'),(1691,1784616616,31.18,31.2,32.11,32.11,'normal'),(1692,1784616617,31.89,31.57,42.8,42.8,'normal'),(1693,1784616618,31.02,31.01,35.82,35.82,'normal'),(1694,1784616619,31.22,31.28,36.7,36.7,'normal'),(1695,1784616620,31.33,31.47,33.85,33.85,'normal'),(1696,1784616621,31.27,31.29,33.21,33.21,'normal'),(1697,1784616622,31.19,31.36,32.56,32.56,'normal'),(1698,1784616623,31.23,31.29,35.23,35.23,'normal'),(1699,1784616624,31.05,31.08,34.05,34.05,'normal'),(1700,1784616625,31.08,31.13,32.65,32.65,'normal'),(1701,1784616626,31.22,31.15,32.95,32.95,'normal'),(1702,1784616627,31.19,31.1,35.75,35.75,'normal'),(1703,1784616628,31.2,31.1,33.72,33.72,'normal'),(1704,1784616629,30.72,31.01,33.82,33.82,'normal'),(1705,1784616630,31.38,31.24,38.4,38.4,'normal'),(1706,1784616631,31.39,31.34,38.11,38.11,'normal'),(1707,1784616632,31.31,31.16,32.74,32.74,'normal'),(1708,1784616633,31.33,31.29,33.49,33.49,'normal'),(1709,1784616634,31.17,31.24,33.54,33.54,'normal'),(1710,1784616635,31.22,31.13,33.88,33.88,'normal'),(1711,1784616636,31.18,31.1,35.03,35.03,'normal'),(1712,1784616637,31.21,31.34,34.28,34.28,'normal'),(1713,1784616638,31.48,31.59,32.72,32.72,'normal'),(1714,1784616639,30.98,31.29,37.62,37.62,'normal'),(1715,1784616640,31.23,31.15,32.9,32.9,'normal'),(1716,1784616641,31.22,31.16,32.39,32.39,'normal'),(1717,1784616642,31.28,31.33,34.7,34.7,'normal'),(1718,1784616643,31.22,31.31,33.62,33.62,'normal'),(1719,1784616644,31.2,31.28,35.75,35.75,'normal'),(1720,1784616645,31.21,31.24,32.29,32.29,'normal'),(1721,1784616646,31.27,31.26,34.83,34.83,'normal'),(1722,1784616647,31.21,31.11,32.98,32.98,'normal'),(1723,1784616648,31.23,31.26,35.19,35.19,'normal'),(1724,1784616649,30.29,30.97,32.52,32.52,'normal'),(1725,1784616650,31.37,31.42,36.44,36.44,'normal'),(1726,1784616651,32.3,31.18,73.01,73.01,'normal'),(1727,1784616652,31.35,31.44,33.51,33.51,'normal'),(1728,1784616654,31.36,31.41,33.31,33.31,'normal'),(1729,1784616655,31.27,31.31,33.52,33.52,'normal'),(1730,1784616656,31.3,31.21,33.34,33.34,'normal'),(1731,1784616657,31.43,31.42,32.78,32.78,'normal'),(1732,1784616658,31.35,31.28,35.75,35.75,'normal'),(1733,1784616659,31.13,31.11,37.75,37.75,'normal'),(1734,1784616660,31.44,31.38,33.88,33.88,'normal'),(1735,1784616661,31.29,31.31,34.11,34.11,'normal'),(1736,1784616662,31.41,31.49,33.75,33.75,'normal'),(1737,1784616663,31.36,31.33,33.98,33.98,'normal'),(1738,1784616664,31.42,31.41,33.78,33.78,'normal'),(1739,1784616665,31.45,31.39,35.29,35.29,'normal'),(1740,1784616666,31.13,31.1,36.04,36.04,'normal'),(1741,1784616667,31.15,31.13,36.21,36.21,'normal'),(1742,1784616668,31.39,31.24,35.72,35.72,'normal'),(1743,1784616669,31.08,30.92,33.41,33.41,'normal'),(1744,1784616670,30.83,31.33,33.75,33.75,'normal'),(1745,1784616671,31.4,31.44,33.05,33.05,'normal'),(1746,1784616672,31.44,31.39,33.47,33.47,'normal'),(1747,1784616673,31.28,31.2,35.52,35.52,'normal'),(1748,1784616674,31.47,31.23,36.63,36.63,'normal'),(1749,1784616675,31.22,31.05,34.44,34.44,'normal'),(1750,1784616676,31.27,31.29,32.83,32.83,'normal'),(1751,1784616677,31.21,31.05,32.62,32.62,'normal'),(1752,1784616678,30.74,31.26,32.18,32.18,'normal'),(1753,1784616679,31.24,31.18,34.24,34.24,'normal'),(1754,1784616680,30.34,31.1,33.26,33.26,'normal'),(1755,1784616681,31.17,31.2,37.72,37.72,'normal'),(1756,1784616682,31.19,31.26,33.88,33.88,'normal'),(1757,1784616683,31.35,31.31,32.98,32.98,'normal'),(1758,1784616684,31.57,31.6,33.55,33.55,'normal'),(1759,1784616685,31.33,31.24,33.03,33.03,'normal'),(1760,1784616686,31.2,30.93,33.62,33.62,'normal'),(1761,1784616687,31.28,31.33,32.65,32.65,'normal'),(1762,1784616688,31.12,31.1,33.65,33.65,'normal'),(1763,1784616689,30.84,31.29,33.26,33.26,'normal'),(1764,1784616690,31.41,31.51,36.67,36.67,'normal'),(1765,1784616691,31.34,31.47,32.74,32.74,'normal'),(1766,1784616692,31.21,31.38,32.74,32.74,'normal'),(1767,1784616693,31.19,31.06,32.82,32.82,'normal'),(1768,1784616694,31.29,31.38,32.75,32.75,'normal'),(1769,1784616695,31.17,31.23,32.67,32.67,'normal'),(1770,1784616696,31.06,31.03,32.37,32.37,'normal'),(1771,1784616697,31.22,31.24,32.49,32.49,'normal'),(1772,1784616698,31.16,31.15,33.36,33.36,'normal'),(1773,1784616699,30.86,31.38,32.51,32.51,'normal'),(1774,1784616700,31.37,31.31,35.39,35.39,'normal'),(1775,1784616701,31.41,31.31,38.27,38.27,'normal'),(1776,1784616702,31.28,31.34,32.47,32.47,'normal'),(1777,1784616703,31.15,31.06,33.01,33.01,'normal'),(1778,1784616704,31.39,31.33,34.73,34.73,'normal'),(1779,1784616705,31.18,31.31,32.98,32.98,'normal'),(1780,1784616706,31.13,31.13,32.82,32.82,'normal'),(1781,1784616707,31.2,31.24,31.93,31.93,'normal'),(1782,1784616708,31.72,31.24,44.89,44.89,'normal'),(1783,1784616709,30.79,31.13,35.19,35.19,'normal'),(1784,1784616710,31.33,31.39,33.91,33.91,'normal'),(1785,1784616711,31.26,31.26,32.65,32.65,'normal'),(1786,1784616712,31.08,31.24,36.04,36.04,'normal'),(1787,1784616713,31.17,31.26,34.18,34.18,'normal'),(1788,1784616714,31.27,31.36,34.57,34.57,'normal'),(1789,1784616715,31.22,31.28,32.9,32.9,'normal'),(1790,1784616716,31.82,31.54,45.12,45.12,'normal'),(1791,1784616717,31.29,31.16,34.14,34.14,'normal'),(1792,1784616718,31.23,31.29,35.59,35.59,'normal'),(1793,1784616719,30.77,31.18,32.93,32.93,'normal'),(1794,1784616720,31.11,31.13,32.15,32.15,'normal'),(1795,1784616721,31.27,31.46,33.54,33.54,'normal'),(1796,1784616722,31.32,31.26,33.13,33.13,'normal'),(1797,1784616723,31.4,31.56,36.47,36.47,'normal'),(1798,1784616724,31.14,31.15,34.54,34.54,'normal'),(1799,1784616725,31.21,31.36,32.85,32.85,'normal'),(1800,1784616726,31.2,31.33,32.78,32.78,'normal'),(1801,1784616727,31.32,31.38,32.98,32.98,'normal'),(1802,1784616728,31.31,31.24,34.83,34.83,'normal'),(1803,1784616729,30.74,31.23,36.83,36.83,'normal'),(1804,1784616730,31.13,31.21,31.88,31.88,'normal'),(1805,1784616731,31.27,31.2,33.95,33.95,'normal'),(1806,1784616732,31.38,31.41,33.91,33.91,'normal'),(1807,1784616733,31.29,31.26,34.34,34.34,'normal'),(1808,1784616734,31.27,31.24,35.32,35.32,'normal'),(1809,1784616735,31.16,31.11,32.39,32.39,'normal'),(1810,1784616736,31.12,30.95,32.64,32.64,'normal'),(1811,1784616737,31.22,31.2,32.42,32.42,'normal'),(1812,1784616738,31.21,31.21,40.14,40.14,'normal'),(1813,1784616739,30.76,31.15,33.75,33.75,'normal'),(1814,1784616740,31.26,31.18,33.36,33.36,'normal'),(1815,1784616741,31.3,31.21,34.24,34.24,'normal'),(1816,1784616742,31.54,31.51,34.05,34.05,'normal'),(1817,1784616743,31.58,31.57,36.34,36.34,'normal'),(1818,1784616744,31.37,31.41,34.41,34.41,'normal'),(1819,1784616745,31.23,31.42,33.05,33.05,'normal'),(1820,1784616746,31.22,31.24,32.72,32.72,'normal'),(1821,1784616747,31.4,31.31,36.01,36.01,'normal'),(1822,1784616748,31.19,31.23,32.83,32.83,'normal'),(1823,1784616749,30.61,30.92,34.57,34.57,'normal'),(1824,1784616750,31.38,31.38,33.72,33.72,'normal'),(1825,1784616751,31.46,31.67,33.37,33.37,'normal'),(1826,1784616752,31.41,31.47,33.65,33.65,'normal'),(1827,1784616753,33.56,31.33,104.07,104.07,'elevated'),(1828,1784616754,31.31,31.28,32.6,32.6,'elevated'),(1829,1784616755,31.22,31.13,32.67,32.67,'elevated'),(1830,1784616756,31.28,31.21,33.08,33.08,'elevated'),(1831,1784616757,31.32,31.33,37.32,37.32,'elevated'),(1832,1784616758,31.26,31.16,32.72,32.72,'normal'),(1833,1784616759,30.72,31.01,35.32,35.32,'normal'),(1834,1784616760,31.73,31.38,41.25,41.25,'normal'),(1835,1784616761,31.19,31.28,36.57,36.57,'normal'),(1836,1784616762,31.23,31.29,33.65,33.65,'normal'),(1837,1784616763,31.15,31.15,32.57,32.57,'normal'),(1838,1784616764,31.36,31.23,33.59,33.59,'normal'),(1839,1784616765,31.1,31.03,32.54,32.54,'normal'),(1840,1784616766,31.2,31.15,32.95,32.95,'normal'),(1841,1784616767,31.27,31.47,32.96,32.96,'normal'),(1842,1784616768,30.23,30.97,33.19,33.19,'normal'),(1843,1784616769,30.87,31.28,33.31,33.31,'normal'),(1844,1784616770,31.53,31.51,32.98,32.98,'normal'),(1845,1784616771,31.24,31.38,33.75,33.75,'normal'),(1846,1784616772,31.07,31.03,32.74,32.74,'normal'),(1847,1784616773,31.33,31.31,37.09,37.09,'normal'),(1848,1784616774,31.21,31.05,33.44,33.44,'normal'),(1849,1784616775,31.12,31.01,33.14,33.14,'normal'),(1850,1784616776,31.13,31,33.29,33.29,'normal'),(1851,1784616777,31.14,31.01,34.54,34.54,'normal'),(1852,1784616778,31.23,31.26,33.29,33.29,'normal'),(1853,1784616779,30.72,31.13,33.69,33.69,'normal'),(1854,1784616780,31.16,31.21,34.57,34.57,'normal'),(1855,1784616781,31.4,31.46,32.95,32.95,'normal'),(1856,1784616782,31.29,31.21,32.74,32.74,'normal'),(1857,1784616784,31.24,31.16,32.85,32.85,'normal'),(1858,1784616785,31.03,31.16,32.98,32.98,'normal'),(1859,1784616786,31.15,31.05,35.95,35.95,'normal'),(1860,1784616787,31.22,31.18,32.7,32.7,'normal'),(1861,1784616788,32.18,31.59,45.35,45.35,'normal'),(1862,1784616789,31.18,31.11,34.21,34.21,'normal'),(1863,1784616790,31.32,31.33,34.7,34.7,'normal'),(1864,1784616791,31.1,31.2,32.41,32.41,'normal'),(1865,1784616792,31.55,31.44,35.95,35.95,'normal'),(1866,1784616793,31.15,31.44,32.52,32.52,'normal'),(1867,1784616794,31.23,31.13,39.62,39.62,'normal'),(1868,1784616795,31.2,31.11,33.37,33.37,'normal'),(1869,1784616796,31.13,31.01,33.44,33.44,'normal'),(1870,1784616797,31.35,31.6,35.03,35.03,'normal'),(1871,1784616798,31.24,31.31,35.59,35.59,'normal'),(1872,1784616799,31.22,31.33,36.01,36.01,'normal'),(1873,1784616800,30.33,31,35.49,35.49,'normal'),(1874,1784616801,31.29,31.47,36.14,36.14,'normal'),(1875,1784616802,31.26,31.16,36.54,36.54,'normal'),(1876,1784616803,31.29,31.38,32.18,32.18,'normal'),(1877,1784616804,31.33,31.44,34.05,34.05,'normal'),(1878,1784616805,31.19,31.38,33.24,33.24,'normal'),(1879,1784616806,31.4,31.41,32.36,32.36,'normal'),(1880,1784616807,31.19,31.18,37.03,37.03,'normal'),(1881,1784616808,31.33,31.18,34.8,34.8,'normal'),(1882,1784616809,31.29,31.34,33.75,33.75,'normal'),(1883,1784616810,30.32,31.15,33.59,33.59,'normal'),(1884,1784616811,31.26,31.26,34.41,34.41,'normal'),(1885,1784616812,31.13,31.26,32.41,32.41,'normal'),(1886,1784616813,31.3,31.42,33.33,33.33,'normal'),(1887,1784616814,31.1,30.98,33.05,33.05,'normal'),(1888,1784616815,31.37,31.34,32.83,32.83,'normal'),(1889,1784616816,31.45,31.41,36.31,36.31,'normal'),(1890,1784616817,31.22,31.28,33,33,'normal'),(1891,1784616818,31.21,31.29,34.18,34.18,'normal'),(1892,1784616819,31.35,31.41,34.34,34.34,'normal'),(1893,1784616820,31.3,31.33,35.68,35.68,'normal'),(1894,1784616821,31.27,31.38,33.26,33.26,'normal'),(1895,1784616822,31.42,31.29,35.52,35.52,'normal'),(1896,1784616823,31.25,31.38,36.24,36.24,'normal'),(1897,1784616824,31.17,31.13,34.93,34.93,'normal'),(1898,1784616825,31.11,31.15,32.82,32.82,'normal'),(1899,1784616826,31.54,31.47,40.4,40.4,'normal'),(1900,1784616827,31.19,31.21,32.62,32.62,'normal'),(1901,1784616828,31.24,31.38,40.5,40.5,'normal'),(1902,1784616829,31.24,31.24,32.36,32.36,'normal'),(1903,1784616830,30.81,31.31,34.83,34.83,'normal'),(1904,1784616831,31.22,31.31,33.16,33.16,'normal'),(1905,1784616832,31.31,31.42,33.75,33.75,'normal'),(1906,1784616833,31.26,31.29,33.11,33.11,'normal'),(1907,1784616834,33.44,31.26,92.6,92.6,'normal'),(1908,1784616835,31.41,31.33,33.14,33.14,'normal'),(1909,1784616836,31.45,31.15,42.89,42.89,'normal'),(1910,1784616837,31.41,31.36,34.08,34.08,'normal'),(1911,1784616838,31.41,31.36,35.32,35.32,'normal'),(1912,1784616839,31.27,31.36,33.08,33.08,'normal'),(1913,1784616840,31.34,31.33,37.68,37.68,'normal'),(1914,1784616841,31.26,31.18,35.06,35.06,'normal'),(1915,1784616842,31.33,31.42,35.88,35.88,'normal'),(1916,1784616843,31.26,31.34,32.15,32.15,'normal'),(1917,1784616844,31.23,31.21,34.73,34.73,'normal'),(1918,1784616845,31.24,31.21,34.28,34.28,'normal'),(1919,1784616846,31.22,31.28,36.96,36.96,'normal'),(1920,1784616847,31.29,31.29,32.83,32.83,'normal'),(1921,1784616848,31.31,31.42,34.5,34.5,'normal'),(1922,1784616849,31.11,31.31,33.78,33.78,'normal'),(1923,1784616850,31.42,31.47,33.23,33.23,'normal'),(1924,1784616851,31.39,31.47,35.65,35.65,'normal'),(1925,1784616852,31.41,31.49,33.75,33.75,'normal'),(1926,1784616853,31.26,31.28,33.19,33.19,'normal'),(1927,1784616854,31.32,31.44,32.6,32.6,'normal'),(1928,1784616855,31.2,31.16,33.24,33.24,'normal'),(1929,1784616856,31.17,31.23,32.34,32.34,'normal'),(1930,1784616857,31.33,31.44,32.57,32.57,'normal'),(1931,1784616858,31.15,31.2,36.37,36.37,'normal'),(1932,1784616859,30.52,31.29,32.65,32.65,'normal'),(1933,1784616860,31.36,31.46,33.65,33.65,'normal'),(1934,1784616861,31.34,31.36,33.41,33.41,'normal'),(1935,1784616862,31.3,31.18,39.12,39.12,'normal'),(1936,1784616863,31.43,31.33,33.39,33.39,'normal'),(1937,1784616864,31.17,31.26,32.74,32.74,'normal'),(1938,1784616865,31.1,31.06,34.5,34.5,'normal'),(1939,1784616866,31.22,31.33,32.52,32.52,'normal'),(1940,1784616867,31.22,31.06,32.9,32.9,'normal'),(1941,1784616868,31.21,31.51,34.73,34.73,'normal'),(1942,1784616869,30.3,31.08,32.19,32.19,'normal'),(1943,1784616870,31.33,31.2,33.39,33.39,'normal'),(1944,1784616871,31.2,31.13,33.82,33.82,'normal'),(1945,1784616872,31.44,31.42,33.95,33.95,'normal'),(1946,1784616873,31.3,31.23,32.42,32.42,'normal'),(1947,1784616874,31.31,31.36,33.33,33.33,'normal'),(1948,1784616875,31.2,31.13,35.91,35.91,'normal'),(1949,1784616876,31.16,31.1,32.19,32.19,'normal'),(1950,1784616877,31.31,31.24,32.83,32.83,'normal'),(1951,1784616878,31.55,31.52,37.36,37.36,'normal'),(1952,1784616879,30.27,31.23,32.13,32.13,'normal'),(1953,1784616880,31.17,31.36,33.13,33.13,'normal'),(1954,1784616881,31.29,31.2,36.27,36.27,'normal'),(1955,1784616882,31.31,31.41,34.47,34.47,'normal'),(1956,1784616883,31.39,31.31,34.6,34.6,'normal'),(1957,1784616884,31.3,31.21,33.29,33.29,'normal'),(1958,1784616885,31.19,31.11,34.54,34.54,'normal'),(1959,1784616886,31.02,31.24,33.08,33.08,'normal'),(1960,1784616887,31.23,31.26,36.47,36.47,'normal'),(1961,1784616888,30.79,31.2,36.7,36.7,'normal'),(1962,1784616889,30.38,31.16,32.85,32.85,'normal'),(1963,1784616890,31.38,31.44,34.01,34.01,'normal'),(1964,1784616891,31.44,31.42,32.33,32.33,'normal'),(1965,1784616892,31.15,31.28,32.69,32.69,'normal'),(1966,1784616893,31.44,31.54,33.62,33.62,'normal'),(1967,1784616894,31.39,31.36,34.31,34.31,'normal'),(1968,1784616895,31.15,31.08,32.92,32.92,'normal'),(1969,1784616896,31.12,31.1,34.34,34.34,'normal'),(1970,1784616897,31.34,31.42,35.65,35.65,'normal'),(1971,1784616898,31.2,31.2,32.37,32.37,'normal'),(1972,1784616899,30.96,31.28,35.82,35.82,'normal'),(1973,1784616900,31.42,31.38,36.86,36.86,'normal'),(1974,1784616901,31.34,31.26,33.29,33.29,'normal'),(1975,1784616902,31.21,31.36,33.46,33.46,'normal'),(1976,1784616903,31.35,31.39,36.44,36.44,'normal'),(1977,1784616904,31.37,31.44,32.75,32.75,'normal'),(1978,1784616905,31.07,31.24,33.05,33.05,'normal'),(1979,1784616906,31.25,31.28,36.31,36.31,'normal'),(1980,1784616907,31.22,31.34,36.54,36.54,'normal'),(1981,1784616908,31.3,31.24,33.46,33.46,'normal'),(1982,1784616909,30.78,31.24,33.16,33.16,'normal'),(1983,1784616910,31.26,31.24,33.91,33.91,'normal'),(1984,1784616911,31.22,31.21,33.65,33.65,'normal'),(1985,1784616912,31.2,31.21,34.73,34.73,'normal'),(1986,1784616913,31.25,31.24,32.9,32.9,'normal'),(1987,1784616914,31.23,31.18,33.11,33.11,'normal'),(1988,1784616915,31.1,31.16,37.49,37.49,'normal'),(1989,1784616916,31.34,31.34,33.28,33.28,'normal'),(1990,1784616917,31.14,31.16,32.13,32.13,'normal'),(1991,1784616918,31.22,31.28,38.93,38.93,'normal'),(1992,1784616919,30.77,31.24,32.92,32.92,'normal'),(1993,1784616920,31.28,31.2,36.21,36.21,'normal'),(1994,1784616921,31.03,31.03,33.88,33.88,'normal'),(1995,1784616922,32.35,31.26,71.57,71.57,'normal'),(1996,1784616923,31.46,31.46,33.78,33.78,'normal'),(1997,1784616924,31.19,31.13,34.87,34.87,'normal'),(1998,1784616925,31.14,31.1,33.26,33.26,'normal'),(1999,1784616926,31.31,31.41,36.04,36.04,'normal'),(2000,1784616928,31.27,31.38,32.6,32.6,'normal'),(2001,1784616929,31.2,31.18,35.59,35.59,'normal'),(2002,1784616930,30.3,31.08,33.14,33.14,'normal'),(2003,1784616931,31.22,31.08,33.44,33.44,'normal'),(2004,1784616932,31.36,31.26,36.93,36.93,'normal'),(2005,1784616933,31.18,31.1,32.67,32.67,'normal'),(2006,1784616934,31.25,31.13,36.73,36.73,'normal'),(2007,1784616935,31.14,31.16,33.13,33.13,'normal'),(2008,1784616936,31.24,31.33,36.27,36.27,'normal'),(2009,1784616937,31.19,31.11,35.39,35.39,'normal'),(2010,1784616938,31.51,31.28,34.31,34.31,'normal'),(2011,1784616939,31.33,31.38,33.75,33.75,'normal'),(2012,1784616940,30.73,31.24,36.93,36.93,'normal'),(2013,1784616941,31.23,31.05,33.42,33.42,'normal'),(2014,1784616942,31.42,31.47,32.96,32.96,'normal'),(2015,1784616943,31.21,31.26,32.51,32.51,'normal'),(2016,1784616944,31.32,31.23,32.54,32.54,'normal'),(2017,1784616945,31.19,31.13,33.78,33.78,'normal'),(2018,1784616946,31.25,31.21,33.36,33.36,'normal'),(2019,1784616947,31.13,31.11,32.56,32.56,'normal'),(2020,1784616948,31.37,31.28,33.59,33.59,'normal'),(2021,1784616949,31.18,31.15,32.56,32.56,'normal'),(2022,1784616950,31.34,31.21,35.19,35.19,'normal'),(2023,1784616951,31.17,31.13,32.46,32.46,'normal'),(2024,1784616952,31.27,31.26,32.57,32.57,'normal'),(2025,1784616953,31.44,31.52,34.96,34.96,'normal'),(2026,1784616954,31.4,31.26,33.16,33.16,'normal'),(2027,1784616955,31.24,31.39,33.78,33.78,'normal'),(2028,1784616956,31.19,31.18,34.6,34.6,'normal'),(2029,1784616957,31.21,31.23,32.88,32.88,'normal'),(2030,1784616958,31.31,31.34,36.14,36.14,'normal'),(2031,1784616959,31.38,31.2,33.23,33.23,'normal'),(2032,1784616960,31.26,31.26,33.62,33.62,'normal'),(2033,1784616961,31.48,31.47,33.24,33.24,'normal'),(2034,1784616962,31.86,31.33,46.63,46.63,'normal'),(2035,1784616963,31.37,31.28,33.13,33.13,'normal'),(2036,1784616964,31.27,31.41,34.05,34.05,'normal'),(2037,1784616965,31.15,31.21,32.34,32.34,'normal'),(2038,1784616966,31.82,31.44,46.56,46.56,'normal'),(2039,1784616967,31.14,31.01,33.55,33.55,'normal'),(2040,1784616968,31.16,31.08,32.62,32.62,'normal'),(2041,1784616969,31.35,31.33,32.96,32.96,'normal'),(2042,1784616970,31.21,31.33,34.24,34.24,'normal'),(2043,1784616971,31.3,31.42,36.08,36.08,'normal'),(2044,1784616972,31.31,31.29,35.72,35.72,'normal'),(2045,1784616973,31.27,31.33,32.37,32.37,'normal'),(2046,1784616974,31.34,31.33,34.01,34.01,'normal'),(2047,1784616975,31.4,31.6,34.8,34.8,'normal'),(2048,1784616976,31.16,31.23,32.24,32.24,'normal'),(2049,1784616977,31.18,31.13,33.16,33.16,'normal'),(2050,1784616978,30.56,31.15,31.95,31.95,'normal'),(2051,1784616979,31.26,31.24,32.83,32.83,'normal'),(2052,1784616980,30.7,31.18,33.31,33.31,'normal'),(2053,1784616981,31.45,31.44,35.59,35.59,'normal'),(2054,1784616982,31.16,31.06,36.08,36.08,'normal'),(2055,1784616983,31.43,31.51,32.82,32.82,'normal'),(2056,1784616984,31.35,31.51,35.52,35.52,'normal'),(2057,1784616985,31.12,31,36.57,36.57,'normal'),(2058,1784616986,31.27,31.29,35.65,35.65,'normal'),(2059,1784616987,31.15,31.26,32.77,32.77,'normal'),(2060,1784616988,31.16,31.2,34.14,34.14,'normal'),(2061,1784616989,30.82,31.16,34.31,34.31,'normal'),(2062,1784616990,31.36,31.46,33.39,33.39,'normal'),(2063,1784616991,31.28,31.34,32.31,32.31,'normal'),(2064,1784616992,31.37,31.41,34.44,34.44,'normal'),(2065,1784616993,31.34,31.46,32.56,32.56,'normal'),(2066,1784616994,31.4,31.34,32.41,32.41,'normal'),(2067,1784616995,31.28,31.21,32.57,32.57,'normal'),(2068,1784616996,31.2,31.24,39.12,39.12,'normal'),(2069,1784616997,31.05,31.24,32.19,32.19,'normal'),(2070,1784616998,31.25,31.11,32.77,32.77,'normal'),(2071,1784616999,30.83,31.08,32.42,32.42,'normal'),(2072,1784617000,31.17,31,36.8,36.8,'normal'),(2073,1784617001,31.22,31.42,34.93,34.93,'normal'),(2074,1784617002,31.4,31.44,36.44,36.44,'normal'),(2075,1784617003,31.48,31.51,36.31,36.31,'normal'),(2076,1784617004,31.42,31.38,35.45,35.45,'normal'),(2077,1784617005,31.2,31.16,36.67,36.67,'normal'),(2078,1784617006,31.23,31.16,33.14,33.14,'normal'),(2079,1784617007,31.21,31.18,37.32,37.32,'normal'),(2080,1784617008,31.24,31.36,37.22,37.22,'normal'),(2081,1784617009,30.75,31.18,33.05,33.05,'normal'),(2082,1784617010,31.26,31.23,32.92,32.92,'normal'),(2083,1784617011,31.34,31.33,32.51,32.51,'normal'),(2084,1784617012,31.31,31.33,32.49,32.49,'normal'),(2085,1784617013,31.28,31.49,32.33,32.33,'normal'),(2086,1784617014,33.51,31.42,101.19,101.19,'elevated'),(2087,1784617015,31.18,31.11,32.78,32.78,'elevated'),(2088,1784617016,31.67,31.38,44.73,44.73,'elevated'),(2089,1784617017,31.07,31.1,32.11,32.11,'elevated'),(2090,1784617018,31.2,31.33,32.75,32.75,'elevated'),(2091,1784617019,30.91,31.44,35.82,35.82,'normal'),(2092,1784617020,31.39,31.33,32.93,32.93,'normal'),(2093,1784617021,31.31,31.38,33.16,33.16,'normal'),(2094,1784617022,31.16,31.21,33.54,33.54,'normal'),(2095,1784617023,31.28,31.28,33.29,33.29,'normal'),(2096,1784617024,31.15,31.18,35.65,35.65,'normal'),(2097,1784617025,31.32,31.41,34.6,34.6,'normal'),(2098,1784617026,31.31,31.21,34.54,34.54,'normal'),(2099,1784617027,31.27,31.29,32.65,32.65,'normal'),(2100,1784617028,31.11,31.16,33.91,33.91,'normal'),(2101,1784617029,30.85,31.2,34.37,34.37,'normal'),(2102,1784617030,31.74,31.2,42.34,42.34,'normal'),(2103,1784617031,31.24,31.26,32.57,32.57,'normal'),(2104,1784617032,31.41,31.36,32.56,32.56,'normal'),(2105,1784617033,31.2,31.26,32.44,32.44,'normal'),(2106,1784617034,31.2,31.11,33.69,33.69,'normal'),(2107,1784617035,31.13,31.1,37.72,37.72,'normal'),(2108,1784617036,31.35,31.24,32.34,32.34,'normal'),(2109,1784617037,31.17,31.06,32.31,32.31,'normal'),(2110,1784617038,31.25,31.36,32.74,32.74,'normal'),(2111,1784617039,31.25,31.2,32.95,32.95,'normal'),(2112,1784617040,31.2,31.26,32.85,32.85,'normal'),(2113,1784617041,31.21,31.29,33.34,33.34,'normal'),(2114,1784617042,31.24,31.29,34.7,34.7,'normal'),(2115,1784617043,31.23,31.15,33.31,33.31,'normal'),(2116,1784617044,31.17,31.13,33.13,33.13,'normal'),(2117,1784617045,31.21,31.33,31.93,31.93,'normal'),(2118,1784617046,31.27,31.24,32.08,32.08,'normal'),(2119,1784617047,31.2,31.16,33.19,33.19,'normal'),(2120,1784617048,31.25,31.29,32.08,32.08,'normal'),(2121,1784617050,30.27,31.26,39.49,39.49,'normal'),(2122,1784617051,32.99,30.85,81.72,81.72,'normal'),(2123,1784617052,31.21,31.28,32.64,32.64,'normal'),(2124,1784617053,31.05,31.13,37.49,37.49,'normal'),(2125,1784617054,31.35,31.26,33.55,33.55,'normal'),(2126,1784617055,31.15,31.16,33.85,33.85,'normal'),(2127,1784617056,31.12,31.16,32.92,32.92,'normal'),(2128,1784617057,31.13,31,37.36,37.36,'normal'),(2129,1784617058,31.19,30.88,36.47,36.47,'normal'),(2130,1784617059,31.26,31.23,33.82,33.82,'normal'),(2131,1784617060,30.85,31.15,34.47,34.47,'normal'),(2132,1784617061,31.09,31.1,34.41,34.41,'normal'),(2133,1784617062,31.21,31.1,32.69,32.69,'normal'),(2134,1784617063,31.21,31.18,34.5,34.5,'normal'),(2135,1784617064,31.29,31.31,32.7,32.7,'normal'),(2136,1784617065,31.27,31.31,36.04,36.04,'normal'),(2137,1784617066,31.07,31.01,33.42,33.42,'normal'),(2138,1784617067,31.2,31.06,34.44,34.44,'normal'),(2139,1784617068,30.28,31.24,35.09,35.09,'normal'),(2140,1784617069,31.05,31.13,34.08,34.08,'normal'),(2141,1784617070,30.8,31.16,40.24,40.24,'normal'),(2142,1784617071,31.26,31.62,33.54,33.54,'normal'),(2143,1784617072,42.92,31.39,166.59,166.59,'elevated'),(2144,1784617073,31.2,31.03,33.13,33.13,'elevated'),(2145,1784617074,35.39,31.46,123.99,123.99,'elevated'),(2146,1784617075,31.09,31.08,34.54,34.54,'elevated'),(2147,1784617076,31.17,31.1,33.37,33.37,'elevated'),(2148,1784617077,31.19,31.42,34.11,34.11,'elevated'),(2149,1784617078,31.14,31.16,34.05,34.05,'elevated'),(2150,1784617079,31.23,31.15,36.08,36.08,'normal'),(2151,1784617080,31.39,31.38,36.67,36.67,'normal'),(2152,1784617081,31.12,31.01,36.34,36.34,'normal'),(2153,1784617082,31.12,30.9,34.6,34.6,'normal'),(2154,1784617083,31.27,31.2,36.54,36.54,'normal'),(2155,1784617084,35.28,31.29,107.28,107.28,'elevated'),(2156,1784617085,31.06,31.03,36.47,36.47,'elevated'),(2157,1784617086,31.09,31.11,34.93,34.93,'elevated'),(2158,1784617087,31.16,31.21,33.95,33.95,'elevated'),(2159,1784617088,31.2,31.13,35.59,35.59,'elevated'),(2160,1784617089,31.09,30.92,38.57,38.57,'normal'),(2161,1784617090,30.34,31.28,33.42,33.42,'normal'),(2162,1784617091,30.91,31,37.39,37.39,'normal'),(2163,1784617092,31.33,31.38,32.39,32.39,'normal'),(2164,1784617093,32.25,31.08,68.03,68.03,'normal'),(2165,1784617094,31.27,31.26,33.18,33.18,'normal'),(2166,1784617095,31.06,31.1,32.16,32.16,'normal'),(2167,1784617096,31.14,31.15,35.52,35.52,'normal'),(2168,1784617097,31.06,31.05,34.73,34.73,'normal'),(2169,1784617098,31.2,31.26,34.54,34.54,'normal'),(2170,1784617099,30.96,31.21,43.42,43.42,'normal'),(2171,1784617100,31.2,31.1,33.49,33.49,'normal'),(2172,1784617101,31.19,31.16,36.18,36.18,'normal'),(2173,1784617102,31.03,31.26,38.14,38.14,'normal'),(2174,1784617103,31.23,31.15,35.82,35.82,'normal'),(2175,1784617104,31.14,30.85,35.75,35.75,'normal'),(2176,1784617105,30.98,31.11,37.29,37.29,'normal'),(2177,1784617106,31.12,31.05,33.37,33.37,'normal'),(2178,1784617107,31.11,31.16,34.34,34.34,'normal'),(2179,1784617108,31.25,31.33,36.11,36.11,'normal'),(2180,1784617109,30.79,31.24,35.95,35.95,'normal'),(2181,1784617110,31.26,31.23,33.08,33.08,'normal'),(2182,1784617111,31.21,31.13,34.31,34.31,'normal'),(2183,1784617112,31.17,31.2,33.62,33.62,'normal'),(2184,1784617113,31.16,31.26,33.62,33.62,'normal'),(2185,1784617114,31.14,31.34,33.39,33.39,'normal'),(2186,1784617115,31.11,31.36,34.6,34.6,'normal'),(2187,1784617116,31,31.05,33.06,33.06,'normal'),(2188,1784617117,30.98,31.16,37.95,37.95,'normal'),(2189,1784617118,30.83,31.2,33.06,33.06,'normal'),(2190,1784617119,31.62,31.05,52.46,52.46,'normal'),(2191,1784617120,31.29,31.21,32.06,32.06,'normal'),(2192,1784617121,31.45,31.6,36.77,36.77,'normal'),(2193,1784617122,31.46,31.46,33.78,33.78,'normal'),(2194,1784617123,31.45,31.56,33.55,33.55,'normal'),(2195,1784617124,31.36,31.26,32.98,32.98,'normal'),(2196,1784617125,31.1,31.13,32.65,32.65,'normal'),(2197,1784617126,31,30.93,32.59,32.59,'normal'),(2198,1784617127,31.07,31.05,33.21,33.21,'normal'),(2199,1784617128,31.13,31.08,34.8,34.8,'normal'),(2200,1784617129,31.69,31.26,48.1,48.1,'normal'),(2201,1784617130,31.2,31.01,32.6,32.6,'normal'),(2202,1784617131,31.02,30.9,32.64,32.64,'normal'),(2203,1784617132,31.39,31.34,35.45,35.45,'normal'),(2204,1784617133,31.11,31.15,33.13,33.13,'normal'),(2205,1784617134,31.08,31.05,32.9,32.9,'normal'),(2206,1784617135,31.06,31.08,32.28,32.28,'normal'),(2207,1784617136,31.15,31.11,32.47,32.47,'normal'),(2208,1784617137,31.08,31.05,32.34,32.34,'normal'),(2209,1784617138,31.18,31.31,32.56,32.56,'normal'),(2210,1784617139,30.74,31.11,32.54,32.54,'normal'),(2211,1784617140,31.31,31.26,34.57,34.57,'normal'),(2212,1784617142,31.18,31.33,32.36,32.36,'normal'),(2213,1784617143,31.27,31.36,34.18,34.18,'normal'),(2214,1784617144,31.14,31.16,32.39,32.39,'normal'),(2215,1784617145,31.12,31.21,33.16,33.16,'normal'),(2216,1784617146,31.07,31.05,32.85,32.85,'normal'),(2217,1784617147,31.14,31.23,33.55,33.55,'normal'),(2218,1784617148,31.02,31.13,34.44,34.44,'normal'),(2219,1784617149,31.21,31.21,34.44,34.44,'normal'),(2220,1784617150,31.21,31.2,32.36,32.36,'normal'),(2221,1784617151,31.26,31.34,32.18,32.18,'normal'),(2222,1784617152,31.18,31.05,32.29,32.29,'normal'),(2223,1784617153,31.01,31.24,32,32,'normal'),(2224,1784617154,31.02,31.08,31.93,31.93,'normal'),(2225,1784617155,31.12,31.2,33.33,33.33,'normal'),(2226,1784617156,30.97,30.92,32.1,32.1,'normal'),(2227,1784617157,31.06,30.95,32.19,32.19,'normal'),(2228,1784617158,30.55,31.03,32.54,32.54,'normal'),(2229,1784617159,31.14,31.11,32.49,32.49,'normal'),(2230,1784617160,30.61,30.93,33,33,'normal'),(2231,1784617161,31.11,31.05,32.42,32.42,'normal'),(2232,1784617162,31.18,31.29,32.13,32.13,'normal'),(2233,1784617163,31.15,31.16,32.51,32.51,'normal'),(2234,1784617164,31.15,31.21,32.44,32.44,'normal'),(2235,1784617165,31.11,31,33.1,33.1,'normal'),(2236,1784617166,31.11,31.01,33.34,33.34,'normal'),(2237,1784617167,31.26,31.28,35.55,35.55,'normal'),(2238,1784617168,31.08,31.1,34.6,34.6,'normal'),(2239,1784617169,31.14,31.05,32.82,32.82,'normal'),(2240,1784617170,30.63,31.16,32.24,32.24,'normal'),(2241,1784617171,31.29,31.15,32.8,32.8,'normal'),(2242,1784617172,31.16,31.16,33.91,33.91,'normal'),(2243,1784617173,31.25,31.21,32.62,32.62,'normal'),(2244,1784617174,31.14,31.24,34.18,34.18,'normal'),(2245,1784617175,31.12,31.01,32.65,32.65,'normal'),(2246,1784617176,31.19,31.33,32.56,32.56,'normal'),(2247,1784617177,31.22,31,33.14,33.14,'normal'),(2248,1784617178,31.21,31.26,32.56,32.56,'normal'),(2249,1784617179,31.16,31.05,35.55,35.55,'normal'),(2250,1784617180,30.34,31.18,32.33,32.33,'normal'),(2251,1784617181,31.1,31.2,32.15,32.15,'normal'),(2252,1784617182,31.23,31.13,32.44,32.44,'normal'),(2253,1784617183,31.24,31.21,32.96,32.96,'normal'),(2254,1784617184,31.13,31.1,34.21,34.21,'normal'),(2255,1784617185,31.15,31.18,33.14,33.14,'normal'),(2256,1784617186,31.11,31.13,32.74,32.74,'normal'),(2257,1784617187,31.11,30.97,32.98,32.98,'normal'),(2258,1784617188,31.22,31.2,42.3,42.3,'normal'),(2259,1784617189,31.15,31.16,32.18,32.18,'normal'),(2260,1784617190,30.63,31.08,32.62,32.62,'normal'),(2261,1784617191,31.34,31.41,32.41,32.41,'normal'),(2262,1784617192,31.26,31.33,32.49,32.49,'normal'),(2263,1784617193,31.26,31.29,33.36,33.36,'normal'),(2264,1784617194,31.12,31.06,32.64,32.64,'normal'),(2265,1784617195,31.15,31.2,32.33,32.33,'normal'),(2266,1784617196,31.05,31.08,37.45,37.45,'normal'),(2267,1784617197,31.07,30.97,33.24,33.24,'normal'),(2268,1784617198,31.23,31.13,32.85,32.85,'normal'),(2269,1784617199,31.15,31.11,33.18,33.18,'normal'),(2270,1784617200,30.68,31.16,32.47,32.47,'normal'),(2271,1784617201,31.12,31.1,33.06,33.06,'normal'),(2272,1784617202,31.04,31.26,32.42,32.42,'normal'),(2273,1784617203,31.14,31.15,32.08,32.08,'normal'),(2274,1784617204,31.22,31.2,32.62,32.62,'normal'),(2275,1784617205,31.11,31.05,33.75,33.75,'normal'),(2276,1784617206,31.16,31.2,32.37,32.37,'normal'),(2277,1784617207,31.11,31.06,32.7,32.7,'normal'),(2278,1784617208,31.12,31.08,32.34,32.34,'normal'),(2279,1784617209,31.29,31.21,35.62,35.62,'normal'),(2280,1784617210,31.21,31.18,33.85,33.85,'normal'),(2281,1784617211,31.1,31.06,32.23,32.23,'normal'),(2282,1784617212,31.09,31.1,34.18,34.18,'normal'),(2283,1784617213,31.17,31.2,32.78,32.78,'normal'),(2284,1784617214,31.18,31.21,33.91,33.91,'normal'),(2285,1784617215,31,31.01,32.16,32.16,'normal'),(2286,1784617216,31.17,31.15,32.9,32.9,'normal'),(2287,1784617217,31.11,31.06,34.83,34.83,'normal'),(2288,1784617218,31.2,31.33,32.64,32.64,'normal'),(2289,1784617219,30.67,31.1,32.95,32.95,'normal'),(2290,1784617220,31.24,31.21,33.31,33.31,'normal'),(2291,1784617221,31.12,31.03,32.34,32.34,'normal'),(2292,1784617222,31.12,31.13,32.01,32.01,'normal'),(2293,1784617223,31.23,31.15,33.59,33.59,'normal'),(2294,1784617224,31.14,31.08,33.01,33.01,'normal'),(2295,1784617225,31.2,31.16,32.56,32.56,'normal'),(2296,1784617226,31.19,31.21,33.1,33.1,'normal'),(2297,1784617227,31.2,31.23,32.69,32.69,'normal'),(2298,1784617228,31.12,31.15,33.88,33.88,'normal'),(2299,1784617229,31.14,31.15,32.98,32.98,'normal'),(2300,1784617230,31.31,31.28,33.28,33.28,'normal'),(2301,1784617231,31.23,31.29,32.33,32.33,'normal'),(2302,1784617232,31.23,31.28,32.37,32.37,'normal'),(2303,1784617233,31.15,31.13,34.93,34.93,'normal'),(2304,1784617234,31.28,31.33,32.51,32.51,'normal'),(2305,1784617235,31.15,31.06,32.28,32.28,'normal'),(2306,1784617237,31.18,31.21,32.44,32.44,'normal'),(2307,1784617238,31.19,31.28,32.33,32.33,'normal'),(2308,1784617239,31.17,31.06,32.69,32.69,'normal'),(2309,1784617240,31.18,31.44,34.31,34.31,'normal'),(2310,1784617241,31.09,30.87,32.6,32.6,'normal'),(2311,1784617242,31.19,31.24,32.59,32.59,'normal'),(2312,1784617243,31.17,31.08,34.9,34.9,'normal'),(2313,1784617244,31.15,31.06,33.11,33.11,'normal'),(2314,1784617245,31.15,31.11,32.28,32.28,'normal'),(2315,1784617246,31.19,31.16,33.26,33.26,'normal'),(2316,1784617247,31.16,31.2,32.82,32.82,'normal'),(2317,1784617248,31.19,31.21,41.32,41.32,'normal'),(2318,1784617249,31.18,31.11,32.42,32.42,'normal'),(2319,1784617250,31.11,31.11,33.44,33.44,'normal'),(2320,1784617251,31.31,31.33,33.18,33.18,'normal'),(2321,1784617252,31.3,31.2,32.78,32.78,'normal'),(2322,1784617253,31.04,31.29,32.52,32.52,'normal'),(2323,1784617254,31.18,31.15,32.74,32.74,'normal'),(2324,1784617255,31.31,31.26,32.19,32.19,'normal'),(2325,1784617256,31.22,31.21,33.21,33.21,'normal'),(2326,1784617257,31.01,30.9,32.77,32.77,'normal'),(2327,1784617258,31.23,31.24,32.06,32.06,'normal'),(2328,1784617259,31.12,31.23,32.33,32.33,'normal'),(2329,1784617260,30.46,31.18,33.69,33.69,'normal'),(2330,1784617261,31.21,31.26,32.33,32.33,'normal'),(2331,1784617262,31.33,31.29,34.28,34.28,'normal'),(2332,1784617263,31.37,31.33,32.46,32.46,'normal'),(2333,1784617264,31.21,31.08,35.29,35.29,'normal'),(2334,1784617265,30.95,31,32.13,32.13,'normal'),(2335,1784617266,31.2,31.15,33.78,33.78,'normal'),(2336,1784617267,31.02,31,31.88,31.88,'normal'),(2337,1784617268,30.96,31.01,32,32,'normal'),(2338,1784617269,30.9,30.97,32.23,32.23,'normal'),(2339,1784617270,31.14,31.15,31.97,31.97,'normal'),(2340,1784617271,31.06,30.98,32.15,32.15,'normal'),(2341,1784617272,31.27,31.41,32.65,32.65,'normal'),(2342,1784617273,31.14,31.21,32.26,32.26,'normal'),(2343,1784617274,31.18,31.08,33.44,33.44,'normal'),(2344,1784617275,31.19,31.11,36.34,36.34,'normal'),(2345,1784617276,31.09,31.11,31.98,31.98,'normal'),(2346,1784617277,31.07,31.05,32.29,32.29,'normal'),(2347,1784617278,31.01,30.92,32.6,32.6,'normal'),(2348,1784617279,31.05,31.01,32.82,32.82,'normal'),(2349,1784617280,30.54,31,32.46,32.46,'normal'),(2350,1784617281,31.01,31.03,33.72,33.72,'normal'),(2351,1784617282,31.3,31.24,37.68,37.68,'normal'),(2352,1784617283,31.09,31.08,34.57,34.57,'normal'),(2353,1784617284,31.13,31.03,32.41,32.41,'normal'),(2354,1784617285,31.19,31.18,33.03,33.03,'normal'),(2355,1784617286,31.12,31,32.88,32.88,'normal'),(2356,1784617287,31.16,31.21,32.33,32.33,'normal'),(2357,1784617288,31.13,31.16,33.52,33.52,'normal'),(2358,1784617289,31.12,31.26,32.24,32.24,'normal'),(2359,1784617290,30.1,31.16,32.8,32.8,'normal'),(2360,1784617291,31.19,31.18,32.37,32.37,'normal'),(2361,1784617292,31.01,31.05,32.01,32.01,'normal'),(2362,1784617293,31.13,31.16,37.78,37.78,'normal'),(2363,1784617294,31.04,31.01,32.62,32.62,'normal'),(2364,1784617295,30.97,30.92,32.42,32.42,'normal'),(2365,1784617296,31.08,31.05,32.42,32.42,'normal'),(2366,1784617297,31.15,31.33,32.08,32.08,'normal'),(2367,1784617298,31.16,31.2,32.75,32.75,'normal'),(2368,1784617299,30.89,30.87,32.29,32.29,'normal'),(2369,1784617300,30.81,31.38,32.39,32.39,'normal'),(2370,1784617301,31.09,31.23,32.52,32.52,'normal'),(2371,1784617302,31.12,31.1,32.59,32.59,'normal'),(2372,1784617303,31.05,31.15,32.57,32.57,'normal'),(2373,1784617304,31.12,31.26,32.18,32.18,'normal'),(2374,1784617305,30.96,31.06,32.33,32.33,'normal'),(2375,1784617306,30.98,30.95,32.34,32.34,'normal'),(2376,1784617307,31.13,31.03,33.01,33.01,'normal'),(2377,1784617308,31.05,31.15,32.34,32.34,'normal'),(2378,1784617309,31.23,31.1,33.65,33.65,'normal'),(2379,1784617310,30.86,31.05,32.26,32.26,'normal'),(2380,1784617311,31.19,31.26,32.34,32.34,'normal'),(2381,1784617312,31.34,31.39,32.28,32.28,'normal'),(2382,1784617313,31.29,31.41,32.18,32.18,'normal'),(2383,1784617314,31.24,31.23,32.1,32.1,'normal'),(2384,1784617315,31.65,31.24,47.15,47.15,'normal'),(2385,1784617316,31.13,31.15,32.87,32.87,'normal'),(2386,1784617317,31.14,31.03,32.78,32.78,'normal'),(2387,1784617318,31.05,31.06,31.93,31.93,'normal'),(2388,1784617319,30.58,30.93,32.65,32.65,'normal'),(2389,1784617320,31.17,31.24,32.24,32.24,'normal'),(2390,1784617321,31.21,31.24,33.03,33.03,'normal'),(2391,1784617322,31.15,31.11,32.41,32.41,'normal'),(2392,1784617323,31.21,31.38,31.98,31.98,'normal'),(2393,1784617324,31.06,31.1,32.29,32.29,'normal'),(2394,1784617325,31.04,30.85,32.1,32.1,'normal'),(2395,1784617326,31.09,31.01,32.31,32.31,'normal'),(2396,1784617327,31.09,31.03,32.72,32.72,'normal'),(2397,1784617328,31.24,31.34,32.26,32.26,'normal'),(2398,1784617329,30.17,31.01,32.1,32.1,'normal'),(2399,1784617330,31.17,31.1,33.26,33.26,'normal'),(2400,1784617331,31.28,31.41,32.33,32.33,'normal'),(2401,1784617332,31.1,31.13,31.88,31.88,'normal'),(2402,1784617333,31,31.01,32.03,32.03,'normal'),(2403,1784617334,31.27,31.46,32.13,32.13,'normal'),(2404,1784617335,30.98,30.97,31.92,31.92,'normal'),(2405,1784617337,31.15,31.18,32.13,32.13,'normal'),(2406,1784617338,31.11,30.98,32.29,32.29,'normal'),(2407,1784617339,30.9,30.97,32.46,32.46,'normal'),(2408,1784617340,30.65,30.93,33.34,33.34,'normal'),(2409,1784617341,31.02,31.01,32.29,32.29,'normal'),(2410,1784617342,31.22,31.26,32.36,32.36,'normal'),(2411,1784617343,31.11,31.08,32.11,32.11,'normal'),(2412,1784617344,31.02,30.8,32.24,32.24,'normal'),(2413,1784617345,31.26,31.29,36.27,36.27,'normal'),(2414,1784617346,31.21,31.31,32.1,32.1,'normal'),(2415,1784617347,31.02,30.83,32.16,32.16,'normal'),(2416,1784617348,31.02,30.98,32.59,32.59,'normal'),(2417,1784617349,31.22,31.2,32.59,32.59,'normal'),(2418,1784617350,30.26,31.18,32.06,32.06,'normal'),(2419,1784617351,31.33,31.42,32.75,32.75,'normal'),(2420,1784617352,31.13,31.16,32.31,32.31,'normal'),(2421,1784617353,31.16,31.16,33.82,33.82,'normal'),(2422,1784617354,31.21,31.29,32.56,32.56,'normal'),(2423,1784617355,31.18,31.26,32.34,32.34,'normal'),(2424,1784617356,31.11,31.16,31.85,31.85,'normal'),(2425,1784617357,31.11,31,32.33,32.33,'normal'),(2426,1784617358,31.17,31.23,33.05,33.05,'normal'),(2427,1784617359,31.15,31.08,32.39,32.39,'normal'),(2428,1784617360,30.68,31.13,32.47,32.47,'normal'),(2429,1784617361,31.16,31.2,33,33,'normal'),(2430,1784617362,31.16,31.23,32.72,32.72,'normal'),(2431,1784617363,31.1,31.05,31.9,31.9,'normal'),(2432,1784617364,31.16,31.13,32.34,32.34,'normal'),(2433,1784617365,31.07,31.1,31.95,31.95,'normal'),(2434,1784617366,31.42,31.49,35.45,35.45,'normal'),(2435,1784617367,31.17,31.26,32.15,32.15,'normal'),(2436,1784617368,31.08,31.11,34.01,34.01,'normal'),(2437,1784617369,30.93,30.97,32.59,32.59,'normal'),(2438,1784617370,30.59,30.9,34.96,34.96,'normal'),(2439,1784617371,31.16,31.24,32.64,32.64,'normal'),(2440,1784617372,31.18,31.16,32.56,32.56,'normal'),(2441,1784617373,31.22,31.11,34.8,34.8,'normal'),(2442,1784617374,31.21,31.18,32.36,32.36,'normal'),(2443,1784617375,31.22,31.24,32.74,32.74,'normal'),(2444,1784617376,30.99,31.08,31.69,31.69,'normal'),(2445,1784617377,31.24,31.23,32.57,32.57,'normal'),(2446,1784617378,31.12,31.06,32.33,32.33,'normal'),(2447,1784617379,31.14,31.15,32.42,32.42,'normal'),(2448,1784617380,31.09,31.08,32.82,32.82,'normal'),(2449,1784617381,31.75,31.38,47.22,47.22,'normal'),(2450,1784617382,31.16,31.31,32.06,32.06,'normal'),(2451,1784617383,31.15,31.28,31.92,31.92,'normal'),(2452,1784617384,31.21,31.11,32.96,32.96,'normal'),(2453,1784617385,31.21,31.16,32.65,32.65,'normal'),(2454,1784617386,31.21,31.23,33.41,33.41,'normal'),(2455,1784617387,31.16,31.18,32.01,32.01,'normal'),(2456,1784617388,31.19,31.2,32.16,32.16,'normal'),(2457,1784617389,31.17,31.13,32.78,32.78,'normal'),(2458,1784617390,30.65,31.05,32.03,32.03,'normal'),(2459,1784617391,31.15,31.01,32.49,32.49,'normal'),(2460,1784617392,31.05,31.1,32.8,32.8,'normal'),(2461,1784617393,31.17,31.1,32.26,32.26,'normal'),(2462,1784617394,31.21,31.33,32.13,32.13,'normal'),(2463,1784617395,31.16,30.93,32.44,32.44,'normal'),(2464,1784617396,31.12,31.11,32.21,32.21,'normal'),(2465,1784617397,31.3,31.29,32.46,32.46,'normal'),(2466,1784617398,31.21,31.18,32.23,32.23,'normal'),(2467,1784617399,31.1,31.24,32.23,32.23,'normal'),(2468,1784617400,30.46,30.82,32.46,32.46,'normal'),(2469,1784617401,31,30.95,32.77,32.77,'normal'),(2470,1784617402,31.11,31.16,32.69,32.69,'normal'),(2471,1784617403,30.87,30.82,31.85,31.85,'normal'),(2472,1784617404,31.18,31.26,32.29,32.29,'normal'),(2473,1784617405,31.16,31.24,31.92,31.92,'normal'),(2474,1784617406,30.9,30.88,32.11,32.11,'normal'),(2475,1784617407,31.05,31.06,35.52,35.52,'normal'),(2476,1784617408,31.09,31,32.05,32.05,'normal'),(2477,1784617409,31.02,31.2,32.13,32.13,'normal');
/*!40000 ALTER TABLE `event_loop_lag` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `kiosk_pages`
--

DROP TABLE IF EXISTS `kiosk_pages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `kiosk_pages` (
  `id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `workspace_id` varchar(64) DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `config` text NOT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `workspace_id` (`workspace_id`),
  CONSTRAINT `kiosk_pages_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `kiosk_pages_ibfk_2` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `kiosk_pages`
--

LOCK TABLES `kiosk_pages` WRITE;
/*!40000 ALTER TABLE `kiosk_pages` DISABLE KEYS */;
/*!40000 ALTER TABLE `kiosk_pages` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `layout_zones`
--

DROP TABLE IF EXISTS `layout_zones`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `layout_zones` (
  `id` varchar(64) NOT NULL,
  `layout_id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL DEFAULT 'Zone',
  `x_percent` double NOT NULL DEFAULT '0',
  `y_percent` double NOT NULL DEFAULT '0',
  `width_percent` double NOT NULL DEFAULT '100',
  `height_percent` double NOT NULL DEFAULT '100',
  `z_index` int NOT NULL DEFAULT '0',
  `zone_type` varchar(50) NOT NULL DEFAULT 'content',
  `fit_mode` varchar(50) NOT NULL DEFAULT 'contain',
  `background_color` varchar(20) DEFAULT '#000000',
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_zones_layout` (`layout_id`),
  CONSTRAINT `layout_zones_ibfk_1` FOREIGN KEY (`layout_id`) REFERENCES `layouts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `layout_zones`
--

LOCK TABLES `layout_zones` WRITE;
/*!40000 ALTER TABLE `layout_zones` DISABLE KEYS */;
INSERT INTO `layout_zones` VALUES ('z-fs-1','tpl-fullscreen','Main',0,0,100,100,0,'content','contain','#000000',0),('z-lb-1','tpl-l-bar','Main Content',0,0,75,85,0,'content','contain','#000000',0),('z-lb-2','tpl-l-bar','Side Panel',75,0,25,100,0,'content','contain','#000000',1),('z-lb-3','tpl-l-bar','Bottom Ticker',0,85,75,15,1,'content','contain','#000000',2),('z-pip-1','tpl-pip','Background',0,0,100,100,0,'content','contain','#000000',0),('z-pip-2','tpl-pip','PiP Window',65,5,30,30,1,'content','contain','#000000',1),('z-q-1','tpl-quad','Top Left',0,0,50,50,0,'content','contain','#000000',0),('z-q-2','tpl-quad','Top Right',50,0,50,50,0,'content','contain','#000000',1),('z-q-3','tpl-quad','Bottom Left',0,50,50,50,0,'content','contain','#000000',2),('z-q-4','tpl-quad','Bottom Right',50,50,50,50,0,'content','contain','#000000',3),('z-sh-1','tpl-split-h','Left',0,0,50,100,0,'content','contain','#000000',0),('z-sh-2','tpl-split-h','Right',50,0,50,100,0,'content','contain','#000000',1),('z-sv-1','tpl-split-v','Top',0,0,100,50,0,'content','contain','#000000',0),('z-sv-2','tpl-split-v','Bottom',0,50,100,50,0,'content','contain','#000000',1),('z-th-1','tpl-thirds','Left',0,0,33.33,100,0,'content','contain','#000000',0),('z-th-2','tpl-thirds','Center',33.33,0,33.34,100,0,'content','contain','#000000',1),('z-th-3','tpl-thirds','Right',66.67,0,33.33,100,0,'content','contain','#000000',2);
/*!40000 ALTER TABLE `layout_zones` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `layouts`
--

DROP TABLE IF EXISTS `layouts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `layouts` (
  `id` varchar(64) NOT NULL,
  `user_id` varchar(64) DEFAULT NULL,
  `workspace_id` varchar(64) DEFAULT NULL,
  `team_id` varchar(64) DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `width` int NOT NULL DEFAULT '1920',
  `height` int NOT NULL DEFAULT '1080',
  `is_template` tinyint(1) NOT NULL DEFAULT '0',
  `template_category` varchar(50) DEFAULT NULL,
  `thumbnail_data` mediumtext,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `workspace_id` (`workspace_id`),
  CONSTRAINT `layouts_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `layouts_ibfk_2` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `layouts`
--

LOCK TABLES `layouts` WRITE;
/*!40000 ALTER TABLE `layouts` DISABLE KEYS */;
INSERT INTO `layouts` VALUES ('tpl-fullscreen',NULL,NULL,NULL,'Fullscreen',1920,1080,1,'basic',NULL,1784540065,1784540065),('tpl-l-bar',NULL,NULL,NULL,'L-Bar with Ticker',1920,1080,1,'news',NULL,1784540065,1784540065),('tpl-pip',NULL,NULL,NULL,'Picture in Picture',1920,1080,1,'overlay',NULL,1784540065,1784540065),('tpl-quad',NULL,NULL,NULL,'Four Quadrants',1920,1080,1,'grid',NULL,1784540065,1784540065),('tpl-split-h',NULL,NULL,NULL,'Split Horizontal',1920,1080,1,'split',NULL,1784540065,1784540065),('tpl-split-v',NULL,NULL,NULL,'Split Vertical',1920,1080,1,'split',NULL,1784540065,1784540065),('tpl-thirds',NULL,NULL,NULL,'Three Column',1920,1080,1,'grid',NULL,1784540065,1784540065);
/*!40000 ALTER TABLE `layouts` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `organization_members`
--

DROP TABLE IF EXISTS `organization_members`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `organization_members` (
  `id` int NOT NULL AUTO_INCREMENT,
  `organization_id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `role` varchar(50) NOT NULL DEFAULT 'org_admin',
  `invited_by` varchar(64) DEFAULT NULL,
  `joined_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `organization_id` (`organization_id`,`user_id`),
  KEY `invited_by` (`invited_by`),
  KEY `idx_organization_members_user` (`user_id`),
  CONSTRAINT `organization_members_ibfk_1` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `organization_members_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `organization_members_ibfk_3` FOREIGN KEY (`invited_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `organization_members`
--

LOCK TABLES `organization_members` WRITE;
/*!40000 ALTER TABLE `organization_members` DISABLE KEYS */;
/*!40000 ALTER TABLE `organization_members` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `organizations`
--

DROP TABLE IF EXISTS `organizations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `organizations` (
  `id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `slug` varchar(255) DEFAULT NULL,
  `owner_user_id` varchar(64) NOT NULL,
  `plan_id` varchar(64) DEFAULT 'free',
  `stripe_customer_id` varchar(255) DEFAULT NULL,
  `stripe_subscription_id` varchar(255) DEFAULT NULL,
  `subscription_status` varchar(50) DEFAULT 'active',
  `subscription_ends` bigint DEFAULT NULL,
  `grace_period_ends` bigint DEFAULT NULL,
  `locked_at` bigint DEFAULT NULL,
  `default_brand_name` varchar(255) DEFAULT NULL,
  `default_logo_url` varchar(500) DEFAULT NULL,
  `default_primary_color` varchar(20) DEFAULT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `slug` (`slug`),
  KEY `owner_user_id` (`owner_user_id`),
  KEY `plan_id` (`plan_id`),
  CONSTRAINT `organizations_ibfk_1` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `organizations_ibfk_2` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `organizations`
--

LOCK TABLES `organizations` WRITE;
/*!40000 ALTER TABLE `organizations` DISABLE KEYS */;
/*!40000 ALTER TABLE `organizations` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `plans`
--

DROP TABLE IF EXISTS `plans`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `plans` (
  `id` varchar(64) NOT NULL,
  `name` varchar(50) NOT NULL,
  `display_name` varchar(255) NOT NULL,
  `max_devices` int NOT NULL DEFAULT '2',
  `max_storage_mb` int NOT NULL DEFAULT '500',
  `remote_control` tinyint(1) NOT NULL DEFAULT '0',
  `remote_url` tinyint(1) NOT NULL DEFAULT '0',
  `priority_support` tinyint(1) NOT NULL DEFAULT '0',
  `price_monthly` double NOT NULL DEFAULT '0',
  `price_yearly` double NOT NULL DEFAULT '0',
  `stripe_monthly_id` varchar(255) DEFAULT NULL,
  `stripe_yearly_id` varchar(255) DEFAULT NULL,
  `stripe_price_monthly` text,
  `stripe_price_yearly` text,
  `sort_order` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `plans`
--

LOCK TABLES `plans` WRITE;
/*!40000 ALTER TABLE `plans` DISABLE KEYS */;
INSERT INTO `plans` VALUES ('enterprise','enterprise','Enterprise',-1,-1,1,1,1,49.99,499,NULL,NULL,NULL,NULL,3,1),('free','free','Free',-1,-1,1,1,1,0,0,NULL,NULL,NULL,NULL,0,1),('pro','pro','Pro',-1,-1,1,1,1,24.99,249,NULL,NULL,NULL,NULL,2,1),('starter','starter','Starter',-1,-1,1,1,1,9.99,99,NULL,NULL,NULL,NULL,1,1);
/*!40000 ALTER TABLE `plans` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `play_logs`
--

DROP TABLE IF EXISTS `play_logs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `play_logs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `device_id` varchar(64) NOT NULL,
  `content_id` varchar(64) DEFAULT NULL,
  `widget_id` varchar(64) DEFAULT NULL,
  `zone_id` varchar(64) DEFAULT NULL,
  `content_name` varchar(500) NOT NULL DEFAULT '',
  `started_at` bigint NOT NULL,
  `ended_at` bigint DEFAULT NULL,
  `duration_sec` int DEFAULT NULL,
  `completed` tinyint(1) NOT NULL DEFAULT '0',
  `trigger_type` varchar(50) DEFAULT 'playlist',
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `widget_id` (`widget_id`),
  KEY `idx_play_logs_device` (`device_id`,`started_at` DESC),
  KEY `idx_play_logs_content` (`content_id`,`started_at` DESC),
  KEY `idx_play_logs_time` (`started_at`,`ended_at`),
  CONSTRAINT `play_logs_ibfk_1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `play_logs_ibfk_2` FOREIGN KEY (`content_id`) REFERENCES `content` (`id`) ON DELETE SET NULL,
  CONSTRAINT `play_logs_ibfk_3` FOREIGN KEY (`widget_id`) REFERENCES `widgets` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `play_logs`
--

LOCK TABLES `play_logs` WRITE;
/*!40000 ALTER TABLE `play_logs` DISABLE KEYS */;
/*!40000 ALTER TABLE `play_logs` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `player_debug_logs`
--

DROP TABLE IF EXISTS `player_debug_logs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `player_debug_logs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `device_id` varchar(64) DEFAULT NULL,
  `ip` varchar(45) DEFAULT NULL,
  `user_agent` varchar(500) DEFAULT NULL,
  `url` varchar(500) DEFAULT NULL,
  `error_fingerprint` varchar(255) DEFAULT NULL,
  `error_data` text,
  `context` text,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_player_debug_fingerprint` (`error_fingerprint`),
  KEY `idx_player_debug_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `player_debug_logs`
--

LOCK TABLES `player_debug_logs` WRITE;
/*!40000 ALTER TABLE `player_debug_logs` DISABLE KEYS */;
/*!40000 ALTER TABLE `player_debug_logs` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `playlist_item_schedules`
--

DROP TABLE IF EXISTS `playlist_item_schedules`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `playlist_item_schedules` (
  `id` varchar(64) NOT NULL,
  `playlist_item_id` int NOT NULL,
  `active_days` varchar(20) NOT NULL DEFAULT '0,1,2,3,4,5,6',
  `start_time` varchar(10) NOT NULL DEFAULT '00:00',
  `end_time` varchar(10) NOT NULL DEFAULT '24:00',
  `start_date` varchar(10) DEFAULT NULL,
  `end_date` varchar(10) DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_playlist_item_schedules_item` (`playlist_item_id`),
  CONSTRAINT `playlist_item_schedules_ibfk_1` FOREIGN KEY (`playlist_item_id`) REFERENCES `playlist_items` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `playlist_item_schedules`
--

LOCK TABLES `playlist_item_schedules` WRITE;
/*!40000 ALTER TABLE `playlist_item_schedules` DISABLE KEYS */;
/*!40000 ALTER TABLE `playlist_item_schedules` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `playlist_items`
--

DROP TABLE IF EXISTS `playlist_items`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `playlist_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `playlist_id` varchar(64) NOT NULL,
  `content_id` varchar(64) DEFAULT NULL,
  `widget_id` varchar(64) DEFAULT NULL,
  `zone_id` varchar(64) DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `duration_sec` int NOT NULL DEFAULT '10',
  `muted` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `playlist_id` (`playlist_id`),
  KEY `content_id` (`content_id`),
  KEY `widget_id` (`widget_id`),
  KEY `zone_id` (`zone_id`),
  CONSTRAINT `playlist_items_ibfk_1` FOREIGN KEY (`playlist_id`) REFERENCES `playlists` (`id`) ON DELETE CASCADE,
  CONSTRAINT `playlist_items_ibfk_2` FOREIGN KEY (`content_id`) REFERENCES `content` (`id`) ON DELETE CASCADE,
  CONSTRAINT `playlist_items_ibfk_3` FOREIGN KEY (`widget_id`) REFERENCES `widgets` (`id`) ON DELETE CASCADE,
  CONSTRAINT `playlist_items_ibfk_4` FOREIGN KEY (`zone_id`) REFERENCES `layout_zones` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `playlist_items`
--

LOCK TABLES `playlist_items` WRITE;
/*!40000 ALTER TABLE `playlist_items` DISABLE KEYS */;
/*!40000 ALTER TABLE `playlist_items` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `playlists`
--

DROP TABLE IF EXISTS `playlists`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `playlists` (
  `id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `workspace_id` varchar(64) DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `description` text,
  `is_auto_generated` tinyint(1) NOT NULL DEFAULT '0',
  `status` varchar(50) NOT NULL DEFAULT 'draft',
  `published_snapshot` mediumtext,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `idx_playlists_workspace` (`workspace_id`),
  CONSTRAINT `playlists_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `playlists_ibfk_2` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `playlists`
--

LOCK TABLES `playlists` WRITE;
/*!40000 ALTER TABLE `playlists` DISABLE KEYS */;
/*!40000 ALTER TABLE `playlists` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `schedules`
--

DROP TABLE IF EXISTS `schedules`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `schedules` (
  `id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `workspace_id` varchar(64) DEFAULT NULL,
  `device_id` varchar(64) DEFAULT NULL,
  `group_id` varchar(64) DEFAULT NULL,
  `zone_id` varchar(64) DEFAULT NULL,
  `content_id` varchar(64) DEFAULT NULL,
  `widget_id` varchar(64) DEFAULT NULL,
  `layout_id` varchar(64) DEFAULT NULL,
  `playlist_id` varchar(64) DEFAULT NULL,
  `title` varchar(255) NOT NULL DEFAULT '',
  `start_time` varchar(20) NOT NULL,
  `end_time` varchar(20) NOT NULL,
  `timezone` varchar(100) NOT NULL DEFAULT 'UTC',
  `recurrence` varchar(255) DEFAULT NULL,
  `recurrence_end` varchar(20) DEFAULT NULL,
  `priority` int NOT NULL DEFAULT '0',
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `color` varchar(20) DEFAULT '#3B82F6',
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `zone_id` (`zone_id`),
  KEY `content_id` (`content_id`),
  KEY `widget_id` (`widget_id`),
  KEY `layout_id` (`layout_id`),
  KEY `playlist_id` (`playlist_id`),
  KEY `idx_schedules_device` (`device_id`,`enabled`),
  KEY `idx_schedules_group` (`group_id`,`enabled`),
  KEY `idx_schedules_workspace` (`workspace_id`),
  CONSTRAINT `schedules_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `schedules_ibfk_2` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `schedules_ibfk_3` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `schedules_ibfk_4` FOREIGN KEY (`group_id`) REFERENCES `device_groups` (`id`) ON DELETE CASCADE,
  CONSTRAINT `schedules_ibfk_5` FOREIGN KEY (`zone_id`) REFERENCES `layout_zones` (`id`) ON DELETE CASCADE,
  CONSTRAINT `schedules_ibfk_6` FOREIGN KEY (`content_id`) REFERENCES `content` (`id`) ON DELETE CASCADE,
  CONSTRAINT `schedules_ibfk_7` FOREIGN KEY (`widget_id`) REFERENCES `widgets` (`id`) ON DELETE CASCADE,
  CONSTRAINT `schedules_ibfk_8` FOREIGN KEY (`layout_id`) REFERENCES `layouts` (`id`) ON DELETE SET NULL,
  CONSTRAINT `schedules_ibfk_9` FOREIGN KEY (`playlist_id`) REFERENCES `playlists` (`id`) ON DELETE SET NULL,
  CONSTRAINT `schedules_chk_1` CHECK ((((`device_id` is not null) and (`group_id` is null)) or ((`device_id` is null) and (`group_id` is not null))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `schedules`
--

LOCK TABLES `schedules` WRITE;
/*!40000 ALTER TABLE `schedules` DISABLE KEYS */;
/*!40000 ALTER TABLE `schedules` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `schema_migrations`
--

DROP TABLE IF EXISTS `schema_migrations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `schema_migrations` (
  `id` varchar(255) NOT NULL,
  `ran_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `schema_migrations`
--

LOCK TABLES `schema_migrations` WRITE;
/*!40000 ALTER TABLE `schema_migrations` DISABLE KEYS */;
/*!40000 ALTER TABLE `schema_migrations` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `screenshots`
--

DROP TABLE IF EXISTS `screenshots`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `screenshots` (
  `id` int NOT NULL AUTO_INCREMENT,
  `device_id` varchar(64) NOT NULL,
  `filepath` varchar(500) NOT NULL,
  `captured_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_screenshots_device` (`device_id`,`captured_at` DESC),
  CONSTRAINT `screenshots_ibfk_1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `screenshots`
--

LOCK TABLES `screenshots` WRITE;
/*!40000 ALTER TABLE `screenshots` DISABLE KEYS */;
/*!40000 ALTER TABLE `screenshots` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `team_invites`
--

DROP TABLE IF EXISTS `team_invites`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `team_invites` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `email` varchar(255) NOT NULL,
  `role` varchar(50) NOT NULL DEFAULT 'viewer',
  `invited_by` varchar(64) NOT NULL,
  `expires_at` bigint NOT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `team_id` (`team_id`),
  KEY `invited_by` (`invited_by`),
  CONSTRAINT `team_invites_ibfk_1` FOREIGN KEY (`team_id`) REFERENCES `teams` (`id`) ON DELETE CASCADE,
  CONSTRAINT `team_invites_ibfk_2` FOREIGN KEY (`invited_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `team_invites`
--

LOCK TABLES `team_invites` WRITE;
/*!40000 ALTER TABLE `team_invites` DISABLE KEYS */;
/*!40000 ALTER TABLE `team_invites` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `team_members`
--

DROP TABLE IF EXISTS `team_members`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `team_members` (
  `id` int NOT NULL AUTO_INCREMENT,
  `team_id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `role` varchar(50) NOT NULL DEFAULT 'viewer',
  `invited_by` varchar(64) DEFAULT NULL,
  `joined_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `team_id` (`team_id`,`user_id`),
  KEY `user_id` (`user_id`),
  KEY `invited_by` (`invited_by`),
  CONSTRAINT `team_members_ibfk_1` FOREIGN KEY (`team_id`) REFERENCES `teams` (`id`) ON DELETE CASCADE,
  CONSTRAINT `team_members_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `team_members_ibfk_3` FOREIGN KEY (`invited_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `team_members`
--

LOCK TABLES `team_members` WRITE;
/*!40000 ALTER TABLE `team_members` DISABLE KEYS */;
/*!40000 ALTER TABLE `team_members` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `teams`
--

DROP TABLE IF EXISTS `teams`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `teams` (
  `id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `owner_id` varchar(64) NOT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `owner_id` (`owner_id`),
  CONSTRAINT `teams_ibfk_1` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `teams`
--

LOCK TABLES `teams` WRITE;
/*!40000 ALTER TABLE `teams` DISABLE KEYS */;
/*!40000 ALTER TABLE `teams` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `totp_recovery_codes`
--

DROP TABLE IF EXISTS `totp_recovery_codes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `totp_recovery_codes` (
  `id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `code_hash` varchar(255) NOT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `used_at` bigint DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_totp_recovery_user` (`user_id`),
  CONSTRAINT `totp_recovery_codes_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `totp_recovery_codes`
--

LOCK TABLES `totp_recovery_codes` WRITE;
/*!40000 ALTER TABLE `totp_recovery_codes` DISABLE KEYS */;
/*!40000 ALTER TABLE `totp_recovery_codes` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` varchar(64) NOT NULL,
  `email` varchar(255) NOT NULL,
  `name` varchar(255) NOT NULL DEFAULT '',
  `password_hash` text,
  `auth_provider` varchar(50) NOT NULL DEFAULT 'local',
  `provider_id` varchar(255) DEFAULT NULL,
  `avatar_url` varchar(500) DEFAULT NULL,
  `role` varchar(50) NOT NULL DEFAULT 'user',
  `plan_id` varchar(64) DEFAULT 'free',
  `stripe_customer_id` varchar(255) DEFAULT NULL,
  `stripe_subscription_id` varchar(255) DEFAULT NULL,
  `subscription_status` varchar(50) DEFAULT 'active',
  `subscription_ends` bigint DEFAULT NULL,
  `totp_secret_enc` text,
  `totp_enabled` tinyint(1) NOT NULL DEFAULT '0',
  `totp_last_step` bigint NOT NULL DEFAULT '0',
  `email_alerts` tinyint(1) DEFAULT '1',
  `trial_started` bigint DEFAULT NULL,
  `trial_plan` varchar(50) DEFAULT 'pro',
  `last_login` bigint DEFAULT NULL,
  `must_change_password` tinyint(1) NOT NULL DEFAULT '0',
  `welcome_email_sent_at` bigint DEFAULT NULL,
  `activation_nudge_sent_at` bigint DEFAULT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `plan_id` (`plan_id`),
  CONSTRAINT `users_ibfk_1` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `users`
--

LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `video_wall_devices`
--

DROP TABLE IF EXISTS `video_wall_devices`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `video_wall_devices` (
  `id` int NOT NULL AUTO_INCREMENT,
  `wall_id` varchar(64) NOT NULL,
  `device_id` varchar(64) NOT NULL,
  `grid_col` int NOT NULL,
  `grid_row` int NOT NULL,
  `rotation` int NOT NULL DEFAULT '0',
  `canvas_x` double DEFAULT NULL,
  `canvas_y` double DEFAULT NULL,
  `canvas_width` double DEFAULT NULL,
  `canvas_height` double DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `wall_id` (`wall_id`,`device_id`),
  UNIQUE KEY `wall_id_2` (`wall_id`,`grid_col`,`grid_row`),
  KEY `device_id` (`device_id`),
  CONSTRAINT `video_wall_devices_ibfk_1` FOREIGN KEY (`wall_id`) REFERENCES `video_walls` (`id`) ON DELETE CASCADE,
  CONSTRAINT `video_wall_devices_ibfk_2` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `video_wall_devices`
--

LOCK TABLES `video_wall_devices` WRITE;
/*!40000 ALTER TABLE `video_wall_devices` DISABLE KEYS */;
/*!40000 ALTER TABLE `video_wall_devices` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `video_walls`
--

DROP TABLE IF EXISTS `video_walls`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `video_walls` (
  `id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `workspace_id` varchar(64) DEFAULT NULL,
  `team_id` varchar(64) DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `grid_cols` int NOT NULL DEFAULT '2',
  `grid_rows` int NOT NULL DEFAULT '2',
  `bezel_h_mm` double NOT NULL DEFAULT '0',
  `bezel_v_mm` double NOT NULL DEFAULT '0',
  `screen_w_mm` double NOT NULL DEFAULT '400',
  `screen_h_mm` double NOT NULL DEFAULT '225',
  `sync_mode` varchar(50) NOT NULL DEFAULT 'leader',
  `leader_device_id` varchar(64) DEFAULT NULL,
  `content_id` varchar(64) DEFAULT NULL,
  `playlist_id` varchar(64) DEFAULT NULL,
  `player_x` double DEFAULT NULL,
  `player_y` double DEFAULT NULL,
  `player_width` double DEFAULT NULL,
  `player_height` double DEFAULT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `leader_device_id` (`leader_device_id`),
  KEY `content_id` (`content_id`),
  KEY `playlist_id` (`playlist_id`),
  KEY `idx_video_walls_workspace` (`workspace_id`),
  CONSTRAINT `video_walls_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `video_walls_ibfk_2` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `video_walls_ibfk_3` FOREIGN KEY (`leader_device_id`) REFERENCES `devices` (`id`) ON DELETE SET NULL,
  CONSTRAINT `video_walls_ibfk_4` FOREIGN KEY (`content_id`) REFERENCES `content` (`id`) ON DELETE SET NULL,
  CONSTRAINT `video_walls_ibfk_5` FOREIGN KEY (`playlist_id`) REFERENCES `playlists` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `video_walls`
--

LOCK TABLES `video_walls` WRITE;
/*!40000 ALTER TABLE `video_walls` DISABLE KEYS */;
/*!40000 ALTER TABLE `video_walls` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `white_labels`
--

DROP TABLE IF EXISTS `white_labels`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `white_labels` (
  `id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `workspace_id` varchar(64) DEFAULT NULL,
  `brand_name` varchar(255) NOT NULL DEFAULT 'ScreenTinker',
  `logo_url` varchar(500) DEFAULT NULL,
  `favicon_url` varchar(500) DEFAULT NULL,
  `primary_color` varchar(20) DEFAULT '#3B82F6',
  `secondary_color` varchar(20) DEFAULT '#1E293B',
  `bg_color` varchar(20) DEFAULT '#111827',
  `custom_domain` varchar(255) DEFAULT NULL,
  `custom_css` text,
  `hide_branding` tinyint(1) DEFAULT '0',
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `workspace_id` (`workspace_id`),
  CONSTRAINT `white_labels_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `white_labels_ibfk_2` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `white_labels`
--

LOCK TABLES `white_labels` WRITE;
/*!40000 ALTER TABLE `white_labels` DISABLE KEYS */;
/*!40000 ALTER TABLE `white_labels` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `widgets`
--

DROP TABLE IF EXISTS `widgets`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `widgets` (
  `id` varchar(64) NOT NULL,
  `user_id` varchar(64) DEFAULT NULL,
  `workspace_id` varchar(64) DEFAULT NULL,
  `team_id` varchar(64) DEFAULT NULL,
  `widget_type` varchar(50) NOT NULL,
  `name` varchar(255) NOT NULL,
  `config` text NOT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `workspace_id` (`workspace_id`),
  CONSTRAINT `widgets_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `widgets_ibfk_2` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `widgets`
--

LOCK TABLES `widgets` WRITE;
/*!40000 ALTER TABLE `widgets` DISABLE KEYS */;
/*!40000 ALTER TABLE `widgets` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `workspace_invites`
--

DROP TABLE IF EXISTS `workspace_invites`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `workspace_invites` (
  `id` varchar(64) NOT NULL,
  `workspace_id` varchar(64) NOT NULL,
  `email` varchar(255) NOT NULL,
  `role` varchar(50) NOT NULL DEFAULT 'workspace_viewer',
  `invited_by` varchar(64) NOT NULL,
  `expires_at` bigint NOT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `workspace_id` (`workspace_id`),
  KEY `invited_by` (`invited_by`),
  CONSTRAINT `workspace_invites_ibfk_1` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `workspace_invites_ibfk_2` FOREIGN KEY (`invited_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `workspace_invites`
--

LOCK TABLES `workspace_invites` WRITE;
/*!40000 ALTER TABLE `workspace_invites` DISABLE KEYS */;
/*!40000 ALTER TABLE `workspace_invites` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `workspace_members`
--

DROP TABLE IF EXISTS `workspace_members`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `workspace_members` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `role` varchar(50) NOT NULL DEFAULT 'workspace_viewer',
  `invited_by` varchar(64) DEFAULT NULL,
  `joined_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `workspace_id` (`workspace_id`,`user_id`),
  KEY `invited_by` (`invited_by`),
  KEY `idx_workspace_members_user` (`user_id`),
  CONSTRAINT `workspace_members_ibfk_1` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `workspace_members_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `workspace_members_ibfk_3` FOREIGN KEY (`invited_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `workspace_members`
--

LOCK TABLES `workspace_members` WRITE;
/*!40000 ALTER TABLE `workspace_members` DISABLE KEYS */;
/*!40000 ALTER TABLE `workspace_members` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `workspaces`
--

DROP TABLE IF EXISTS `workspaces`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `workspaces` (
  `id` varchar(64) NOT NULL,
  `organization_id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `slug` varchar(255) DEFAULT NULL,
  `created_by` varchar(64) DEFAULT NULL,
  `billing_type` varchar(50) DEFAULT 'client_billable',
  `billing_notes` text,
  `billing_contact_email` varchar(255) DEFAULT NULL,
  `billing_contract_ref` varchar(255) DEFAULT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `organization_id` (`organization_id`,`slug`),
  KEY `created_by` (`created_by`),
  KEY `idx_workspaces_organization` (`organization_id`),
  CONSTRAINT `workspaces_ibfk_1` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `workspaces_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `workspaces`
--

LOCK TABLES `workspaces` WRITE;
/*!40000 ALTER TABLE `workspaces` DISABLE KEYS */;
/*!40000 ALTER TABLE `workspaces` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Dumping routines for database 'beamos'
--
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!50014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!50014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-07-21 12:33:37
