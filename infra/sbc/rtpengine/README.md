# RTPengine SBC Notes

RTPengine is configured by `docker-compose.sbc.yml` in bridge-mode style with:

- NG control: UDP `2223` on `sbc_net`
- Media relay ports: UDP `30000-40000` on `sbc_net`

Kamailio uses `rtpengine_manage()` for INVITE and INVITE replies to anchor media.
