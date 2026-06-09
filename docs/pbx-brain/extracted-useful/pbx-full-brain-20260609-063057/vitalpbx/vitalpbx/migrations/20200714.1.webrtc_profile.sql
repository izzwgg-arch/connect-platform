use `ombutel`;

insert into `ombu_device_profiles` (`technology`, `name`, `description`, `default`) values
 ('pjsip','Default WebRTC Profile', 'Default WebRTC Profile', 'yes');

set @profile_id = last_insert_id();

insert into `ombu_pjsip_profiles`
    (`profile_id`,
     `transport`,
     `media_encryption`,
     `dtls_setup`,
     `dtls_verify`,
     `media_use_received_transport`,
     `disable_direct_media_on_nat`,
     `webrtc`,
     `rtp_symmetric`,
     `rtcp_mux`,
     `asymmetric_rtp_codec`,
     `force_rport`,
     `ice_support`,
     `use_avpf`,
     `remove_existing`,
     `send_pai`,
     `send_rpid`
     ) values (
        @profile_id,
        'wss',
        'dtls',
        'actpass',
        'fingerprint',
        'yes',
        'yes',
        'yes',
        'yes',
        'yes',
        'no',
        'yes',
        'yes',
        'yes',
        'yes',
        'yes',
        'yes'
    );