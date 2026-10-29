import type { QuickCommand } from '../../../../packages/contracts/src/commerce-extra';
import { platformSchema, type PlatformId } from '../../../../packages/contracts/src/platform';
import type { SendCommand, SendResult } from '../../../../packages/contracts/src';
import type {
  OrderRemarkCommand,
  ShipmentCommand,
  PlatformActionResult,
} from '../../../../packages/contracts/src/commerce-tools';
import { assert } from '../../../../packages/core/src/util';
import type { PlatformAccount } from './workbench-host';
import type { PlatformStaff, TransferCommand } from '../../../../packages/contracts/src/workbench';
type Account = PlatformAccount & { platform: PlatformId };
export interface PlatformDriver {
  executeQuickAction?(command: QuickCommand): Promise<PlatformActionResult>;
  staff?(accountId: string): Promise<PlatformStaff[]>;
  executeTransfer?(command: TransferCommand): Promise<PlatformActionResult>;
  markRead?(
    accountId: string,
    input: {
      conversationKey: string;
      buyerId: string;
      messageIds: string[];
      platformContext?: Record<string, unknown>;
    },
  ): Promise<unknown>;
  connect(account?: PlatformAccount, visible?: boolean): Promise<unknown>;
  restore(accounts: PlatformAccount[]): Promise<void>;
  send(command: SendCommand): Promise<SendResult>;
  query(accountId: string, operation: string, input: Record<string, unknown>): Promise<unknown>;
  executeShipment?(command: ShipmentCommand): Promise<PlatformActionResult>;
  executeAction?(command: OrderRemarkCommand): Promise<PlatformActionResult>;
  verify(accountId: string): Promise<unknown>;
  disconnect(accountId: string): void;
  forgetPartition(partition: string): Promise<void>;
  setMaintenance(paused: boolean): void;
  close(): Promise<void>;
}
// No global "current platform" or renderer-selected store participates in dispatch.
export class PlatformHosts {
  private accounts = new Map<string, Account>();
  constructor(private drivers: Record<PlatformId, PlatformDriver>) {}
  remember(account: Account) {
    const platform = platformSchema.parse(account.platform);
    const prior = this.accounts.get(account.id);
    assert(
      !prior ||
        (prior.platform === platform &&
          prior.storeId === account.storeId &&
          prior.sessionPartition === account.sessionPartition),
      '账号的平台或登录分区已改变',
    );
    this.accounts.set(account.id, { ...account, platform });
  }
  private driver(accountId: string) {
    const account = this.accounts.get(accountId);
    assert(account, '账号尚未连接，请先打开对应平台');
    return this.drivers[account.platform];
  }
  async connect(account?: Account, platform: PlatformId = 'pinduoduo') {
    if (account) {
      this.remember(account);
      return this.driver(account.id).connect(account);
    }
    return this.drivers[platformSchema.parse(platform)].connect();
  }
  async restore(accounts: Account[]) {
    this.accounts.clear();
    for (const account of accounts) this.remember(account);
    await Promise.all(
      Object.entries(this.drivers).map(([platform, driver]) =>
        driver.restore(accounts.filter((a) => a.platform === platform)),
      ),
    );
  }
  send(command: SendCommand) {
    return this.driver(command.accountId).send(command);
  }
  query(accountId: string, operation: string, input: Record<string, unknown>) {
    return this.driver(accountId).query(accountId, operation, input);
  }
  staff(accountId: string) {
    const driver = this.driver(accountId);
    assert(driver.staff, '当前平台不支持客服列表');
    return driver.staff(accountId);
  }
  executeTransfer(command: TransferCommand) {
    const driver = this.driver(command.accountId);
    assert(driver.executeTransfer, '当前平台不支持客服转接');
    return driver.executeTransfer(command);
  }
  markRead(
    accountId: string,
    input: {
      conversationKey: string;
      buyerId: string;
      messageIds: string[];
      platformContext?: Record<string, unknown>;
    },
  ) {
    return this.driver(accountId).markRead?.(accountId, input);
  }
  executeQuickAction(command: QuickCommand) {
    const driver = this.driver(command.accountId);
    assert(driver.executeQuickAction, '当前平台不支持此操作');
    return driver.executeQuickAction(command);
  }
  executeShipment(command: ShipmentCommand) {
    const driver = this.driver(command.accountId);
    assert(driver.executeShipment, '当前平台不支持无需物流发货');
    return driver.executeShipment(command);
  }
  executeAction(command: OrderRemarkCommand) {
    const driver = this.driver(command.accountId);
    assert(driver.executeAction, '当前平台未提供可核验的订单修改能力');
    return driver.executeAction(command);
  }
  verify(accountId: string) {
    return this.driver(accountId).verify(accountId);
  }
  disconnect(accountId: string) {
    const account = this.accounts.get(accountId);
    if (account) this.drivers[account.platform].disconnect(accountId);
  }
  async forgetPartition(partition: string) {
    const account = [...this.accounts.values()].find((a) => a.sessionPartition === partition);
    if (account) {
      await this.driver(account.id).forgetPartition(partition);
      this.accounts.delete(account.id);
    } else {
      await Promise.all(
        Object.values(this.drivers).map((driver) => driver.forgetPartition(partition)),
      );
    }
  }
  setMaintenance(paused: boolean) {
    for (const driver of Object.values(this.drivers)) driver.setMaintenance(paused);
  }
  async close() {
    await Promise.all(Object.values(this.drivers).map((driver) => driver.close()));
  }
}
