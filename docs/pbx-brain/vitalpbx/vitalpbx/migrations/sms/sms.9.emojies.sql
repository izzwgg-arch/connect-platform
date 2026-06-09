use ombutel;

alter table `ombu_sms_messages`
 modify column `message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL;