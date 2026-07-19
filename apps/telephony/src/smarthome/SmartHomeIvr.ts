// SmartHomeIvr — the call flow: answer → PIN auth → DTMF menu → HA actions.
//
// Menu conventions: mapped digits 1-9 fire the account's Home Assistant
// actions; 0 repeats the menu prompt; * (or repeated silence) says goodbye.

import { childLogger } from "../logging/logger";
import type { IvrChannel } from "./agi/AgiChannel";
import type { SmartHomeAccount, SmartHomeConfig, SmartHomeMenuItem } from "./config";
import { verifyPin } from "./pinHash";
import { PinLockout } from "./pinLockout";
import { HaError, HomeAssistantClient } from "./HomeAssistantClient";
import { executeWebhook } from "./webhookExecutor";

const log = childLogger("SmartHomeIvr");

const PIN_ATTEMPTS_PER_CALL = 3;
const PIN_TIMEOUT_MS = 10_000;
const MENU_TIMEOUT_MS = 8_000;
const MENU_MAX_IDLE = 2;
const MENU_MAX_ACTIONS = 30;

export interface SmartHomeIvrDeps {
  config: SmartHomeConfig;
  ha: HomeAssistantClient;
  lockout?: PinLockout;
  onEvent?: (event: string, fields?: Record<string, unknown>) => void;
}

export class SmartHomeIvr {
  private readonly cfg: SmartHomeConfig;
  private readonly ha: HomeAssistantClient;
  private readonly lockout: PinLockout;
  private readonly onEvent: (event: string, fields?: Record<string, unknown>) => void;

  constructor(deps: SmartHomeIvrDeps) {
    this.cfg = deps.config;
    this.ha = deps.ha;
    this.lockout = deps.lockout ?? new PinLockout();
    this.onEvent = deps.onEvent ?? (() => undefined);
  }

  async handleCall(chan: IvrChannel): Promise<void> {
    const p = this.cfg.prompts;
    this.onEvent("call_started", { callerId: chan.callerId || "(withheld)" });
    await chan.answer();

    const account = await this.authenticate(chan);
    if (!account) {
      await chan.play(p.goodbye);
      await chan.hangup();
      return;
    }
    this.onEvent("auth_success", { accountId: account.id });
    log.info({ accountId: account.id }, "Smart-home IVR authenticated");

    await this.menuLoop(chan, account);
    await chan.play(p.goodbye);
    await chan.hangup();
    this.onEvent("call_finished", { accountId: account.id });
  }

  // ── auth ──────────────────────────────────────────────────────────────────

  private async authenticate(chan: IvrChannel): Promise<SmartHomeAccount | null> {
    const p = this.cfg.prompts;
    if (this.lockout.isLocked(chan.callerId)) {
      this.onEvent("auth_locked_out", { callerId: chan.callerId || "(withheld)" });
      log.warn({ callerId: chan.callerId || "(withheld)" }, "Smart-home IVR lockout — refusing PIN prompt");
      await chan.play(p.invalidPin);
      return null;
    }

    for (let attempt = 1; attempt <= PIN_ATTEMPTS_PER_CALL; attempt++) {
      const pin = await chan.getData(p.enterPin, PIN_TIMEOUT_MS, 10);
      if (pin === null) return null; // caller hung up
      const account = pin ? this.findAccountByPin(pin) : undefined;
      if (account) {
        this.lockout.recordSuccess(chan.callerId);
        return account;
      }
      this.lockout.recordFailure(chan.callerId);
      this.onEvent("auth_failed", { attempt, callerId: chan.callerId || "(withheld)" });
      if (attempt < PIN_ATTEMPTS_PER_CALL && !this.lockout.isLocked(chan.callerId)) {
        await chan.play(p.invalidPin);
      }
    }
    await chan.play(p.invalidPin);
    return null;
  }

  private findAccountByPin(pin: string): SmartHomeAccount | undefined {
    return this.cfg.accounts.find((acc) => {
      if (!acc.enabled) return false;
      if (acc.pinHash) return verifyPin(pin, acc.pinHash);
      return acc.pinPlain !== undefined && acc.pinPlain === pin;
    });
  }

  // ── menu ──────────────────────────────────────────────────────────────────

  private async menuLoop(chan: IvrChannel, account: SmartHomeAccount): Promise<void> {
    const p = this.cfg.prompts;
    let idle = 0;
    for (let i = 0; i < MENU_MAX_ACTIONS; i++) {
      const digit = await chan.getData(p.menu, MENU_TIMEOUT_MS, 1);
      if (digit === null) return; // hung up
      if (digit === "") {
        idle++;
        if (idle >= MENU_MAX_IDLE) return;
        continue;
      }
      idle = 0;
      if (digit === "*") return;
      if (digit === "0") continue; // replay menu prompt
      const item = account.menu.find((m) => m.digit === digit);
      if (!item) {
        await chan.play(p.invalidOption);
        continue;
      }
      await this.runAction(chan, account, item);
    }
  }

  private async runAction(
    chan: IvrChannel,
    account: SmartHomeAccount,
    item: SmartHomeMenuItem,
  ): Promise<void> {
    const p = this.cfg.prompts;
    const started = Date.now();
    try {
      if (item.webhook) {
        await executeWebhook(item.webhook);
      } else if (account.ha && item.domain && item.service && item.entityId) {
        await this.ha.callService(account.ha, {
          domain: item.domain,
          service: item.service,
          entityId: item.entityId,
          serviceData: item.serviceData,
        });
      } else {
        // Config validation prevents this; guard anyway.
        throw new HaError("service", `menu item ${item.digit} has no executable action`);
      }
      this.onEvent("ha_action_ok", {
        accountId: account.id,
        digit: item.digit,
        label: item.label,
        latencyMs: Date.now() - started,
      });
      log.info(
        { accountId: account.id, digit: item.digit, label: item.label, entityId: item.entityId },
        "Smart-home action executed",
      );
      await chan.play(item.okPrompt ?? p.ok);
    } catch (err) {
      const kind = err instanceof HaError ? err.kind : "unreachable";
      this.onEvent("ha_action_failed", {
        accountId: account.id,
        digit: item.digit,
        label: item.label,
        kind,
      });
      log.warn(
        { accountId: account.id, digit: item.digit, kind, err: err instanceof Error ? err.message : String(err) },
        "Smart-home action failed",
      );
      await chan.play(p.fail);
    }
  }
}
