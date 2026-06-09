/* Allow customizing the priority of scheduled calls when entering a queue */
use ombutel;

alter table `ombu_queues_callback`
 add column if not exists `priority` int unsigned null default 50 after `ringtime`;

update `ombu_queues_callback` set `priority` = 50 where `priority` is null;