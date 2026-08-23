# LoopCom, LLC — Robocall Mitigation Plan

**DRAFT for Izzy's review — not yet filed.** To be submitted with LoopCom's Robocall
Mitigation Database (RMD) registration once the USAC 499 Filer ID is issued.

| | |
|---|---|
| Company | LoopCom, LLC (d/b/a Loopcom) |
| FCC Registration Number (FRN) | 0038803722 |
| FCC Form 499 Filer ID | *(pending — USAC registration in review)* |
| Business address | 33 NY-17M, Suite C, Harriman, NY 10926 |
| Robocall mitigation contact | Israel Weinstock, CEO — izzy@loopcom.net — (562) 209-6644 |
| Provider type | Interconnected VoIP provider (voice service provider; no facilities-based PSTN interconnection of its own) |

## 1. Who we are and how calls reach the phone network

LoopCom provides business phone service (interconnected VoIP) to small and
mid-size businesses in the United States. Customers place and receive calls
through LoopCom's hosted platform; calls reach the public switched telephone
network exclusively through LoopCom's underlying wholesale carriers. LoopCom
does not sell wholesale termination, does not serve other carriers or call
centers as traffic aggregators, and does not offer high-volume outbound
dialing, autodialing, or telemarketing campaign services.

## 2. STIR/SHAKEN status

**LoopCom certifies no STIR/SHAKEN implementation of its own and is
performing robocall mitigation, as described in this plan.**

LoopCom does not hold an Operating Company Number or a Service Provider Code
(SPC) token, and therefore does not itself apply STIR/SHAKEN authentication
to calls. LoopCom does not originate traffic directly onto the PSTN. All
outbound calls are handed to underlying wholesale carriers, which apply
STIR/SHAKEN attestation to the calls they originate on LoopCom's behalf.

Accordingly, LoopCom's obligation and commitment is robocall mitigation: to
ensure that the traffic it hands to its upstream carriers is lawful,
attributable to a known and identified customer, and carries only caller ID
that the customer is entitled to use. The practices below implement that
commitment.

## 3. Know-your-customer (KYC) controls

- Every customer is a identified business that completes a sign-up including
  legal/business name, contact identity, service address, and payment by
  verifiable means (payment card). Service is provisioned only after payment.
- Each line/extension is associated with a named user within the customer's
  organization, and each customer's E911 service address is validated and
  registered with the carrier at provisioning time.
- LoopCom does not accept anonymous sign-ups and does not provision service
  to customers whose identity cannot be established.

## 4. Caller ID controls

- Outbound caller ID is configured exclusively by LoopCom personnel when a
  customer's service is provisioned. Customers have no ability — self-service
  or otherwise — to set, change, or override the caller ID their calls
  present. There is no customer-facing setting for caller ID anywhere on the
  platform.
- Every number a customer presents was either purchased for them through
  LoopCom's underlying carriers, or ported into LoopCom through a number port
  in which the customer supplied documentary proof of ownership (such as a
  carrier bill in the customer's name) before the number was provisioned.
- Unlawful caller ID spoofing by a customer is therefore not merely
  prohibited by policy — it is not possible on the platform, because the
  customer never controls the caller ID field.

## 5. Traffic monitoring and abuse prevention

- LoopCom requires 10DLC registration for outbound text messaging: customers
  sending application-to-person text traffic must be registered under a 10DLC
  brand and campaign before that traffic is permitted.
- Outbound messaging is subject to per-customer daily caps and a campaign
  approval process; anomalous volume requires manual review.
- Platform monitoring watches for toll-fraud patterns and anomalous calling
  behavior (including automated monitoring with alerts to management), and
  every administrative and provisioning action is recorded in audit logs.
- LoopCom's platform can suspend an individual customer's outbound service
  promptly without affecting other customers, and this capability is used
  when abuse is identified.
- LoopCom's customer base is small businesses using ordinary business
  calling; the platform is not marketed to, or suitable for, mass outbound
  calling operations.

## 6. Cooperation with traceback and enforcement

- LoopCom will respond to traceback requests from the Industry Traceback
  Group, the FCC, or law enforcement within 24 hours of receipt, using the
  contact listed above.
- Because every call is attributable to an identified, paying business
  customer, LoopCom can identify the source of any call it carried.

## 7. Enforcement against violators

- Customers agree not to use the service for unlawful calling, including
  illegal robocalls and unlawful spoofing.
- On discovery of illegal robocalling or spoofing, LoopCom will suspend the
  offending customer's outbound service immediately, investigate, and
  terminate service where the violation is confirmed. LoopCom will not
  knowingly serve any customer engaged in illegal calling campaigns.

## 8. Commitment

LoopCom certifies that it is committed to preventing the origination of
illegal robocall traffic on its network, will cooperate fully with the FCC
and traceback efforts, and will maintain and update the practices described
in this plan as its network and the governing rules evolve.

---
*Prepared 2026-08-20. Review before filing: (a) confirm the description of
upstream carrier signing is current; (b) confirm the contact phone/email;
(c) insert the 499 Filer ID when issued.*
