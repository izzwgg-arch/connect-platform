use `asterisk`;

alter table `cdr`
    add index (`tenant`,`uniqueid`),
    add index (`tenant`,`uniqueid`, `calltype`),
    add index (`auth_code`),
    add index (`customer_code`),
    add index (`channel`),
    add index (`dstchannel`);