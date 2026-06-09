use `ombutel`;

alter table ombu_pjsip_profiles
    add column if not exists `incoming_call_offer_pref` enum('local', 'local_first', 'remote', 'remote_first') not null default 'local',
    add column if not exists `outgoing_call_offer_pref` enum('local', 'local_merge', 'local_first', 'remote', 'remote_merge', 'remote_first') not null default 'remote_merge';